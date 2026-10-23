/**
 * env.mjs — خواندن سادهٔ `.env`
 *
 * چرا دستی: پروژه بدون وابستگی است و این ۳۰ خط کافی است. مقادیری که از قبل در
 * environment هستند دست‌نخورده می‌مانند (اولویت با env واقعی).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(DIR, '../.env');

/**
 * چند فایل، به ترتیب اولویت. `liara.env` برای وقتی است که `.env` توسط
 * ignore rules (مثل `.env*` در .gitignore) از بستهٔ آپلود حذف شود.
 */
const FILES = [FILE, path.resolve(DIR, '../liara.env')];

export function loadEnv(file = FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const loaded = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
    loaded[key] = value;
  }
  return loaded;
}

for (const f of FILES) loadEnv(f);

if (!process.env.LIA_LLM_API_KEY) {
  console.warn('⚠ LIA_LLM_API_KEY تنظیم نشده — برنامه در حالت دمو اجرا می‌شود (پاسخ‌های آماده، بدون مدل).');
}
