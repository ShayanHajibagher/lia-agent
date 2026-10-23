/**
 * registry.mjs — حافظهٔ دیپلوی‌های انجام‌شده
 *
 * چرا لازم است: کاربری که پروژه‌اش را قبلاً دیپلوی کرده نباید مجبور شود دوباره
 * zip بفرستد. با «اثر انگشت» پروژه (مسیر + حجم فایل‌ها) تشخیص می‌دهیم که همین
 * پروژه قبلاً کجا و با چه نامی دیپلوی شده و همان فضای استقرار را دوباره بالا می‌آوریم.
 *
 * ذخیره در `.data/deployments.json` (بعد از ری‌استارت سرور هم می‌ماند).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.mjs';

const DIR = DATA_DIR;
const FILE = path.join(DIR, 'deployments.json');
const MAX_ENTRIES = 80;

let entries = [];
let saveTimer = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    entries = Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    entries = [];
  }
}
load();

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify({ savedAt: new Date().toISOString(), entries }, null, 1), 'utf8');
    } catch (e) {
      console.error('ذخیرهٔ فهرست دیپلوی‌ها ناموفق بود:', e.message);
    }
  }, 400);
}

/** آیا پوشهٔ استقرار این ورودی هنوز روی دیسک هست؟ */
export function isAlive(entry) {
  try {
    return !!entry?.dir && fs.existsSync(entry.dir);
  } catch {
    return false;
  }
}

/** ثبت/به‌روزرسانی یک دیپلوی */
export function remember({ session, run, summary, analysis, fingerprint }) {
  if (!run) return null;
  const entry = {
    appName: run.appName,
    dir: run.internal?.dir || null,
    url: summary?.url || run.url || null,
    port: run.internal?.port || null,
    fingerprint: fingerprint || run.internal?.fingerprint || null,
    sessionId: run.sessionId || session?.id || null,
    accountId: session?.accountId || null,
    analysis: analysis || run.internal?.analysis || null,
    status: summary?.status || run.status,
    reused: !!run.reuse,
    deployedAt: Date.now(),
    runId: run.id,
  };
  entries = entries.filter((e) => e.appName !== entry.appName);
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  saveSoon();
  return entry;
}

export function get(appName) {
  return entries.find((e) => e.appName === appName) || null;
}

export function forget(appName) {
  const before = entries.length;
  entries = entries.filter((e) => e.appName !== appName);
  if (entries.length !== before) saveSoon();
  return before !== entries.length;
}

export function list({ accountId = null, sessionId = null, limit = 10 } = {}) {
  return entries
    .filter((e) => isAlive(e))
    .filter((e) => {
      if (accountId && e.accountId && e.accountId !== accountId) return false;
      if (sessionId && !accountId && e.sessionId && e.sessionId !== sessionId) return false;
      return true;
    })
    .slice(0, limit)
    .map((e) => ({ ...e, analysis: e.analysis ? { platform: e.analysis.platform, build: e.analysis.build, port: e.analysis.port } : null }));
}

/** همهٔ ورودی‌های زنده (برای پیشنهاد «قبلاً دیپلوی شده») */
export function allAlive(limit = 20) {
  return entries.filter(isAlive).slice(0, limit);
}

/**
 * بهترین گزینهٔ «همین پروژه را دوباره دیپلوی کن».
 *
 * ترتیب اولویت: اثر انگشت یکسان → همان حساب → همان سشن → آخرین دیپلوی.
 *
 * `sameOwnerOnly` = فقط وقتی پیشنهاد بده که پروژه مال همین کاربر/گفتگو باشد.
 * (برای پیشنهاد خودکار بعد از آپلود استفاده می‌شود تا کاربر تازه پیام اضافه نبیند.)
 */
export function findReusable({ session, fingerprint, sameOwnerOnly = false } = {}) {
  const alive = entries.filter(isAlive);
  if (!alive.length) return null;

  const accountId = session?.accountId || null;
  const sessionId = session?.id || null;
  const sameOwner = (e) => (accountId && e.accountId === accountId) || (sessionId && e.sessionId === sessionId);

  if (fingerprint) {
    const exact = alive.find((e) => e.fingerprint === fingerprint && (!sameOwnerOnly || sameOwner(e)));
    if (exact) return { ...exact, match: 'fingerprint' };
  }
  if (sameOwnerOnly) return null;

  if (accountId) {
    const mine = alive.find((e) => e.accountId === accountId);
    if (mine) return { ...mine, match: 'account' };
  }
  if (sessionId) {
    const own = alive.find((e) => e.sessionId === sessionId);
    if (own) return { ...own, match: 'session' };
  }
  // بدون حساب (حالت محلی/تک‌کاربره): آخرین دیپلوی
  return { ...alive[0], match: 'latest' };
}

/** خلاصهٔ کوتاه برای چت/کارت */
export function describe(entry) {
  if (!entry) return '';
  const when = entry.deployedAt ? new Date(entry.deployedAt).toLocaleString('fa-IR') : '—';
  return `${entry.appName} — آخرین دیپلوی ${when}${entry.url ? ` (${entry.url})` : ''}`;
}
