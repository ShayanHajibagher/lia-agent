/**
 * account.mjs — حساب کاربر و وضعیت پلن
 *
 * هدف: ایجنت بتواند قبل از دیپلوی مطمئن شود کاربر پلن فعال دارد، و اگر ندارد
 * مسیر خرید را نشان دهد. این پیاده‌سازی «محلی/دمو» است (بدون پرداخت واقعی) ولی
 * همان قراردادی را دارد که بعداً به لیارا/درگاه پرداخت وصل می‌شود:
 *
 *   createOrGet(email)      → حساب
 *   planStatus(account)     → { linked, active, plan, daysLeft }
 *   purchase(id, plan, m)   → فعال‌سازی دوره + رسید پرداخت
 *
 * برای تولید: `purchase` باید به درگاه (زرین‌پال/آیدی‌پی) و `planStatus` به
 * `GET /v1/projects` لیارا وصل شود. جزئیات در README-API.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.mjs';
import crypto from 'node:crypto';

const FILE = dataPath('accounts.json');
const catalog = JSON.parse(fs.readFileSync(path.resolve('knowledge/plans.json'), 'utf8'));
const PLANS = catalog.plans;
const DAY = 24 * 60 * 60 * 1000;

/** @type {Map<string, any>} */
const accounts = new Map();
let saveTimer = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const a of raw.accounts || []) accounts.set(a.id, a);
  } catch {
    /* اولین اجرا */
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ savedAt: new Date().toISOString(), accounts: [...accounts.values()] }), 'utf8');
  } catch (e) {
    console.error('ذخیرهٔ حساب‌ها ناموفق بود:', e.message);
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 300);
}

load();
process.on('exit', persist);

/* ---------------- کاتالوگ ---------------- */

export function plansList() {
  return PLANS.map((p) => ({
    id: p.id,
    name: p.name,
    ramGb: p.ramGb,
    vcpu: p.vcpu,
    diskGb: p.diskGb,
    monthly: p.monthly,
  }));
}

export function planById(id) {
  return PLANS.find((p) => p.id === String(id || '')) || null;
}

/* ---------------- حساب و احراز هویت ---------------- */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

/** ثبت‌نام کاربر جدید */
export function register({ email, password, name } = {}) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) throw new Error('ایمیل معتبر نیست');
  const cleanPass = String(password || '');
  if (cleanPass.length < 4) throw new Error('رمز عبور باید حداقل ۴ نویسه باشد');

  const existing = [...accounts.values()].find((a) => a.email === cleanEmail);
  if (existing) throw new Error('این ایمیل قبلاً ثبت‌نام شده است. لطفاً وارد شوید.');

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(cleanPass, salt);
  const account = {
    id: 'a_' + crypto.randomBytes(6).toString('hex'),
    email: cleanEmail,
    name: String(name || cleanEmail.split('@')[0]).trim().slice(0, 60),
    salt,
    passwordHash,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plan: null,
    purchases: [],
  };
  accounts.set(account.id, account);
  save();
  return account;
}

/** ورود به حساب کاربری با ایمیل و رمز عبور */
export function login({ email, password } = {}) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) throw new Error('لطفاً ایمیل خود را وارد کنید');
  const cleanPass = String(password || '');
  if (!cleanPass) throw new Error('لطفاً رمز عبور خود را وارد کنید');

  const account = [...accounts.values()].find((a) => a.email === cleanEmail);
  if (!account) throw new Error('کاربری با این ایمیل یافت نشد. لطفاً ثبت‌نام کنید.');

  if (account.passwordHash && account.salt) {
    const computed = hashPassword(cleanPass, account.salt);
    if (computed !== account.passwordHash) {
      throw new Error('رمز عبور وارد شده نادرست است.');
    }
  } else {
    // کاربر قبلی بدون پسورد بوده؛ پسورد اولیه را تنظیم کن
    const salt = crypto.randomBytes(16).toString('hex');
    account.salt = salt;
    account.passwordHash = hashPassword(cleanPass, salt);
    save();
  }
  account.updatedAt = Date.now();
  save();
  return account;
}

export function createOrGet({ email, name } = {}) {
  const clean = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) throw new Error('ایمیل معتبر نیست');
  let account = [...accounts.values()].find((a) => a.email === clean);
  const created = !account;
  if (!account) {
    account = {
      id: 'a_' + crypto.randomBytes(6).toString('hex'),
      email: clean,
      name: String(name || clean.split('@')[0]).slice(0, 60),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      plan: null,
      purchases: [],
    };
    accounts.set(account.id, account);
  } else if (name) {
    account.name = String(name).slice(0, 60);
  }
  save();
  return { account, created };
}

export function getAccount(id) {
  return accounts.get(String(id || '')) || null;
}

/** فقط فیلدهای عمومی (بدون پسورد و اطلاعات حساس) */
export function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    createdAt: account.createdAt,
    hasPassword: !!account.passwordHash,
  };
}

export function planStatus(account) {
  if (!account) return { linked: false, active: false, plan: null, expiresAt: null, daysLeft: 0 };
  const p = account.plan;
  if (!p) return { linked: true, active: false, plan: null, expiresAt: null, daysLeft: 0 };
  const active = p.expiresAt > Date.now();
  return {
    linked: true,
    active,
    plan: {
      id: p.id,
      name: p.name,
      monthly: p.monthly,
      months: p.months,
      startedAt: p.startedAt,
      expiresAt: p.expiresAt,
    },
    expiresAt: p.expiresAt,
    daysLeft: Math.max(0, Math.ceil((p.expiresAt - Date.now()) / DAY)),
  };
}

/**
 * فعال‌سازی/تمدید پلن. در نسخهٔ واقعی این تابع بعد از callback درگاه صدا زده
 * می‌شود؛ این‌جا پرداخت «دمو» ثبت می‌شود تا کل جریان قابل تست باشد.
 */
export function purchase(accountId, planId, months = 1) {
  const account = getAccount(accountId);
  if (!account) throw new Error('حساب پیدا نشد');
  const plan = planById(planId);
  if (!plan) throw new Error('پلن نامعتبر است');
  const m = Math.max(1, Math.min(36, Number(months) || 1));
  const start = Math.max(Date.now(), account.plan?.expiresAt || 0);
  const expiresAt = start + m * 30 * DAY;
  const payment = {
    ref: 'pay_' + crypto.randomBytes(5).toString('hex'),
    at: Date.now(),
    amount: plan.monthly * m,
    currency: 'IRT',
    status: 'paid',
    provider: 'demo',
    planId: plan.id,
    months: m,
  };
  account.plan = { id: plan.id, name: plan.name, monthly: plan.monthly, months: m, startedAt: Date.now(), expiresAt };
  account.purchases = [...(account.purchases || []), payment].slice(-20);
  save();
  return { account, plan: planStatus(account), payment };
}

/** اتصال سشن به حساب (اختیاری؛ سشن ناشناس هم کار می‌کند) */
export function linkSession(session, accountId) {
  const account = getAccount(accountId);
  if (!account) return null;
  session.accountId = account.id;
  return account;
}
