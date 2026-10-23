/**
 * llm.mjs — کلاینت مدل زبانی (سازگار با OpenAI) + جواب‌دهی دمو
 *
 * چرا OpenAI-compatible: هم با کلیدی که بعداً می‌دهی کار می‌کند، هم با مسیر
 * `/v1/chat/completions` لیارا. تنظیمات از env می‌آید:
 *   LIA_LLM_BASE_URL, LIA_LLM_API_KEY, LIA_LLM_MODEL, LIA_DEMO=1
 *
 * پیش‌فرضِ درگاه، **BoxAPI** است؛ برای عوض کردنش کافی است همین متغیرها را ست کنی
 * (مثلاً LM Studio محلی). اگر کلید نباشد، «حالت دمو» فعال می‌شود: پاسخ‌ها از وضعیت
 * سشن ساخته می‌شوند تا کل جریان بدون کلید هم قابل تست باشد.
 */
import './env.mjs';

const BASE = (process.env.LIA_LLM_BASE_URL || 'https://ai.boxapi.ir/ai/v1').replace(/\/$/, '');
const KEY = process.env.LIA_LLM_API_KEY || '';
const MODEL = process.env.LIA_LLM_MODEL || 'gpt-6-luna';
const FORCE_DEMO = process.env.LIA_DEMO === '1';

/* ---------------- سازگاری پارامترها با مدل ----------------
 *
 * مدل‌های «reasoning» (خانوادهٔ gpt-5/gpt-6 و o-series) پارامترهای متفاوتی
 * قبول می‌کنند:
 *   - به‌جای `max_tokens` باید `max_completion_tokens` بدهی
 *   - `temperature` فقط مقدار پیش‌فرض (۱) را قبول می‌کند
 *   - با function tools، باید `reasoning_effort: "none"` بدهی
 *
 * این‌ها خودکار تشخیص داده می‌شوند و اگر سرویس خطای پارامتر بدهد، یک بار با
 * پارامتر درست دوباره تلاش می‌شود (و نتیجه برای بقیهٔ عمر پروسه کش می‌شود).
 * با env هم قابل اجبار است:
 *   LIA_LLM_TOKEN_PARAM=max_completion_tokens | max_tokens
 *   LIA_LLM_TEMPERATURE=0        (ارسال نکن)
 *   LIA_LLM_REASONING_EFFORT=none|low|medium|high  (خالی = ارسال نکن)
 */
const REASONING_FAMILY = /^(?:openai\/)?(?:o[1-9]|gpt-5|gpt-6)/i;
const IS_REASONING = REASONING_FAMILY.test(MODEL);

const caps = {
  tokenParam: process.env.LIA_LLM_TOKEN_PARAM || (IS_REASONING ? 'max_completion_tokens' : 'max_tokens'),
  temperature: process.env.LIA_LLM_TEMPERATURE === '0' ? false : !IS_REASONING,
  reasoningEffort:
    process.env.LIA_LLM_REASONING_EFFORT !== undefined
      ? process.env.LIA_LLM_REASONING_EFFORT
      : IS_REASONING
        ? 'none'
        : '',
};

export function llmCaps() {
  return { ...caps, reasoningFamily: IS_REASONING };
}

/** پارامترهای سقف توکن/دما/تلاش استدلال را روی بدنهٔ درخواست می‌گذارد */
function applyParams(body, { maxTokens, temperature } = {}) {
  if (maxTokens) {
    if (caps.tokenParam === 'max_completion_tokens') body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
  }
  if (temperature != null && caps.temperature) body.temperature = temperature;
  if (caps.reasoningEffort) body.reasoning_effort = caps.reasoningEffort;
  return body;
}

/** آخرین خطای سرویس مدل (برای نمایش در پنل/چت) */
let lastError = null;
/** نتیجهٔ آخرین بررسی سلامت سرویس مدل */
let cachedProbe = null;

export function llmInfo() {
  return { configured: !FORCE_DEMO && !!KEY, model: MODEL, baseUrl: BASE, demo: FORCE_DEMO || !KEY };
}

export function llmStatus() {
  return { ...llmInfo(), caps: llmCaps(), lastError, probe: cachedProbe };
}

/**
 * گزینه‌های ساخت `ChatOpenAI` برای گراف LangGraph با همان سازگاری پارامترها.
 * (مدل‌های reasoning `max_tokens`/`temperature` را قبول نمی‌کنند.)
 */
export function chatModelOptions({ maxTokens = 900 } = {}) {
  const info = llmInfo();
  const opts = {
    model: info.model,
    apiKey: KEY,
    maxRetries: 1,
    timeout: 90_000,
    configuration: { baseURL: info.baseUrl },
  };
  const modelKwargs = {};
  if (caps.tokenParam === 'max_completion_tokens') modelKwargs.max_completion_tokens = maxTokens;
  else opts.maxTokens = maxTokens;
  if (caps.reasoningEffort) modelKwargs.reasoning_effort = caps.reasoningEffort;
  if (Object.keys(modelKwargs).length) opts.modelKwargs = modelKwargs;
  if (caps.temperature) opts.temperature = 0.2;
  return opts;
}

/** پیام‌های خطای شناخته‌شدهٔ سرویس → توضیح فارسی + اقدام */
function explainProviderError(status, bodyText) {
  let message = bodyText || '';
  let code = '';
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || message;
    code = String(json.error?.type || json.error?.code || '');
  } catch {
    /* متن ساده */
  }
  if (/telegram_required/i.test(message + code)) {
    return {
      code: 'telegram_required',
      status,
      message,
      hint: 'حساب سرویس مدل باید ابتدا تلگرام را وصل کند (در تنظیمات پنل همان سرویس). بعد از آن کلید بدون تغییر کار می‌کند.',
      blocked: true,
    };
  }
  if (status === 401 || status === 403) {
    return { code: code || 'unauthorized', status, message, hint: 'کلید معتبر نیست یا دسترسی‌اش محدود شده است.', blocked: true };
  }
  if (status === 429) {
    return { code: 'rate_limited', status, message, hint: 'سقف مصرف یا نرخ درخواست پر شده؛ کمی بعد دوباره امتحان کن.', blocked: false };
  }
  if (status === 404) {
    return { code: 'model_not_found', status, message, hint: 'این مدل روی این درگاه نیست؛ نام مدل را در .env بررسی کن.', blocked: true };
  }
  return { code: code || 'provider_error', status, message: message.slice(0, 300), hint: null, blocked: false };
}

/**
 * درخواست chat/completions با «یادگیری» پارامترهای مدل.
 * اگر سرویس به‌خاطر max_tokens / temperature / reasoning_effort خطا بدهد،
 * بدنه اصلاح و یک بار دیگر ارسال می‌شود.
 */
async function postChat(body, { signal } = {}) {
  let lastText = '';
  let lastStatus = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) {
      lastError = null;
      cachedProbe = { ok: true, status: res.status, at: Date.now() };
      return res;
    }

    lastStatus = res.status;
    lastText = await res.text().catch(() => '');

    // ۱) max_tokens → max_completion_tokens
    if (/max_completion_tokens/.test(lastText) && body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
      caps.tokenParam = 'max_completion_tokens';
      continue;
    }
    // ۲) temperature پشتیبانی نمی‌شود
    if (/temperature/i.test(lastText) && /unsupported|not support/i.test(lastText) && body.temperature !== undefined) {
      delete body.temperature;
      caps.temperature = false;
      continue;
    }
    // ۳) ابزار + reasoning_effort
    if (/reasoning_effort/i.test(lastText) && /tool/i.test(lastText) && body.reasoning_effort !== 'none') {
      body.reasoning_effort = 'none';
      caps.reasoningEffort = 'none';
      continue;
    }

    const explained = explainProviderError(res.status, lastText);
    lastError = explained;
    const error = new Error(`LLM ${res.status}: ${explained.message}`);
    error.status = res.status;
    error.explained = explained;
    throw error;
  }

  const explained = explainProviderError(lastStatus, lastText);
  lastError = explained;
  const error = new Error(`LLM ${lastStatus}: ${explained.message}`);
  error.status = lastStatus;
  error.explained = explained;
  throw error;
}

/** بررسی سبک سلامت سرویس مدل (GET /models)؛ نتیجه کش می‌شود. */
export async function checkProvider({ force = false } = {}) {
  if (!llmInfo().configured) {
    cachedProbe = { ok: false, skipped: true, at: Date.now(), hint: 'کلید مدل تنظیم نشده است.' };
    return cachedProbe;
  }
  if (cachedProbe && !force && Date.now() - cachedProbe.at < 60_000) return cachedProbe;

  try {
    const res = await fetch(`${BASE}/models`, {
      headers: { authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      cachedProbe = { ok: true, status: res.status, at: Date.now() };
      lastError = null;
      return cachedProbe;
    }
    const text = await res.text().catch(() => '');
    const explained = explainProviderError(res.status, text);
    lastError = explained;
    cachedProbe = { ok: false, ...explained, at: Date.now() };
    return cachedProbe;
  } catch (e) {
    cachedProbe = { ok: false, status: 0, message: e.message, hint: 'ارتباط با سرویس مدل برقرار نشد.', at: Date.now() };
    return cachedProbe;
  }
}

function persona(session, extra = {}) {
  const ctx = session.context || {};
  const plan = session.quote?.plan;
  const findings = session.analysis?.findings || [];
  const deploy = session.deploySummary;
  return [
    'تو «لیا» هستی؛ دستیار فارسی‌زبان دیپلوی روی پلتفرم ابری لیارا (PaaS).',
    'لحن: صمیمی، کوتاه، دقیق. جمله‌های تکراری و تعارف اضافه ننویس. حداکثر ۴ جمله.',
    'قواعد قطعی:',
    '1) هیچ عدد قیمت یا مشخصات پلنی از خودت نساز؛ فقط از داده‌های زیر استفاده کن.',
    '2) هیچ کار هزینه‌زایی (ساخت اپ، دیپلوی، ساخت دیتابیس) را بدون تأیید صریح کاربر پیشنهاد اجرا نکن.',
    '3) اگر چیزی را نمی‌دانی یا در داده‌ها نیست، صریح بگو و راه بررسی بده.',
    '4) پاسخ‌ها فارسی و بدون مارک‌داون سنگین باشد (متن ساده، حداکثر یک فهرست کوتاه).',
    '',
    `وضعیت کاربر: حالت=${session.mode}، مرحله=${session.stage}`,
    `صفحهٔ فعلی: ${ctx.path || '/'}${ctx.title ? ' — ' + ctx.title : ''}`,
    session.requirement?.platform ? `نوع برنامه: ${session.requirement.platform}` : '',
    session.requirement?.visitors ? `بازدید ماهانه: ${session.requirement.visitors}` : '',
    plan ? `پلن پیشنهادی: ${plan.name} — ${plan.monthly.toLocaleString('fa-IR')} تومان در ماه` : '',
    session.quote ? `هزینهٔ دوره: ${session.quote.cost.periodTotal.toLocaleString('fa-IR')} تومان برای ${session.quote.cost.months} ماه` : '',
    findings.length ? `باگ‌های شناسایی‌شده: ${findings.slice(0, 4).map((f) => f.title).join('؛ ')}` : '',
    deploy
      ? `آخرین دیپلوی: ${deploy.status} — ${deploy.url || 'بدون آدرس'}` +
        (deploy.stoppedAt ? ` — توقف در «${deploy.stoppedAt}»` : '') +
        (deploy.error ? ` — خطا: ${String(deploy.error).slice(0, 120)}` : '')
      : '',
    session.mode === 'chat' ? 'الان در حالت چت بعد از دیپلوی هستی؛ با لاگ/دامنه/متغیر/خطا کمک کن.' : '',
    extra.step ? `مرحلهٔ راهنما: ${extra.step.title} — ${extra.step.action}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** استریم پاسخ مدل؛ هر تکه متن را به onDelta می‌دهد. */
export async function streamChat({ messages, onDelta, signal }) {
  const body = applyParams({ model: MODEL, messages, stream: true }, { maxTokens: 700, temperature: 0.4 });
  const res = await postChat(body, { signal });
  if (!res.body) {
    const error = new Error('پاسخ استریم خالی بود');
    error.status = 200;
    throw error;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      } catch {
        /* خط ناقص؛ نادیده بگیر */
      }
    }
  }
  return full;
}

/**
 * یک دور گفتگو با پشتیبانی tool-calling (غیر استریم).
 * @returns {{ text: string, toolCalls: {id:string,name:string,args:object}[] }}
 */
export async function chatWithTools({ messages, tools, temperature = 0.2 }) {
  const info = llmInfo();
  if (!info.configured) {
    const err = new Error('کلید مدل تنظیم نشده است');
    err.userHint = 'کلید مدل تنظیم نشده؛ در حالت دمو ادامه می‌دهم.';
    throw err;
  }

  const body = applyParams({ model: MODEL, messages }, { maxTokens: 900, temperature });
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  let res;
  try {
    res = await postChat(body, { signal: AbortSignal.timeout(90_000) });
  } catch (e) {
    if (e.status) {
      e.userHint = e.explained?.hint || '';
      if (e.status === 400 && /tool/i.test(e.message)) {
        e.userHint = 'این مدل از tool-calling پشتیبانی نمی‌کند؛ با برنامه‌ریز داخلی ادامه می‌دهم.';
      }
      throw e;
    }
    const err = new Error(`ارتباط با مدل برقرار نشد: ${e.message}`);
    err.userHint = 'ارتباط با سرویس مدل برقرار نشد.';
    throw err;
  }

  const json = await res.json();
  const message = json?.choices?.[0]?.message || {};
  // شکل خام (استاندارد OpenAI) برای برگرداندن در پیام‌های بعدی لازم است
  const rawToolCalls = message.tool_calls || [];
  const toolCalls = rawToolCalls.map((tc) => {
    let args = {};
    try {
      args = JSON.parse(tc.function?.arguments || '{}');
    } catch {
      args = {};
    }
    return { id: tc.id, name: tc.function?.name, args };
  });

  return { text: (message.content || '').trim(), toolCalls, rawToolCalls, usage: json?.usage || null };
}

/**
 * یک «دستور» به مدل می‌دهد و پاسخ را استریم می‌کند — بدون اینکه پیام کاربر در
 * تاریخچه ثبت شود. برای روایت رویدادهای واقعی (تحلیل، پلن، نتیجهٔ دیپلوی).
 * اگر مدل در دسترس نباشد null برمی‌گرداند تا صدازننده متن واقعیت‌محور بگذارد.
 */
export async function answerInstruction({ session, instruction, onDelta }) {
  if (!llmInfo().configured) return null;

  const history = session.messages
    .filter((m) => m.kind === 'text' && m.role)
    .slice(-6)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text || '').slice(0, 700) }));

  const messages = [
    { role: 'system', content: persona(session) },
    ...history,
    { role: 'user', content: instruction },
  ];

  try {
    return await streamChat({ messages, onDelta });
  } catch (e) {
    console.error('LLM narrate error:', e.message);
    lastError = e.explained || { message: e.message, blocked: false };
    return null;
  }
}
/** پاسخ دمو: از وضعیت سشن، بدون تماس با هیچ سرویسی. */
export function demoAnswer(session, question, extra = {}) {
  const q = (question || '').trim();
  const plan = session.quote?.plan;
  const findings = session.analysis?.findings || [];
  const step = extra.step;
  const deploy = session.deploySummary;

  if (/قیمت|هزینه|چند|تومان/.test(q) && session.quote) {
    const c = session.quote.cost;
    return `برای ${session.quote.inputs.months} ماه، جمع تخمینی ${c.periodTotal.toLocaleString('fa-IR')} تومان می‌شود: پلن ${plan.name} ماهی ${c.appMonthly.toLocaleString('fa-IR')} تومان${c.dbMonthly ? ` + دیتابیس ${c.dbMonthly.toLocaleString('fa-IR')} تومان` : ''} + ترافیک حدود ${c.trafficMonthly.toLocaleString('fa-IR')} تومان.`;
  }

  if (/باگ|خطا|مشکل|ارور/.test(q) && findings.length) {
    return `مهم‌ترین مورد: «${findings[0].title}» — ${findings[0].detail} اگر بخواهی همین را برایت رفع می‌کنم.`;
  }

  if (deploy && /لاگ|وضعیت|دیپلوی|دامنه|بعد از|چی شد/.test(q)) {
    const line =
      deploy.status === 'success'
        ? `دیپلوی موفق بود و آدرسش ${deploy.url} است.`
        : `دیپلوی با وضعیت «${deploy.status}» تمام شد${deploy.stoppedAt ? ` (توقف در «${deploy.stoppedAt}»)` : ''}${deploy.error ? `: ${deploy.error}` : ''}.`;
    const warn = deploy.warnings?.length ? ` هشدارها: ${deploy.warnings.join('؛ ')}` : '';
    return `${line}${warn} بگو کدام بخش را بررسی کنم: لاگ، دامنه، متغیر محیطی یا خطای اجرا.`;
  }

  if (session.mode === 'guided' && step) {
    return `الان مرحلهٔ «${step.title}» است: ${step.action} (${step.why}) اگر گیر کردی، بگو در کدام صفحه‌ای تا دقیق‌تر راهنمایی کنم.`;
  }

  if ((session.mode === 'auto' || session.mode === 'chat') && plan) {
    return `پیشنهاد من پلن ${plan.name} است (${plan.monthly.toLocaleString('fa-IR')} تومان در ماه). اگر تأیید کنی، مرحله‌به‌مرحله دیپلوی را با اجازهٔ خودت انجام می‌دهم.`;
  }

  if (/سلام|درود|هی/.test(q)) {
    return 'سلام! من لیا هستم. بگو چه چیزی می‌خواهی بسازی و چند نفر قرار است از آن استفاده کنند تا پلن درست را حساب کنم.';
  }

  return 'این را از داده‌های فعلی نمی‌توانم قطعی بگویم. اگر پروژه‌ات را (zip یا لینک گیت‌هاب) بدهی، دقیق بررسی می‌کنم و پلن و مراحل دیپلوی را می‌گویم.';
}

/** پاسخ به سؤال آزاد کاربر: LLM اگر تنظیم شده باشد، وگرنه دمو. */
export async function answerQuestion({ session, question, extra = {}, onDelta }) {
  if (!llmInfo().configured) {
    const text = demoAnswer(session, question, extra);
    onDelta?.(text);
    return text;
  }

  const history = session.messages
    .filter((m) => m.kind === 'text' && m.role)
    .slice(-8)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.text || '').slice(0, 700) }));

  const messages = [
    { role: 'system', content: persona(session, extra) },
    ...history,
    { role: 'user', content: question },
  ];

  try {
    return await streamChat({ messages, onDelta });
  } catch (e) {
    console.error('LLM error:', e.message);
    const explained = e.explained || { message: e.message, hint: null, blocked: false };
    session.llmNotice = { ...explained, at: Date.now() };
    const fallback = demoAnswer(session, question, extra);
    onDelta?.(fallback);
    return fallback;
  }
}
