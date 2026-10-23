/**
 * steps.mjs — دانش «راهنمای مرحله‌به‌مرحله»
 *
 * هر مرحله: کجا برو (route)، کجا کلیک کن (selector)، چرا (why)، و چطور مطمئن شویم
 * انجام شده (check). ویجت با selector، عنصر هدف را هایلایت می‌کند.
 */
import fs from 'node:fs';
import path from 'node:path';

const data = JSON.parse(fs.readFileSync(path.resolve('knowledge/steps.json'), 'utf8'));
const STEPS = data.steps;

export const STEP_COUNT = STEPS.length;

function fill(value, vars) {
  if (!value || !vars) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

export function resolveStep(step, vars = {}) {
  return {
    ...step,
    selector: fill(step.selector, vars),
    action: fill(step.action, vars),
    title: fill(step.title, vars),
  };
}

export function stepById(id) {
  return STEPS.find((s) => s.id === id) || null;
}

export function indexOf(id) {
  return STEPS.findIndex((s) => s.id === id);
}

/** چه مرحله‌ای با این مسیر مطابقت دارد؟ (دقیق‌ترین مسیر) */
export function stepForPath(pagePath) {
  if (!pagePath) return null;
  const normalized = pagePath.endsWith('/') ? pagePath : pagePath + '/';
  let best = null;
  for (const step of STEPS) {
    const route = step.route.endsWith('/') ? step.route : step.route + '/';
    const match = route === '/' ? normalized === '/' : normalized.startsWith(route);
    if (match && (!best || route.length > (best.route.length || 0))) best = step;
  }
  return best;
}

/**
 * وضعیت مسیر کاربر: مرحلهٔ جاری + مراحل انجام‌شده
 * @param {{pagePath?: string, done?: string[], stepId?: string}} s
 */
export function progress(s = {}) {
  const byPath = stepForPath(s.pagePath);
  const currentId = s.stepId || byPath?.id || STEPS[0].id;
  const currentIndex = Math.max(0, indexOf(currentId));
  const done = new Set(s.done || []);
  for (let i = 0; i < currentIndex; i++) done.add(STEPS[i].id);
  return {
    steps: STEPS.map((step, i) => ({
      id: step.id,
      title: step.title,
      route: step.route,
      done: done.has(step.id) && step.id !== currentId,
      current: step.id === currentId,
      index: i,
    })),
    current: STEPS[currentIndex],
    currentIndex,
    next: STEPS[currentIndex + 1] || null,
    done: [...done],
  };
}

/** آیا کاربر از مرحلهٔ قبلی جلوتر رفته؟ (برای پیام «خوب، مرحله بعد») */
export function advancedFrom(prevStepId, pagePath) {
  const now = stepForPath(pagePath);
  if (!now) return null;
  if (!prevStepId) return now;
  return indexOf(now.id) > indexOf(prevStepId) ? now : null;
}
