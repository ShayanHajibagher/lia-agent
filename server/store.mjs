/**
 * store.mjs — نگهداری سشن‌ها و پیام‌ها
 *
 * فعلاً فایل JSON (`.data/state.json`) کافی است: بدون دیتابیس، قابل دیپلوی روی یک
 * پلتفرم Node و قابل بررسی. برای تولید، همین رابط به Postgres منتقل می‌شود.
 */
import fs from 'node:fs';
import { DATA_DIR as DATA_ROOT } from './paths.mjs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = DATA_ROOT;
const FILE = path.join(DATA_DIR, 'state.json');

/** @type {Map<string, any>} */
const sessions = new Map();
/** @type {Map<string, any>} */
const runs = new Map();
let saveTimer = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const s of raw.sessions || []) {
      // اجرای دیپلوی فقط در حافظه است؛ بعد از ری‌استارت دیگر وجود ندارد
      if (s.deployRunId) {
        s.deployRunId = null;
        if (s.stage === 'deploying') s.stage = s.analysis ? 'ready' : 'greet';
      }
      if (s.agent) {
        s.agent.messages = [];
        s.agent.pending = null;
        s.agent.demo = null;
        s.agent.threadId = null;
        s.agent.status = 'idle';
      }
      if (Array.isArray(s.messages) && s.messages.length > 2000) s.messages = s.messages.slice(-2000);
      sessions.set(s.id, s);
    }
    for (const r of raw.runs || []) runs.set(r.id, r);
  } catch {
    /* اولین اجرا */
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 400);
}

export function persistNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const sessionsOut = [...sessions.values()].map((s) => ({
      ...s,
      messages: s.messages || [],
      // وضعیت موقت ایجنت (تاریخچهٔ ابزارها/حافظهٔ گراف) ذخیره نمی‌شود
      agent: s.agent
        ? { notes: (s.agent.notes || []).slice(-20), status: 'idle', mode: s.agent.mode || null }
        : undefined,
      analysis: s.analysis
        ? { ...s.analysis, tree: undefined, files: undefined }
        : null,
    }));
    const payload = {
      savedAt: new Date().toISOString(),
      sessions: sessionsOut,
      runs: [...runs.values()].slice(-100),
    };
    fs.writeFileSync(FILE, JSON.stringify(payload), 'utf8');
  } catch (e) {
    console.error('ذخیرهٔ وضعیت ناموفق بود:', e.message);
  }
}

load();
process.on('exit', persistNow);

/* ---------------- سشن ---------------- */

export function createSession(meta = {}) {
  const session = {
    id: 's_' + crypto.randomBytes(8).toString('hex'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accountId: meta.accountId || null,
    mode: 'idle', // idle | choose | guided | auto | agent | chat
    stage: 'greet', // بسته به حالت
    messages: [],
    context: { path: '/', title: '', headings: [] },
    requirement: {},
    analysis: null,
    intake: null,
    quote: null,
    deployRunId: null,
    deploySummary: null,
    guided: { stepId: null, done: [] },
    agent: {},
    ...meta,
  };
  sessions.set(session.id, session);
  scheduleSave();
  return session;
}

export function getSession(id) {
  const s = sessions.get(id);
  if (s) s.updatedAt = Date.now();
  return s || null;
}

export function touch(session) {
  session.updatedAt = Date.now();
  scheduleSave();
}

export function addMessage(session, message) {
  const msg = {
    id: 'm_' + crypto.randomBytes(5).toString('hex'),
    at: Date.now(),
    ...message,
  };
  session.messages = session.messages || [];
  session.messages.push(msg);
  if (session.messages.length > 2000) session.messages.splice(0, session.messages.length - 2000);
  touch(session);
  return msg;
}

/* ---------------- اجراها ---------------- */

export function saveRun(run) {
  runs.set(run.id, run);
  scheduleSave();
}

export function getRun(id) {
  return runs.get(id) || null;
}

/* ---------------- فهرست و حذف سشن‌ها (تاریخچه مخصوص کاربران عضو) ---------------- */

export function listSessions(accountId = null) {
  if (!accountId) return [];
  const list = [];
  for (const s of sessions.values()) {
    if (s.accountId !== accountId) continue;
    const messages = s.messages || [];
    const firstUserMsg = messages.find((m) => m.role === 'user' && m.kind === 'text');
    const lastMsg = messages[messages.length - 1];

    const appName = s.analysis?.app?.name || s.deploySummary?.appName || null;
    const title = appName
      ? `پروژه ${appName}`
      : firstUserMsg?.text
        ? String(firstUserMsg.text).slice(0, 45).trim()
        : 'گفتگوی تازه';

    const platform = s.analysis?.app?.platform || null;
    const deployStatus = s.deploySummary
      ? (s.deploySummary.status === 'success' || s.deploySummary.success ? 'success' : 'failed')
      : (s.deployRunId ? 'deploying' : null);

    list.push({
      id: s.id,
      accountId: s.accountId,
      title,
      appName,
      platform,
      mode: s.mode || 'idle',
      stage: s.stage || 'greet',
      deployStatus,
      deployUrl: s.deploySummary?.url || null,
      messageCount: messages.length,
      lastMessage: lastMsg?.text ? String(lastMsg.text).slice(0, 70) : null,
      createdAt: s.createdAt || Date.now(),
      updatedAt: s.updatedAt || Date.now(),
    });
  }

  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function deleteSession(id, accountId = null) {
  const session = sessions.get(id);
  if (!session) return false;
  if (accountId && session.accountId && session.accountId !== accountId) {
    return false;
  }
  sessions.delete(id);
  scheduleSave();
  return true;
}

