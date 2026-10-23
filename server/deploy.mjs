/**
 * deploy.mjs — دیپلوی واقعی روی همین سیستم (لوکال‌هاست)
 *
 * به‌جای شبیه‌سازی، حالا واقعاً:
 *   ۱) سورس را در `.data/deployments/<app>/` کپی می‌کند
 *   ۲) وابستگی‌ها را نصب می‌کند (npm ci/install یا pip)
 *   ۳) بیلد می‌گیرد (npm run build اگر باشد)
 *   ۴) پروسه را روی یک پورت آزاد اجرا می‌کند (فقط 127.0.0.1)
 *   ۵) سلامت‌سنجی می‌کند و لینک واقعی `http://127.0.0.1:<port>` می‌دهد
 *
 * همان قواعد قبلی حفظ شده: هر مرحلهٔ مهم قبل از اجرا تأیید می‌گیرد، «نه» متوقف
 * می‌کند، و «فقط تا اینجا» هر کاری که انجام شده را نگه می‌دارد.
 *
 * هشدار: سورس کاربر روی همین سیستم اجرا می‌شود؛ فقط روی 127.0.0.1 گوش می‌دهد،
 * با تایم‌اوت و سقف لاگ، و با stop/rollback پروسه بسته می‌شود.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logLine } from './bus.mjs';
import { projectDir, hasProject } from './workspace.mjs';
import { planDeploy } from './planner.mjs';
import { dataPath } from './paths.mjs';
import { snapshotVersion } from './versions.mjs';

const DEPLOY_ROOT = dataPath('deployments');
const PORT_RANGE = [4310, 4399];
const LIMITS = {
  installMs: 240_000,
  buildMs: 300_000,
  healthMs: 60_000,
  maxLogLines: 400,
};

/**
 * حالت شبیه‌سازی برای تست/دمو: نصب و بیلد واقعی اجرا نمی‌شود، آدرس نهایی
 * `https://<app>.liara.run` است و اولین بیلد عمداً شکست می‌خورد تا جریان
 * «کارت باگ → رفع → موفقیت» قابل تست باشد.
 */
const SIMULATE = process.env.LIA_DEPLOY_SIMULATE === '1';

/** آیا دیپلوی شبیه‌سازی است؟ (برای برچسب‌زدن آدرس‌ها در UI) */
export function isSimulated() {
  return SIMULATE;
}

const runs = new Map();
const deployed = new Map();
const finishListeners = new Set();
const failListeners = new Set();
let seq = 0;

/** ثبت شنوندهٔ پایان اجرا (برای سوییچ سشن به حالت چت) */
export function onRunFinished(fn) {
  finishListeners.add(fn);
  return () => finishListeners.delete(fn);
}

function notifyFinished(run) {
  if (run.notified) return;
  run.notified = true;
  for (const fn of finishListeners) {
    try {
      fn(run, run.summary);
    } catch (e) {
      console.error('deploy listener error:', e.message);
    }
  }
}

/** ثبت شنوندهٔ شکست یک مرحله (برای دیباگ خودکار ایجنت) */
export function onRunFailed(fn) {
  failListeners.add(fn);
  return () => failListeners.delete(fn);
}

function notifyFailed(run, info) {
  for (const fn of failListeners) {
    try {
      fn(run, info);
    } catch (e) {
      console.error('deploy fail listener error:', e.message);
    }
  }
}

const now = () => Date.now();
const seqn = () => ++seq;

function emit(run, type, payload = {}) {
  const event = { n: seqn(), at: now(), type, ...payload };
  run.events.push(event);
  if (run.events.length > 800) run.events.shift();
  return event;
}

function log(run, text, level = 'dim', stepId = null) {
  const line = String(text ?? '').replace(/\r/g, '').slice(0, 2000);
  if (!line.trim()) return;
  run.logs.push({ at: now(), level, text: line, stepId });
  if (run.logs.length > LIMITS.maxLogLines) run.logs.shift();
  emit(run, 'log', { level, text: line, stepId });
  logLine(run.sessionId, 'deploy', line, level);
}

function slugify(name) {
  const base = String(name || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return base || 'app';
}

/* ---------------- پورت آزاد ---------------- */

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  const used = new Set([...deployed.values()].map((d) => d.port).filter(Boolean));
  for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) {
    if (used.has(p)) continue;
    if (await portFree(p)) return p;
  }
  throw new Error('پورت آزادی در بازهٔ ۴۳۱۰–۴۳۹۹ پیدا نشد');
}

/* ---------------- پروسه ---------------- */

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

/** اگر همین برنامه قبلاً بالا آمده، اول ببند تا پورت/پروسه تکراری نماند */
function killExisting(appName) {
  const prev = deployed.get(appName);
  if (!prev) return;
  killTree(prev.child);
  prev.status = 'stopped';
}

/** آیا چیزی روی این پورت گوش می‌دهد؟ */
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(400, () => done(false));
  });
}

/** تا آزادشدن پورت صبر می‌کند (kill در ویندوز async است) */
async function waitPortFree(port, ms = 5000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (!(await portInUse(port))) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function runCommand(run, command, args, { cwd, env, timeoutMs, stepId }) {
  return new Promise((resolve) => {
    const started = now();
    let output = '';
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        shell: process.platform === 'win32',
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      return resolve({ code: -1, output: e.message, ms: 0 });
    }

    run.children = run.children || [];
    run.children.push(child);

    const timer = setTimeout(() => {
      log(run, `⏱ زمان مجاز تمام شد؛ متوقف شد: ${command} ${args.join(' ')}`, 'err', stepId);
      killTree(child);
    }, timeoutMs);

    const onData = (chunk, isErr) => {
      const text = chunk.toString('utf8');
      output += text;
      if (output.length > 40_000) output = output.slice(-40_000);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) log(run, line, isErr ? 'err' : 'dim', stepId);
      }
    };
    child.stdout?.on('data', (d) => onData(d, false));
    child.stderr?.on('data', (d) => onData(d, true));

    child.on('error', (e) => {
      clearTimeout(timer);
      log(run, `خطا در اجرای دستور: ${e.message}`, 'err', stepId);
      resolve({ code: -1, output: output + '\n' + e.message, ms: now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output, ms: now() - started });
    });
  });
}

/* ---------------- HTTP سلامت ---------------- */

async function httpCheck(url, timeoutMs = 5000) {
  try {
    const target = url.startsWith('http') ? url : `http://127.0.0.1:${process.env.PORT || 4173}${url}`;
    const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function waitHealthy(run, url, timeoutMs) {
  const started = now();
  let last = '';
  while (now() - started < timeoutMs) {
    const res = await httpCheck(url);
    if (res.ok) return { ok: true, status: res.status, ms: now() - started };
    last = res.error || `HTTP ${res.status}`;
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ok: false, error: last, ms: now() - started };
}

/* ---------------- گام‌ها (تصمیم پویا) ---------------- */

export function createRun({ session, analysis, plan, needsDb, reuse = null, only = null }) {
  // نام اپ: نام پکیج پروژه → نامی که کاربر گفته → نام فایل zip → پیش‌فرض
  const intakeName = String(session.intake?.name || '');
  const fromFile = /^[\w.\- ]+\.zip$/i.test(intakeName) ? intakeName.replace(/\.zip$/i, '') : '';
  const appName = slugify(
    reuse?.appName || analysis?.packageName || session.requirement?.appName || fromFile || 'lia-app',
  );
  const deployment = planDeploy({
    analysis: reuse?.analysis || analysis,
    requirement: session.requirement || {},
    reuse: !!reuse,
    needsDb,
    only,
  });

  const run = {
    id: 'run_' + crypto.randomUUID().slice(0, 8),
    sessionId: session.id,
    appName,
    // آدرس عمومی: در شبیه‌سازی یک برچسب، در اجرای واقعی مسیر پیش‌نمایش روی همین دامنه
    url: SIMULATE ? `https://${appName}.liara.run` : `/apps/${appName}/`,
    createdAt: now(),
    status: 'created',
    steps: deployment.steps,
    skipped: deployment.skipped,
    planNotes: deployment.notes,
    planSummary: deployment.summary,
    reuse: reuse ? { appName: reuse.appName, dir: reuse.dir, fingerprint: reuse.fingerprint || null } : null,
    index: 0,
    logs: [],
    events: [],
    pendingApproval: null,
    bug: null,
    warnings: [],
    summary: null,
    children: [],
    notified: false,
    buildAttempts: 0,
    fixed: [],
    internal: {
      analysis: reuse?.analysis || analysis,
      plan,
      needsDb: !!needsDb,
      dir: reuse?.dir || null,
      port: null,
      staticDir: null,
      startCommand: null,
      fingerprint: reuse?.fingerprint || session.projectFingerprint || null,
    },
  };
  runs.set(run.id, run);
  return run;
}

export function getRun(id) {
  return runs.get(id) || null;
}

function stepById(run, id) {
  return run.steps.find((s) => s.id === id) || null;
}

function setPending(run, step) {
  run.status = 'awaiting_approval';
  run.index = run.steps.indexOf(step);
  run.pendingApproval = {
    stepId: step.id,
    index: run.index,
    total: run.steps.length,
    title: step.title,
    detail: step.detail,
    effect: step.effect,
  };
  emit(run, 'approval', { approval: run.pendingApproval });
}

export function advance(run) {
  if (!run || ['stopped', 'done', 'awaiting_fix', 'error'].includes(run.status)) return snapshot(run);

  while (run.index < run.steps.length) {
    const step = run.steps[run.index];
    if (step.done) {
      run.index += 1;
      continue;
    }
    if (step.approval) {
      setPending(run, step);
      return snapshot(run);
    }
    executeStep(run, step);
    return snapshot(run);
  }
  finish(run);
  return snapshot(run);
}

function executeStep(run, step) {
  run.status = 'running';
  emit(run, 'step_start', { stepId: step.id, title: step.title });
  log(run, `▶ ${step.title}`, 'ok', step.id);

  const handler = STEP_HANDLERS[step.id];
  setTimeout(async () => {
    try {
      const result = await handler(run, step);
      if (result?.failed) {
        // مرحله انجام نشد؛ نشانگر مرحله روی همان گام می‌ماند (نه گام بعد)
        step.done = false;
        run.index = run.steps.indexOf(step);
        return;
      }
      step.done = true;
      step.finishedAt = now();
      emit(run, 'step_done', { stepId: step.id });
      run.index += 1;
      if (run.index >= run.steps.length) return finish(run);
      advance(run);
    } catch (e) {
      log(run, `✗ ${step.title}: ${e.message}`, 'err', step.id);
      fail(run, step, e.message);
    }
  }, 60);
}

function fail(run, step, message) {
  run.status = 'error';
  run.warnings.push(`${step.title} انجام نشد: ${message}`);
  run.summary = {
    status: 'failed',
    url: run.url,
    appName: run.appName,
    steps: run.steps.filter((s) => s.done).length,
    warnings: run.warnings,
    stoppedAt: step.title,
    error: message.slice(0, 400),
    fixed: run.fixed,
    local: !SIMULATE,
  };
  emit(run, 'failed', { summary: run.summary });
  emit(run, 'done', { summary: run.summary });
  notifyFinished(run);
  notifyFailed(run, {
    stepId: step.id,
    stepTitle: step.title,
    error: String(message || '').slice(0, 1600),
    logTail: tailLines(run.logs.map((l) => l.text).join('\n'), 16),
    fatal: true,
  });
}

function finish(run) {
  run.status = 'done';
  run.pendingApproval = null;
  run.summary = {
    status: 'success',
    url: run.url,
    appName: run.appName,
    port: run.internal.port || null,
    steps: run.steps.filter((s) => s.done).length,
    total: run.steps.length,
    warnings: run.warnings,
    fixed: run.fixed,
    reused: !!run.reuse,
    skipped: (run.skipped || []).length,
    local: !SIMULATE,
    simulated: SIMULATE,
  };
  log(run, `✓ دیپلوی کامل شد: ${run.url}`, 'ok');
  emit(run, 'done', { summary: run.summary });
  notifyFinished(run);
}

/* ---------------- کپی سورس (مشترک بین upload و تلاش دوباره) ---------------- */

/** سورس سشن را در فضای استقرار کپی می‌کند (بدون node_modules/.git/خروجی بیلد). */
function syncSource(run) {
  const src = projectDir(run.sessionId);
  const dest = run.internal.dir;
  fs.mkdirSync(dest, { recursive: true });
  let files = 0;
  let bytes = 0;
  const copy = (from, to) => {
    for (const item of fs.readdirSync(from, { withFileTypes: true })) {
      if (['node_modules', '.git', '.next', 'dist', 'build'].includes(item.name)) continue;
      const s = path.join(from, item.name);
      const d = path.join(to, item.name);
      if (item.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copy(s, d);
      } else {
        fs.copyFileSync(s, d);
        files += 1;
        bytes += fs.statSync(s).size;
      }
    }
  };
  copy(src, dest);
  return { files, bytes };
}

/* ---------------- هندلر هر مرحله ---------------- */

const STEP_HANDLERS = {
  async preflight(run) {
    // دیپلوی مجدد: سورس در فضای استقرار قبلی است، نه در فضای کاری
    if (run.reuse) {
      if (!run.internal.dir || !fs.existsSync(run.internal.dir)) {
        throw new Error('فضای استقرار قبلی پیدا نشد؛ پروژه را دوباره آپلود کن');
      }
      const items = fs.readdirSync(run.internal.dir).filter((n) => n !== 'node_modules');
      log(run, `استفاده از فضای قبلی «${run.reuse.appName}» — ${items.length} مورد`, 'ok');
      if (SIMULATE) {
        run.internal.port = run.internal.analysis?.port || 3000;
        run.url = `https://${run.appName}.liara.run`;
        log(run, `حالت شبیه‌سازی: آدرس نهایی ${run.url}`, 'ok');
        return;
      }
      const reusePort = await pickPort();
      run.internal.port = reusePort;
      run.url = `http://127.0.0.1:${reusePort}`;
      log(run, `پورت آزاد انتخاب شد: ${reusePort}`, 'ok');
      return;
    }

    const src = projectDir(run.sessionId);
    if (!fs.existsSync(src)) throw new Error('سورس پروژه پیدا نشد؛ اول zip را آپلود کن');
    const files = fs.readdirSync(src);
    if (!files.length) throw new Error('پوشهٔ پروژه خالی است');
    log(run, `سورس: ${files.length} مورد — ${files.slice(0, 6).join(', ')}${files.length > 6 ? '…' : ''}`);

    if (SIMULATE) {
      run.internal.port = run.internal.analysis?.port || 3000;
      run.url = `https://${run.appName}.liara.run`;
      log(run, `حالت شبیه‌سازی: آدرس نهایی ${run.url}`, 'ok');
      return;
    }

    const port = await pickPort();
    run.internal.port = port;
    // آدرس عمومی (قابل کلیک) از روی همین دامنه؛ خود آدرس داخلی برای سلامت‌سنجی
    run.internal.healthUrl = `http://127.0.0.1:${port}`;
    run.url = `/apps/${run.appName}/`;
    log(run, `پورت داخلی ${port} — پیش‌نمایش عمومی: ${run.url}`, 'ok');
  },

  async 'create-app'(run) {
    const dir = path.join(DEPLOY_ROOT, run.appName);
    fs.mkdirSync(dir, { recursive: true });
    run.internal.dir = dir;
    log(run, `فضای برنامه: ${path.relative(process.cwd(), dir)}`, 'ok');
  },

  async upload(run) {
    const stats = syncSource(run);
    log(run, `✓ ${stats.files} فایل (${Math.round(stats.bytes / 1024)}KB) کپی شد`, 'ok');
  },

  async envs(run) {
    const dest = run.internal.dir;
    const analysis = run.internal.analysis || {};
    const lines = ['NODE_ENV=production', `PORT=${run.internal.port}`];
    for (const key of analysis.envKeys || []) {
      if (['NODE_ENV', 'PORT'].includes(key)) continue;
      lines.push(`${key}=`);
    }
    fs.writeFileSync(path.join(dest, '.env'), lines.join('\n') + '\n', 'utf8');
    log(run, `متغیرها: ${lines.join('، ')}`, 'dim');
    log(run, '✓ فایل .env ساخته شد (مقادیر محرمانه را باید پر کنی)', 'ok');
  },

  async install(run) {
    if (SIMULATE) {
      log(run, 'حالت شبیه‌سازی: نصب وابستگی‌ها رد شد', 'dim');
      return;
    }
    const dir = run.internal.dir;
    const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
    const hasReq = fs.existsSync(path.join(dir, 'requirements.txt'));

    if (hasPkg) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const depCount = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
      if (depCount === 0) {
        log(run, 'package.json وابستگی‌ای ندارد؛ نصب لازم نیست', 'dim');
        return;
      }
      const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
      const args = hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
      log(run, `npm ${args.join(' ')}`, 'dim');
      const res = await runCommand(run, 'npm', args, { cwd: dir, timeoutMs: LIMITS.installMs, stepId: 'install' });
      if (res.code !== 0) throw new Error(`npm نصب نشد (کد ${res.code})`);
      log(run, `✓ وابستگی‌ها نصب شد (${Math.round(res.ms / 1000)}s)`, 'ok');
      return;
    }

    if (hasReq) {
      log(run, 'pip install -r requirements.txt', 'dim');
      const res = await runCommand(run, 'python', ['-m', 'pip', 'install', '-r', 'requirements.txt', '--disable-pip-version-check'], {
        cwd: dir,
        timeoutMs: LIMITS.installMs,
        stepId: 'install',
      });
      if (res.code !== 0) log(run, 'نصب پکیج‌های پایتون ناموفق بود؛ با استاندارد ادامه می‌دهم', 'err');
      else log(run, '✓ پکیج‌های پایتون نصب شد', 'ok');
      return;
    }

    log(run, 'وابستگی‌ای اعلام نشده؛ این مرحله رد شد', 'dim');
  },

  async build(run, step) {
    if (SIMULATE) {
      run.buildAttempts = (run.buildAttempts || 0) + 1;
      log(run, 'npm run build (شبیه‌سازی)', 'dim', step.id);
      if (run.buildAttempts === 1) {
        const detail =
          "Error: next build failed — خروجی standalone تنظیم نشده و مسیر اجرای برنامه پیدا نشد (این خطا در حالت شبیه‌سازی عمدی است تا جریان «رفع باگ» قابل تست باشد).";
        log(run, '✗ ' + detail, 'err', step.id);
        run.status = 'awaiting_fix';
        run.buildFailed = true;
        run.bug = {
          title: 'بیلد شکست خورد',
          reason: 'خروجی بیلد خطا داد. می‌توانی دوباره تلاش کنی یا از بیلد رد شوی و برنامه را اجرا کنم.',
          retryable: true,
          findings: [{ title: 'خطای بیلد', severity: 'high', detail, fix: 'تلاش دوباره بعد از بررسی لاگ' }],
          ask: 'دوباره تلاش کنم یا رد شوم و برنامه را اجرا کنم؟',
        };
        emit(run, 'bug', { bug: run.bug });
        log(run, '✗ بیلد شکست خورد — منتظر تصمیم تو', 'err', step.id);
        notifyFailed(run, { stepId: step.id, stepTitle: step.title, error: detail, logTail: detail, fatal: false });
        return { failed: true };
      }
      run.fixed.push('خطای بیلد بعد از بررسی لاگ برطرف شد');
      log(run, '✓ بیلد موفق (شبیه‌سازی)', 'ok', step.id);
      return;
    }
    const dir = run.internal.dir;
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      log(run, 'package.json نیست؛ بیلد لازم نیست', 'dim');
      return;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.scripts?.build) {
      log(run, 'اسکریپت build ندارد؛ رد شد', 'dim');
      return;
    }

    log(run, 'npm run build', 'dim');
    const res = await runCommand(run, 'npm', ['run', 'build'], { cwd: dir, timeoutMs: LIMITS.buildMs, stepId: 'build' });
    if (res.code !== 0) {
      run.status = 'awaiting_fix';
      run.buildFailed = true;
      run.bug = {
        title: 'بیلد شکست خورد',
        reason: 'خروجی بیلد خطا داد. می‌توانی دوباره تلاش کنی یا از بیلد رد شوی و برنامه را اجرا کنم.',
        retryable: true,
        findings: [
          { title: 'خطای بیلد', severity: 'high', detail: tailLines(res.output, 12), fix: 'تلاش دوباره بعد از بررسی لاگ' },
        ],
        ask: 'دوباره تلاش کنم یا رد شوم و برنامه را اجرا کنم؟',
      };
      emit(run, 'bug', { bug: run.bug });
      log(run, '✗ بیلد شکست خورد — منتظر تصمیم تو', 'err', step.id);
      notifyFailed(run, {
        stepId: step.id,
        stepTitle: step.title,
        error: tailLines(res.output, 20),
        logTail: tailLines(res.output, 20),
        fatal: false,
      });
      return { failed: true };
    }
    log(run, `✓ بیلد موفق (${Math.round(res.ms / 1000)}s)`, 'ok');
  },

  async start(run) {
    const dir = run.internal.dir;
    const port = run.internal.port;
    const analysis = run.internal.analysis || {};

    if (SIMULATE) {
      // جای پروسهٔ واقعی: همان مسیر عادی ولی بدون spawn
      killExisting(run.appName);
      deployed.set(run.appName, {
        name: run.appName,
        dir,
        port,
        url: run.url,
        status: 'running',
        child: null,
        startedAt: now(),
        runId: run.id,
        staticDir: null,
      });
      log(run, `✓ (شبیه‌سازی) برنامه روی ${run.url} بالا آمد`, 'ok');
      return;
    }

    const pkgPath = path.join(dir, 'package.json');
    const isNext = analysis.platform === 'nextjs';
    const isPython = ['python-script', 'flask', 'django'].includes(analysis.platform);

    let command;
    let args;

    if (isPython) {
      const entry = ['app.py', 'main.py', 'web.py', 'server.py'].find((f) => fs.existsSync(path.join(dir, f)));
      command = 'python';
      args = entry ? [entry] : ['-m', 'http.server', String(port), '--bind', '127.0.0.1'];
    } else if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.start) {
        command = 'npm';
        args = isNext ? ['start', '--', '-p', String(port)] : ['start'];
      } else if (pkg.main) {
        command = 'node';
        args = [pkg.main];
      } else if (fs.existsSync(path.join(dir, 'index.js'))) {
        command = 'node';
        args = ['index.js'];
      } else {
        command = 'npm';
        args = ['start'];
      }
    } else if (fs.existsSync(path.join(dir, 'index.html'))) {
      // استاتیک: همان سرور خودمان فایل‌ها را سرو می‌کند
      run.internal.staticDir = dir;
      run.url = `/apps/${run.appName}/`;
      deployed.set(run.appName, {
        name: run.appName,
        dir,
        port: null,
        url: run.url,
        status: 'running',
        child: null,
        startedAt: now(),
        runId: run.id,
        staticDir: dir,
      });
      log(run, `✓ سرو استاتیک از ${run.url}`, 'ok');
      return;
    } else {
      throw new Error('ورودی قابل اجرا پیدا نشد (package.json / app.py / index.html)');
    }

    log(run, `اجرا: ${command} ${args.join(' ')} (PORT=${port})`, 'dim');
    killExisting(run.appName);
    const child = spawn(command, args, {
      cwd: dir,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
      shell: process.platform === 'win32',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    run.children = run.children || [];
    run.children.push(child);

    child.stdout?.on('data', (d) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) if (line.trim()) log(run, line, 'dim', 'start');
    });
    child.stderr?.on('data', (d) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) if (line.trim()) log(run, line, 'err', 'start');
    });
    child.on('exit', (code) => {
      log(run, `پروسه با کد ${code} بسته شد`, code === 0 ? 'dim' : 'err', 'start');
      const dep = deployed.get(run.appName);
      if (dep && dep.child === child) dep.status = 'stopped';
    });

    deployed.set(run.appName, {
      name: run.appName,
      dir,
      port,
      url: run.url,
      status: 'starting',
      child,
      startedAt: now(),
      runId: run.id,
      staticDir: null,
    });
    run.internal.startCommand = `${command} ${args.join(' ')}`;
    log(run, `✓ پروسه اجرا شد (pid ${child.pid}) روی ${run.url}`, 'ok');
  },

  async health(run) {
    if (SIMULATE) {
      const dep = deployed.get(run.appName);
      if (dep) dep.status = 'running';
      log(run, `✓ سلامت‌سنجی (شبیه‌سازی): HTTP 200 — ${run.url}`, 'ok');
      return;
    }
    const dep = deployed.get(run.appName);
    if (run.internal.staticDir) {
      if (dep) dep.status = 'running';
      log(run, `✓ سرو استاتیک آماده است: ${run.url}`, 'ok');
      return;
    }
    const check = await waitHealthy(run, run.internal.healthUrl || run.url, LIMITS.healthMs);
    if (!check.ok) {
      throw new Error(`برنامه در ${Math.round(LIMITS.healthMs / 1000)}s پاسخ نداد (${check.error || 'بدون پاسخ'})`);
    }
    if (dep) dep.status = 'running';
    log(run, `✓ سلامت‌سنجی: HTTP ${check.status} در ${Math.round(check.ms / 1000)}s`, 'ok');
  },
};

function tailLines(text, n) {  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).join('\n').slice(0, 1200);
}

/* ---------------- تأیید / رد / توقف ---------------- */

export function approve(run, stepId) {
  const approval = run.pendingApproval;
  if (!approval || approval.stepId !== stepId) return { error: 'این مرحله در انتظار تأیید نیست' };
  run.pendingApproval = null;
  const step = stepById(run, stepId);
  emit(run, 'approved', { stepId });
  log(run, `✓ تأیید شد: ${step.title}`, 'ok', stepId);
  executeStep(run, step);
  return snapshot(run);
}

export function reject(run, stepId) {
  if (!run.pendingApproval || run.pendingApproval.stepId !== stepId) return { error: 'این مرحله در انتظار تأیید نیست' };
  const step = stepById(run, stepId);
  run.pendingApproval = null;
  run.status = 'stopped';
  run.warnings.push(`مرحلهٔ «${step.title}» انجام نشد (به خواست تو).`);
  run.summary = {
    status: 'stopped',
    url: run.url,
    appName: run.appName,
    steps: run.steps.filter((s) => s.done).length,
    total: run.steps.length,
    warnings: run.warnings,
    fixed: run.fixed,
    stoppedAt: step.title,
    local: !SIMULATE,
  };
  log(run, `متوقف شد: «${step.title}» را انجام ندادم.`, 'err', step.id);
  emit(run, 'done', { summary: run.summary });
  notifyFinished(run);
  return snapshot(run);
}

export function stopHere(run) {
  run.pendingApproval = null;
  run.status = 'stopped';
  run.summary = {
    status: 'stopped_by_user',
    url: run.url,
    appName: run.appName,
    steps: run.steps.filter((s) => s.done).length,
    total: run.steps.length,
    warnings: run.warnings,
    fixed: run.fixed,
    note: 'به خواست تو همین‌جا متوقف شد.',
    local: !SIMULATE,
  };
  log(run, 'به خواست تو همین‌جا متوقف شد.', 'err');
  emit(run, 'done', { summary: run.summary });
  notifyFinished(run);
  return snapshot(run);
}

/** تلاش دوبارهٔ بیلد (accept) یا رد شدن از بیلد (deny) */
export function fixBug(run, accept) {
  if (run.status !== 'awaiting_fix') return { error: 'در وضعیت انتظار رفع باگ نیست' };
  run.bug = null;
  run.pendingApproval = null;

  const build = stepById(run, 'build');
  if (!build) return snapshot(run);

  if (accept) {
    run.status = 'running';
    build.done = false;
    run.index = run.steps.indexOf(build);
    log(run, 'تلاش دوبارهٔ بیلد…', 'dim', 'build');
    executeStep(run, build);
  } else {
    run.warnings.push('از بیلد رد شدیم؛ برنامه بدون خروجی بیلد اجرا می‌شود.');
    build.done = true;
    run.index = run.steps.indexOf(build) + 1;
    log(run, 'از بیلد رد شدم؛ سراغ اجرای برنامه می‌روم.', 'warn', 'build');
    advance(run);
  }
  return snapshot(run);
}

/* ---------------- تلاش دوبارهٔ مرحله (دیباگ خودکار) ---------------- */

/**
 * بعد از رفع خطا، همان مرحله را دوباره اجرا می‌کند.
 *
 * @param {object} run
 * @param {string} stepId
 * @param {{newPort?:boolean, skipStep?:boolean, sync?:boolean}} opts
 *   newPort: پورت تازه انتخاب شود (برای EADDRINUSE)
 *   skipStep: از این مرحله رد شو (مثلاً بیلد لازم نیست)
 *   sync: سورس فضای کاری دوباره کپی شود (پیش‌فرض بله)
 */
export async function retryStep(run, stepId, opts = {}) {
  if (!run) return { error: 'اجرا پیدا نشد' };
  const step = stepById(run, stepId);
  if (!step) return { error: 'این مرحله در این اجرا نیست' };
  if (['done', 'stopped'].includes(run.status)) return { error: 'این اجرا بسته شده است' };

  run.attempts = run.attempts || {};
  const tries = run.attempts[stepId] || 0;
  if (tries >= 4) {
    log(run, `✗ بعد از ۴ تلاش، «${step.title}» درست نشد — متوقف می‌کنم`, 'err', stepId);
    return { error: 'سقف تلاش دوباره پر شد' };
  }
  run.attempts[stepId] = tries + 1;

  run.bug = null;
  run.pendingApproval = null;
  run.status = 'running';
  step.done = false;
  run.index = run.steps.indexOf(step);

  // وصله‌ها در فضای کاری نوشته شده‌اند؛ باید به فضای استقرار هم برسند.
  // در دیپلوی مجدد اگر فضای کاری‌ای نباشد، فضای استقرار خودش منبع است.
  if (opts.sync !== false && run.internal?.dir && hasProject(run.sessionId)) {
    try {
      syncSource(run);
      log(run, 'سورس تازه در فضای استقرار کپی شد', 'dim', stepId);
    } catch (e) {
      log(run, 'کپی سورس ناموفق بود: ' + e.message, 'warn', stepId);
    }
  }

  if (opts.newPort) {
    try {
      const p = await pickPort();
      run.internal.port = p;
      if (!SIMULATE) run.url = `http://127.0.0.1:${p}`;
      log(run, `پورت تازه: ${p}`, 'dim', stepId);
    } catch {
      /* با همان پورت قبلی ادامه بده */
    }
  }

  if (opts.skipStep) {
    step.done = true;
    step.skipped = true;
    run.index = run.steps.indexOf(step) + 1;
    log(run, `از «${step.title}» رد شدم`, 'warn', stepId);
    emit(run, 'step_done', { stepId: step.id });
    advance(run);
    return snapshot(run);
  }

  log(run, `تلاش دوباره (${tries + 2}): ${step.title}`, 'warn', stepId);
  executeStep(run, step);
  return snapshot(run);
}

/* ---------------- اعمال کد تازه روی اپ در حال اجرا ---------------- */

/**
 * سورس تازهٔ فضای کاری را روی اپ در حال اجرا اعمال می‌کند:
 * کپی → بیلد (اگر مرحله داشته باشد) → ری‌استارت → سلامت‌سنجی.
 * برای «بعد از دیپلوی هم بتوانم کد را عوض کنم» لازم است.
 */
export async function restartWithCurrentSource(run) {
  if (!run) throw new Error('اجرای دیپلوی پیدا نشد؛ اول یک‌بار دیپلوی کن.');
  if (SIMULATE) {
    run.logs = run.logs || [];
    log(run, `↻ سورس تغییریافته بازخوانی شد`, 'dim');
    log(run, `↻ بیلد و اجرای نسخهٔ جدید با موفقیت اعمال گردید`, 'ok');
    log(run, `✓ نسخهٔ جدید آنلاین است: ${run.url}`, 'ok');
    run.status = 'done';
    return snapshot(run);
  }
  if (!run.internal?.dir) throw new Error('فضای استقرار این اپ پیدا نشد.');
  if (!hasProject(run.sessionId)) throw new Error('سورس پروژه در فضای کاری نیست.');

  // نسخهٔ فعلی (قبل از تغییر) نگه داشته می‌شود تا بشود برگشت
  const before = snapshotVersion(run.appName, run.internal.dir, 'before-apply');
  if (before) log(run, `نسخهٔ قبلی ذخیره شد (${before.files} فایل)`, 'dim');

  const stats = syncSource(run);
  log(run, `↻ ${stats.files} فایل تازه روی فضای استقرار کپی شد`, 'ok');

  const hasBuild = run.steps.some((s) => s.id === 'build');
  if (hasBuild) await STEP_HANDLERS.build(run, { id: 'build', title: 'بیلد پروژه' });

  killExisting(run.appName);
  deployed.delete(run.appName);
  const freed = await waitPortFree(run.internal.port);
  if (!freed) {
    // اگر پروسهٔ قبلی پورت را نگه داشته، با پورت تازه بالا می‌آید
    const fresh = await pickPort();
    log(run, `پورت قبلی آزاد نشد؛ پورت تازه: ${fresh}`, 'warn');
    run.internal.port = fresh;
    run.internal.healthUrl = `http://127.0.0.1:${fresh}`;
  }
  await STEP_HANDLERS.start(run, { id: 'start', title: 'اجرای برنامه' });
  await STEP_HANDLERS.health(run, { id: 'health', title: 'سلامت‌سنجی' });

  run.status = 'done';
  log(run, `✓ کد تازه اعمال شد: ${run.url}`, 'ok');
  return snapshot(run);
}

/** اجرای دیپلوی مربوط به یک اپ زنده (برای API) */
export function getRunByApp(name) {
  const dep = deployed.get(name);
  return dep?.runId ? runs.get(dep.runId) || null : null;
}

/* ---------------- مدیریت اپ‌های مستقرشده ---------------- */

export function listDeployments() {
  return [...deployed.values()].map((d) => ({
    name: d.name,
    url: d.url,
    port: d.port ?? null,
    status: d.status,
    startedAt: d.startedAt,
    static: !!d.staticDir,
    simulated: SIMULATE,
    runId: d.runId,
  }));
}

export function deploymentInfo(name) {
  const dep = deployed.get(name);
  if (!dep) return null;
  return { name: dep.name, port: dep.port ?? null, status: dep.status, staticDir: dep.staticDir || null, url: dep.url };
}

export function stopDeployment(name) {
  const dep = deployed.get(name);
  if (!dep) return { error: 'برنامه‌ای با این نام در حال اجرا نیست' };
  killTree(dep.child);
  dep.status = 'stopped';
  return { ok: true, name };
}

export function staticRoot(name) {
  const dep = deployed.get(name);
  return dep?.staticDir || null;
}

export function shutdownAll() {
  for (const dep of deployed.values()) killTree(dep.child);
  for (const run of runs.values()) for (const child of run.children || []) killTree(child);
}

process.on('exit', shutdownAll);
process.on('SIGINT', () => {
  shutdownAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdownAll();
  process.exit(0);
});

/* ---------------- خروجی برای کلاینت ---------------- */

export function snapshot(run, since = 0) {
  return {
    id: run.id,
    appName: run.appName,
    url: run.url,
    status: run.status,
    index: run.index,
    total: run.steps.length,
    steps: run.steps.map((s) => ({ id: s.id, title: s.title, done: !!s.done, current: run.index === run.steps.indexOf(s) })),
    skipped: run.skipped || [],
    reused: !!run.reuse,
    planSummary: run.planSummary || null,
    pendingApproval: run.pendingApproval,
    bug: run.status === 'awaiting_fix' ? run.bug : null,
    repair: run.repair || null,
    logs: run.logs.slice(-100),
    events: run.events.filter((e) => e.n > since),
    lastEvent: run.events.length ? run.events[run.events.length - 1].n : 0,
    summary: run.summary,
    warnings: run.warnings,
    local: true,
  };
}

/** نتیجهٔ تشخیص ایجنت را روی اجرا می‌گذارد تا ویجت هم (از طریق polling) ببیندش */
export function setRepair(run, repair) {
  if (!run) return;
  run.repair = repair;
}

export function attachBug(run, findings) {  run.bug = {
    title: 'مشکل در پروژه',
    reason: 'چند مورد در پروژه پیدا شد که ممکن است روی اجرا اثر بگذارد.',
    findings: (findings || []).slice(0, 3).map((f) => ({
      title: f.title,
      severity: f.severity,
      detail: f.detail,
      fix: f.fix,
      file: f.file,
    })),
    ask: 'ادامه بدهم؟',
  };
  return run.bug;
}
