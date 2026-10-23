/**
 * index.mjs — سرور برنامه: صفحه‌های تست + API ایجنت لیا
 *
 *   node server/index.mjs            → http://127.0.0.1:4173
 *   PORT=5000 node server/index.mjs
 *
 * API:
 *   POST /api/session            ساخت/بازیابی سشن (بدون لاگین)
 *   GET  /api/session/:id        وضعیت + پیام‌ها (برای ادامهٔ چت بین صفحات)
 *   POST /api/chat               گفتگو (SSE)
 *   POST /api/action             دکمه‌ها (SSE)
 *   POST /api/context            تغییر صفحه (آگاهی از صفحه)
 *   POST /api/intake             آپلود zip (بدنهٔ خام)
 *   POST /api/intake/repo        تحلیل مخزن گیت‌هاب
 *   GET  /api/deploy/:id         وضعیت/رویدادهای اجرای دیپلوی
 *   GET  /api/health             سلامت + وضعیت LLM
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import './env.mjs';

import { createSession, getSession } from './store.mjs';
import {
  greet,
  handleChat,
  handleAction,
  handleContext,
  handleAnalysis,
  importRepo,
  sessionState,
  deployFinished,
  deployFailed,
} from './orchestrator.mjs';
import { analyzeFromZip } from './intake.mjs';
import { saveProject, fileTree, readFile as readWorkspaceFile, exportZip } from './workspace.mjs';
import { getRun, snapshot, listDeployments, stopDeployment, staticRoot, onRunFinished, onRunFailed } from './deploy.mjs';
import { llmInfo, llmStatus, checkProvider } from './llm.mjs';
import { PLAN_CATALOG } from './plans.mjs';
import { createOrGet, getAccount, planStatus, publicAccount, purchase, plansList, linkSession } from './account.mjs';
import { remember as rememberDeployment } from './registry.mjs';
import { recent, subscribe, logLine } from './bus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MOCK_DIR = path.join(ROOT, 'mock');
const WIDGET_DIR = path.join(ROOT, 'widget');
const AGENT_DIR = path.join(ROOT, 'agent-ui');
const TEST_PROJECTS_DIR = path.join(ROOT, 'test-projects');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD = 60 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------------- کمکی‌های HTTP ---------------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('حجم درخواست بیش از حد مجاز است');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('بدنهٔ JSON نامعتبر است');
  }
}

function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let closed = false;
  const send = (event) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  // ضربان دوره‌ای تا پروکسی‌ها اتصال طولانی را قطع نکنند
  const ping = setInterval(() => {
    if (closed) return;
    res.write(': ping\n\n');
  }, 15_000);
  const end = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  return { send, end };
}

/* ---------------- استاتیک ---------------- */

function safeJoin(base, urlPath) {
  const target = path.resolve(base, '.' + urlPath);
  return target.startsWith(base) ? target : null;
}

function resolveFile(base, urlPath) {
  const raw = urlPath.split('?')[0];
  const variants = [raw];
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) variants.push(decoded);
  } catch {
    /* ignore */
  }
  for (const variant of variants) {
    const file = safeJoin(base, variant);
    if (!file) continue;
    try {
      const st = fs.statSync(file);
      if (st.isDirectory()) {
        const idx = path.join(file, 'index.html');
        if (fs.existsSync(idx)) return idx;
        continue;
      }
      return file;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * مسیرهای ویژهٔ Next.js در آینه.
 * آینه استاتیک است و رانتایم Next را ندارد؛ اگر جایی (کش مرورگر، لینک قدیمی یا
 * صفحهٔ ذخیره‌شدهٔ قبلی) این مسیرها درخواست شدند، پاسخ تمیز بده تا کنسول پر از
 * ۴۰۴ و خطای hydration نشود.
 */
function nextMirrorFallback(req, res, urlPath) {
  if (urlPath.startsWith('/_next/image')) {
    try {
      const u = new URL(req.url || '/', 'http://local');
      const inner = u.searchParams.get('url') || '';
      // فقط مسیر داخلی مجاز است (جلوگیری از open redirect)
      if (inner.startsWith('/') && !inner.startsWith('//')) {
        res.writeHead(302, { location: inner });
        res.end();
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  if (urlPath.startsWith('/_next/data/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end('{}');
    return true;
  }
  return false;
}

function serveStatic(req, res, url) {
  if (nextMirrorFallback(req, res, url)) return;

  // اپ‌های استاتیک مستقرشده: /apps/<name>/...
  if (url.startsWith('/apps/')) {
    const parts = url.split('/').filter(Boolean); // ['apps', name, ...rest]
    const name = parts[1];
    if (!name) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>اپ‌های مستقرشده</title>
        <body style="font-family:system-ui;background:#0b0f14;color:#e7eef4;padding:40px">
        <h1>اپ‌های مستقرشده</h1><p style="color:#93a4b3">فهرست از <code>/api/apps</code> خوانده می‌شود.</p>
        <pre id="out" style="background:#060a0d;padding:16px;border-radius:12px;direction:ltr;min-height:120px"></pre>
        <script>fetch('/api/apps').then(r=>r.json()).then(d=>{document.getElementById('out').textContent=JSON.stringify(d.apps,null,2);})</script>
        </body></html>`);
    }
    const root = staticRoot(name);
    if (!root) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0f14;color:#e7eef4;padding:40px">
        <h1>اپ پیدا نشد</h1><p>برنامه‌ای با نام <code>${name}</code> در حال سرو استاتیک نیست.</p>
        <p><a style="color:#2ee6b0" href="/api/apps">فهرست اپ‌ها</a></p></body></html>`);
    }
    const rel = '/' + parts.slice(2).join('/');
    const file = resolveFile(root, rel === '/' ? '/index.html' : rel);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  if (url.startsWith('/test-projects')) {
    const rel = url.replace(/^\/test-projects/, '');
    const file = resolveFile(TEST_PROJECTS_DIR, rel);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  const isWidget = url.startsWith('/widget/');
  const isMock = url.startsWith('/panel') || url.startsWith('/mock');
  const isAgent = url.startsWith('/agent');
  const base = isWidget ? WIDGET_DIR : isAgent ? AGENT_DIR : isMock ? MOCK_DIR : PUBLIC_DIR;
  const rel = isWidget
    ? url.replace(/^\/widget/, '')
    : isAgent
      ? url.replace(/^\/agent/, '') || '/'
      : isMock
        ? url.startsWith('/panel')
          ? url
          : url.replace(/^\/mock/, '') || '/'
        : url;

  if (url === '/panel' || url === '/mock' || url === '/agent') {
    res.writeHead(301, { location: url + '/' });
    return res.end();
  }

  const aliases = {
    '/panel/tickets/create': '/panel/tickets/',
    '/panel/apps/create': '/panel/apps/new/',
  };
  if (aliases[url]) {
    res.writeHead(302, { location: aliases[url] });
    return res.end();
  }

  const file = resolveFile(base, rel);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>۴۰۴</title>
      <body style="font-family:system-ui;padding:48px;background:#f6f8fa;color:#1f2933">
      <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:26px">
      <h1 style="font-size:20px;margin:0 0 8px">این صفحه در محیط تست وجود ندارد</h1>
      <p style="color:#667085;font-size:13px;margin:0 0 14px">مسیر: <code dir="ltr">${url}</code></p>
      <p style="font-size:13px"><a href="/mock/" style="color:#009689">فهرست محیط تست</a> · <a href="/" style="color:#009689">صفحهٔ اصلی</a></p>
      </div></body></html>`,
    );
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': isWidget ? 'no-cache' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

/* ---------------- API ---------------- */

function withSession(body, res) {
  const session = getSession(body.sessionId);
  if (!session) {
    json(res, 404, { error: 'سشن پیدا نشد', code: 'no_session' });
    return null;
  }
  return session;
}

function deployState(session) {
  if (!session.deployRunId) return null;
  const run = getRun(session.deployRunId);
  if (!run) {
    // اجرا بعد از ری‌استارت از حافظه رفته؛ خلاصهٔ ذخیره‌شده را با همان شکل snapshot بده
    const s = session.deploySummary;
    if (!s) return { id: session.deployRunId, missing: true, status: 'unknown', steps: [], logs: [], events: [] };
    const status = s.status === 'success' ? 'done' : s.status === 'failed' ? 'error' : 'stopped';
    return {
      id: s.runId,
      appName: s.appName,
      url: s.url,
      status,
      index: s.total || 0,
      total: s.total || 0,
      steps: [],
      warnings: s.warnings || [],
      summary: s,
      logs: [],
      events: [],
      missing: true,
    };
  }
  const snap = snapshot(run, 0);
  return { ...snap, events: undefined, logs: snap.logs.slice(-40) };
}

/** اگر اجرای دیپلوی از حافظه رفته، سشن را از حالت «در حال دیپلوی» بیرون بیاور */
function reconcileSession(session) {
  if (session.deployRunId && !getRun(session.deployRunId)) {
    if (session.stage === 'deploying') {
      session.mode = session.deploySummary ? 'chat' : 'auto';
      session.stage = session.deploySummary ? 'chat' : 'ready';
    }
    session.deployRunId = null;
  }
}

async function routeApi(req, res, url, urlPath) {
  /* --- لاگ زنده (SSE) --- */
  if (urlPath.startsWith('/api/logs/') && req.method === 'GET') {
    const sid = urlPath.slice('/api/logs/'.length);
    const session = getSession(sid);
    if (!session) return json(res, 404, { error: 'سشن پیدا نشد' });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (entry) => res.write('data: ' + JSON.stringify({ t: 'log', entry }) + '\n\n');
    for (const entry of recent(sid, 80)) send(entry);
    const unsubscribe = subscribe(sid, send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      res.end();
    });
    return;
  }

  /* --- اپ‌های مستقرشده روی لوکال --- */
  if (urlPath === '/api/apps' && req.method === 'GET') {
    return json(res, 200, { apps: listDeployments() });
  }
  if (urlPath.startsWith('/api/apps/') && urlPath.endsWith('/stop') && req.method === 'POST') {
    const name = urlPath.slice('/api/apps/'.length, -'/stop'.length);
    const result = stopDeployment(name);
    return json(res, result.error ? 404 : 200, result);
  }

  /* --- سلامت --- */
  if (urlPath === '/api/health') {
    return json(res, 200, {
      ok: true,
      llm: llmStatus(),
      catalogVersion: PLAN_CATALOG.version,
      time: new Date().toISOString(),
    });
  }

  // بررسی فعال بودن کلید/سرویس مدل (درخواست واقعی به سرویس)
  if (urlPath === '/api/llm/check') {
    const probe = await checkProvider({ force: true });
    return json(res, probe.ok ? 200 : 502, { probe, llm: llmStatus() });
  }

  /* --- حساب، پلن و خرید --- */
  if (urlPath === '/api/plans' && req.method === 'GET') {
    return json(res, 200, { plans: plansList(), catalogVersion: PLAN_CATALOG.version });
  }

  if (urlPath === '/api/account' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      if (body.accountId) {
        const existing = getAccount(body.accountId);
        if (existing) {
          return json(res, 200, {
            account: publicAccount(existing),
            plan: planStatus(existing),
            created: false,
          });
        }
      }
      const { account, created } = createOrGet({ email: body.email, name: body.name });
      logLine('account', 'account', `حساب ${created ? 'ساخته' : 'بازیابی'} شد: ${account.email}`, 'ok');
      return json(res, 200, { account: publicAccount(account), plan: planStatus(account), created });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (urlPath.startsWith('/api/account/') && urlPath.endsWith('/plan') && req.method === 'POST') {
    const id = urlPath.slice('/api/account/'.length, -'/plan'.length);
    const body = await readJson(req);
    try {
      const result = purchase(id, body.planId, body.months);
      if (body.sessionId) {
        const session = getSession(body.sessionId);
        if (session) linkSession(session, id);
      }
      logLine(id, 'account', `خرید ثبت شد: ${result.plan.plan?.name || body.planId} — ${result.payment.amount} تومان`, 'ok');
      return json(res, 200, {
        account: publicAccount(result.account),
        plan: result.plan,
        payment: result.payment,
      });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (urlPath.startsWith('/api/account/') && req.method === 'GET') {
    const id = urlPath.slice('/api/account/'.length);
    const account = getAccount(id);
    if (!account) return json(res, 404, { error: 'حساب پیدا نشد' });
    return json(res, 200, { account: publicAccount(account), plan: planStatus(account) });
  }

  /* --- سشن --- */
  if (urlPath === '/api/session' && req.method === 'POST') {
    const body = await readJson(req);
    let session = getSession(body.sessionId);
    const isNew = !session;
    if (!session) {
      session = createSession();
      logLine(session.id, 'session', 'سشن جدید ساخته شد (بدون لاگین)', 'ok');
      await greet(session, () => {});
    }
    if (body.accountId) linkSession(session, body.accountId);
    reconcileSession(session);
    return json(res, 200, { sessionId: session.id, isNew, state: { ...sessionState(session), deploy: deployState(session) } });
  }

  if (urlPath.startsWith('/api/session/') && req.method === 'GET') {
    const id = urlPath.slice('/api/session/'.length);
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'سشن پیدا نشد' });
    reconcileSession(session);
    return json(res, 200, { state: { ...sessionState(session), deploy: deployState(session) } });
  }

  /* --- گفتگو / دکمه‌ها --- */
  if ((urlPath === '/api/chat' || urlPath === '/api/action') && req.method === 'POST') {
    const body = await readJson(req);
    const session = withSession(body, res);
    if (!session) return;
    const sse = startSse(res);
    try {
      sse.send({ t: 'meta', sessionId: session.id, mode: session.mode, stage: session.stage });
      if (urlPath === '/api/chat') await handleChat(session, body.text, sse.send);
      else await handleAction(session, body.action, body.payload || {}, sse.send);
      sse.send({
        t: 'state',
        state: {
          mode: session.mode,
          stage: session.stage,
          deploy: deployState(session),
          llm: llmStatus(),
          agent: sessionState(session).agent,
        },
      });
    } catch (e) {
      console.error('chat error:', e);
      sse.send({ t: 'error', message: 'خطای داخلی: ' + e.message });
    } finally {
      sse.end();
    }
    return;
  }

  /* --- تغییر صفحه --- */
  if (urlPath === '/api/context' && req.method === 'POST') {
    const body = await readJson(req);
    const session = withSession(body, res);
    if (!session) return;
    const events = [];
    handleContext(session, { path: body.path, title: body.title, headings: body.headings || [] }, (e) => events.push(e));
    return json(res, 200, { events, state: { mode: session.mode, stage: session.stage, guided: session.guided } });
  }

  /* --- آپلود zip --- */
  if (urlPath === '/api/intake' && req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const session = getSession(sessionId);
    if (!session) return json(res, 404, { error: 'سشن پیدا نشد' });

    let buffer;
    try {
      buffer = await readBody(req, MAX_UPLOAD);
    } catch (e) {
      return json(res, 413, { error: e.message });
    }
    if (!buffer.length) return json(res, 400, { error: 'فایل خالی است' });

    const rawName = req.headers['x-file-name'] || 'project.zip';
    let fileName = 'project.zip';
    try {
      fileName = decodeURIComponent(String(rawName));
    } catch {
      fileName = String(rawName);
    }
    try {
      const { analysis, entries } = analyzeFromZip(buffer, fileName);
      // سورس در فضای کاری همین سشن می‌ماند تا ایجنت بتواند بخواند/جست‌وجو/تغییر دهد
      const saved = saveProject(session.id, entries);
      const events = [];
      await handleAnalysis(session, (e) => events.push(e), { analysis, source: 'zip', fileName });
      return json(res, 200, { ok: true, events, analysis: summarizeForClient(analysis), workspace: saved });
    } catch (e) {
      return json(res, 400, { error: 'خواندن zip ناموفق بود: ' + e.message });
    }
  }

  /* --- گیت‌هاب --- */
  if (urlPath === '/api/intake/repo' && req.method === 'POST') {
    const body = await readJson(req);
    const session = withSession(body, res);
    if (!session) return;
    const sse = startSse(res);
    try {
      await importRepo(session, sse.send, body.url, 'github');
      sse.send({ t: 'state', state: { mode: session.mode, stage: session.stage, llm: llmStatus() } });
    } catch (e) {
      sse.send({ t: 'error', message: e.message });
    } finally {
      sse.end();
    }
    return;
  }

  /* --- فضای کاری پروژه (برای ابزارهای ایجنت و دانلود تغییرها) --- */
  if (urlPath.startsWith('/api/project/') && req.method === 'GET') {
    const rest = urlPath.slice('/api/project/'.length);
    const [sessionId, action] = rest.split('/');
    const session = getSession(sessionId);
    if (!session) return json(res, 404, { error: 'سشن پیدا نشد' });

    if (action === 'tree') return json(res, 200, { files: fileTree(session.id) });
    if (action === 'file') {
      const rel = url.searchParams.get('path') || '';
      try {
        return json(res, 200, { file: readWorkspaceFile(session.id, rel) });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (action === 'download') {
      const zip = exportZip(session.id);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="lia-project.zip"' });
      return res.end(zip);
    }
    return json(res, 404, { error: 'مسیر پروژه نامعتبر است' });
  }

  /* --- دیپلوی --- */
  if (urlPath.startsWith('/api/deploy/') && req.method === 'GET') {
    const id = urlPath.slice('/api/deploy/'.length);
    const run = getRun(id);
    if (!run) return json(res, 404, { error: 'اجرا پیدا نشد', code: 'run_gone' });
    const since = Number(url.searchParams.get('since') || 0);
    return json(res, 200, snapshot(run, since));
  }

  return json(res, 404, { error: 'مسیر API پیدا نشد', path: urlPath });
}

function summarizeForClient(a) {
  return {
    platform: a.platform,
    build: a.build,
    start: a.start,
    port: a.port,
    envKeys: a.envKeys,
    findings: a.findings,
    stats: a.stats,
  };
}

/* ---------------- سرور ---------------- */

/**
 * وقتی اجرای دیپلوی تمام شد، سشن به حالت چت می‌رود و یک پیام واقعی‌محور
 * (و چیپ‌های قدم بعد) ثبت می‌شود. ویجت با refresh، همان پیام‌ها را می‌بیند.
 */
onRunFinished((run, summary) => {
  const session = getSession(run.sessionId);
  if (!session) return;

  // حافظهٔ دیپلوی‌ها: تا دفعهٔ بعد بتوانیم «همین پروژه را دوباره دیپلوی کن» بدهیم
  if (summary?.status !== 'failed') {
    try {
      rememberDeployment({ session, run, summary });
    } catch (e) {
      console.error('registry error:', e.message);
    }
  }

  deployFinished(session, run, summary).catch((e) => console.error('deployFinished error:', e));
});

/**
 * شکست یک مرحله → ایجنت خودش وارد دیباگ می‌شود (تشخیص، کارت رفع، اعمال و تلاش دوباره).
 * عمداً اینجا ثبت می‌شود تا `deploy.mjs` به لایهٔ گفتگو وابسته نشود.
 */
onRunFailed((run, info) => {
  const session = getSession(run.sessionId);
  if (!session) return;
  deployFailed(session, run, info).catch((e) => console.error('deployFailed error:', e));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const urlPath = url.pathname;

  try {
    if (urlPath.startsWith('/api/')) return await routeApi(req, res, url, urlPath);
    return serveStatic(req, res, urlPath);
  } catch (e) {
    console.error('server error:', e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const info = llmInfo();
  console.log(`\n  لیا${info.demo ? ' (حالت دمو — کلید LLM تنظیم نشده)' : ` (مدل: ${info.model})`}\n`);
  console.log(`  سایت آینه‌شده : http://${HOST}:${PORT}/`);
  console.log(`  پنل جعلی     : http://${HOST}:${PORT}/panel/`);
  console.log(`  فهرست تست    : http://${HOST}:${PORT}/mock/`);
  console.log(`  سلامت API    : http://${HOST}:${PORT}/api/health\n`);

  // بررسی کلید مدل در پس‌زمینه (نتیجه در /api/health دیده می‌شود)
  checkProvider()
    .then((p) => {
      if (p.skipped) console.log('  مدل: کلید تنظیم نشده (حالت دمو)');
      else if (p.ok) console.log(`  مدل: آماده (${info.model})`);
      else console.log(`  مدل: در دسترس نیست — ${p.code || p.status}: ${p.message || ''}`);
    })
    .catch(() => {});
});
