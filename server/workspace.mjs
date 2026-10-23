/**
 * workspace.mjs — فضای کاری پروژهٔ کاربر روی سرور
 *
 * سورس آپلودشده (یا گرفته‌شده از گیت‌هاب) اینجا نگهداری می‌شود تا ایجنت بتواند
 * فایل‌ها را بخواند، جست‌وجو کند و — با تأیید کاربر — تغییر بدهد.
 *
 * امنیت: همهٔ مسیرها داخل ریشهٔ همان سشن قفل می‌شوند (ضد path traversal)،
 * سقف حجم/تعداد فایل، و پوشه‌های حجیم (node_modules/.git) نگه داشته نمی‌شوند.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeZip } from './zip.mjs';
import { dataPath } from './paths.mjs';

const ROOT = dataPath('projects');
const LIMITS = {
  maxFiles: 3000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 80 * 1024 * 1024,
  readChars: 200_000,
  searchResults: 60,
};

const SKIP_DIRS = ['node_modules/', '.git/', 'dist/', 'build/', '.next/', 'vendor/', 'coverage/'];

export function projectDir(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(ROOT, safe);
}

export function hasProject(sessionId) {
  try {
    return fs.readdirSync(projectDir(sessionId)).length > 0;
  } catch {
    return false;
  }
}

/** ذخیرهٔ فایل‌های آپلودشده. ورودی: [{name, data:Buffer}] */
export function saveProject(sessionId, entries) {
  const dir = projectDir(sessionId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  let count = 0;
  let total = 0;
  const skipped = [];

  for (const entry of entries || []) {
    if (!entry || entry.isDir) continue;
    const rel = String(entry.name || '').replace(/\\/g, '/');
    if (!rel || SKIP_DIRS.some((d) => rel.startsWith(d) || rel.includes('/' + d))) {
      skipped.push(rel || '(بدون نام)');
      continue;
    }
    if (count >= LIMITS.maxFiles) break;
    if (!entry.data || entry.data.length > LIMITS.maxFileBytes) {
      skipped.push(rel);
      continue;
    }
    total += entry.data.length;
    if (total > LIMITS.maxTotalBytes) break;

    const target = safePath(sessionId, rel);
    if (!target) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    count += 1;
  }

  return { dir, files: count, bytes: total, skippedCount: skipped.length };
}

/** مسیر امن داخل پروژه (null = تلاش برای خروج از محدوده) */
export function safePath(sessionId, relPath) {
  const root = projectDir(sessionId);
  const cleaned = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0')) return null;
  const target = path.resolve(root, cleaned);
  if (!target.startsWith(root + path.sep) && target !== root) return null;
  return target;
}

export function listFiles(sessionId, sub = '') {
  const root = projectDir(sessionId);
  const start = sub ? safePath(sessionId, sub) : root;
  if (!start || !fs.existsSync(start)) return { dir: sub, entries: [] };
  const entries = [];
  const walk = (dir, depth) => {
    if (entries.length > 400) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.') && item.name !== '.env.example') continue;
      const abs = path.join(dir, item.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (item.isDirectory()) {
        if (depth < 3) walk(abs, depth + 1);
        entries.push({ path: rel + '/', type: 'dir' });
      } else {
        entries.push({ path: rel, type: 'file', size: fs.statSync(abs).size });
      }
    }
  };
  walk(start, 0);
  return { dir: sub, entries };
}

export function fileTree(sessionId, max = 300) {
  const { entries } = listFiles(sessionId);
  return entries.filter((e) => e.type === 'file').slice(0, max).map((e) => e.path);
}

export function readFile(sessionId, relPath) {
  const abs = safePath(sessionId, relPath);
  if (!abs) throw new Error('مسیر نامعتبر است');
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`فایل پیدا نشد: ${relPath}`);
  }
  if (stat.isDirectory()) throw new Error('این مسیر یک پوشه است، نه فایل');
  if (stat.size > 2 * 1024 * 1024) throw new Error('فایل بزرگ‌تر از ۲ مگابایت است');
  const buffer = fs.readFileSync(abs);
  if (buffer.subarray(0, 400).includes(0)) throw new Error('این فایل باینری است و خوانده نمی‌شود');
  const raw = buffer.toString('utf8');
  const truncated = raw.length > LIMITS.readChars;
  return { path: relPath, text: raw.slice(0, LIMITS.readChars), truncated, size: stat.size };
}

export function writeFile(sessionId, relPath, content) {
  const abs = safePath(sessionId, relPath);
  if (!abs) throw new Error('مسیر نامعتبر است');
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const after = String(content ?? '');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, after, 'utf8');
  return { path: relPath, before, after, created: !before, diff: buildDiff(before, after) };
}

/**
 * تغییر جراحی: فقط بخش مشخصی از فایل عوض می‌شود.
 * برای وقتی است که مدل نباید کل فایل را بازنویسی کند (کم‌کردن ریسک و توکن).
 */
export function patchFile(sessionId, relPath, find, replace, { all = false } = {}) {
  const abs = safePath(sessionId, relPath);
  if (!abs) throw new Error('مسیر نامعتبر است');
  if (!fs.existsSync(abs)) throw new Error(`فایل پیدا نشد: ${relPath}`);
  const before = fs.readFileSync(abs, 'utf8');
  const needle = String(find ?? '');
  if (!needle) throw new Error('متن مورد جست‌وجو خالی است');

  const occurrences = before.split(needle).length - 1;
  if (!occurrences) {
    throw new Error('این متن در فایل پیدا نشد؛ اول فایل را بخوان و متن دقیق را بردار.');
  }
  const after = all ? before.split(needle).join(String(replace ?? '')) : before.replace(needle, String(replace ?? ''));
  fs.writeFileSync(abs, after, 'utf8');
  return {
    path: relPath,
    before,
    after,
    occurrences,
    replaced: all ? occurrences : 1,
    diff: buildDiff(before, after),
  };
}

/**
 * پیش‌نمایش تغییر جراحی بدون نوشتن روی دیسک (برای کارت تأیید).
 * @returns {{ok:boolean, error?:string, replaced:number, diff?:object}}
 */
export function probePatch(before, find, replace, all = false) {
  const needle = String(find ?? '');
  const src = String(before ?? '');
  if (!needle) return { ok: false, error: 'متن مورد جست‌وجو خالی است', replaced: 0 };
  const occurrences = src.split(needle).length - 1;
  if (!occurrences) {
    return { ok: false, error: 'این متن در فایل پیدا نشد؛ متن دقیق را از فایل بردار.', replaced: 0 };
  }
  const after = all ? src.split(needle).join(String(replace ?? '')) : src.replace(needle, String(replace ?? ''));
  return { ok: true, replaced: all ? occurrences : 1, occurrences, diff: buildDiff(src, after, 40) };
}

/** حذف فایل از نسخهٔ کاری (فایل اصلی کاربر دست‌نخورده است) */
export function deleteFile(sessionId, relPath) {
  const abs = safePath(sessionId, relPath);
  if (!abs) throw new Error('مسیر نامعتبر است');
  if (!fs.existsSync(abs)) throw new Error(`فایل پیدا نشد: ${relPath}`);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error('این مسیر یک پوشه است؛ حذف پوشه مجاز نیست.');
  const text = stat.size < LIMITS.maxFileBytes ? fs.readFileSync(abs, 'utf8') : '';
  fs.unlinkSync(abs);
  return { path: relPath, bytes: stat.size, preview: text.slice(0, 400) };
}

/** جابه‌جایی یا تغییر نام فایل */
export function moveFile(sessionId, from, to) {
  const src = safePath(sessionId, from);
  const dest = safePath(sessionId, to);
  if (!src || !dest) throw new Error('مسیر نامعتبر است');
  if (!fs.existsSync(src)) throw new Error(`فایل پیدا نشد: ${from}`);
  if (fs.existsSync(dest)) throw new Error(`مسیر مقصد از قبل وجود دارد: ${to}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return { from, to };
}

/**
 * بازگرداندن سورس از یک پوشهٔ بیرونی (مثلاً فضای استقرار قبلی) به فضای کاری.
 * لازم است وقتی کاربر بعد از دیپلوی می‌خواهد کد اپ در حال اجرا را ویرایش کند
 * ولی فضای کاری خالی شده است.
 */
export function restoreFromDir(sessionId, fromDir) {
  if (!fromDir || !fs.existsSync(fromDir)) return 0;
  const dest = projectDir(sessionId);
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  const walk = (src, out) => {
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
      if (['node_modules', '.git', '.next', 'dist', 'build', 'vendor'].includes(item.name)) continue;
      if (item.name === '.env') continue;
      const s1 = path.join(src, item.name);
      const d1 = path.join(out, item.name);
      if (item.isDirectory()) {
        fs.mkdirSync(d1, { recursive: true });
        walk(s1, d1);
      } else {
        try {
          fs.copyFileSync(s1, d1);
          copied += 1;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(fromDir, dest);
  return copied;
}

/**
 * اثر انگشت پروژه — برای تشخیص «همین پروژه قبلاً دیپلوی شده».
 * از مسیر + حجم همهٔ فایل‌ها ساخته می‌شود (سریع و بدون خواندن محتوا).
 */
export function projectFingerprint(sessionId) {
  try {
    const files = fileTree(sessionId, 5000).sort();
    if (!files.length) return null;
    const h = crypto.createHash('sha256');
    for (const rel of files) {
      const abs = safePath(sessionId, rel);
      if (!abs) continue;
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      h.update(`${rel}:${size}\n`);
    }
    return h.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

export function searchCode(sessionId, query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { matches: [] };
  const root = projectDir(sessionId);
  const needle = q.toLowerCase();
  const matches = [];
  const walk = (dir, depth) => {
    if (matches.length >= LIMITS.searchResults) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (matches.length >= LIMITS.searchResults) return;
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (depth < 6) walk(abs, depth + 1);
        continue;
      }
      const stat = fs.statSync(abs);
      if (stat.size > 400 * 1024) continue;
      if (!/\.(js|mjs|cjs|ts|tsx|jsx|py|php|go|cs|html|css|scss|json|yml|yaml|env|md|txt|sql|prisma)$/i.test(item.name)) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({
            path: path.relative(root, abs).replace(/\\/g, '/'),
            line: i + 1,
            text: lines[i].trim().slice(0, 160),
          });
          if (matches.length >= LIMITS.searchResults) break;
        }
      }
    }
  };
  walk(root, 0);
  return { query: q, matches };
}

export function projectStats(sessionId) {
  const files = fileTree(sessionId, 100_000);
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += fs.statSync(path.join(projectDir(sessionId), rel)).size;
    } catch {
      /* ignore */
    }
  }
  return { files: files.length, bytes };
}

/** خروجی zip از نسخهٔ کاری (برای دانلود تغییرها) */
export function exportZip(sessionId) {
  const root = projectDir(sessionId);
  const entries = fileTree(sessionId, 5000).map((rel) => ({
    name: rel,
    data: fs.readFileSync(path.join(root, rel)),
  }));
  return writeZip(entries);
}

/** دیف ساده و خوانا (کافی برای نشان‌دادن به کاربر) */
export function buildDiff(before, after, maxLines = 60) {
  const a = before ? before.split(/\r?\n/) : [];
  const b = after ? after.split(/\r?\n/) : [];
  const out = [];
  const n = Math.max(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < n && out.length < maxLines; i++) {
    if (a[i] === b[i]) {
      out.push(`  ${a[i] ?? ''}`);
    } else {
      if (a[i] !== undefined) out.push(`- ${a[i]}`);
      if (b[i] !== undefined) out.push(`+ ${b[i]}`);
      changed += 1;
    }
  }
  if (out.length >= maxLines) out.push('… (بقیهٔ تغییرات کوتاه شد)');
  return { text: out.join('\n'), changedLines: changed };
}

/** همهٔ فایل‌های پروژه به‌صورت {name, data} — برای تحلیل دوباره */
export function readAllFiles(sessionId, max = 3000) {
  const root = projectDir(sessionId);
  return fileTree(sessionId, max).map((rel) => ({
    name: rel,
    data: fs.readFileSync(path.join(root, rel)),
  }));
}

export function newSessionToken() {
  return crypto.randomBytes(6).toString('hex');
}
