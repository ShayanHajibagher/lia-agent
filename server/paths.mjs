/**
 * paths.mjs — ریشهٔ داده‌های زمان اجرا
 *
 * همهٔ حالت‌های ماندگار (سشن‌ها، فضای کاری پروژه‌ها، فضاهای استقرار، فهرست دیپلوی‌ها)
 * زیر یک پوشه می‌نشینند. پیش‌فرض `.data` کنار پروژه است؛ روی هاست با
 * `LIA_DATA_DIR` می‌توان به مسیر یک دیسک پایدار (مثلاً `/data`) منتقلش کرد.
 *
 * نکتهٔ هاست: فایل‌سیستم لیارا پیش‌فرض read-only است. اگر دیسکی وصل نشده باشد،
 * نوشتن در `.data` شکست می‌خورد؛ در آن حالت به پوشهٔ موقت سیستم برمی‌گردیم تا
 * سایت بالا بیاید (داده‌ها موقت می‌مانند) و یک هشدار روشن در لاگ می‌گذاریم.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function pickDataDir() {
  const wanted = process.env.LIA_DATA_DIR ? path.resolve(process.env.LIA_DATA_DIR) : path.resolve('.data');
  if (writable(wanted)) return wanted;

  const fallback = path.join(os.tmpdir(), 'liyara-data');
  fs.mkdirSync(fallback, { recursive: true });
  console.warn(
    `[liyara] پوشهٔ داده «${wanted}» قابل نوشتن نیست (فایل‌سیستم read-only؟).\n` +
      `         موقتاً از «${fallback}» استفاده می‌کنم؛ داده‌ها با ری‌استارت پاک می‌شوند.\n` +
      '         برای ماندگاری: یک دیسک به برنامه وصل کن و LIA_DATA_DIR را به مسیر آن بده (مثلاً /data).',
  );
  return fallback;
}

export const DATA_DIR = pickDataDir();

/** مسیر داخل پوشهٔ داده */
export function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}
