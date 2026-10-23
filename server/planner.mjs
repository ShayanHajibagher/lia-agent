/**
 * planner.mjs — «کدام مرحله‌ها لازم است؟»
 *
 * به‌جای رفتن کورکورانه از یک فهرست ثابت، ایجنت (و موتور دیپلوی) بر اساس
 * فایل‌های واقعی پروژه تصمیم می‌گیرد کدام مرحله‌ها لازم‌اند:
 *
 *   • پروژهٔ استاتیک  → نصب و بیلد لازم نیست
 *   • پایتون          → نصب با pip، بیلد npm ندارد
 *   • Next.js         → بیلد لازم است
 *   • دیپلوی مجدد     → کپی سورس/نصب دوباره لازم نیست (reuse)
 *
 * خروجی: فهرست مرحله‌های لازم + مرحله‌های رد‌شده با دلیل. همین داده در کارت
 * «نقشهٔ دیپلوی» و در ابزار `plan_deploy` به کاربر/مدل نشان داده می‌شود.
 */

/** فهرست کامل مرحله‌ها (تنها منبع حقیقت) */
export const STEP_CATALOG = {
  preflight: {
    title: 'بررسی پیش‌نیازها',
    detail: 'سورس، پورت آزاد و ابزارهای لازم را چک می‌کنم.',
    effect: 'فقط بررسی؛ چیزی ساخته نمی‌شود.',
    approval: false,
  },
  'create-app': {
    title: 'ساخت فضای برنامه',
    detail: 'پوشهٔ استقرار این برنامه را روی سیستم می‌سازم.',
    effect: 'یک پوشه در `.data/deployments/` ساخته می‌شود.',
    approval: true,
  },
  upload: {
    title: 'کپی سورس',
    detail: 'فایل‌های پروژه را (بدون node_modules و .git) به فضای استقرار منتقل می‌کنم.',
    effect: 'فقط کپی محلی؛ سورس اصلی دست‌نخورده می‌ماند.',
    approval: true,
  },
  envs: {
    title: 'تنظیم متغیرهای محیطی',
    detail: 'فایل .env با PORT و متغیرهای کشف‌شده می‌سازم.',
    effect: 'فقط یک فایل متنی در فضای استقرار.',
    approval: true,
  },
  install: {
    title: 'نصب وابستگی‌ها',
    detail: 'بسته‌های Node یا پایتون را نصب می‌کنم (اگر لازم باشد).',
    effect: 'بسته‌ها روی همین سیستم نصب می‌شوند؛ ممکن است چند دقیقه طول بکشد.',
    approval: true,
  },
  build: {
    title: 'بیلد پروژه',
    detail: 'اگر اسکریپت build باشد، اجرا می‌شود.',
    effect: 'فقط خروجی بیلد ساخته می‌شود.',
    approval: false,
  },
  start: {
    title: 'اجرای برنامه',
    detail: 'برنامه را روی یک پورت محلی (فقط 127.0.0.1) بالا می‌آورم.',
    effect: 'یک پروسهٔ محلی اجرا می‌شود که با stop بسته می‌شود.',
    approval: true,
  },
  health: {
    title: 'سلامت‌سنجی',
    detail: 'آدرس برنامه را صدا می‌زنم تا مطمئن شوم جواب می‌دهد.',
    effect: 'فقط یک درخواست HTTP محلی.',
    approval: false,
  },
};

export const STEP_ORDER = ['preflight', 'create-app', 'upload', 'envs', 'install', 'build', 'start', 'health'];

const PYTHON = ['flask', 'django', 'python-script'];
const UNSUPPORTED = ['go', 'dotnet'];

function makeStep(id, why) {
  return { id, ...STEP_CATALOG[id], why };
}

/**
 * @param {object} input
 * @param {object} input.analysis   خروجی analyzer (platform/build/start/envKeys/…)
 * @param {object} [input.requirement]
 * @param {boolean} [input.reuse]   از فضای استقرار قبلی استفاده شود
 * @param {boolean} [input.needsDb]
 * @param {string[]} [input.only]   اگر بدهی، فقط همین مرحله‌ها (تصمیم ایجنت)
 * @returns {{steps:Array, skipped:Array, notes:Array, platform:string, reuse:boolean, summary:string}}
 */
export function planDeploy({ analysis = {}, requirement = {}, reuse = false, needsDb = false, only = null } = {}) {
  const platform = analysis.platform || 'nodejs';
  const isStatic = platform === 'static';
  const isPython = PYTHON.includes(platform);
  const hasBuild = !!(analysis.build && String(analysis.build).trim());
  const envKeys = analysis.envKeys || [];
  const hasNodeDeps = !isPython && !isStatic;

  const steps = [];
  const skipped = [];
  const notes = [];

  const include = (id, why) => steps.push(makeStep(id, why));
  const skip = (id, why) => skipped.push({ id, title: STEP_CATALOG[id].title, why });

  /* preflight */
  include('preflight', reuse ? 'فضای استقرار قبلی و پورت را چک می‌کنم' : 'سورس، پورت آزاد و ابزارها را چک می‌کنم');

  if (reuse) {
    skip('create-app', 'فضای برنامه از قبل ساخته شده است');
    skip('upload', 'سورس قبلی همان‌جاست؛ نیازی به کپی دوباره نیست');
    skip('envs', 'فایل .env از اجرای قبلی موجود است');
    skip('install', 'وابستگی‌ها قبلاً نصب شده‌اند');
  } else {
    include('create-app', 'پوشهٔ استقرار باید ساخته شود');
    include('upload', 'سورس پروژه باید در فضای استقرار کپی شود');

    if (isStatic) {
      skip('envs', 'سایت استاتیک متغیر محیطی لازم ندارد');
    } else if (envKeys.length || needsDb || isPython || platform === 'nextjs' || platform === 'nodejs') {
      include('envs', envKeys.length ? `این متغیرها لازم‌اند: ${envKeys.slice(0, 5).join('، ')}` : 'PORT و NODE_ENV لازم است');
    } else {
      skip('envs', 'متغیر محیطی‌ای برای این پروژه پیدا نشد');
    }

    if (isStatic) {
      skip('install', 'سایت استاتیک وابستگی ندارد');
    } else if (isPython) {
      include('install', 'پکیج‌های پایتون از requirements.txt نصب می‌شوند');
    } else if (hasNodeDeps) {
      include('install', 'بسته‌های package.json نصب می‌شوند');
    } else {
      skip('install', 'فایل وابستگی‌ای پیدا نشد');
    }
  }

  /* build */
  if (hasBuild) include('build', `اسکریپت build پروژه: ${String(analysis.build).slice(0, 40)}`);
  else skip('build', 'این پروژه اسکریپت build ندارد');

  /* start + health */
  include('start', isStatic ? 'فایل‌های استاتیک را سرو می‌کنم' : 'برنامه باید اجرا و روی پورت گوش بدهد');
  include('health', 'باید مطمئن شوم برنامه واقعاً جواب می‌دهد');

  if (UNSUPPORTED.includes(platform)) {
    notes.push(`پلتفرم «${platform}» هنوز اجرای مستقیم ندارد؛ اگر Dockerfile داشته باشد از مسیر Docker استفاده می‌شود.`);
  }
  if (!analysis.port) notes.push('پورت از متغیر محیطی PORT خوانده می‌شود؛ اگر در کد ثابت باشد، ایجنت اصلاحش می‌کند.');

  /* تصمیم ایجنت: فقط مرحله‌های خواسته‌شده (ولی preflight/health همیشه می‌مانند) */
  let final = steps;
  if (Array.isArray(only) && only.length) {
    const wanted = new Set([...only, 'preflight', 'health']);
    for (const id of only) if (!STEP_CATALOG[id]) notes.push(`مرحلهٔ ناشناخته نادیده گرفته شد: ${id}`);
    final = steps.filter((s) => wanted.has(s.id));
    for (const s of steps) {
      if (!wanted.has(s.id)) skipped.push({ id: s.id, title: s.title, why: 'به تصمیم ایجنت انجام نمی‌شود' });
    }
    final.sort((a, b) => STEP_ORDER.indexOf(a.id) - STEP_ORDER.indexOf(b.id));
  }

  const summary = `${final.length} مرحله از ${STEP_ORDER.length}` + (skipped.length ? ` — ${skipped.length} مرحله لازم نیست` : '');

  return { steps: final, skipped, notes, platform, reuse, summary };
}
