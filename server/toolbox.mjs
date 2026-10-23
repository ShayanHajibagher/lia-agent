/**
 * toolbox.mjs — ابزارهای ایجنت خودمختار
 *
 * هر ابزار: نام، توضیح برای مدل، اسکیمای ورودی، برچسب فارسی برای UI،
 * سیاست تأیید (approval) و تابع اجرا.
 *
 * اصل: خواندن/تحلیل/جست‌وجو آزاد است؛ نوشتن روی فایل، ساخت اپ و دیپلوی
 * بدون تأیید صریح کاربر انجام نمی‌شود.
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeFiles } from './analyzer.mjs';
import { quote, planCard } from './plans.mjs';
import { progress, stepById, resolveStep } from './steps.mjs';
import { createRun, advance, snapshot, getRun, retryStep, isSimulated, restartWithCurrentSource, getRunByApp } from './deploy.mjs';
import { diagnoseFailure } from './repair.mjs';
import {
  hasProject,
  listFiles,
  readFile,
  writeFile,
  patchFile,
  probePatch,
  deleteFile,
  moveFile,
  searchCode,
  fileTree,
  projectStats,
  buildDiff,
  readAllFiles,
  projectDir,
  projectFingerprint,
  restoreFromDir,
} from './workspace.mjs';
import { checkCommand, runShell } from './exec.mjs';
import { getAccount, planStatus, publicAccount, plansList } from './account.mjs';
import { planDeploy } from './planner.mjs';
import { listVersions, restoreVersion } from './versions.mjs';
import { logLine } from './bus.mjs';
import { findReusable, list as listDeployments, get as getDeployment } from './registry.mjs';

const DOC_HOSTS = ['docs.liara.ir', 'liara.ir', 'developers.liara.ir', 'www.liara.ir'];

/**
 * فضای کاری را آماده می‌کند — ایجنت می‌تواند پروژه را از صفر بسازد.
 * اگر فضای کاری خالی باشد ولی اپ مستقرشده‌ای وجود داشته باشد، سورس از همان
 * فضای استقرار برگردانده می‌شود تا «ویرایش کد بعد از دیپلوی» ممکن باشد.
 */
function ensureProject(session) {
  fs.mkdirSync(projectDir(session.id), { recursive: true });
  if (hasProject(session.id)) return;
  const run = session.deployRunId ? getRun(session.deployRunId) : null;
  const from = run?.internal?.dir;
  if (from && fs.existsSync(from)) {
    const n = restoreFromDir(session.id, from);
    if (n) logLine(session.id, 'project', `${n} فایل از اپ مستقرشده به فضای کاری برگردانده شد`, 'dim');
  }
}

/**
 * بعد از هر تغییر فایل، تحلیل را تازه می‌کند تا پلن/دیپلوی و پرامپت با وضعیت
 * واقعی جدید کار کنند (بدون این، ایجنت بعد از کدنویسی هنوز پروژه را «ناشناخته» می‌دید).
 */
function refreshAnalysis(session) {
  try {
    const files = readAllFiles(session.id, 2000);
    if (!files.length) return null;
    const analysis = analyzeFiles(files);
    session.analysis = analysis;
    if (analysis.platform) session.requirement.platform = analysis.platform;
    if (session.stage === 'greet' || session.stage === 'intake' || !session.stage) session.stage = 'ready';
    return analysis;
  } catch {
    return null;
  }
}

function loadEntries(session) {
  return readAllFiles(session.id, 2000);
}

/** نزدیک‌ترین «رفع» ممکن برای یک باگ شناسایی‌شده */
function proposeFix(session, finding) {
  const tree = fileTree(session.id, 2000);
  const nextConfig = tree.find((f) => /(^|\/)next\.config\.(js|mjs|ts)$/.test(f));
  const envFile = tree.find((f) => /(^|\/)\.env$/.test(f));

  if (finding.id === 'next-standalone' && nextConfig) {
    const current = readFile(session.id, nextConfig).text;
    const patched = current.includes('output')
      ? current.replace(/output\s*:\s*['"][^'"]*['"]/, "output: 'standalone'")
      : `${current.replace(/\s*$/, '')}\n\n// افزودهٔ لیا: خروجی مستقل برای لیارا\nmodule.exports.output = 'standalone';\n`;
    return {
      path: nextConfig,
      content: patched,
      reason: 'فعال‌کردن خروجی standalone در Next.js تا بیلد سبک‌تر و قابل اجرا روی لیارا باشد.',
    };
  }

  if (finding.id === 'sqlite-ephemeral') {
    const dbFile = tree.find((f) => /\.(js|mjs|cjs|ts)$/.test(f) && /sqlite/i.test(safeRead(session, f)));
    if (dbFile) {
      const current = readFile(session.id, dbFile).text;
      const patched = current.replace(
        /(['"])([^'"]*\.(?:db|sqlite))\1/,
        "process.env.SQLITE_PATH || '/data/app.db'",
      );
      return {
        path: dbFile,
        content: patched,
        reason: 'انتقال مسیر SQLite به دیسک پایدار (/data) تا با هر ریلیز داده‌ها پاک نشوند.',
      };
    }
  }

  if (finding.id === 'env-committed') {
    const example = tree.find((f) => /(^|\/)\.env(\.example|\.sample)?$/.test(f));
    if (example) {
      const keys = readFile(session.id, example)
        .text.split(/\r?\n/)
        .map((l) => l.match(/^\s*([A-Z0-9_]{2,})\s*=/))
        .filter(Boolean)
        .map((m) => `${m[1]}=`);
      return {
        path: '.env.example',
        content: keys.join('\n') + '\n',
        reason: 'ساخت .env.example از کلیدهای موجود تا مقادیر محرمانه در سورس نمانند و تنظیم در پنل ممکن شود.',
      };
    }
  }

  if (finding.id === 'missing-start' || finding.id === 'missing-build') {
    const pkgFile = tree.find((f) => /(^|\/)package\.json$/.test(f));
    if (pkgFile) {
      const pkg = JSON.parse(readFile(session.id, pkgFile).text);
      pkg.scripts = pkg.scripts || {};
      if (finding.id === 'missing-start' && !pkg.scripts.start) pkg.scripts.start = session.analysis?.platform === 'nextjs' ? 'next start' : 'node index.js';
      if (finding.id === 'missing-build' && !pkg.scripts.build) pkg.scripts.build = 'next build';
      return {
        path: pkgFile,
        content: JSON.stringify(pkg, null, 2) + '\n',
        reason: `افزودن اسکریپت ${finding.id === 'missing-start' ? 'start' : 'build'} به package.json تا لیارا بداند برنامه را چطور اجرا/بیلد کند.`,
      };
    }
  }

  // اگر رفع خودکاری نداریم، حداقل پیشنهاد توضیحی بده
  return {
    path: null,
    content: null,
    reason: finding.fix || 'برای این مورد رفع خودکار آماده نیست؛ پیشنهاد متنی می‌دهم.',
  };
}

function safeRead(session, rel) {
  try {
    return readFile(session.id, rel).text;
  } catch {
    return '';
  }
}

/* ---------------- تعریف ابزارها ---------------- */

export const TOOLS = [
  {
    name: 'list_files',
    label: 'فهرست فایل‌ها',
    description: 'فهرست فایل‌ها و پوشه‌های پروژه را برمی‌گرداند. برای آشنایی با ساختار پروژه.',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'پوشهٔ شروع (اختیاری)' } },
    },
    async handler(args, { session }) {
      ensureProject(session);
      const { entries } = listFiles(session.id, args.dir || '');
      return {
        summary: `${entries.filter((e) => e.type === 'file').length} فایل`,
        data: entries.slice(0, 120),
      };
    },
  },

  {
    name: 'read_file',
    label: 'خواندن فایل',
    description: 'محتوای یک فایل متنی پروژه را می‌خواند (حداکثر ۲۰۰ هزار کاراکتر).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'مسیر نسبی فایل، مثل package.json' } },
      required: ['path'],
    },
    async handler(args, { session }) {
      ensureProject(session);
      const file = readFile(session.id, args.path);
      return {
        summary: `${file.path} (${file.text.split('\n').length} خط)`,
        data: { path: file.path, content: file.text, truncated: file.truncated },
      };
    },
  },

  {
    name: 'search_code',
    label: 'جست‌وجو در کد',
    description: 'یک عبارت را در همهٔ فایل‌های پروژه جست‌وجو می‌کند و مسیر/شمارهٔ خط می‌دهد.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'عبارت مورد جست‌وجو' } },
      required: ['query'],
    },
    async handler(args, { session }) {
      ensureProject(session);
      const { matches, query: q } = searchCode(session.id, args.query);
      return {
        summary: `${matches.length} نتیجه برای «${q}»`,
        data: matches,
      };
    },
  },

  {
    name: 'analyze_project',
    label: 'تحلیل پروژه',
    description:
      'پروژه را تحلیل می‌کند: پلتفرم، دستور build/start، پورت، وابستگی‌ها، متغیرها و باگ‌های مخصوص لیارا.',
    parameters: { type: 'object', properties: {} },
    async handler(args, { session }) {
      ensureProject(session);
      const analysis = analyzeFiles(loadEntries(session));
      session.analysis = analysis;
      return {
        summary: `${analysis.findings.length} نکته — پلتفرم ${analysis.platform}`,
        data: {
          platform: analysis.platform,
          build: analysis.build,
          start: analysis.start,
          port: analysis.port,
          envKeys: analysis.envKeys,
          stats: analysis.stats,
          findings: analysis.findings,
        },
      };
    },
  },

  {
    name: 'quote_plan',
    label: 'محاسبهٔ پلن',
    description:
      'پلن مناسب و هزینه را با تعرفهٔ رسمی حساب می‌کند. بازدید ماهانه و مدت (ماه) را بده.',
    parameters: {
      type: 'object',
      properties: {
        visitors: { type: 'number', description: 'بازدید ماهانه' },
        months: { type: 'number', description: 'مدت میزبانی به ماه' },
        needsDb: { type: 'boolean', description: 'دیتابیس لازم است؟' },
      },
      required: ['visitors', 'months'],
    },
    async handler(args, { session }) {
      const platform = session.analysis?.platform || session.requirement?.platform || 'nodejs';
      const q = quote({
        platform,
        visitors: args.visitors,
        months: args.months,
        needsDb: args.needsDb ?? session.analysis?.planInputs?.needsDb ?? false,
        heavyDeps: session.analysis?.planInputs?.heavyDeps || 0,
        uploadsGb: 0,
      });
      session.quote = q;
      session.requirement = { ...session.requirement, visitors: args.visitors, months: args.months, platform };
      return {
        summary: `پلن ${q.plan.name} — ${q.cost.periodTotal.toLocaleString('fa-IR')} تومان برای ${q.cost.months} ماه`,
        data: q,
        card: planCard(q, { cta: 'خرید کردم' }),
      };
    },
  },

  {
    name: 'get_step_guide',
    label: 'راهنمای مرحله',
    description: 'مرحلهٔ راهنمای پنل را می‌دهد: کجا برو، کجا کلیک کن، و چرا.',
    parameters: {
      type: 'object',
      properties: { stepId: { type: 'string', description: 'شناسهٔ مرحله (اختیاری)' } },
    },
    async handler(args, { session }) {
      const p = progress({
        pagePath: session.context?.path,
        stepId: args.stepId || session.guided?.stepId,
        done: session.guided?.done || [],
      });
      const resolved = resolveStep(p.current, {
        platform: session.analysis?.platform || session.requirement?.platform || 'nextjs',
        planId: session.quote?.plan?.id || 'earth',
      });
      return {
        summary: `مرحله ${p.currentIndex + 1} از ${p.steps.length}: ${resolved.title}`,
        data: resolved,
        card: {
          kind: 'step',
          step: {
            id: resolved.id,
            title: resolved.title,
            action: resolved.action,
            why: resolved.why,
            check: resolved.check,
            route: resolved.route,
            selector: resolved.selector,
            index: p.currentIndex,
            total: p.steps.length,
          },
          progress: p.steps,
        },
      };
    },
  },

  {
    name: 'write_file',
    label: 'تغییر فایل',
    description:
      'یک فایل را در نسخهٔ کاری پروژه می‌نویسد. قبل از اعمال، دیف و اثر تغییر به کاربر نشان داده و تأیید گرفته می‌شود.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'مسیر نسبی فایل' },
        content: { type: 'string', description: 'محتوای کامل جدید فایل' },
        reason: { type: 'string', description: 'چرا این تغییر لازم است' },
      },
      required: ['path', 'content', 'reason'],
    },
    approval: true,
    async preview(args, { session }) {
      ensureProject(session);
      let before = '';
      try {
        before = readFile(session.id, args.path).text;
      } catch {
        before = '';
      }
      const diff = buildDiff(before, args.content, 40);
      return {
        title: `تغییر «${args.path}»`,
        reason: args.reason,
        impact: before
          ? `${diff.changedLines} بخش تغییر می‌کند و فایل روی نسخهٔ کاری پروژه بازنویسی می‌شود (نسخهٔ اصلی تو دست‌نخورده می‌ماند).`
          : 'فایل جدید ساخته می‌شود. فایل‌های اصلی تو دست‌نخورده می‌مانند.',
        diff: diff.text,
      };
    },
    async handler(args, { session }) {
      ensureProject(session);
      const result = writeFile(session.id, args.path, args.content);
      refreshAnalysis(session);
      return {
        summary: `${result.created ? 'ساخته شد' : 'تغییر کرد'}: ${result.path} (${result.diff.changedLines} تغییر)`,
        data: { path: result.path, created: result.created, changedLines: result.diff.changedLines, diff: result.diff.text },
      };
    },
  },

  {
    name: 'patch_file',
    label: 'اصلاح بخشی از فایل',
    description:
      'فقط یک بخش مشخص از فایل را عوض می‌کند (متن قدیم → متن جدید) بدون بازنویسی کل فایل. برای اصلاح کد از این ابزار استفاده کن؛ اول فایل را بخوان تا متن دقیق را برداری. اگر متن پیدا نشود خطا می‌دهد.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'مسیر نسبی فایل' },
        find: { type: 'string', description: 'متن دقیق فعلی (چند خط اگر لازم است، عیناً همان‌طور که در فایل است)' },
        replace: { type: 'string', description: 'متن جایگزین' },
        all: { type: 'boolean', description: 'همهٔ تکرارها عوض شوند (پیش‌فرض: فقط اولی)' },
        reason: { type: 'string', description: 'چرا این تغییر لازم است' },
      },
      required: ['path', 'find', 'replace', 'reason'],
    },
    approval: true,
    async preview(args, { session }) {
      ensureProject(session);
      const before = readFile(session.id, args.path).text;
      const probe = probePatch(before, args.find, args.replace, !!args.all);
      return {
        title: `اصلاح «${args.path}»`,
        reason: args.reason,
        impact: probe.ok
          ? `${probe.replaced} بخش از فایل عوض می‌شود (${probe.diff.changedLines} خط). بقیهٔ فایل دست‌نخورده می‌ماند.`
          : `⚠ ${probe.error}`,
        diff: probe.ok ? probe.diff.text : '',
      };
    },
    async handler(args, { session }) {
      ensureProject(session);
      const result = patchFile(session.id, args.path, args.find, args.replace, { all: !!args.all });
      refreshAnalysis(session);
      return {
        summary: `${result.replaced} بخش از ${result.path} اصلاح شد (${result.diff.changedLines} خط)`,
        data: { path: result.path, replaced: result.replaced, occurrences: result.occurrences, diff: result.diff.text },
      };
    },
  },

  {
    name: 'delete_file',
    label: 'حذف فایل',
    description: 'یک فایل را از نسخهٔ کاری پروژه حذف می‌کند (نسخهٔ اصلی کاربر دست‌نخورده می‌ماند). برای پوشه مجاز نیست.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'مسیر نسبی فایل' },
        reason: { type: 'string', description: 'چرا حذف می‌شود' },
      },
      required: ['path', 'reason'],
    },
    approval: true,
    async preview(args, { session }) {
      ensureProject(session);
      const file = readFile(session.id, args.path);
      return {
        title: `حذف «${args.path}»`,
        reason: args.reason,
        impact: `این فایل (${Math.round(file.size / 1024)}KB) از نسخهٔ کاری حذف می‌شود. اگر جایی import شده باشد، اجرا می‌شکند.`,
        diff: file.text
          .split('\n')
          .slice(0, 14)
          .map((l) => `- ${l}`)
          .join('\n'),
      };
    },
    async handler(args, { session }) {
      ensureProject(session);
      const result = deleteFile(session.id, args.path);
      refreshAnalysis(session);
      return {
        summary: `حذف شد: ${result.path} (${Math.round(result.bytes / 1024)}KB)`,
        data: { path: result.path, bytes: result.bytes },
      };
    },
  },

  {
    name: 'move_file',
    label: 'جابه‌جایی/تغییر نام فایل',
    description: 'یک فایل را جابه‌جا یا تغییر نام می‌دهد (مثلاً `server.js` → `src/server.js`).',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'مسیر فعلی' },
        to: { type: 'string', description: 'مسیر جدید' },
        reason: { type: 'string', description: 'چرا جابه‌جا می‌شود' },
      },
      required: ['from', 'to', 'reason'],
    },
    approval: true,
    async preview(args, { session }) {
      ensureProject(session);
      return {
        title: `جابه‌جایی «${args.from}» → «${args.to}»`,
        reason: args.reason,
        impact: 'مسیر فایل عوض می‌شود؛ اگر جایی به مسیر قبلی ارجاع شده باشد باید اصلاح شود.',
        diff: `- ${args.from}\n+ ${args.to}`,
      };
    },
    async handler(args, { session }) {
      ensureProject(session);
      const result = moveFile(session.id, args.from, args.to);
      refreshAnalysis(session);
      return { summary: `جابه‌جا شد: ${result.from} → ${result.to}`, data: result };
    },
  },

  {
    name: 'apply_changes',
    label: 'اعمال تغییرات روی اپ',
    description:
      'کد تغییریافته را روی اپ در حال اجرا می‌گذارد: کپی، بیلد (اگر لازم باشد)، ری‌استارت و سلامت‌سنجی. بعد از هر ویرایشی که باید روی اپ دیده شود این را صدا بزن.',
    parameters: { type: 'object', properties: {} },
    approval: true,
    async preview(args, { session }) {
      const run = session.deployRunId ? getRun(session.deployRunId) : null;
      if (!run) throw new Error('اپ مستقرشده‌ای در این گفتگو نیست؛ اول دیپلوی کن.');
      return {
        title: `اعمال کد روی اپ «${run.appName}»`,
        reason: 'فایل‌های فضای کاری روی اپ در حال اجرا کپی و برنامه ری‌استارت می‌شود.',
        impact:
          'یک نسخه از کد فعلی ذخیره می‌شود، بعد فایل‌ها جایگزین و برنامه دوباره بالا می‌آید ' +
          '(چند ثانیه قطعی). اگر بیلد لازم باشد، انجام می‌شود.',
        diff: '',
      };
    },
    async handler(args, { session }) {
      const run = session.deployRunId ? getRun(session.deployRunId) : null;
      if (!run) throw new Error('اپ مستقرشده‌ای در این گفتگو نیست؛ اول دیپلوی کن.');
      const snap = await restartWithCurrentSource(run);
      return {
        summary: `کد تازه روی اپ اعمال شد — ${snap.url || ''}`,
        data: { url: snap.url, status: snap.status, port: snap.steps?.length || null },
      };
    },
  },

  {
    name: 'list_versions',
    label: 'نسخه‌های کد',
    description: 'نسخه‌های ذخیره‌شدهٔ سورس این اپ روی ماشین خودمان (هر دیپلوی و هر اعمال تغییر یک نسخه می‌سازد).',
    parameters: {
      type: 'object',
      properties: { appName: { type: 'string', description: 'نام اپ (پیش‌فرض: اپ همین گفتگو)' } },
    },
    async handler(args, { session }) {
      const run = session.deployRunId ? getRun(session.deployRunId) : null;
      const appName = args.appName || run?.appName || session.deploySummary?.appName;
      if (!appName) throw new Error('اپی برای این گفتگو ثبت نشده است.');
      const versions = listVersions(appName);
      return {
        summary: `${versions.length} نسخه برای «${appName}»`,
        data: {
          appName,
          versions: versions.map((v) => ({
            id: v.id,
            label: v.label,
            at: v.at,
            files: v.files,
            kb: Math.round(v.bytes / 1024),
          })),
        },
      };
    },
  },

  {
    name: 'restore_version',
    label: 'برگشت به نسخه',
    description: 'یک نسخهٔ ذخیره‌شده را در فضای کاری برمی‌گرداند (بعد از آن با apply_changes روی اپ اعمال کن).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'شناسهٔ نسخه از list_versions' },
        appName: { type: 'string', description: 'نام اپ (پیش‌فرض: اپ همین گفتگو)' },
      },
      required: ['id'],
    },
    approval: true,
    async preview(args, { session }) {
      const run = session.deployRunId ? getRun(session.deployRunId) : null;
      const appName = args.appName || run?.appName || session.deploySummary?.appName;
      return {
        title: `برگشت به نسخهٔ ${args.id}`,
        reason: 'فایل‌های این نسخه جایگزین سورس فضای کاری می‌شوند.',
        impact: 'فضای کاری با آن نسخه بازنویسی می‌شود؛ برای اعمال روی اپ بعدش apply_changes لازم است.',
        diff: '',
      };
    },
    async handler(args, { session }) {
      const run = session.deployRunId ? getRun(session.deployRunId) : null;
      const appName = args.appName || run?.appName || session.deploySummary?.appName;
      if (!appName) throw new Error('اپی برای این گفتگو ثبت نشده است.');
      ensureProject(session);
      const files = restoreVersion(appName, args.id, projectDir(session.id));
      refreshAnalysis(session);
      return { summary: `${files} فایل از نسخهٔ ${args.id} برگردانده شد`, data: { appName, id: args.id, files } };
    },
  },

  {
    name: 'plan_deploy',
    label: 'نقشهٔ دیپلوی',
    description:
      'بر اساس فایل‌های واقعی پروژه تصمیم می‌گیرد کدام مرحله‌های دیپلوی لازم‌اند و کدام نه (مثلاً پروژهٔ استاتیک نصب/بیلد ندارد). قبل از start_deploy این را صدا بزن و به کاربر بگو چه مراحلی لازم است.',
    parameters: {
      type: 'object',
      properties: {
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'اگر می‌خواهی مرحله‌های خاصی را دستی انتخاب کنی: preflight, create-app, upload, envs, install, build, start, health',
        },
      },
    },
    async handler(args, { session }) {
      ensureProject(session);
      const plan = planDeploy({
        analysis: session.analysis || {},
        requirement: session.requirement || {},
        needsDb: session.analysis?.planInputs?.needsDb || false,
        only: Array.isArray(args.only) ? args.only : null,
      });
      return {
        summary: plan.summary,
        data: {
          platform: plan.platform,
          steps: plan.steps.map((s) => ({ id: s.id, title: s.title, why: s.why, approval: s.approval })),
          skipped: plan.skipped,
          notes: plan.notes,
        },
      };
    },
  },

  {
    name: 'list_deployments',
    label: 'دیپلوی‌های قبلی',
    description:
      'فهرست پروژه‌هایی که قبلاً دیپلوی شده‌اند (نام، آدرس، زمان، اثر انگشت). اگر کاربر گفت «همین پروژه را دوباره دیپلوی کن» اول این را صدا بزن تا لازم نباشد فایل را دوباره بگیرد.',
    parameters: { type: 'object', properties: {} },
    async handler(args, { session }) {
      const mine = listDeployments({ accountId: session.accountId || null, sessionId: session.id, limit: 10 });
      const reusable = findReusable({ session, fingerprint: session.projectFingerprint });
      return {
        summary: `${mine.length} دیپلوی قبلی` + (reusable ? ` — پیشنهاد: ${reusable.appName}` : ''),
        data: {
          deployments: mine.map((d) => ({
            appName: d.appName,
            url: d.url,
            deployedAt: d.deployedAt,
            fingerprint: d.fingerprint,
            platform: d.analysis?.platform || null,
            status: d.status,
          })),
          reusable: reusable ? { appName: reusable.appName, url: reusable.url, match: reusable.match } : null,
        },
      };
    },
  },

  {
    name: 'redeploy',
    label: 'دیپلوی مجدد',
    description:
      'همان پروژه‌ای که قبلاً دیپلوی شده را دوباره بالا می‌آورد، بدون گرفتن zip دوباره. مرحله‌های کپی سورس و نصب حذف می‌شوند.',
    parameters: {
      type: 'object',
      properties: {
        appName: { type: 'string', description: 'نام برنامهٔ قبلی (اختیاری؛ پیش‌فرض: بهترین گزینهٔ موجود)' },
      },
    },
    async handler(args, { session }) {
      const entry = (args.appName && getDeployment(args.appName)) || findReusable({ session, fingerprint: session.projectFingerprint });
      if (!entry) throw new Error('دیپلوی قبلی زنده‌ای پیدا نشد؛ کاربر باید فایل را دوباره بفرستد.');
      const run = createRun({
        session,
        analysis: entry.analysis || session.analysis,
        plan: session.quote?.plan,
        needsDb: false,
        reuse: entry,
      });
      session.deployRunId = run.id;
      session.stage = 'deploying';
      advance(run);
      return {
        summary: `دیپلوی مجدد «${entry.appName}» — ${run.steps.length} مرحله (بدون آپلود و نصب)`,
        data: { runId: run.id, appName: run.appName, url: run.url, steps: run.steps.map((s) => s.id) },
        card: {
          kind: 'deploy_plan',
          runId: run.id,
          appName: run.appName,
          url: run.url,
          reused: true,
          simulated: isSimulated(),
          summary: run.planSummary,
          steps: run.steps.map((s) => ({ id: s.id, title: s.title, approval: s.approval, why: s.why })),
          skipped: run.skipped,
          notes: run.planNotes,
        },
      };
    },
  },

  {
    name: 'start_deploy',
    label: 'شروع دیپلوی',
    description:
      'دیپلوی را شروع می‌کند. مرحله‌ها از روی فایل‌های پروژه انتخاب می‌شوند؛ با steps می‌توانی تصمیم خودت را اعمال کنی. هر مرحلهٔ مهم جداگانه تأیید می‌گیرد.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'زیرمجموعهٔ مرحله‌ها برای اجرا (اختیاری). خالی = نقشهٔ خودکار.',
        },
      },
    },
    async handler(args, { session }) {
      ensureProject(session);
      const run = createRun({
        session,
        analysis: session.analysis,
        plan: session.quote?.plan,
        needsDb: session.analysis?.planInputs?.needsDb || false,
        only: Array.isArray(args.steps) && args.steps.length ? args.steps : null,
      });
      session.deployRunId = run.id;
      session.stage = 'deploying';
      advance(run);
      return {
        summary: `${run.steps.length} مرحله — منتظر تأیید مرحلهٔ اول`,
        data: { runId: run.id, appName: run.appName, url: run.url, steps: run.steps.map((s) => s.id) },
        card: {
          kind: 'deploy_plan',
          runId: run.id,
          appName: run.appName,
          url: run.url,
          simulated: isSimulated(),
          summary: run.planSummary,
          steps: run.steps.map((s) => ({ id: s.id, title: s.title, approval: s.approval, why: s.why })),
          skipped: run.skipped,
          notes: run.planNotes,
        },
      };
    },
  },

  {
    name: 'deploy_status',
    label: 'وضعیت دیپلوی',
    description: 'وضعیت آخرین اجرای دیپلوی و لاگ‌هایش را می‌دهد.',
    parameters: { type: 'object', properties: {} },
    async handler(args, { session }) {
      if (!session.deployRunId) throw new Error('دیپلویی شروع نشده است');
      const run = getRun(session.deployRunId);
      if (!run) throw new Error('اجرای دیپلوی پیدا نشد');
      const snap = snapshot(run);
      return {
        summary: `وضعیت: ${snap.status} — مرحله ${snap.index + 1}/${snap.total}`,
        data: {
          status: snap.status,
          appName: snap.appName,
          url: snap.url,
          steps: snap.steps,
          pendingApproval: snap.pendingApproval,
          logs: snap.logs.slice(-10),
          summary: snap.summary,
        },
      };
    },
  },

  {
    name: 'diagnose_deploy',
    label: 'دیباگ دیپلوی',
    description:
      'وقتی دیپلوی شکست خورده، علت‌های محتمل را از خطا/لاگ/کد درمی‌آورد و تغییرهای پیشنهادی (فایل/دستور) را می‌دهد. قبل از هر اصلاح کد، این را صدا بزن تا حدس نزنی.',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: 'مرحلهٔ شکست‌خورده (build/start/health/install). خالی = مرحلهٔ خطای فعلی' },
        error: { type: 'string', description: 'متن خطا اگر جای دیگری دیده‌ای' },
      },
    },
    async handler(args, { session }) {
      if (!session.deployRunId) throw new Error('دیپلویی شروع نشده است');
      const run = getRun(session.deployRunId);
      if (!run) throw new Error('اجرای دیپلوی پیدا نشد');
      const snap = snapshot(run);
      const stepId =
        args.stepId || run.bug?.findings?.[0]?.title || snap.pendingApproval?.stepId || snap.summary?.stoppedAt || 'build';
      const diag = diagnoseFailure(session, run, {
        stepId,
        stepTitle: stepId,
        error: args.error || run.bug?.findings?.[0]?.detail || snap.summary?.error || '',
        logTail: snap.logs
          .slice(-20)
          .map((l) => l.text)
          .join('\n'),
      });
      session.lastDiagnosis = { runId: run.id, at: Date.now(), ...diag };
      return {
        summary: `${diag.findings.length} یافته، ${diag.patches.length} تغییر پیشنهادی`,
        data: {
          stepId: diag.stepId,
          findings: diag.findings,
          patches: diag.patches.map((p) => ({ id: p.id, kind: p.kind, title: p.title, detail: p.detail, path: p.path || null })),
          canRetry: diag.canRetry,
        },
      };
    },
  },

  {
    name: 'retry_deploy',
    label: 'تلاش دوبارهٔ مرحله',
    description:
      'مرحلهٔ شکست‌خوردهٔ دیپلوی را دوباره اجرا می‌کند (بعد از این‌که با write_file یا run_command مشکل را رفع کردی).',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: 'مرحله‌ای که دوباره اجرا شود (پیش‌فرض: مرحلهٔ شکست‌خورده)' },
        newPort: { type: 'boolean', description: 'اگر پورت اشغال بود، پورت تازه انتخاب شود' },
      },
    },
    async handler(args, { session }) {
      if (!session.deployRunId) throw new Error('دیپلویی شروع نشده است');
      const run = getRun(session.deployRunId);
      if (!run) throw new Error('اجرای دیپلوی پیدا نشد');
      const stepId = args.stepId || session.lastDiagnosis?.stepId || 'build';
      const snap = await retryStep(run, stepId, { newPort: !!args.newPort });
      if (snap?.error) throw new Error(snap.error);
      return {
        summary: `«${stepId}» دوباره اجرا شد — وضعیت: ${snap.status}`,
        data: { status: snap.status, steps: snap.steps, url: snap.url },
      };
    },
  },

  {
    name: 'ask_user',
    label: 'پرسش از کاربر',
    interactive: true,
    description:
      'چند سؤال (تا ۶) را یک‌جا از کاربر می‌پرسد و به‌صورت فرم دکمه‌دار نشان می‌دهد؛ کاربر همه را جواب می‌دهد و یک‌جا می‌فرستد. برای تصمیم‌های مهم (نام برنامه، پلتفرم، پلن، تأیید مسیر، انتخاب بین گزینه‌ها) از این ابزار استفاده کن، نه سؤال متنی. سؤال‌ها را تا حد امکان در یک فراخوانی جمع کن.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'عنوان کوتاه فرم' },
        intro: { type: 'string', description: 'یک جمله توضیح چرا این سؤال‌ها لازم است' },
        questions: {
          type: 'array',
          description: 'فهرست سؤال‌ها (۱ تا ۶)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'شناسهٔ کوتاه و یکتا، مثل app_name' },
              label: { type: 'string', description: 'متن سؤال' },
              type: { type: 'string', enum: ['choice', 'text', 'confirm'], description: 'نوع پاسخ' },
              options: { type: 'array', items: { type: 'string' }, description: 'گزینه‌ها برای نوع choice' },
              placeholder: { type: 'string', description: 'راهنمای فیلد متنی' },
            },
            required: ['label'],
          },
        },
      },
      required: ['questions'],
    },
    async handler(args) {
      // در گراف، این ابزار با interrupt اجرا می‌شود و پاسخ کاربر برمی‌گردد.
      return { summary: 'منتظر پاسخ کاربر', data: { answers: {}, note: 'در این موتور پاسخی ثبت نشد' } };
    },
  },

  {
    name: 'run_command',
    label: 'اجرای دستور',
    description:
      'یک دستور شل را داخل پوشهٔ پروژه اجرا می‌کند (نصب وابستگی، بیلد، تست، lint، اجرای اسکریپت) و خروجی را برمی‌گرداند. قبل از اجرا از کاربر اجازه می‌گیرد. دستورهای مخرب رد می‌شوند.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'دستور کامل، مثل "npm install" یا "npm run build"' },
        reason: { type: 'string', description: 'چرا این دستور لازم است (به کاربر نشان داده می‌شود)' },
        timeoutSec: { type: 'number', description: 'سقف زمان به ثانیه (پیش‌فرض ۶۰، حداکثر ۱۲۰)' },
      },
      required: ['command', 'reason'],
    },
    approval: true,
    async preview(args, { session }) {
      ensureProject(session);
      const cmd = checkCommand(args.command);
      return {
        title: `اجرای دستور: ${cmd}`,
        reason: args.reason || '',
        impact:
          'دستور داخل پوشهٔ نسخهٔ کاری پروژه اجرا می‌شود و خروجی‌اش خوانده می‌شود. اگر دستور فایلی بسازد یا تغییر بدهد، همان‌جا اعمال می‌شود.',
        diff: `$ ${cmd}\n(cwd: پروژهٔ همین گفتگو)`,
      };
    },
    async handler(args, { session }) {
      ensureProject(session);
      const cmd = checkCommand(args.command);
      const timeoutMs = Math.min(120, Math.max(5, Number(args.timeoutSec) || 60)) * 1000;
      const res = await runShell(cmd, { cwd: projectDir(session.id), timeoutMs });
      const lastLine = res.output.split('\n').filter(Boolean).slice(-1)[0] || '';
      return {
        summary: `کد ${res.code}${res.timedOut ? ' (تایم‌اوت)' : ''} — ${lastLine.slice(0, 80)}`,
        data: {
          command: cmd,
          code: res.code,
          timedOut: res.timedOut,
          ms: res.ms,
          output: res.output.slice(-6000),
        },
      };
    },
  },

  {
    name: 'account_status',
    label: 'وضعیت حساب و پلن',
    description:
      'حساب متصل به این گفتگو و پلن فعالش را می‌گوید: نوع پلن، تاریخ انقضا و روزهای باقی‌مانده، و فهرست پلن‌های قابل خرید. قبل از دیپلوی از این ابزار استفاده کن تا مطمئن شوی کاربر پلن فعال دارد.',
    parameters: { type: 'object', properties: {} },
    async handler(args, { session }) {
      const account = session.accountId ? getAccount(session.accountId) : null;
      const status = planStatus(account);
      return {
        summary: status.active ? `پلن ${status.plan.name} فعال — ${status.daysLeft} روز باقی` : 'پلن فعالی ثبت نشده',
        data: {
          account: publicAccount(account),
          ...status,
          plans: plansList(),
          note: status.linked ? undefined : 'کاربر هنوز حساب ندارد؛ می‌تواند از صفحهٔ /agent/ بسازد.',
        },
      };
    },
  },

  {
    name: 'fetch_docs',
    label: 'خواندن مستندات',
    description: 'یک صفحه از مستندات لیارا را می‌خواند (فقط دامنه‌های رسمی).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'آدرس صفحه' } },
      required: ['url'],
    },
    async handler(args) {
      let url;
      try {
        url = new URL(args.url);
      } catch {
        throw new Error('آدرس نامعتبر است');
      }
      if (!DOC_HOSTS.includes(url.hostname)) throw new Error('فقط مستندات رسمی لیارا مجاز است');
      const res = await fetch(url.href, { headers: { 'user-agent': 'Lia-Agent/1.0' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/g, ' ')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n');
      return { summary: `${url.pathname} — ${text.length} کاراکتر`, data: { url: url.href, text: text.slice(0, 6000) } };
    },
  },

  {
    name: 'remember',
    label: 'یادداشت',
    description: 'یک نکتهٔ مهم دربارهٔ پروژه یا خواستهٔ کاربر را برای ادامهٔ کار ذخیره می‌کند.',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: 'متن یادداشت' } },
      required: ['note'],
    },
    async handler(args, { session }) {
      session.agent = session.agent || {};
      session.agent.notes = [...(session.agent.notes || []), String(args.note).slice(0, 300)].slice(-20);
      return { summary: 'ثبت شد', data: { notes: session.agent.notes.length } };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** اسکیمای ابزارها به فرمت OpenAI */
export function toolSchemas() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** رفع پیشنهادی برای یک باگ (برای ابزار/جریان خودمختار) */
export function buildFixProposal(session, finding) {
  return proposeFix(session, finding);
}
