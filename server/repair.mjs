/**
 * repair.mjs — «وارد عمل شدن» ایجنت وقتی دیپلوی می‌شکند
 *
 * سه کار می‌کند:
 *   ۱) **تشخیص**: از پیام خطا، لاگ مرحله و فایل‌های پروژه، علت‌های محتمل را درمی‌آورد.
 *   ۲) **نسخهٔ رفع**: برای هر علت یک «وصله» می‌سازد — تغییر فایل، اجرای دستور،
 *      یا تلاش دوباره با پورت تازه.
 *   ۳) **اعمال**: وصله‌ها را روی نسخهٔ کاری پروژه می‌نویسد/اجرا می‌کند.
 *
 * قاعدهٔ مهم: این ماژول قطعی است و هیچ توکنی مصرف نمی‌کند. اگر هیچ وصله‌ای پیدا
 * نشد، orchestrator سراغ مدل می‌رود تا خودش کد را بخواند و تغییر بدهد.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readFile, writeFile, listFiles, buildDiff, projectDir } from './workspace.mjs';
import { runShell } from './exec.mjs';

const MAX_TAIL = 14;

/* ---------------- کمکی ---------------- */

function tail(text, n = MAX_TAIL) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

function readSafe(session, rel) {
  try {
    return readFile(session.id, rel).text;
  } catch {
    return null;
  }
}

function projectFiles(session, max = 400) {
  try {
    return listFiles(session.id).entries.filter((e) => e.type === 'file').map((e) => e.path);
  } catch {
    return [];
  }
}

/** «@scope/pkg/sub» → «@scope/pkg» و «pkg/sub» → «pkg»؛ مسیر نسبی/داخلی → null */
function moduleName(spec) {
  const raw = String(spec || '').trim();
  if (!raw || /^[./]/.test(raw) || /^node:/.test(raw)) return null;
  const parts = raw.split('/');
  const name = raw.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return /^[\w@./-]+$/.test(name) ? name : null;
}

/** فایل‌های کاندید برای «کد سرور» — جایی که پورت/هاست ست می‌شود */
function serverCandidates(session, analysis) {
  const files = projectFiles(session);
  const preferred = [
    analysis?.start?.match(/[\w./-]+\.(?:js|mjs|cjs|ts|py)/)?.[0],
    'server.js',
    'index.js',
    'app.js',
    'src/server.js',
    'src/index.js',
    'main.py',
    'app.py',
    'wsgi.py',
  ].filter(Boolean);
  const out = [];
  for (const p of preferred) if (files.includes(p) && !out.includes(p)) out.push(p);
  for (const p of files) {
    if (out.length >= 6) break;
    if (out.includes(p)) continue;
    if (/^(src\/)?[\w.-]*(server|app|main|index)[\w.-]*\.(js|mjs|cjs|ts|py)$/i.test(p)) out.push(p);
  }
  return out.slice(0, 6);
}

/* ---------------- تشخیص ---------------- */

/**
 * @param {object} session
 * @param {object} run       اجرای دیپلوی (برای analysis / dir / port)
 * @param {{stepId?:string, stepTitle?:string, error?:string, logTail?:string}} info
 * @returns {{stepId:string, stepTitle:string, error:string, findings:Array, patches:Array, canRetry:boolean, summary:string}}
 */
export function diagnoseFailure(session, run, info = {}) {
  const analysis = run?.internal?.analysis || session.analysis || {};
  const stepId = info.stepId || 'build';
  const stepTitle = info.stepTitle || stepId;
  const error = String(info.error || '').slice(0, 1600);
  const logTail = String(info.logTail || '');
  const text = `${error}\n${logTail}`;

  const findings = [];
  const patches = [];
  const addFinding = (title, severity, detail, fix) => {
    if (findings.some((f) => f.title === title)) return;
    findings.push({ title, severity, detail: String(detail || '').slice(0, 700), fix });
  };
  const addPatch = (patch) => {
    if (patches.some((p) => p.id === patch.id)) return;
    patches.push(patch);
  };

  const pkgRaw = readSafe(session, 'package.json');
  let pkg = null;
  try {
    pkg = pkgRaw ? JSON.parse(pkgRaw) : null;
  } catch {
    pkg = null;
  }
  const isNode = !!pkg;
  const isPython = ['python-script', 'flask', 'django'].includes(analysis.platform) || !!readSafe(session, 'requirements.txt');

  /* ۱) اسکریپت start نداریم ولی دیپلوی «npm start» صدا زده */
  if (/missing script:?\s*"?start"?/i.test(text) || (stepId === 'start' && isNode && !pkg.scripts?.start)) {
    const target = pkg?.scripts?.start ? null : guessStartScript(session, pkg, analysis);
    if (target) {
      addFinding(
        'اسکریپت start تعریف نشده',
        'high',
        'package.json هیچ اسکریپت start ندارد، ولی اجرای برنامه با «npm start» انجام می‌شود.',
        `اسکریپت start اضافه می‌شود: ${target}`,
      );
      const next = { ...pkg, scripts: { ...(pkg.scripts || {}), start: target } };
      addPatch({
        id: 'add-start-script',
        kind: 'file',
        title: 'افزودن اسکریپت start به package.json',
        detail: `"start": "${target}"`,
        path: 'package.json',
        content: JSON.stringify(next, null, 2) + '\n',
      });
    }
  }

  /* ۲) ماژول پیدا نشد (وابستگی نصب نیست یا در dependencies نیست) */
  const missing = [
    ...text.matchAll(/Cannot find module ['"]([^'"]+)['"]/gi),
    ...text.matchAll(/Module not found: Can't resolve ['"]([^'"]+)['"]/gi),
    ...text.matchAll(/ERR_MODULE_NOT_FOUND[^\n]*['"]([^'"]+)['"]/gi),
  ]
    .map((m) => moduleName(m[1]))
    .filter(Boolean);

  if (missing.length) {
    const mods = [...new Set(missing)].slice(0, 4);
    addFinding(
      'وابستگی نصب نشده',
      'high',
      `این بسته‌ها پیدا نشدند: ${mods.join('، ')}`,
      'همان بسته‌ها نصب می‌شوند و مرحله دوباره اجرا می‌شود.',
    );
    addPatch({
      id: 'install-missing',
      kind: 'command',
      title: `نصب ${mods.join('، ')}`,
      detail: `npm install ${mods.join(' ')}`,
      command: `npm install ${mods.join(' ')}`,
      timeoutMs: 180_000,
    });
    // اگر ماژول اصلی فریم‌ورک است، کل وابستگی‌ها را نصب کن
    if (mods.some((m) => ['next', 'react', 'vue', 'nuxt', 'express', 'vite', '@nestjs/core'].includes(m))) {
      addPatch({
        id: 'npm-install-all',
        kind: 'command',
        title: 'نصب کامل وابستگی‌ها',
        detail: 'npm install (بر اساس package.json)',
        command: 'npm install',
        timeoutMs: 240_000,
      });
    }
  }

  /* ۳) خروجی بیلد نیست ولی اجرای برنامه به آن نیاز دارد */
  if (/couldn't find any `pages`|could not find a production build|\.next[/\\]BUILD_ID|ENOENT[^\n]*\.next/i.test(text)) {
    addFinding(
      'خروجی بیلد وجود ندارد',
      'high',
      'برنامهٔ Next در حالت production اجرا می‌شود ولی پوشهٔ .next ساخته نشده است.',
      'اول بیلد گرفته می‌شود، بعد برنامه دوباره اجرا می‌شود.',
    );
    addPatch({
      id: 'build-first',
      kind: 'command',
      title: 'گرفتن بیلد قبل از اجرا',
      detail: 'npm run build',
      command: 'npm run build',
      timeoutMs: 300_000,
    });
  }

  /* ۴) پورت در کد ثابت است → برنامه روی پورت اشتباه گوش می‌دهد */
  const portPatched = tryPortPatch(session, analysis, findings, patches);
  if (portPatched) {
    addFinding(
      'پورت در کد ثابت است',
      'high',
      'برنامه پورت را از متغیر محیطی PORT نمی‌خواند؛ برای همین سلامت‌سنجی روی پورت انتخاب‌شده جواب نمی‌دهد.',
      'پورت از process.env.PORT خوانده می‌شود (با مقدار پیش‌فرض قبلی).',
    );
  }

  /* ۵) پورت اشغال است */
  if (/EADDRINUSE|address already in use/i.test(text)) {
    addFinding(
      'پورت اشغال است',
      'medium',
      'یک پروسهٔ دیگر روی همان پورت گوش می‌دهد.',
      'پورت آزاد تازه انتخاب می‌شود و مرحله دوباره اجرا می‌شود.',
    );
    addPatch({ id: 'new-port', kind: 'retry', title: 'پورت تازه', detail: 'انتخاب پورت آزاد و اجرای دوباره', newPort: true });
  }

  /* ۶) پایتون: ماژول نصب نیست */
  const pyMissing = [...text.matchAll(/ModuleNotFoundError: No module named ['"]([\w.]+)['"]/gi)].map((m) => m[1]);
  if (pyMissing.length && isPython) {
    const mods = [...new Set(pyMissing)].slice(0, 4);
    addFinding('ماژول پایتون نصب نشده', 'high', `پیدا نشد: ${mods.join('، ')}`, 'با pip نصب می‌شود.');
    addPatch({
      id: 'pip-install',
      kind: 'command',
      title: `نصب ${mods.join('، ')} با pip`,
      detail: `python -m pip install ${mods.join(' ')}`,
      command: `python -m pip install ${mods.join(' ')}`,
      timeoutMs: 180_000,
    });
  }

  /* ۷) بیلد وجود ندارد ولی اسکریپتش هم نیست → از بیلد رد شو */
  if (stepId === 'build' && isNode && !pkg?.scripts?.build) {
    addFinding('اسکریپت build تعریف نشده', 'medium', 'پروژه اسکریپت build ندارد.', 'از مرحلهٔ بیلد رد می‌شویم و برنامه مستقیم اجرا می‌شود.');
    addPatch({ id: 'skip-build', kind: 'retry', title: 'رد شدن از بیلد', detail: 'بیلد لازم نیست؛ اجرای برنامه', skipStep: true });
  }

  /* ۸) خطای تایم‌اوت/شبکهٔ موقت → تلاش دوباره */
  const transient = /ETIMEDOUT|ECONNRESET|socket hang up|network timeout|EAI_AGAIN|429|rate limit/i.test(text);
  if (transient) {
    addFinding('خطای موقت شبکه', 'low', 'خطا شبیه قطع موقت شبکه/سرویس است.', 'یک‌بار دیگر تلاش می‌کنیم.');
    addPatch({ id: 'retry-transient', kind: 'retry', title: 'تلاش دوباره', detail: 'اجرای دوبارهٔ همان مرحله' });
  }

  const canRetry = patches.length === 0 || patches.some((p) => p.kind === 'retry');
  if (!patches.length && !findings.length) {
    addFinding(
      'علت قطعی پیدا نشد',
      'medium',
      tail(error || logTail, 6) || 'پیام خطای مشخصی در لاگ نبود.',
      'لاگ کامل بررسی می‌شود و می‌شود همان مرحله را دوباره اجرا کرد.',
    );
  }

  return {
    stepId,
    stepTitle,
    error,
    logTail: tail(logTail, 10),
    findings,
    patches,
    canRetry,
    summary: summarize(findings, patches),
  };
}

function summarize(findings, patches) {
  if (!findings.length) return 'علت مشخصی پیدا نشد.';
  const head = findings[0];
  return head.fix ? `${head.title}: ${head.fix}` : head.title;
}

/** حدس زدن اسکریپت start از روی ساختار پروژه */
function guessStartScript(session, pkg, analysis) {
  const files = projectFiles(session);
  if (analysis?.platform === 'nextjs' || pkg?.dependencies?.next || pkg?.devDependencies?.next) return 'next start';
  const main = pkg?.main && files.includes(String(pkg.main).replace(/^\.\//, ''));
  if (main) return `node ${String(pkg.main).replace(/^\.\//, '')}`;
  for (const candidate of ['server.js', 'index.js', 'app.js', 'src/server.js', 'src/index.js', 'dist/index.js']) {
    if (files.includes(candidate)) return `node ${candidate}`;
  }
  return null;
}

/** اگر پورت در کد ثابت باشد، نسخهٔ اصلاح‌شده را وصله می‌کند */
function tryPortPatch(session, analysis, findings, patches) {
  const candidates = serverCandidates(session, analysis);
  for (const rel of candidates) {
    const src = readSafe(session, rel);
    if (!src) continue;

    // الگوی ۱: app.listen(3000
    const listenRe = /\.listen\(\s*(\d{2,5})\s*([,)])/;
    const m1 = src.match(listenRe);
    if (m1) {
      const next = src.replace(listenRe, `.listen(process.env.PORT || $1$2`);
      pushFilePatch(session, rel, src, next, patches, `پورت در ${rel} از PORT خوانده شود`);
      return true;
    }

    // الگوی ۲: const PORT = 3000
    const constRe = /\b(?:const|let|var)\s+(PORT|port)\s*=\s*(\d{2,5})\s*;?/;
    const m2 = src.match(constRe);
    if (m2) {
      const next = src.replace(constRe, `${m2[1]} = process.env.PORT || ${m2[2]};`);
      pushFilePatch(session, rel, src, next, patches, `مقدار ${m2[1]} در ${rel} از PORT خوانده شود`);
      return true;
    }

    // الگوی ۳: پایتون app.run(port=5000)
    const pyRe = /app\.run\(([^)]*)\)/;
    const m3 = src.match(pyRe);
    if (m3 && /port\s*=\s*\d+/.test(m3[1])) {
      const next = src.replace(pyRe, `app.run(${m3[1].replace(/port\s*=\s*\d+/, "port=int(os.environ.get('PORT', 5000))")})`);
      const withImport = /\bimport os\b/.test(next) ? next : `import os\n${next}`;
      pushFilePatch(session, rel, src, withImport, patches, `پورت در ${rel} از متغیر محیطی خوانده شود`);
      return true;
    }
  }
  return false;
}

function pushFilePatch(session, rel, before, after, patches, detail) {
  if (before === after) return;
  const diff = buildDiff(before, after, 24);
  patches.push({
    id: `file:${rel}`,
    kind: 'file',
    title: `اصلاح ${rel}`,
    detail,
    path: rel,
    content: after,
    diff: diff.text,
    changedLines: diff.changedLines,
  });
}

/* ---------------- اعمال وصله‌ها ---------------- */

/**
 * وصله‌ها را اعمال می‌کند. وصلهٔ «retry» کاری روی فایل نمی‌کند و فقط به
 * فراخواننده می‌گوید مرحله را دوباره اجرا کند.
 *
 * @returns {Promise<{applied:Array, retry:boolean, skipStep:boolean, newPort:boolean, errors:Array}>}
 */
export async function applyRepairs(session, patches, { onLog } = {}) {
  const applied = [];
  const errors = [];
  let retry = false;
  let skipStep = false;
  let newPort = false;
  const cwd = projectDir(session.id);

  for (const patch of patches || []) {
    try {
      if (patch.kind === 'file') {
        const res = writeFile(session.id, patch.path, patch.content);
        applied.push({
          kind: 'file',
          title: patch.title,
          path: res.path,
          created: res.created,
          changedLines: res.diff.changedLines,
          diff: res.diff.text,
        });
        onLog?.(`✓ فایل اصلاح شد: ${res.path} (${res.diff.changedLines} خط)`);
      } else if (patch.kind === 'command') {
        onLog?.(`▶ اجرا: ${patch.command}`);
        const res = await runShell(patch.command, { cwd, timeoutMs: patch.timeoutMs || 180_000 });
        applied.push({
          kind: 'command',
          title: patch.title,
          command: patch.command,
          code: res.code,
          output: tail(res.output, 8),
        });
        onLog?.(`${res.code === 0 ? '✓' : '✗'} ${patch.command} → کد ${res.code}`);
        if (res.code !== 0) errors.push(`${patch.command} با کد ${res.code} تمام شد`);
      } else if (patch.kind === 'retry') {
        retry = true;
        if (patch.newPort) newPort = true;
        if (patch.skipStep) skipStep = true;
      }
    } catch (e) {
      errors.push(`${patch.title}: ${e.message}`);
      onLog?.(`✗ ${patch.title}: ${e.message}`);
    }
  }

  return { applied, retry: retry || applied.length > 0, skipStep, newPort, errors };
}

/** توضیح کوتاه برای پیام چت */
export function describeApplied(result) {
  const parts = [];
  for (const a of result.applied || []) {
    if (a.kind === 'file') parts.push(`${a.created ? 'فایل جدید' : 'اصلاح'} ${a.path}`);
    if (a.kind === 'command') parts.push(`${a.code === 0 ? 'موفق' : 'ناموفق'}: ${a.command}`);
  }
  return parts.join(' · ');
}

/** آیا فایل روی دیسک پروژه وجود دارد (برای تست/تشخیص) */
export function hasFile(session, rel) {
  try {
    return fs.existsSync(path.join(projectDir(session.id), rel));
  } catch {
    return false;
  }
}
