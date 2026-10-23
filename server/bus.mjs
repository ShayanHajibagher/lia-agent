/**
 * bus.mjs — گذرگاه رویدادهای زندهٔ هر سشن
 *
 * هر کاری که سرور انجام می‌دهد (ابزار ایجنت، مرحلهٔ دیپلوی، تماس با مدل، آپلود،
 * تأییدها) یک خط لاگ واقعی با زمان دقیق تولید می‌کند؛ ویجت با SSE همین‌ها را
 * زنده می‌گیرد و در پنل «لاگ زنده» نشان می‌دهد.
 */
const buffers = new Map(); // sessionId -> entries[]
const subscribers = new Map(); // sessionId -> Set<fn>
const MAX = 400;
let seq = 0;

export function publish(sessionId, entry) {
  if (!sessionId) return;
  const item = { n: ++seq, at: Date.now(), ...entry };
  const list = buffers.get(sessionId) || [];
  list.push(item);
  if (list.length > MAX) list.splice(0, list.length - MAX);
  buffers.set(sessionId, list);

  const subs = subscribers.get(sessionId);
  if (subs) for (const fn of subs) {
    try {
      fn(item);
    } catch {
      /* مشترک خراب نباید بقیه را بشکند */
    }
  }
}

export function logLine(sessionId, source, text, level = 'dim') {
  publish(sessionId, { source, text, level });
}

export function recent(sessionId, limit = 150) {
  const list = buffers.get(sessionId) || [];
  return list.slice(-limit);
}

export function subscribe(sessionId, fn) {
  const set = subscribers.get(sessionId) || new Set();
  set.add(fn);
  subscribers.set(sessionId, set);
  return () => {
    set.delete(fn);
    if (!set.size) subscribers.delete(sessionId);
  };
}

export function clear(sessionId) {
  buffers.delete(sessionId);
}
