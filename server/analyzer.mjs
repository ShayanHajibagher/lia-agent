/**
 * analyzer.mjs — مطالعهٔ پروژهٔ کاربر (سورس) بدون اجرای کد
 *
 * ورودی: فایل‌های zip (یا فایل‌های گرفته‌شده از گیت‌هاب)
 * خروجی: پلتفرم، پورت، دستور build/start، وابستگی‌ها، متغیرهای محیطی،
 *        و فهرست «باگ/ریسک» مخصوص محیط لیارا (که بعداً می‌شود رفع کرد یا نادیده گرفت)
 *
 * اصل امنیتی: هیچ کدی از کاربر اجرا نمی‌شود؛ فقط خواندن متن و نام فایل‌ها.
 */
import path from 'node:path';

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.php', '.py', '.rb', '.go', '.cs',
  '.html', '.css', '.scss', '.md', '.yml', '.yaml', '.toml', '.ini', '.conf', '.env', '.txt',
  '.dockerfile', '.sql', '.prisma',
]);

const IGNORED_DIRS = ['node_modules/', 'vendor/', '.git/', 'dist/', 'build/', '.next/', 'storage/'];

function isIgnored(name) {
  return IGNORED_DIRS.some((d) => name.startsWith(d) || name.includes(`/${d}`));
}

function ext(name) {
  const base = name.split('/').pop();
  if (base.toLowerCase() === 'dockerfile') return '.dockerfile';
  return path.extname(base).toLowerCase();
}

function readText(file) {
  const data = file.data;
  if (!data || data.length === 0) return '';
  // فایل باینری را نادیده بگیر
  const probe = data.subarray(0, 400);
  if (probe.includes(0)) return '';
  return data.toString('utf8');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ---------------- تشخیص پلتفرم ---------------- */

function detectPlatform(files, pkg) {
  const names = new Set(files.map((f) => f.name));
  const has = (re) => files.some((f) => re.test(f.name));
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };

  if (has(/(^|\/)manage\.py$/) && deps.django !== undefined) return 'django';
  if (has(/(^|\/)manage\.py$/)) return 'django';
  if (has(/(^|\/)artisan$/) || names.has('composer.json')) return 'laravel';
  if (has(/(^|\/)go\.mod$/)) return 'go';
  if (has(/\.csproj$/)) return 'dotnet';
  if (has(/(^|\/)requirements\.txt$/) || has(/(^|\/)pyproject\.toml$/)) {
    return 'flask';
  }
  if (deps.next) return 'nextjs';
  if (has(/(^|\/)next\.config\.(js|mjs|ts)$/)) return 'nextjs';
  if (deps.nuxt) return 'nextjs';
  if (has(/(^|\/)package\.json$/)) {
    if (deps.express || deps.fastify || deps.nestjs || deps['@nestjs/core'] || deps.hono || deps.koa) return 'nodejs';
    if (has(/(^|\/)Dockerfile$/)) return 'docker';
    // Node ساده (بدون فریم‌ورک): اگر start یا main دارد، وب‌سرور Node است
    if (pkg?.scripts?.start || pkg?.main) return 'nodejs';
    // SPA/Vite/Astro/Svelte: خروجی بیلد، فایل استاتیک است (نه سرور Next)
    if (deps.vite || deps['@vitejs/plugin-react'] || deps['react-scripts'] || deps.astro || deps.svelte || deps.parcel || has(/(^|\/)index\.html$/)) {
      return 'static';
    }
    return 'static';
  }
  if (has(/(^|\/)Dockerfile$/)) return 'docker';
  if (has(/(^|\/)index\.html$/)) return 'static';
  return 'docker';
}

/* ---------------- پورت و دستورها ---------------- */

function detectPort(platform, files = []) {
  // اگر Dockerfile پورت را صریح گفته باشد، همان معتبر است
  const dockerfile = files.find((f) => /(^|\/)Dockerfile$/.test(f.name));
  if (dockerfile) {
    const text = readText(dockerfile);
    const expose = text.match(/EXPOSE\s+(\d{2,5})/i);
    if (expose) return Number(expose[1]);
    const envPort = text.match(/ENV\s+PORT\s*=\s*(\d{2,5})/i) || text.match(/PORT=(\d{2,5})/);
    if (envPort) return Number(envPort[1]);
  }
  return (
    { nextjs: 3000, nodejs: 3000, flask: 8000, django: 8000, laravel: 80, static: 80, go: 8080, dotnet: 8080, docker: 3000 }[
      platform
    ] || 3000
  );
}

function detectCommands(platform, pkg) {
  const scripts = pkg?.scripts || {};
  let build = scripts.build || null;
  let start = scripts.start || null;

  if (platform === 'nextjs' && !build) build = 'next build';
  if (platform === 'nextjs' && !start) start = 'next start';
  if (platform === 'nodejs' && !start) start = pkg?.main ? `node ${pkg.main}` : 'node index.js';
  if (platform === 'laravel') {
    build = 'composer install --no-dev && npm ci && npm run build';
    start = 'php artisan serve --host=0.0.0.0 --port=80';
  }
  if (platform === 'django') {
    build = 'pip install -r requirements.txt && python manage.py migrate';
    start = 'gunicorn project.wsgi:application --bind 0.0.0.0:8000';
  }
  if (platform === 'flask') {
    build = 'pip install -r requirements.txt';
    start = 'gunicorn app:app --bind 0.0.0.0:8000';
  }
  if (platform === 'static') {
    build = null;
    start = 'serve static';
  }
  return { build, start };
}

/* ---------------- متغیرها و وابستگی‌ها ---------------- */

function collectEnvKeys(files) {
  const keys = new Set();
  for (const f of files) {
    if (!/(^|\/)\.env(\.example|\.sample|\.template)?$/.test(f.name)) continue;
    for (const line of readText(f).split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]{2,})\s*=/);
      if (m) keys.add(m[1]);
    }
  }
  return [...keys];
}

function detectCapabilities(files, pkg) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const all = files.map((f) => f.name).join('\n');
  return {
    db: ['pg', 'mysql', 'mysql2', 'mongoose', 'mongodb', 'prisma', '@prisma/client', 'typeorm', 'sequelize', 'knex', 'psycopg2', 'psycopg', 'sqlalchemy', 'django'].filter(
      (d) => deps[d] !== undefined,
    ),
    cache: ['redis', 'ioredis', 'cache-manager'].filter((d) => deps[d] !== undefined),
    heavy: [
      ['sharp', 0.1],
      ['ffmpeg', 0.2],
      ['fluent-ffmpeg', 0.2],
      ['puppeteer', 0.3],
      ['playwright', 0.3],
      ['@tensorflow/tfjs-node', 0.4],
      ['onnxruntime-node', 0.3],
      ['torch', 0.4],
      ['opencv-python', 0.3],
    ]
      .filter(([d]) => deps[d] !== undefined || new RegExp(`(^|\\n)[^\\n]*${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(all))
      .map(([d, w]) => ({ dep: d, weight: w })),
  };
}

/* ---------------- باگ/ریسک‌ها ---------------- */

function scanFindings(files, { platform, pkg, commands, caps }) {
  const findings = [];
  const add = (f) => findings.push({ id: f.id, severity: f.severity, title: f.title, detail: f.detail, fix: f.fix || null, file: f.file || null });

  const nextConfig = files.find((f) => /(^|\/)next\.config\.(js|mjs|ts)$/.test(f.name));
  if (platform === 'nextjs' && nextConfig) {
    const text = readText(nextConfig);
    if (!/output\s*:\s*['"]standalone['"]/.test(text)) {
      add({
        id: 'next-standalone',
        severity: 'high',
        title: 'تنظیم «standalone» در Next.js نیست',
        detail:
          'برای اجرای سبک و درست روی لیارا بهتر است next.config مقدار output: "standalone" داشته باشد؛ وگرنه ایمیج بزرگ‌تر و اجرا شکننده‌تر می‌شود.',
        fix: 'افزودن output: "standalone" به next.config',
        file: nextConfig.name,
      });
    }
  }

  if (platform === 'nextjs' && !commands.build) {
    add({
      id: 'missing-build',
      severity: 'high',
      title: 'اسکریپت build پیدا نشد',
      detail: 'لیارا بدون build، خروجی تولید نمی‌کند. در package.json باید "build": "next build" باشد.',
      fix: 'افزودن اسکریپت build',
    });
  }

  if (platform !== 'static' && !commands.start) {
    add({
      id: 'missing-start',
      severity: 'high',
      title: 'اسکریپت start پیدا نشد',
      detail: 'سرور باید بداند برنامه را چطور اجرا کند (مثلاً "start": "next start" یا "node server.js").',
      fix: 'افزودن اسکریپت start',
    });
  }

  // وابستگی‌هایی که در کد استفاده شده‌اند ولی در package.json اعلام نشده‌اند
  if (pkg) {
    const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
    const BUILTIN = new Set([
      'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
      'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module',
      'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
      'string_decoder', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
    ]);
    const depOf = (spec) => {
      if (!spec || /[${}]/.test(spec)) return null;
      const clean = spec.startsWith('node:') ? spec.slice(5) : spec;
      if (clean.startsWith('.') || clean.startsWith('/') || clean.startsWith('@/') || clean.startsWith('~') || clean.startsWith('#')) return null;
      if (BUILTIN.has(clean)) return null;
      const parts = clean.split('/');
      return clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    };
    const used = new Set();
    for (const f of files) {
      if (!/\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(f.name)) continue;
      const text = readText(f).slice(0, 200_000);
      for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const d = depOf(m[1]);
        if (d) used.add(d);
      }
      for (const m of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
        const d = depOf(m[1]);
        if (d) used.add(d);
      }
    }
    const missing = [...used].filter((d) => !declared.has(d));
    if (missing.length) {
      add({
        id: 'missing-deps',
        severity: 'high',
        title: `${missing.length} وابستگی در package.json نیست`,
        detail:
          'این ماژول‌ها در کد استفاده شده‌اند ولی در dependencies نیستند: ' +
          missing.join('، ') +
          ' — نصب و اجرا با «Cannot find module» شکست می‌خورد.',
        fix: 'افزودن به dependencies در package.json',
      });
    }
  }

  const sqlite = files.find((f) => /(^|\/)(better-sqlite3|sqlite3|\.db|\.sqlite)$/.test(f.name) || /sqlite/i.test(readText(f).slice(0, 2000)));
  const sqliteDep = pkg && { ...(pkg.dependencies || {}) }['better-sqlite3'];
  if (sqlite || sqliteDep) {
    add({
      id: 'sqlite-ephemeral',
      severity: 'high',
      title: 'دیتابیس SQLite روی فایل‌سیستم موقت',
      detail:
        'فایل‌سیستم ریشهٔ برنامه در لیارا با هر ریلیز پاک می‌شود. SQLite باید روی دیسک پایدار (disks) باشد یا به دیتابیس ابری منتقل شود.',
      fix: 'انتقال SQLite به دیسک یا دیتابیس ابری',
      file: sqlite?.name || null,
    });
  }

  const localhostHits = [];
  for (const f of files) {
    if (localhostHits.length >= 3) break;
    if (!TEXT_EXT.has(ext(f.name)) || isIgnored(f.name) || f.data.length > 400_000) continue;
    const text = readText(f);
    const m = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s'"`)]*/);
    if (m) localhostHits.push({ file: f.name, url: m[0] });
  }
  if (localhostHits.length) {
    add({
      id: 'hardcoded-localhost',
      severity: 'medium',
      title: 'آدرس localhost داخل کد hard-code شده',
      detail: `بعد از دیپلوی این آدرس‌ها به خود سرور اشاره می‌کنند. نمونه: ${localhostHits[0].url} در ${localhostHits[0].file}`,
      fix: 'تبدیل آدرس‌ها به متغیر محیطی',
      file: localhostHits[0].file,
    });
  }

  const envCommitted = files.find((f) => /(^|\/)\.env$/.test(f.name));
  if (envCommitted) {
    add({
      id: 'env-committed',
      severity: 'high',
      title: 'فایل .env در سورس است',
      detail: 'کلیدهای داخل .env نباید در سورس/zip باشند. باید به‌صورت متغیر محیطی در پنل لیارا تنظیم شوند.',
      fix: 'حذف .env از سورس و انتقال مقادیر به متغیرهای پنل',
      file: envCommitted.name,
    });
  }

  if (!files.some((f) => /(^|\/)\.env(\.example|\.sample|\.template)$/.test(f.name))) {
    add({
      id: 'missing-env-example',
      severity: 'low',
      title: '.env.example وجود ندارد',
      detail: 'بدون فهرست متغیرها، تنظیم محیط در پنل سعی و خطا می‌شود.',
      fix: 'ساخت .env.example',
    });
  }

  if (files.some((f) => f.name.startsWith('node_modules/'))) {
    add({
      id: 'node-modules',
      severity: 'low',
      title: 'پوشهٔ node_modules در آرشیو است',
      detail: 'حجم آپلود و زمان بیلد را چند برابر می‌کند؛ باید حذف شود (در .gitignore/.liaraignore باشد).',
      fix: 'حذف node_modules از آرشیو',
    });
  }

  const totalBytes = files.reduce((s, f) => s + f.data.length, 0);
  if (totalBytes > 40 * 1024 * 1024) {
    add({
      id: 'large-repo',
      severity: 'low',
      title: 'حجم سورس زیاد است',
      detail: `حدود ${Math.round(totalBytes / 1048576)} مگابایت سورس؛ آپلود و بیلد کند می‌شود.`,
      fix: 'خارج کردن فایل‌های حجیم از ریپو',
    });
  }

  if (caps.db.length === 0 && /DATABASE_URL|POSTGRES|MYSQL_|MONGO_/i.test(files.map((f) => readText(f)).join('\n').slice(0, 200000))) {
    add({
      id: 'db-env-without-client',
      severity: 'low',
      title: 'متغیر دیتابیس هست ولی کلاینت دیتابیس پیدا نشد',
      detail: 'شاید اتصال با ORM دیگری انجام می‌شود؛ موقع اجرا بررسی شود.',
    });
  }

  return findings.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity]));
}

/* ---------------- API اصلی ---------------- */

export function analyzeFiles(files) {
  const realFiles = files.filter((f) => !f.isDir && !isIgnored(f.name));
  const pkgFile = realFiles.find((f) => /(^|\/)package\.json$/.test(f.name) && f.name.split('/').length <= 3);
  const pkg = pkgFile ? parseJson(readText(pkgFile)) : null;

  const platform = detectPlatform(realFiles, pkg);
  const commands = detectCommands(platform, pkg);
  const caps = detectCapabilities(realFiles, pkg);
  const envKeys = collectEnvKeys(realFiles);
  const findings = scanFindings(realFiles, { platform, pkg, commands, caps });

  const totalBytes = realFiles.reduce((s, f) => s + f.data.length, 0);
  const heavyDeps = caps.heavy.length;

  return {
    platform,
    packageName: pkg?.name || null,
    port: detectPort(platform, realFiles),
    build: commands.build,
    start: commands.start,
    envKeys,
    capabilities: { db: caps.db, cache: caps.cache, heavy: caps.heavy.map((h) => h.dep) },
    findings,
    stats: { fileCount: realFiles.length, sourceBytes: totalBytes, sourceMb: Math.round((totalBytes / 1048576) * 10) / 10 },
    planInputs: {
      platform,
      heavyDeps,
      needsDb: caps.db.length > 0,
      uploadsGb: 0,
    },
    tree: realFiles.map((f) => f.name).slice(0, 60),
  };
}

export function summarizeAnalysis(a) {
  const lines = [];
  lines.push(`پلتفرم: ${a.platform}`);
  lines.push(`فایل‌ها: ${a.stats.fileCount} (${a.stats.sourceMb}MB)`);
  if (a.build) lines.push(`build: ${a.build}`);
  if (a.start) lines.push(`start: ${a.start}`);
  if (a.envKeys.length) lines.push(`متغیرها: ${a.envKeys.slice(0, 6).join(', ')}`);
  const sev = (s) => a.findings.filter((f) => f.severity === s).length;
  lines.push(`باگ/ریسک: ${a.findings.length} مورد (${sev('high')} بالا، ${sev('medium')} متوسط، ${sev('low')} کم)`);
  return lines.join('\n');
}
