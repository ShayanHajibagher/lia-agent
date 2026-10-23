/**
 * plans.mjs — موتور قطعی محاسبهٔ پلن
 *
 * قاعدهٔ اصلی: عدد پلن را LLM نمی‌سازد. ورودی‌ها (نوع برنامه، بازدید ماهانه، مدت،
 * دیتابیس، دیسک) به یک تخمین منابع تبدیل می‌شوند و از کاتالوگ رسمی، کوچک‌ترین
 * پلنی که جواب می‌دهد انتخاب می‌شود. LLM فقط توضیح می‌دهد.
 */
import fs from 'node:fs';
import path from 'node:path';

const catalogPath = path.resolve('knowledge/plans.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const plans = catalog.plans;

export const PLAN_CATALOG = catalog;

const AVG_SESSION_SECONDS = 180; // مدت متوسط حضور هر بازدید
const PEAK_FACTOR = 3; // ترافیک ساعت پیک نسبت به میانگین
const MONTH_SECONDS = 30 * 24 * 3600;
const PAGE_MB = 1.4; // میانگین حجم دانلود هر بازدید (HTML+تصویر+فونت)
const HEADROOM = 1.3;

export function planById(id) {
  return plans.find((p) => p.id === id) || null;
}

function pickTier(need) {
  const byRam = plans.find((p) => p.ramGb >= need.ramGb);
  if (!byRam) return plans[plans.length - 1];
  // حداقل CPU بر اساس نوع بار
  const cpuOk = plans.find((p) => p.ramGb >= need.ramGb && p.vcpu >= need.vcpu);
  return cpuOk || byRam;
}

/**
 * @param {object} req
 * @param {string} req.platform      کلید پلتفرم (nextjs, static, laravel, ...)
 * @param {number} req.visitors      بازدید ماهانه (یا کاربر)
 * @param {number} req.months        مدت میزبانی
 * @param {boolean} [req.needsDb]
 * @param {number} [req.uploadsGb]   حجم فایل‌های پایدار
 * @param {number} [req.heavyDeps]   تعداد وابستگی‌های سنگین (ffmpeg، ML، …)
 */
export function quote(req) {
  const platform = catalog.platformRamBase[req.platform] !== undefined ? req.platform : 'nodejs';
  const visitors = Math.max(0, Number(req.visitors) || 0);
  const months = Math.max(1, Math.min(36, Number(req.months) || 1));
  const heavyDeps = Math.max(0, Math.min(4, Number(req.heavyDeps) || 0));
  const uploadsGb = Math.max(0, Math.min(500, Number(req.uploadsGb) || 0));

  const baseRam = catalog.platformRamBase[platform];
  const perConn = catalog.platformRamPerConnection[platform];
  const concurrency = Math.max(1, Math.round(((visitors * AVG_SESSION_SECONDS) / MONTH_SECONDS) * PEAK_FACTOR));

  const rawRam = baseRam + concurrency * perConn + heavyDeps * 0.25;
  const ramNeed = Math.round((rawRam * HEADROOM + Number.EPSILON) * 1000) / 1000;
  const vcpuNeed = platform === 'static' ? 0.5 : heavyDeps > 0 || req.needsDb ? 2 : 1;
  const diskNeed = Math.round((2 + uploadsGb * 1.2 + (heavyDeps > 0 ? 4 : 0)) * 10) / 10;

  const tier = pickTier({ ramGb: ramNeed, vcpu: vcpuNeed });
  const dbTier = req.needsDb ? tier : null;

  const trafficGb = Math.round((visitors * PAGE_MB) / 1024);
  const trafficCost = trafficGb * catalog.trafficPerGbDownload;

  const appCost = tier.monthly;
  const dbCost = dbTier ? dbTier.monthly : 0;
  const monthlyTotal = appCost + dbCost + trafficCost;

  const index = plans.indexOf(tier);
  const cheaper = index > 0 ? plans[index - 1] : null;
  const growth = index < plans.length - 1 ? plans[index + 1] : null;

  const assumptions = [
    `میانگین هر بازدید ${AVG_SESSION_SECONDS} ثانیه و ضریب پیک ${PEAK_FACTOR} در نظر گرفته شد`,
    `هم‌زمانی تخمینی: حدود ${concurrency} کاربر`,
    `ترافیک ماهانه: حدود ${trafficGb} گیگابایت (هر گیگ دانلود ${catalog.trafficPerGbDownload.toLocaleString('fa-IR')} تومان)`,
    `فضای دیسک موردنیاز: حدود ${diskNeed} گیگابایت`,
  ];
  if (req.needsDb) assumptions.push('دیتابیس با همان سطح پلن برنامه محاسبه شد');

  return {
    catalogVersion: catalog.version,
    inputs: { platform, visitors, months, needsDb: !!req.needsDb, uploadsGb, heavyDeps },
    estimate: { concurrency, ramNeed, vcpuNeed, diskNeed, trafficGb },
    plan: tier,
    dbPlan: dbTier,
    cost: {
      appMonthly: appCost,
      dbMonthly: dbCost,
      trafficMonthly: trafficCost,
      monthlyTotal,
      periodTotal: monthlyTotal * months,
      months,
    },
    cheaper,
    growth,
    assumptions,
  };
}

export function formatToman(n) {
  return `${Number(n).toLocaleString('fa-IR')} تومان`;
}

/** کارت پلن برای نمایش در چت */
export function planCard(q, opts = {}) {
  const p = q.plan;
  return {
    kind: 'plan',
    title: `پیشنهاد لیا: پلن ${p.name}`,
    planId: p.id,
    planName: p.name,
    specs: { ram: p.ramGb, vcpu: p.vcpu, disk: p.diskGb },
    db: q.dbPlan ? { name: q.dbPlan.name, monthly: q.dbPlan.monthly } : null,
    cost: q.cost,
    estimate: q.estimate,
    assumptions: q.assumptions,
    cheaper: q.cheaper && { name: q.cheaper.name, monthly: q.cheaper.monthly },
    growth: q.growth && { name: q.growth.name, monthly: q.growth.monthly },
    catalogVersion: q.catalogVersion,
    purchaseUrl: '/panel/apps/new/plan/',
    evidence: 'https://liara.ir/pricing/',
    ...opts,
  };
}
