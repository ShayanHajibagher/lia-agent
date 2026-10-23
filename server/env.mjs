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

loadEnv();
