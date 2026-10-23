/**
 * orchestrator.mjs — مغز گفتگو
 *
 * دو حالت (طبق نیازمندی):
 *  - guided: راهنمایی مرحله‌به‌مرحله؛ فقط «کجا برو، کجا کلیک کن» + پاسخ به سؤال
 *    بر اساس مرحلهٔ فعلی. وضعیت با تغییر صفحه به‌روز می‌شود.
 *  - auto: پرسیدن جنس برنامه/مخاطب/مدت → پیشنهاد پلن (کارت) → دریافت سورس →
 *    دیپلوی با تأیید مرحله‌به‌مرحله + گزارش باگ.
 *
 * جریان‌ها عمداً «قطعی» هستند (state machine)؛ مدل زبانی فقط برای پاسخ به
 * سؤال‌های آزاد استفاده می‌شود تا اعداد و مراحل قابل اتکا بمانند.
 */
import { addMessage, touch } from './store.mjs';
import { quote, planCard, PLAN_CATALOG } from './plans.mjs';
import { progress, stepForPath, resolveStep, stepById } from './steps.mjs';
import { answerQuestion, answerInstruction, llmInfo, llmStatus } from './llm.mjs';
import { createRun, advance, approve, reject, stopHere, fixBug, retryStep, setRepair, snapshot, getRun, isSimulated } from './deploy.mjs';
import { diagnoseFailure, applyRepairs, describeApplied } from './repair.mjs';
import { runAgent, resumeAgent, agentState, resetAgentMemory } from './agent.mjs';
import { assessSuitability, applyAdaptations } from './suitability.mjs';
import { fileTree, readAllFiles, readFile as readWorkspaceFile, writeFile as writeWorkspaceFile, projectFingerprint } from './workspace.mjs';
import { findReusable, list as listDeployments, get as getDeployment } from './registry.mjs';
import { planDeploy } from './planner.mjs';
import { analyzeFiles } from './analyzer.mjs';
import { logLine } from './bus.mjs';
import { getAccount, planStatus, publicAccount } from './account.mjs';

/* ---------------- کمکی‌ها ---------------- */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function toNumber(text) {
  if (typeof text === 'number') return text;
  const normalized = String(text || '')
    .replace(/[۰-۹]/g, (d) => FA_DIGITS.indexOf(d))
    .replace(/,/g, '')
    .replace(/٬/g, '');
  const m = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  let n = Number(m[1]);
  if (/هزار|k\b/i.test(normalized)) n *= 1000;
  if (/میلیون|m\b/i.test(normalized)) n *= 1_000_000;
  return n;
}

/* ---------------- پیام‌های متنی: یکی در هر نوبت ---------------- */

/**
 * پیام‌های متنی که پشت سر هم در یک نوبت تولید می‌شوند با هم ادغام می‌شوند تا
 * کاربر به‌جای ۵–۶ پیام جدا، یک پیام با پاراگراف‌های کوتاه ببیند.
 * ارسال با کمی تأخیر انجام می‌شود و در پایان هر نوبت (flushSay) قطعی می‌شود.
 */
const sayBuf = new Map();

function say(session, emit, text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const queued = sayBuf.get(session.id);
  if (queued) {
    if (!queued.texts.includes(clean)) queued.texts.push(clean);
    return null;
  }
  const entry = { session, emit, texts: [clean], timer: null };
  entry.timer = setTimeout(() => flushSay(session.id), 220);
  sayBuf.set(session.id, entry);
  return null;
}

/** متن‌های صف‌شده را به‌صورت یک پیام می‌فرستد (پایان نوبت یا قبل از کارت) */
export function flushSay(sessionId) {
  const entry = sayBuf.get(sessionId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  sayBuf.delete(sessionId);
  const text = entry.texts.join('\n\n');
  const msg = addMessage(entry.session, { kind: 'text', role: 'lia', text });
  try {
    entry.emit({ t: 'msg', msg });
  } catch {
    /* استریم بسته شده؛ پیام در سشن ذخیره شده است */
  }
  return msg;
}

/** همهٔ متن‌های صف‌شده را می‌فرستد (پایان مسیرهای API) */
export function flushAllSays() {
  for (const id of [...sayBuf.keys()]) flushSay(id);
}

function card(session, emit, cardPayload) {
  // متن‌های صف‌شده اول می‌روند تا ترتیب «حرف → کارت» حفظ شود
  flushSay(session.id);
  const msg = addMessage(session, { kind: 'card', role: 'lia', card: cardPayload });
  emit({ t: 'msg', msg });
  return msg;
}

async function streamAnswer(session, emit, question, extra = {}) {
  emit({ t: 'typing', on: true });
  const placeholder = addMessage(session, { kind: 'text', role: 'lia', text: '' });
  emit({ t: 'msg_start', msg: placeholder });
  let full = '';
  try {
    await answerQuestion({
      session,
      question,
      extra,
      onDelta: (delta) => {
        full += delta;
        emit({ t: 'delta', id: placeholder.id, text: delta });
      },
    });
  } finally {
    placeholder.text = full.trim();
    touch(session);
    emit({ t: 'msg_end', msg: placeholder });
    emit({ t: 'typing', on: false });
  }

  // اگر سرویس مدل خطا داد (مثلاً کلید فعال نیست)، یک بار صریح بگو
  if (session.llmNotice && !session.llmNoticeShown) {
    session.llmNoticeShown = true;
    const n = session.llmNotice;
    say(
      session,
      emit,
      `⚠️ سرویس مدل پاسخ نداد (${n.code || n.status || 'خطا'}). فعلاً با حالت دمو جواب می‌دهم؛ جریان‌ها کامل کار می‌کنند.` +
        (n.hint ? `\n${n.hint}` : ''),
    );
  }
  return placeholder;
}

const INTENTS = {
  deploy: /(دیپلوی|دپلوی|deploy|بالا بیار|منتشر|انتشار|سایت(م|مو)|برنامه(م|مو)|آپلود)/i,
  plan: /(پلن|قیمت|هزینه|چقدر|تعرفه|اشتراک)/i,
  stuck: /(گیر|خطا|ارور|مشکل|نمیش|نمی‌شه|کار نمی)/i,
  greeting: /^(سلام|درود|هی|خوبی|hi|hello)/i,
};

/**
 * «همین رو دوباره دیپلوی کن» — یعنی پروژه از قبل هست، فایل تازه لازم نیست.
 * عمداً باریک است تا با «دوباره امتحان کن» یا «دوباره بیلد کن» قاطی نشود.
 */
const REDEPLOY_INTENT =
  /(همین|همون|همان).{0,15}(دوباره|مجدد|باز).{0,10}(دیپلوی|deploy|بالا|اجرا|منتشر)|(دوباره|مجدد).{0,12}(همین|همون|همان).{0,10}(دیپلوی|deploy)|(دیپلوی|deploy).{0,12}(دوباره|مجدد)\s*(کن|کنم|کنی)?\s*[؟?]?$|(همین|همون)\s*(رو|را)?\s*(دیپلوی|deploy)\s*(کن|کنم)/i;

const PLATFORM_BY_KIND = [
  [/next|نکست|ری‌اکت|react/i, 'nextjs'],
  [/لاراول|laravel|وردپرس|wordpress|php/i, 'laravel'],
  [/جنگو|django/i, 'django'],
  [/فلاسک|flask/i, 'flask'],
  [/استاتیک|static|html|صفحه ساده/i, 'static'],
  [/گولنگ|go\b/i, 'go'],
  [/داکر|docker/i, 'docker'],
  [/node|نود|api|ای‌پی‌آی|express|nestjs/i, 'nodejs'],
];

function platformForKind(kind) {
  for (const [re, platform] of PLATFORM_BY_KIND) if (re.test(kind || '')) return platform;
  return 'nodejs';
}

/* ---------------- ورود ---------------- */

export async function greet(session, emit) {
  await narrate(
    session,
    emit,
    'به کاربر خوش‌آمد بگو: خودت را کوتاه معرفی کن و بگو می‌توانی مرحله‌به‌مرحله راهنمایی کنی یا دیپلوی را با اجازهٔ او انجام دهی. حداکثر دو جمله. هیچ کاری را انجام‌شده اعلام نکن.',
    'سلام! من لیا هستم، دستیار دیپلوی. می‌توانم مرحله‌به‌مرحله راهنمایی‌ات کنم یا با اجازهٔ تو دیپلوی را انجام دهم.',
  );
  card(session, emit, {
    kind: 'chips',
    title: 'از کجا شروع کنیم؟',
    items: [
      { label: 'می‌خوام سایتم رو دیپلوی کنم', action: 'intent_deploy' },
      { label: 'پلن مناسبم چیه؟', action: 'intent_plan' },
      { label: 'همه کارها را به لیا بسپار', action: 'mode', value: 'agent' },
      { label: 'دیپلوی‌ام گیر کرده', action: 'intent_stuck' },
    ],
  });
}

/**
 * «روایت» رویداد واقعی توسط مدل.
 *
 * قاعده: متن چت را مدل می‌نویسد، ولی فقط بر اساس دادهٔ واقعیِ همان رویداد؛
 * هیچ ادعای موفقیت/عددی از خودش اضافه نمی‌کند. اگر مدل در دسترس نباشد،
 * یک جملهٔ کوتاه و واقعیت‌محور (fallback) گذاشته می‌شود.
 */
/** رقم‌های فارسی/عربی را به لاتین و بدون جداکننده تبدیل می‌کند */
function normalizeDigits(value) {
  return String(value ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[٬,،\s]/g, '');
}

/** همهٔ عددهای متن باید در فهرست مجاز باشند (تطابق کامل) */
function numbersAllowed(text, allowed) {
  if (!Array.isArray(allowed) || !allowed.length) return true;
  const pool = new Set(allowed.map((n) => normalizeDigits(n)).filter(Boolean));
  const found = normalizeDigits(text).match(/\d+/g) || [];
  return found.every((n) => pool.has(n));
}

/**
 * «روایت» رویداد واقعی توسط مدل.
 *
 * `opts.numbers` = فهرست اعداد مجاز. اگر متن مدل عدد دیگری بسازد، به‌جای آن
 * متن قطعی (fallback) گذاشته می‌شود. در این حالت استریم نمی‌کنیم تا کاربر
 * عدد اشتباه نبیند.
 */
async function narrate(session, emit, instruction, fallback, opts = {}) {
  flushSay(session.id);
  if (!llmInfo().configured) {
    if (fallback) say(session, emit, fallback);
    return;
  }

  // مسیر حساس به عدد: کامل بگیر، اعتبارسنجی کن، بعد یک‌جا بفرست
  if (Array.isArray(opts.numbers)) {
    emit({ t: 'typing', on: true });
    let full = '';
    try {
      full = await answerInstruction({ session, instruction });
    } catch {
      full = '';
    }
    // هر عددی که در خودِ دادهٔ واقعی (instruction) آمده مجاز است
    const fromFacts = normalizeDigits(instruction).match(/\d+/g) || [];
    const pool = [...opts.numbers, ...fromFacts];
    const ok = !!full && !!full.trim() && numbersAllowed(full, pool);
    if (!ok && full && full.trim()) {
      logLine(
        session.id,
        'model',
        'عدد نامعتبر در روایت مدل بود؛ متن قطعی جایگزین شد — ' + String(full).slice(0, 120),
        'warn',
      );
    }
    say(session, emit, ok ? full.trim() : fallback || '');
    emit({ t: 'typing', on: false });
    touch(session);
    return;
  }

  emit({ t: 'typing', on: true });
  const placeholder = addMessage(session, { kind: 'text', role: 'lia', text: '' });
  emit({ t: 'msg_start', msg: placeholder });

  const full = await answerInstruction({
    session,
    instruction,
    onDelta: (delta) => emit({ t: 'delta', id: placeholder.id, text: delta }),
  });

  placeholder.text = (full && full.trim()) || fallback || '';
  touch(session);
  emit({ t: 'msg_end', msg: placeholder });
  emit({ t: 'typing', on: false });
}
/* ---------------- ورودی چت ---------------- */

export async function handleChat(session, rawText, emit) {
  const text = String(rawText || '').trim();
  if (!text) return;

  addMessage(session, { kind: 'text', role: 'user', text });
  emit({ t: 'msg', msg: session.messages[session.messages.length - 1] });

  const numeric = toNumber(text);

  /* --------- حالت چت/خودمختار: همهٔ کارها با ایجنت --------- */
  if (session.mode === 'agent' || session.mode === 'chat') {
    return runAgent(session, emit, text, agentIO(session, emit));
  }

  /* --------- حالت خودکار --------- */
  if (session.mode === 'auto') {
    // اگر دیپلوی تمام شده، از «حالت دیپلوی» بیرون بیا و به چت برگرد
    if (deploySettled(session)) {
      enterChatMode(session);
      return runAgent(session, emit, text, agentIO(session, emit));
    }

    if (session.stage === 'ask_app') {
      session.requirement.appKind = text;
      session.requirement.platform = platformForKind(text);
      session.stage = 'ask_audience';
      await narrate(
        session,
        emit,
        'کاربر گفت برنامه‌اش «' + text + '» است. در یک جملهٔ کوتاه بپرس تقریباً چند نفر در ماه از آن استفاده می‌کنند. عدد یا گزینه بدهد.',
        'حالا تقریباً چند نفر در ماه از آن استفاده می‌کنند؟ (عدد بگو یا یکی از گزینه‌ها را بزن)',
      );
      card(session, emit, {
        kind: 'chips',
        title: 'مقیاس استفاده',
        items: [100, 1000, 10000, 100000].map((n) => ({
          label: `${n.toLocaleString('fa-IR')} بازدید در ماه`,
          action: 'answer',
          value: String(n),
        })),
      });
      touch(session);
      return;
    }

    if (session.stage === 'ask_audience') {
      const visitors = numeric && numeric > 0 ? Math.round(numeric) : 1000;
      session.requirement.visitors = visitors;
      session.stage = 'ask_duration';
      await narrate(
        session,
        emit,
        'کاربر گفت حدود ' + visitors + ' بازدید در ماه دارند. در یک جملهٔ کوتاه بپرس سایت چند ماه باید روی هاست بماند.',
        'این سایت قرار است چند ماه روی هاست بماند؟',
      );
      card(session, emit, {
        kind: 'chips',
        title: 'مدت میزبانی',
        items: [1, 3, 6, 12].map((m) => ({ label: `${m.toLocaleString('fa-IR')} ماه`, action: 'answer', value: String(m) })),
      });
      touch(session);
      return;
    }

    if (session.stage === 'ask_duration') {
      const months = numeric && numeric >= 1 && numeric <= 36 ? Math.round(numeric) : 1;
      session.requirement.months = months;
      await computeQuote(session, emit);
      return;
    }

    if (session.stage === 'offer') {
      if (/(گرفتم|خریدم|پرداخت|خرید کردم|اوکی|شروع|بله)/i.test(text)) {
        return askIntake(session, emit);
      }
      if (/(ارزان|کمتر|گران|بیشتر|پلن دیگر|پلن دیگه|تغییر پلن)/i.test(text)) {
        const q = session.quote;
        const alt = q.cheaper || q.growth;
        if (alt) {
          await narrate(
            session,
            emit,
            'این دادهٔ واقعی پلن جایگزین است (JSON):\n' +
              JSON.stringify({ plan: alt.name, monthly: alt.monthly, current: q.plan.name, currentMonthly: q.plan.monthly }) +
              '\n\nدر یک جملهٔ کوتاه فقط همین را بگو و پیشنهاد بده محاسبه برای همین پلن انجام شود. عدد جدید نساز.',
            `گزینهٔ ${alt === q.cheaper ? 'ارزان‌تر' : 'بزرگ‌تر'} «${alt.name}» است با ${alt.monthly.toLocaleString('fa-IR')} تومان در ماه. اگر بخواهی محاسبه را برای همین پلن هم انجام می‌دهم.`,
            { numbers: [alt.monthly, q.plan.monthly] },
          );
          touch(session);
          return;
        }
        return streamAnswer(session, emit, text);
      }
      return streamAnswer(session, emit, text);
    }

    if (session.stage === 'intake') {
      const gh = text.match(/https?:\/\/(?:github\.com|gitlab\.com|gitlab\.ir)\/[^\s]+/i);
      if (gh) return importRepo(session, emit, gh[0], 'github');
      // به‌جای سکوت، راه درست را نشان بده (قبلاً این ورودی هیچ پاسخی نمی‌گرفت)
      say(
        session,
        emit,
        'برای ادامه یکی از این دو راه: فایل zip پروژه را از دکمهٔ زیر آپلود کن، یا لینک مخزن گیت‌هاب را همین‌جا بفرست.',
      );
      card(session, emit, { kind: 'intake', title: 'سورس پروژه', hint: 'zip بدون node_modules بهتر است.' });
      touch(session);
      return;
    }

    // ready / deploying: پاسخ با آگاهی از وضعیت دیپلوی
    return streamAnswer(session, emit, text, { deploy: session.deploySummary });
  }

  /* --------- حالت راهنما --------- */
  if (session.mode === 'guided') {
    const p = progress({ pagePath: session.context.path, stepId: session.guided.stepId, done: session.guided.done });
    session.guided.stepId = p.current.id;

    if (/(کجا|مرحله|بعدی|چیکار|چه کار|راهنما)/i.test(text)) {
      emitStepCard(session, emit, p.current, p);
      say(
        session,
        emit,
        `الان مرحلهٔ «${p.current.title}» است. ${p.current.action}` +
          (p.next ? ` بعدش می‌رسیم به «${p.next.title}».` : '') +
          ` (صفحهٔ فعلی تو: ${session.context.path || '/'})`,
      );
      return;
    }

    // آخرین مرحلهٔ راهنما: کار تمام است؛ برو به حالت چت تا در «مرحله» گیر نکند
    if (!p.next && p.currentIndex === p.steps.length - 1) {
      enterChatMode(session);
      await narrate(
        session,
        emit,
        'کاربر به آخرین مرحلهٔ راهنما رسیده است. در یک جمله تبریک بگو و بگو از اینجا در حالت چت هر سؤالی داشت جواب می‌دهی (لاگ، دامنه، متغیر، خطا).',
        'رسیدیم به آخرین مرحله؛ کار راهنما تمام شد. از اینجا در حالت چت هستم — هر سؤالی دربارهٔ لاگ، دامنه یا خطا داشتی بپرس.',
      );
      return runAgent(session, emit, text, agentIO(session, emit));
    }

    return streamAnswer(session, emit, text, { step: resolveStep(p.current) });
  }

  /* --------- حالت بی‌حالت --------- */
  if (/(خودمختار|همه کار|همه‌کار|هر کاری|بسپار|همه چیز|خودت همه)/i.test(text)) {
    startAgentMode(session, emit);
    return runAgent(session, emit, text, agentIO(session, emit));
  }

  // «همین پروژه را دوباره دیپلوی کن» → بدون آپلود دوباره
  if (REDEPLOY_INTENT.test(text) && !session.analysis) {
    const prior = findReusable({ session, fingerprint: session.projectFingerprint });
    if (prior) return offerReuse(session, emit, prior);
    say(session, emit, 'دیپلوی قبلی‌ای پیدا نکردم؛ اگر zip پروژه را بفرستی، از نو می‌سازم.');
    return;
  }

  if (INTENTS.deploy.test(text)) return offerModes(session, emit);
  if (INTENTS.plan.test(text)) return startAuto(session, emit);
  if (INTENTS.stuck.test(text)) {
    // وقتی مدل هست، خودش می‌پرسد و راهنمایی می‌کند (به‌جای متن ثابت)
    if (llmInfo().configured) return streamAnswer(session, emit, text, { focus: 'stuck' });
    say(session, emit, 'باشه، گیر را پیدا می‌کنیم. بگو در کدام مرحله‌ای (ساخت برنامه، انتخاب پلن، آپلود، بیلد) و چه پیامی می‌بینی. اگر متن خطا را بفرستی، دقیق‌تر می‌گویم.');
    return;
  }
  if (INTENTS.greeting.test(text)) {
    if (llmInfo().configured) return streamAnswer(session, emit, text, { focus: 'greeting' });
    say(session, emit, 'سلام! برای شروع بگو می‌خواهی سایتی را دیپلوی کنی یا اول پلن مناسب را حساب کنیم؟');
    return;
  }

  return streamAnswer(session, emit, text);
}

/** آیا اجرای دیپلوی این سشن به پایان رسیده است؟ */
function deploySettled(session) {
  const s = session.deploySummary;
  return !!s && ['success', 'stopped', 'stopped_by_user', 'failed'].includes(s.status);
}

/** سشن را از حالت دیپلوی/راهنما بیرون می‌آورد و به چت می‌برد */
function enterChatMode(session) {
  session.mode = 'chat';
  session.stage = 'chat';
  touch(session);
}

/* ---------------- حالت‌ها ---------------- */

export function offerModes(session, emit) {
  session.mode = 'choose';
  session.stage = 'modes';
  say(session, emit, 'دو راه داریم؛ هر کدام را راحت‌تری انتخاب کن:');
  card(session, emit, {
    kind: 'modes',
    title: 'می‌خواهی چطور کمک کنم؟',
    options: [
      {
        id: 'guided',
        title: 'راهنمایی مرحله‌به‌مرحله',
        desc: 'بهت می‌گم کجا برو و کجا کلیک کن؛ سؤال هم بپرسی جواب می‌دهم.',
        action: 'mode',
        value: 'guided',
        icon: '🧭',
      },
      {
        id: 'auto',
        title: 'خودت انجامش بده',
        desc: 'مدت و تعداد کاربر را می‌پرسم، پلن را پیشنهاد می‌دهم و با اجازهٔ تو دیپلوی می‌کنم.',
        action: 'mode',
        value: 'auto',
        icon: '🤖',
      },
    ],
  });
  touch(session);
}

/** ابزارهای say/card برای ایجنت خودمختار */
function agentIO(session, emit) {
  return {
    say: (text) => say(session, emit, text),
    card: (payload) => card(session, emit, payload),
  };
}

export async function startAgentMode(session, emit) {
  session.mode = 'agent';
  session.stage = 'agent';
  await narrate(
    session,
    emit,
    'به کاربر بگو از اینجا خودت کارها را انجام می‌دهی: خواندن کد، تحلیل، پیشنهاد پلن، دیپلوی. تأکید کن قبل از کارهای حساس اجازه می‌گیری. حداکثر دو جمله و بدون ادعای انجام کار.',
    'از اینجا خودم مختارم کارها را انجام دهم — خواندن کد، تحلیل، پیشنهاد پلن و دیپلوی؛ قبل از هر تغییر حساس اجازه می‌گیرم.',
  );
  touch(session);
}

export async function startAuto(session, emit) {
  session.mode = 'auto';
  session.stage = 'ask_app';
  await narrate(
    session,
    emit,
    'از کاربر بپرس برنامه‌اش چیست (مثلاً فروشگاه Next.js، سایت وردپرسی، API نود). یک سؤال کوتاه، بدون مقدمهٔ اضافه.',
    'برنامه‌ات چیست؟ (مثلاً فروشگاه با Next.js، سایت وردپرسی، API نود)',
  );
  card(session, emit, {
    kind: 'chips',
    title: 'نمونه‌ها',
    items: [
      { label: 'سایت Next.js', action: 'answer', value: 'سایت Next.js' },
      { label: 'فروشگاه Laravel', action: 'answer', value: 'فروشگاه Laravel' },
      { label: 'API با Node', action: 'answer', value: 'API با Node' },
      { label: 'سایت استاتیک', action: 'answer', value: 'سایت استاتیک' },
    ],
  });
  touch(session);
}

export async function computeQuote(session, emit, { quiet = false } = {}) {
  const r = session.requirement;
  const analysis = session.analysis;
  const q = quote({
    platform: analysis?.platform || r.platform || 'nodejs',
    visitors: r.visitors || 1000,
    months: r.months || 1,
    needsDb: analysis ? analysis.planInputs.needsDb : /فروشگاه|shop|دیتابیس|db/i.test(r.appKind || ''),
    uploadsGb: analysis?.planInputs.uploadsGb || 0,
    heavyDeps: analysis?.planInputs.heavyDeps || 0,
  });
  session.quote = q;
  session.stage = 'offer';

  const c = q.cost;
  card(session, emit, planCard(q, { cta: 'خرید کردم' }));

  // در جریان تحلیل، کارت پلن کافی است و روایت نهایی یک‌جا می‌آید (کمتر پیام)
  if (quiet) {
    touch(session);
    return q;
  }

  await narrate(
    session,
    emit,
    'این محاسبهٔ واقعی پلن است (JSON):\n' +
      JSON.stringify({
        plan: q.plan.name,
        ram: q.plan.ramGb,
        vcpu: q.plan.vcpu,
        disk: q.plan.diskGb,
        monthly: c.monthlyTotal,
        periodTotal: c.periodTotal,
        months: c.months,
        traffic: c.trafficMonthly,
        assumptions: q.assumptions,
        cheaper: q.cheaper ? { name: q.cheaper.name, monthly: q.cheaper.monthly } : null,
      }) +
      '\n\nدر دو جملهٔ کوتاه فقط همین اعداد را توضیح بده. عدد جدید نساز.',
    `پلن ${q.plan.name}: ماهی ${c.monthlyTotal.toLocaleString('fa-IR')} تومان؛ ${c.months} ماه: ${c.periodTotal.toLocaleString('fa-IR')} تومان.`,
    {
      numbers: [
        c.monthlyTotal,
        c.periodTotal,
        c.months,
        c.trafficMonthly,
        q.plan.ramGb,
        q.plan.vcpu,
        q.plan.diskGb,
        q.cheaper?.monthly,
      ].filter((n) => n !== undefined && n !== null),
    },
  );
  touch(session);
  return q;
}

export async function askIntake(session, emit) {
  session.stage = 'intake';
  await narrate(
    session,
    emit,
    'از کاربر بخواه سورس پروژه را بدهد: فایل zip آپلود کند یا لینک مخزن گیت‌هاب بفرستد. یک جملهٔ کوتاه.',
    'برای دیپلوی به سورس پروژه نیاز دارم: فایل zip را آپلود کن یا لینک گیت‌هاب را بفرست.',
  );
  card(session, emit, {
    kind: 'intake',
    title: 'سورس پروژه',
    hint: 'zip بدون node_modules بهتر است (کمتر آپلود می‌شود).',
  });
  touch(session);
}

/* ---------------- ورودی سورس ---------------- */

export async function handleAnalysis(session, emit, { analysis, source, fileName }) {
  session.analysis = analysis;
  session.intake = { kind: source, name: fileName || source, at: Date.now() };
  session.stage = 'ready';
  if (analysis.platform) session.requirement.platform = analysis.platform;

  // اثر انگشت پروژه: برای تشخیص «همین پروژه قبلاً دیپلوی شده»
  try {
    session.projectFingerprint = projectFingerprint(session.id);
  } catch {
    session.projectFingerprint = null;
  }
  const prior = session.projectFingerprint
    ? findReusable({ session, fingerprint: session.projectFingerprint, sameOwnerOnly: true })
    : null;
  session.reusable = prior ? { ...prior, analysis: undefined } : null;

  const a = analysis;
  card(session, emit, {
    kind: 'analysis',
    platform: a.platform,
    build: a.build,
    start: a.start,
    port: a.port,
    envKeys: a.envKeys,
    capabilities: a.capabilities,
    stats: a.stats,
    findings: a.findings,
  });

  logLine(
    session.id,
    'project',
    `تحلیل پروژه: پلتفرم ${a.platform}، ${a.stats.fileCount} فایل، ${a.findings.length} نکته`,
    'ok',
  );

  // همین پروژه قبلاً دیپلوی شده؟ → لازم نیست دوباره آپلود/نصب شود
  if (session.reusable) {
    const r = session.reusable;
    logLine(session.id, 'project', `این پروژه قبلاً به نام «${r.appName}» دیپلوی شده بود`, 'ok');
    card(session, emit, {
      kind: 'reuse',
      appName: r.appName,
      url: r.url,
      port: r.port,
      deployedAt: r.deployedAt,
      match: r.match,
      fingerprint: r.fingerprint,
      files: a.stats.fileCount,
    });
    say(
      session,
      emit,
      `این همان پروژه‌ای است که قبلاً به نام «${r.appName}» دیپلوی شده بود؛ لازم نیست دوباره بفرستی. ` +
        'اگر بخواهی همان را با همین فایل‌ها دوباره بالا می‌آورم.',
    );
  }

  // آیا این پروژه اصلاً برای هاست وب مناسب است؟
  const files = fileTree(session.id, 2000).map((rel) => ({ name: rel }));
  let suitability = { suitable: true, reasons: [], adaptations: [], canAdapt: false };
  try {
    suitability = assessSuitability(session, files, a);
  } catch (e) {
    logLine(session.id, 'project', 'ارزیابی مناسب‌بودن ناموفق بود: ' + e.message, 'err');
  }
  session.suitability = { ...suitability, assessedAt: Date.now() };

  if (!suitability.suitable) {
    logLine(session.id, 'project', `نامناسب برای هاست وب: ${suitability.reasons.map((r) => r.title).join('، ')}`, 'warn');
    card(session, emit, {
      kind: 'suitability',
      suitable: false,
      summary: suitability.summary,
      reasons: suitability.reasons,
      canAdapt: suitability.canAdapt,
      adaptations: suitability.adaptations.map((ad) => ({
        id: ad.id,
        title: ad.title,
        detail: ad.detail,
        files: ad.files.map((f) => f.path),
      })),
    });
  } else if (suitability.adaptations.length) {
    // مناسب است ولی یک بهبود پیشنهادی دارد
    card(session, emit, {
      kind: 'suitability',
      suitable: true,
      summary: suitability.summary,
      reasons: [],
      canAdapt: true,
      adaptations: suitability.adaptations.map((ad) => ({
        id: ad.id,
        title: ad.title,
        detail: ad.detail,
        files: ad.files.map((f) => f.path),
      })),
    });
  }
  // اگر پروژه سالم است، کارت اضافه نمی‌فرستیم؛ وضعیت در همان روایت گفته می‌شود.

  // پلن را با اطلاعات واقعی پروژه دوباره حساب کن (کارت، بدون روایت جداگانه)
  let quoted = false;
  if (session.requirement.visitors) {
    await computeQuote(session, emit, { quiet: true });
    quoted = true;
  } else {
    session.stage = 'ask_audience';
  }

  // روایت واقعی تحلیل: مدل فقط بر اساس همین داده‌ها می‌نویسد
  const facts = {
    platform: a.platform,
    files: a.stats.fileCount,
    build: a.build,
    start: a.start,
    port: a.port,
    envKeys: a.envKeys,
    findings: a.findings.map((f) => ({ title: f.title, severity: f.severity })),
    suitable: suitability.suitable,
    suitabilityReasons: suitability.reasons.map((r) => r.title),
    canAdapt: suitability.canAdapt,
    plan: quoted ? { name: session.quote.plan.name, monthly: session.quote.cost.monthlyTotal } : null,
  };
  await narrate(
    session,
    emit,
    'این دادهٔ واقعی تحلیل پروژه است (JSON):\n' +
      JSON.stringify(facts) +
      '\n\nدر حداکثر سه جمله، فقط همین یافته‌ها را برای کاربر خلاصه کن. ' +
      'چیزی که در داده نیست نگو، ادعای موفقیت یا رفع باگ نکن، و اگر پروژه نامناسب است دلیلش را بگو.' +
      (quoted
        ? ' کارت پلن هم نمایش داده شد؛ عدد را تکرار نکن و فقط یک جملهٔ کوتاه دربارهٔ آن بگو.'
        : ' در پایان فقط یک سؤال کوتاه بپرس: تقریباً چند نفر در ماه از این سایت استفاده می‌کنند؟'),
    `تحلیل انجام شد: پلتفرم ${a.platform}، ${a.stats.fileCount} فایل، ${a.findings.length} نکته.` +
      (suitability.suitable ? '' : ` پروژه برای هاست وب مناسب نیست: ${suitability.reasons.map((r) => r.title).join('، ')}.`) +
      (quoted ? '' : ' برای محاسبهٔ پلن، تقریباً چند نفر در ماه از این سایت استفاده می‌کنند؟'),
    {
      numbers: [a.stats.fileCount, a.findings.length, quoted ? session.quote?.cost?.monthlyTotal : null].filter(
        (n) => n !== undefined && n !== null,
      ),
    },
  );
  touch(session);
}

export async function importRepo(session, emit, url, source = 'repo') {
  emit({ t: 'typing', on: true });
  try {
    const { analyzeFromRepo } = await import('./intake.mjs');
    const { saveProject } = await import('./workspace.mjs');
    const result = await analyzeFromRepo(url);
    saveProject(session.id, result.entries || []);
    emit({ t: 'typing', on: false });
    await handleAnalysis(session, emit, { analysis: result.analysis, source, fileName: result.name });
  } catch (e) {
    emit({ t: 'typing', on: false });
    say(
      session,
      emit,
      `نشد مخزن را بگیرم (${e.message}). اگر دسترسی گیت‌هاب محدود است، فایل zip را آپلود کن — همان نتیجه را می‌دهد.`,
    );
  }
}

/* ---------------- راهنمای مرحله ---------------- */

export function emitStepCard(session, emit, step, p) {
  const vars = {
    platform: session.analysis?.platform || session.requirement?.platform || 'nextjs',
    planId: session.quote?.plan?.id || 'earth',
  };
  const resolved = resolveStep(step, vars);
  card(session, emit, {
    kind: 'step',
    step: {
      id: resolved.id,
      title: resolved.title,
      action: resolved.action,
      why: resolved.why,
      check: resolved.check,
      route: resolved.route,
      selector: resolved.selector,
      index: p.currentIndex,
      total: p.steps.length,
    },
    progress: p.steps,
  });
}

export function startGuided(session, emit, stepId) {
  session.mode = 'guided';
  session.stage = 'steps';
  const p = progress({ pagePath: session.context.path, stepId: stepId || session.guided.stepId, done: session.guided.done });
  session.guided.stepId = p.current.id;
  say(
    session,
    emit,
    'باشه، قدم‌به‌قدم می‌بریم جلو. هر جا رسیدی بگو یا صفحه را عوض کن؛ من می‌فهمم کجایی. سؤال هم داشتی همین‌جا بپرس.',
  );
  emitStepCard(session, emit, p.current, p);
  touch(session);
}

/* ---------------- رویداد تغییر صفحه ---------------- */

export function handleContext(session, ctx, emit) {
  const prevPath = session.context.path;
  session.context = { ...session.context, ...ctx };
  touch(session);

  if (session.mode !== 'guided') return;

  const nowStep = stepForPath(ctx.path);
  if (!nowStep) return;
  const prevStepId = session.guided.stepId;
  const prevIndex = prevStepId ? stepById(prevStepId) : null;
  const prevIdx = prevIndex ? progress({ pagePath: prevIndex.route, stepId: prevStepId, done: session.guided.done }).currentIndex : -1;
  const p = progress({ pagePath: ctx.path, stepId: nowStep.id, done: session.guided.done });

  if (p.currentIndex > prevIdx && nowStep.id !== prevStepId) {
    session.guided.stepId = nowStep.id;
    for (let i = 0; i < p.currentIndex; i++) if (!session.guided.done.includes(p.steps[i].id)) session.guided.done.push(p.steps[i].id);
    say(session, emit, `آفرین، رسیدی به «${p.current.title}». ${p.current.action}`);
    emitStepCard(session, emit, p.current, p);

    // آخرین مرحلهٔ راهنما: راهنما تمام شده؛ به حالت چت برو تا ایجنت در «مرحله» گیر نکند
    if (p.currentIndex === p.steps.length - 1) {
      enterChatMode(session);
      say(
        session,
        emit,
        'این آخرین مرحلهٔ راهنما بود. از اینجا در حالت چت هستم — اگر لاگ، دامنه یا خطایی داشتیم با هم بررسی می‌کنیم.',
      );
      logLine(session.id, 'guided', 'راهنما به آخرین مرحله رسید؛ سشن به حالت چت رفت', 'ok');
    }
  }
  flushSay(session.id);
}

/* ---------------- شروع دیپلوی (با نقشهٔ پویا) ---------------- */

/**
 * اجرای دیپلوی با نقشه‌ای که از خود پروژه درآمده است.
 * `reuse` = استفاده از فضای استقرار قبلی (بدون آپلود/نصب دوباره)
 * `only`  = تصمیم ایجنت که فقط کدام مرحله‌ها اجرا شوند
 */
export async function launchDeploy(session, emit, { reuse = null, only = null } = {}) {
  const analysis = reuse?.analysis || session.analysis;
  if (!analysis) {
    say(session, emit, 'برای دیپلوی به سورس پروژه نیاز دارم؛ zip را آپلود کن یا لینک گیت‌هاب بده.');
    return askIntake(session, emit);
  }

  const run = createRun({
    session,
    analysis,
    plan: session.quote?.plan,
    needsDb: analysis.planInputs?.needsDb || false,
    reuse,
    only,
  });
  session.deployRunId = run.id;
  session.stage = 'deploying';

  card(session, emit, {
    kind: 'deploy_plan',
    runId: run.id,
    appName: run.appName,
    url: run.url,
    reused: !!reuse,
    simulated: isSimulated(),
    summary: run.planSummary,
    steps: run.steps.map((s) => ({ id: s.id, title: s.title, approval: s.approval, why: s.why })),
    skipped: run.skipped,
    notes: run.planNotes,
  });

  const skippedText = run.skipped.length ? ` (${run.skipped.length} مرحله لازم نبود)` : '';
  say(
    session,
    emit,
    `${reuse ? 'دیپلوی مجدد' : 'دیپلوی'} با ${run.steps.length} مرحله شروع شد${skippedText}. ` +
      'هر مرحلهٔ مهم را جداگانه تأیید می‌کنم.',
  );

  advance(run);
  touch(session);
  return run;
}

/** پیشنهاد «همین پروژه را دوباره دیپلوی کنم؟» */
export function offerReuse(session, emit, entry) {
  session.reusable = { ...entry };
  const when = entry.deployedAt ? new Date(entry.deployedAt).toLocaleString('fa-IR') : '';
  logLine(session.id, 'deploy', `پروژهٔ قابل استفادهٔ مجدد پیدا شد: ${entry.appName}`, 'ok');
  card(session, emit, {
    kind: 'reuse',
    appName: entry.appName,
    url: entry.url,
    port: entry.port,
    deployedAt: entry.deployedAt,
    match: entry.match,
    fingerprint: entry.fingerprint,
  });
  say(
    session,
    emit,
    `این پروژه قبلاً با نام «${entry.appName}» دیپلوی شده${when ? ` (${when})` : ''} و فضایش هنوز هست. ` +
      'لازم نیست دوباره بفرستی — همین را دوباره بالا بیاورم؟',
  );
  touch(session);
}

/* ---------------- دکمه‌ها ---------------- */

export async function handleAction(session, action, payload, emit) {
  switch (action) {
    case 'intent_deploy':
      return offerModes(session, emit);

    case 'intent_plan':
      return startAuto(session, emit);

    case 'intent_stuck':
      say(session, emit, 'بگو در کدام مرحله گیر کرده‌ای و چه پیامی می‌بینی؛ اگر متن خطا را بفرستی دقیق می‌گویم چه کار کنی.');
      return;

    case 'mode':
      if (payload.value === 'guided') return startGuided(session, emit, payload.stepId);
      if (payload.value === 'agent') return startAgentMode(session, emit);
      return startAuto(session, emit);

    case 'agent_approve':
      return resumeAgent(session, emit, { approved: true }, agentIO(session, emit));

    case 'agent_deny':
      return resumeAgent(session, emit, { approved: false }, agentIO(session, emit));

    case 'ask_answer': {
      const pending = session.agent?.pending;
      if (!pending?.askId) {
        say(session, emit, 'فرم بازی نیست؛ اگر سؤالی هست همین‌جا بپرس.');
        return;
      }
      if (payload.askId && payload.askId !== pending.askId) {
        say(session, emit, 'این فرم قدیمی است؛ آخرین فرم را پر کن.');
        return;
      }
      return resumeAgent(session, emit, { approved: true, answers: payload.answers || {} }, agentIO(session, emit));
    }

    case 'answer':
      return handleChat(session, String(payload.value ?? ''), emit);

    case 'purchased':
      return askIntake(session, emit);

    case 'start_deploy': {
      if (!session.analysis) {
        const prior = findReusable({ session, fingerprint: session.projectFingerprint });
        if (prior) return offerReuse(session, emit, prior);
        say(session, emit, 'اول باید سورس پروژه را ببینم؛ zip را آپلود کن یا لینک گیت‌هاب بده.');
        return askIntake(session, emit);
      }
      // دیپلوی به عدد بازدید/مدت وابسته نیست؛ اگر کاربر نگفته، فرض‌های پیش‌فرض
      // می‌گذاریم و بعداً پلن دقیق را حساب می‌کنیم (به‌جای بلاک کردن کار).
      if (!session.requirement.visitors || !session.requirement.months) {
        if (!session.requirement.visitors) session.requirement.visitors = 1000;
        if (!session.requirement.months) session.requirement.months = 1;
        logLine(session.id, 'deploy', 'بازدید/مدت اعلام نشده بود؛ برای محاسبهٔ هزینه ۱۰۰۰ بازدید و ۱ ماه فرض شد', 'dim');
      }
      return launchDeploy(session, emit, { only: payload.steps || null });
    }

    /* دیپلوی مجدد همان پروژهٔ قبلی — بدون آپلود و نصب دوباره */
    case 'redeploy': {
      const entry =
        (payload.appName ? getDeployment(payload.appName) : null) ||
        (session.reusable?.appName ? getDeployment(session.reusable.appName) : null) ||
        findReusable({ session, fingerprint: session.projectFingerprint });

      if (!entry) {
        say(session, emit, 'دیپلوی قبلی‌ای پیدا نکردم؛ اگر پروژه را دوباره بفرستی، از نو می‌سازم.');
        return askIntake(session, emit);
      }
      if (!session.analysis && entry.analysis) {
        session.analysis = entry.analysis;
        session.stage = 'ready';
      }
      logLine(session.id, 'deploy', `دیپلوی مجدد «${entry.appName}» بدون آپلود`, 'ok');
      return launchDeploy(session, emit, { reuse: entry, only: payload.steps || null });
    }

    /* «نه، فایل تازه می‌فرستم» */
    case 'reuse_skip': {
      session.reusable = null;
      say(session, emit, 'باشه. zip جدید را بفرست یا لینک گیت‌هاب بده تا از نو تحلیل کنم.');
      return askIntake(session, emit);
    }

    case 'approve': {
      const run = getRun(payload.runId || session.deployRunId);
      if (!run) {
        say(session, emit, 'اجرای دیپلوی پیدا نشد (شاید سرور ری‌استارت شده). از نو شروع می‌کنیم.');
        session.deployRunId = null;
        return;
      }
      // کارت قدیمی یا مرحله‌ای که دیگر منتظر تأیید نیست: بی‌صدا رد نشو، توضیح بده
      const pending = run.pendingApproval;
      if (!pending) {
        say(
          session,
          emit,
          run.status === 'done'
            ? 'این دیپلوی تمام شده است؛ مرحلهٔ بازِ دیگری برای تأیید نیست.'
            : 'این مرحله الان منتظر تأیید نیست (در حال اجراست). چند لحظه صبر کن؛ وضعیت را تازه می‌کنم.',
        );
        return;
      }
      if (payload.stepId && payload.stepId !== pending.stepId) {
        say(
          session,
          emit,
          `این کارت مربوط به مرحلهٔ «${payload.title || payload.stepId}» بود که دیگر منتظر تأیید نیست. ` +
            `مرحلهٔ فعلی «${pending.title}» است؛ همان کارت پایین را بزن.`,
        );
        return;
      }
      approve(run, pending.stepId);
      return;
    }

    case 'reject': {
      const run = getRun(payload.runId || session.deployRunId);
      if (!run) return;
      if (!run.pendingApproval || (payload.stepId && payload.stepId !== run.pendingApproval.stepId)) {
        say(session, emit, 'این کارت دیگر معتبر نیست؛ کارت مرحلهٔ فعلی را بزن.');
        return;
      }
      reject(run, run.pendingApproval.stepId);
      const snap = snapshot(run);
      say(session, emit, `باشه، «${payload.title || 'این مرحله'}» را انجام ندادم و همین‌جا متوقف شدم.`);
      card(session, emit, { kind: 'summary', summary: snap.summary });
      return;
    }

    case 'stop': {
      const run = getRun(payload.runId || session.deployRunId);
      if (!run) return;
      stopHere(run);
      const snap = snapshot(run);
      card(session, emit, { kind: 'summary', summary: snap.summary });
      return;
    }

    case 'fix': {
      const run = getRun(payload.runId || session.deployRunId);
      if (!run) return;
      fixBug(run, !!payload.accept);
      return;
    }

    /* اعمال رفع خودکار و اجرای دوبارهٔ مرحلهٔ شکست‌خورده */
    case 'deploy_autofix': {
      const run = getRun(payload.runId || session.deployRunId);
      if (!run) {
        say(session, emit, 'اجرای دیپلوی پیدا نشد (شاید سرور ری‌استارت شده). از نو شروع می‌کنیم.');
        return;
      }
      const diag =
        session.lastDiagnosis && session.lastDiagnosis.runId === run.id
          ? session.lastDiagnosis
          : diagnoseFailure(session, run, {
              stepId: payload.stepId || 'build',
              stepTitle: payload.stepTitle || 'مرحلهٔ دیپلوی',
              error: run.bug?.findings?.[0]?.detail || run.summary?.error || '',
            });

      if (payload.retryOnly) {
        // بدون تغییر کد، فقط همان مرحله دوباره
        const snap = await retryStep(run, diag.stepId, {});
        if (snap?.error) say(session, emit, `نتوانستم دوباره اجرا کنم: ${snap.error}`);
        else say(session, emit, `«${diag.stepTitle}» را دوباره اجرا کردم.`);
        return;
      }

      if (!diag.patches?.length && !diag.canRetry) {
        say(session, emit, 'تغییر مشخصی برای اعمال پیدا نکردم؛ لاگ را با هم بررسی می‌کنیم.');
        return;
      }
      return applyAutoFix(session, run, diag, emit, { patchIds: payload.patchIds || null });
    }

    /* روشن/خاموش کردن رفع خودکار */
    case 'auto_fix_toggle': {
      session.autoFix = payload.value === undefined ? !session.autoFix : !!payload.value;
      say(
        session,
        emit,
        session.autoFix
          ? 'از این به بعد اگر مرحله‌ای بشکند، خودم بدون پرسیدن رفع می‌کنم و دوباره اجرا می‌کنم.'
          : 'از این به بعد اول تشخیص می‌دهم و قبل از اعمال تغییر، از تو اجازه می‌گیرم.',
      );
      touch(session);
      return;
    }

    case 'goto':
      emit({ t: 'navigate', url: payload.url });
      return;

    case 'show_step': {
      const step = stepById(payload.stepId);
      if (!step) return;
      const p = progress({ pagePath: step.route, stepId: step.id, done: session.guided.done });
      session.guided.stepId = step.id;
      emitStepCard(session, emit, step, p);
      return;
    }

    case 'restart': {
      session.mode = 'idle';
      session.stage = 'greet';
      session.deployRunId = null;
      session.deploySummary = null;
      await resetAgentMemory(session);
      greet(session, emit);
      return;
    }

    case 'chat_send':
      // چیپ‌های «قدم بعد» در حالت چت، همان مسیر گفتگو را صدا می‌زنند
      return handleChat(session, String(payload.value ?? ''), emit);

    case 'suitability_apply': {
      const s = session.suitability;
      if (!s?.adaptations?.length) {
        say(session, emit, 'تغییری برای مناسب‌سازی نیست.');
        return;
      }
      const applied = applyAdaptations(session, s.adaptations, {
        writeFile: writeWorkspaceFile,
        readFile: readWorkspaceFile,
      });
      logLine(session.id, 'project', `مناسب‌سازی اعمال شد: ${applied.map((f) => f.path).join('، ')}`, 'ok');

      // تحلیل دوباره با فایل‌های جدید (پلتفرم/پورت/باگ‌ها به‌روز می‌شوند)
      let analysis = session.analysis;
      try {
        analysis = analyzeFiles(readAllFiles(session.id));
        session.analysis = analysis;
        if (analysis.platform) session.requirement.platform = analysis.platform;
        session.suitability = {
          ...assessSuitability(session, fileTree(session.id, 2000).map((rel) => ({ name: rel })), analysis),
          assessedAt: Date.now(),
        };
      } catch (e) {
        logLine(session.id, 'project', 'تحلیل دوباره ناموفق بود: ' + e.message, 'err');
      }

      // یک کارت (فایل‌های تغییرکرده) + یک متن — نه پنج پیام پشت سر هم
      card(session, emit, {
        kind: 'adaptation_result',
        files: applied,
        analysis: analysis
          ? {
              platform: analysis.platform,
              build: analysis.build,
              port: analysis.port,
              findings: analysis.findings,
              stats: analysis.stats,
            }
          : null,
        suitable: !!session.suitability?.suitable,
        remaining: session.suitability?.reasons?.length || 0,
      });

      await narrate(
        session,
        emit,
        'مناسب‌سازی پروژه اعمال شد. دادهٔ واقعی:\n' +
          JSON.stringify({
            files: applied.map((f) => f.path),
            platform: analysis?.platform,
            build: analysis?.build,
            port: analysis?.port,
            suitable: session.suitability?.suitable,
            remaining: session.suitability?.reasons?.map((r) => r.title) || [],
          }) +
          '\n\nدر دو جمله بگو چه چیزی اضافه شد و قدم بعدی چیست. ادعای جدید نکن.',
        `انجام شد. ${applied.length} فایل اضافه/تغییر کرد: ${applied.map((f) => f.path).join('، ')}. ` +
          (session.suitability?.suitable ? 'حالا برای هاست وب مناسب است.' : `${session.suitability?.reasons?.length || 0} مورد باقی است.`),
        { numbers: [applied.length, session.suitability?.reasons?.length || 0] },
      );
      touch(session);
      return;
    }

    case 'suitability_skip': {
      session.suitability = { ...(session.suitability || {}), skipped: true };
      session.agent = session.agent || {};
      session.agent.notes = [...(session.agent.notes || []), 'کاربر مناسب‌سازی پروژه را رد کرد'].slice(-20);
      logLine(session.id, 'project', 'کاربر مناسب‌سازی را رد کرد؛ ادامه بدون تغییر ساختار', 'warn');
      say(
        session,
        emit,
        'باشه، ساختار پروژه را تغییر نمی‌دهم. با همین وضعیت جلو می‌رویم؛ فقط حواست باشد ممکن است هنگام اجرا روی هاست به مشکل بخورد.',
      );
      touch(session);
      return;
    }

    default:
      return;
  }
}

/* ---------------- پایان دیپلوی → حالت چت ---------------- */

/**
 * وقتی اجرای دیپلوی تمام می‌شود (موفق، متوقف، خطا) سشن را از «حالت دیپلوی»
 * بیرون می‌آورد و به حالت چت می‌برد تا ایجنت در آن مرحله گیر نکند و بتواند
 * بعد از دیپلوی هم کمک کند.
 *
 * فقط یک پیام (روایت واقعی) + یک کارت چیپ برای قدم بعد فرستاده می‌شود.
 */
export async function deployFinished(session, run, summary) {
  if (!summary) return;
  if (session.deploySummary?.runId === run.id) return; // یک‌بار بیشتر اعلان نده

  session.deploySummary = {
    runId: run.id,
    appName: run.appName,
    url: summary.url || run.url,
    status: summary.status,
    steps: summary.steps,
    total: summary.total,
    warnings: (summary.warnings || []).slice(-4),
    fixed: summary.fixed || [],
    stoppedAt: summary.stoppedAt || null,
    error: summary.error || null,
    at: Date.now(),
  };
  session.deployRunId = run.id;
  enterChatMode(session);
  await resetAgentMemory(session);
  touch(session);

  const emit = (event) => {
    if (event?.t === 'msg') logLine(session.id, 'deploy', 'پیام پس از دیپلوی برای کاربر ثبت شد', 'dim');
  };
  logLine(session.id, 'deploy', `پایان دیپلوی (${summary.status}) — سشن به حالت چت رفت`, 'ok');

  const ok = summary.status === 'success';
  await narrate(
    session,
    emit,
    'دیپلوی تمام شد. این دادهٔ واقعی است:\n' +
      JSON.stringify({
        status: summary.status,
        url: session.deploySummary.url,
        stepsDone: summary.steps,
        stepsTotal: summary.total,
        warnings: session.deploySummary.warnings,
        stoppedAt: summary.stoppedAt || null,
        error: summary.error || null,
      }) +
      '\n\nدر حداکثر سه جمله بگو چه شد و از اینجا چه کاری برای کاربر می‌توانی بکنی (بررسی لاگ، دامنه، متغیر محیطی، خطای اجرا، ارتقای پلن). ' +
      'ادعای جدید یا عدد نساز؛ اگر خطا بوده صادقانه بگو.',
    ok
      ? `دیپلوی کامل شد و سایت روی ${session.deploySummary.url} بالا آمد.` +
        (summary.reused ? ' این یک دیپلوی مجدد بود و فایل‌ها/وابستگی‌های قبلی استفاده شد.' : '') +
        ' از اینجا در حالت چت هستم: لاگ، دامنه، متغیر محیطی یا هر خطای اجرا را با هم بررسی می‌کنیم.'
      : summary.status === 'failed'
        ? `دیپلوی در مرحلهٔ «${summary.stoppedAt || 'اجرا'}» متوقف شد: ${String(summary.error || '').slice(0, 120)}. بگو ادامه بدهم یا مسیر دیگری برویم.`
        : `دیپلوی همین‌جا متوقف شد (${summary.stoppedAt || 'به خواست تو'}). هر وقت خواستی از همین نقطه ادامه می‌دهیم.`,
  );

  // در شکست، کارت «دیباگ خودکار» (deployFailed) جای این چیپ‌ها را می‌گیرد؛
  // دو پیام پشت سر هم لازم نیست.
  if (summary.status !== 'failed') {
    card(session, emit, {
      kind: 'chips',
      title: 'قدم بعدی؟',
      items: [
        { label: 'لاگ‌ها را بررسی کن', action: 'chat_send', value: 'لاگ‌های دیپلوی را بررسی کن و اگر خطایی هست توضیح بده' },
        { label: 'دامنه و سلامت سایت', action: 'chat_send', value: 'دامنه و سلامت سایت را بررسی کن' },
        { label: 'متغیرهای محیطی', action: 'chat_send', value: 'متغیرهای محیطی لازم برای این پروژه چیست؟' },
        { label: 'یک مشکل دارم', action: 'chat_send', value: 'بعد از دیپلوی یک مشکل دارم' },
      ],
    });
  }
  touch(session);
}

/* ---------------- دیباگ خودکار وقتی دیپلوی می‌شکند ---------------- */

/**
 * وقتی مرحله‌ای از دیپلوی شکست می‌خورد، ایجنت خودش وارد عمل می‌شود:
 *
 *   ۱) علت‌ها را از خطا/لاگ/کد تشخیص می‌دهد (قطعی، بدون مصرف توکن)
 *   ۲) کارت «دیباگ» با یافته‌ها و تغییرهای پیشنهادی می‌فرستد
 *   ۳) اگر حالت «رفع خودکار» روشن باشد، همان‌جا اعمال و مرحله را دوباره اجرا می‌کند
 *   ۴) اگر تشخیص قطعی چیزی پیدا نکرد و مدل در دسترس باشد، خود ایجنت (با ابزارها)
 *      کد را می‌خواند و تغییر می‌دهد — نوشتن فایل هم با تأیید کاربر
 */
export async function deployFailed(session, run, info) {
  if (!run || !info) return;
  // این تابع از موتور دیپلوی صدا زده می‌شود، نه از یک درخواست SSE باز؛
  // پیام‌ها در سشن ذخیره می‌شوند و UI با polling/refresh می‌بیندشان.
  const emit = () => {};
  const key = `${run.id}:${info.stepId}`;

  session.repairs = Array.isArray(session.repairs) ? session.repairs : [];
  const recent = session.repairs.filter((r) => r.key === key && Date.now() - r.at < 45_000);
  if (recent.length >= 2) return; // برای یک شکست چند بار کارت نفرست
  if (session.repairs.filter((r) => String(r.key).startsWith(run.id + ':')).length >= 6) {
    logLine(session.id, 'repair', 'سقف تلاش‌های خودکار این اجرا پر شد؛ دستی ادامه می‌دهیم', 'warn');
    return;
  }

  if (session.autoFix === undefined) session.autoFix = process.env.LIA_AUTO_FIX === '1';

  logLine(session.id, 'repair', `دیباگ خودکار شروع شد — مرحلهٔ «${info.stepTitle || info.stepId}»`, 'warn');

  const diag = diagnoseFailure(session, run, info);
  session.lastDiagnosis = { runId: run.id, at: Date.now(), ...diag };
  session.repairs.push({
    key,
    at: Date.now(),
    stepId: diag.stepId,
    findings: diag.findings.length,
    patches: diag.patches.length,
    auto: !!session.autoFix,
  });
  if (session.repairs.length > 20) session.repairs.shift();

  const cardPayload = {
    kind: 'repair',
    id: `${run.id}:${diag.stepId}:${Date.now()}`,
    runId: run.id,
    stepId: diag.stepId,
    stepTitle: diag.stepTitle,
    error: diag.error,
    summary: diag.summary,
    findings: diag.findings,
    patches: diag.patches.map((p) => ({
      id: p.id,
      kind: p.kind,
      title: p.title,
      detail: p.detail,
      path: p.path || null,
      diff: p.diff || null,
    })),
    canRetry: diag.canRetry,
    auto: !!session.autoFix,
  };
  setRepair(run, cardPayload);
  card(session, emit, cardPayload);

  const lead = diag.patches.length
    ? `«${diag.stepTitle}» شکست خورد؛ وارد دیباگ شدم. ${diag.summary}`
    : `«${diag.stepTitle}» شکست خورد؛ وارد دیباگ شدم. ${diag.summary}`;
  say(session, emit, lead);
  touch(session);

  // حالت رفع خودکار: بدون کلیک اعمال و دوباره تلاش کن
  if (session.autoFix) {
    await applyAutoFix(session, run, diag, emit);
    return;
  }

  // تشخیص قطعی چیزی پیدا نکرد → خود ایجنت با ابزارها کد را بررسی می‌کند
  if (!diag.patches.length && !llmInfo().demo && session.agent?.status !== 'running') {
    const logTail = (run.logs || [])
      .slice(-25)
      .map((l) => `[${l.level || 'dim'}] ${l.text}`)
      .join('\n');
    const prompt =
      `دیپلوی در مرحلهٔ «${diag.stepTitle}» شکست خورد. متن خطا:\n` +
      `${String(info.error || diag.logTail || '').slice(0, 1500)}\n\n` +
      `آخرین لاگ‌های اجرا:\n${logTail.slice(-2500) || '(خالی)'}\n\n` +
      'این کار را واقعاً انجام بده (نه توضیح کلی):\n' +
      '۱) analyze_project و بعد فایل‌های مرتبط را با read_file بخوان.\n' +
      '۲) علت دقیق را در یک جمله بگو (کدام فایل، کدام خط).\n' +
      '۳) با patch_file (یا write_file اگر لازم است) اصلاح کن.\n' +
      '۴) بعد analyze_project را دوباره بزن تا مطمئن شوی مشکل رفته.\n' +
      '۵) در پایان بگو چه چیزی عوض شد و اگر لازم است retry_deploy را صدا بزن.';
    logLine(session.id, 'repair', 'تشخیص قطعی چیزی پیدا نکرد؛ از مدل برای دیباگ عمیق‌تر کمک می‌گیرم', 'dim');
    try {
      await runAgent(session, emit, prompt, agentIO(session, emit));
    } catch (e) {
      logLine(session.id, 'repair', 'دیباگ با مدل ناموفق بود: ' + e.message, 'err');
    }
  }

  flushSay(session.id);
}

/** اعمال وصله‌های تشخیص‌داده‌شده و اجرای دوبارهٔ همان مرحله */
export async function applyAutoFix(session, run, diag, emit, { patchIds = null } = {}) {
  const patches = (diag.patches || []).filter((p) => !patchIds || patchIds.includes(p.id));
  const result = await applyRepairs(session, patches, {
    onLog: (text) => logLine(session.id, 'repair', text, text.startsWith('✗') ? 'err' : 'ok'),
  });

  const desc = describeApplied(result);
  if (desc) say(session, emit, `این تغییرها اعمال شد: ${desc}`);
  if (result.errors.length) say(session, emit, `بخشی از رفع انجام نشد: ${result.errors.join('، ')}`);

  card(session, emit, { kind: 'repair_result', applied: result.applied, errors: result.errors });

  // اگر تغییری لازم نبود ولی تلاش دوباره معنا دارد (خطای موقت/بی‌علت)، همان را انجام بده
  const willRetry = result.retry || (patches.length === 0 && diag.canRetry);
  if (!willRetry) {
    say(session, emit, 'تغییرها اعمال شد. حالا می‌توانی مرحله را دوباره اجرا کنی.');
    touch(session);
    return result;
  }

  const snap = await retryStep(run, diag.stepId, { newPort: result.newPort, skipStep: result.skipStep });
  session.deployRunId = run.id;
  if (snap?.error) {
    say(session, emit, `نتوانستم دوباره اجرا کنم: ${snap.error}`);
    logLine(session.id, 'repair', 'تلاش دوباره ناموفق: ' + snap.error, 'err');
  } else {
    logLine(session.id, 'repair', `مرحلهٔ «${diag.stepTitle}» دوباره اجرا شد`, 'ok');
  }
  touch(session);
  return result;
}

/* ---------------- وضعیت برای ویجت ---------------- */

export function sessionState(session) {
  const account = session.accountId ? getAccount(session.accountId) : null;
  return {
    id: session.id,
    mode: session.mode,
    stage: session.stage,
    account: account ? { ...publicAccount(account), plan: planStatus(account) } : null,
    context: session.context,
    requirement: session.requirement,
    quote: session.quote,
    analysis: session.analysis
      ? {
          platform: session.analysis.platform,
          findings: session.analysis.findings,
          stats: session.analysis.stats,
          build: session.analysis.build,
          start: session.analysis.start,
          port: session.analysis.port,
          envKeys: session.analysis.envKeys,
        }
      : null,
    deployRunId: session.deployRunId,
    deploySummary: session.deploySummary || null,
    reusable: session.reusable
      ? {
          appName: session.reusable.appName,
          url: session.reusable.url,
          port: session.reusable.port,
          deployedAt: session.reusable.deployedAt,
          match: session.reusable.match,
        }
      : null,
    plan: session.analysis
      ? (() => {
          const p = planDeploy({
            analysis: session.analysis,
            requirement: session.requirement || {},
            needsDb: session.analysis.planInputs?.needsDb || false,
          });
          return { steps: p.steps.map((s) => ({ id: s.id, title: s.title, why: s.why })), skipped: p.skipped, notes: p.notes, summary: p.summary };
        })()
      : null,
    guided: session.guided,
    suitability: session.suitability
      ? {
          suitable: session.suitability.suitable,
          reasons: session.suitability.reasons,
          canAdapt: session.suitability.canAdapt,
          adaptations: (session.suitability.adaptations || []).map((a) => ({ id: a.id, title: a.title, files: a.files.map((f) => f.path) })),
          skipped: !!session.suitability.skipped,
        }
      : null,
    agent: agentState(session),
    autoFix: !!session.autoFix,
    llm: { ...llmInfo(), status: llmStatus() },
    catalogVersion: PLAN_CATALOG.version,
    messages: session.messages.slice(-40),
  };
}
