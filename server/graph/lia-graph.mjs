/**
 * lia-graph.mjs — ایجنت لیا روی LangGraph
 *
 * چرا LangGraph: حلقهٔ «فکر کن → ابزار → نتیجه → ادامه» باید صریح و قابل‌تست باشد،
 * وضعیت بین نوبت‌های گفتگو (و بعد از تأیید کاربر) حفظ شود، و سقف مراحل از خودِ
 * گراف بیاید نه از یک شمارندهٔ سراسری. این‌جا همان معماری است:
 *
 *   START → agent ─┬─(tool_calls)─→ tools ─┐
 *                  └─(پاسخ نهایی)─→ END    │
 *                        ↑───────────────┘
 *
 * - «agent»: مدل با ابزارهای لیا (tool-calling).
 * - «tools»: اجرای ابزارها؛ ابزار حساس قبل از اجرا `interrupt()` می‌کند تا
 *   کاربر اجازه بدهد. کارت تأیید بیرون از گراف (در orchestrator) ساخته می‌شود،
 *   پس در بازپخشِ گره تکرار نمی‌شود.
 * - ابزارها با کلید `thread+callId` یک‌بار اجرا می‌شوند (idempotent) تا بازپخش
 *   گره بعد از `interrupt` باعث نوشتن دوبارهٔ فایل یا اجرای دوبارهٔ دیپلوی نشود.
 *
 * اگر پکیج‌های LangChain نصب نباشند یا مدل تنظیم نشده باشد، این ماژول بارگذاری
 * نمی‌شود و `agent.mjs` با برنامه‌ریز داخلی ادامه می‌دهد (بدون کرش).
 */
import { TOOL_MAP, toolSchemas } from '../toolbox.mjs';
import { execTool, approvalPreview } from '../tool-runner.mjs';
import { logLine } from '../bus.mjs';
import { hasProject, projectStats } from '../workspace.mjs';
import { llmInfo, chatModelOptions } from '../llm.mjs';

const MAX_TURNS = Math.max(6, Number(process.env.LIA_MAX_TURNS) || 16); // سقف دورهای مدل در یک نوبت (هر دور = یک تماس مدل)
const MAX_RESULT_CHARS = 4500;
const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 1400;

/* ---------------- بارگذاری تنبل وابستگی‌ها ---------------- */

let deps = null;
let loadError = null;

export async function loadGraphDeps() {
  if (deps) return deps;
  if (loadError) return null;
  try {
    const [lg, openai, messages] = await Promise.all([
      import('@langchain/langgraph'),
      import('@langchain/openai'),
      import('@langchain/core/messages'),
    ]);
    deps = {
      StateGraph: lg.StateGraph,
      Annotation: lg.Annotation,
      MemorySaver: lg.MemorySaver,
      Command: lg.Command,
      interrupt: lg.interrupt,
      START: lg.START,
      END: lg.END,
      ChatOpenAI: openai.ChatOpenAI,
      HumanMessage: messages.HumanMessage,
      AIMessage: messages.AIMessage,
      SystemMessage: messages.SystemMessage,
      ToolMessage: messages.ToolMessage,
    };
    return deps;
  } catch (e) {
    loadError = e;
    console.warn('[lia] LangGraph در دسترس نیست؛ برنامه‌ریز داخلی فعال می‌ماند:', e.message);
    return null;
  }
}

/* ---------------- کمکی‌ها ---------------- */

const clip = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '\n…(کوتاه شد)' : text;
};

/** متن یک پیام مدل را به رشته تبدیل می‌کند (رشته یا بلوک‌های محتوا) */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

const fa = (n) => Number(n || 0).toLocaleString('fa-IR');

/** وضعیت واقعی سشن در یک بلوک کوتاه برای مدل */
function stateBlock(session) {
  const a = session.analysis;
  const stats = hasProject(session.id) ? projectStats(session.id) : null;
  const notes = session.agent?.notes || [];
  const deploy = session.deploySummary;
  const recent = session.messages
    .filter((m) => m.kind === 'text' && m.role === 'user')
    .slice(-3)
    .map((m) => m.text.slice(0, 90));

  return [
    `حالت گفتگو: ${session.mode} / ${session.stage}`,
    session.context?.path ? `صفحهٔ فعلی کاربر: ${session.context.path}` : '',
    stats ? `پروژه: ${fa(stats.files)} فایل، حدود ${Math.round(stats.bytes / 1024)} کیلوبایت` : 'پروژه‌ای آپلود نشده',
    a ? `پلتفرم: ${a.platform} — build: ${a.build || '—'} — پورت: ${a.port}` : '',
    a?.findings?.length ? `یافته‌ها: ${a.findings.slice(0, 5).map((f) => `${f.title} (${f.severity})`).join('؛ ')}` : '',
    session.quote?.plan ? `پلن پیشنهادی: ${session.quote.plan.name} — ماهی ${fa(session.quote.plan.monthly)} تومان` : '',
    deploy ? `آخرین دیپلوی: ${deploy.status} — ${deploy.appName || ''} — آدرس: ${deploy.url || '—'} — مرحله: ${deploy.stoppedAt || 'پایان'}` : '',
    deploy?.warnings?.length ? `هشدارهای دیپلوی: ${deploy.warnings.slice(0, 3).join(' | ')}` : '',
    notes.length ? `یادداشت‌ها: ${notes.slice(-4).join(' | ')}` : '',
    recent.length ? `آخرین درخواست‌های کاربر: ${recent.join(' ⟂ ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function systemPrompt(session) {
  return [
    'تو «لیا» هستی: ایجنت خودمختار فارسی‌زبان برای دیپلوی پروژه روی لیارا (PaaS).',
    'کاربر فارسی حرف می‌زند؛ تو هم فارسی، صمیمی و کوتاه جواب بده.',
    '',
    'قواعد قطعی:',
    '۱) قبل از هر ادعا دربارهٔ کد، پروژه یا وضعیت دیپلوی، ابزار مناسب را صدا بزن. حدس نزن.',
    '۲) برای بررسی کلی پروژه اول analyze_project را صدا بزن (پلتفرم، build/start، پورت، متغیرها و باگ‌ها را یک‌جا می‌دهد)؛ فایل‌به‌فایل خواندن فقط وقتی لازم است که جزئیات یک مورد را می‌خواهی.',
    '۳) هیچ عدد قیمت یا مشخصات پلنی از خودت نساز؛ فقط quote_plan.',
    '۴) تغییر فایل را با write_file بده؛ خودش از کاربر اجازه می‌گیرد. تا اجازه نگرفته‌ای نگو «انجام شد».',
    '۴٫۱) برای اصلاح کد، اول patch_file را امتحان کن (فقط همان بخش عوض می‌شود)؛ write_file برای فایل جدید یا بازنویسی کامل. ' +
      'delete_file و move_file هم برای حذف/جابه‌جایی فایل هستند. همه با اجازه و دیف.',
    '۴٫۲) قبل از start_deploy حتماً plan_deploy را صدا بزن؛ مرحله‌ها از روی فایل‌های واقعی پروژه انتخاب می‌شوند. ' +
      'اگر دیدی مرحله‌ای لازم نیست، با steps در start_deploy تصمیم خودت را اعمال کن.',
    '۵) هر کار هزینه‌زا (ساخت اپ، ریلیز) فقط با start_deploy و تأیید مرحله‌به‌مرحله.',
    '۶) در هر نوبت فقط یک پاسخ نهایی بده: حداکثر ۴ جمله، بدون مقدمه، بدون تکرار اعدادی که کارت نشان می‌دهد.',
    '۷) اگر کاربر اجازهٔ کاری را نداد، با همان واقعیت ادامه بده و جایگزین پیشنهاد کن. اصرار نکن.',
    '۸) بعد از پایان دیپلوی در «حالت چت» هستی: با لاگ، دامنه، متغیر محیطی، خطای اجرا و ارتقای پلن کمک کن.',
    '۹) اگر ابزاری نتیجهٔ خالی داد، همان را بگو؛ از خودت پر نکن.',
    '۱۰) وقتی چند تصمیم لازم داری (نام برنامه، پلتفرم، پلن، مسیر کار)، همه را در **یک** فراخوانی ask_user بپرس تا کاربر یک‌جا جواب بدهد؛ سؤال متنی نپرس.',
    '۱۱) قبل از start_deploy حتماً account_status را صدا بزن؛ اگر پلن فعال نبود، با ask_user بپرس و کارت پلن/خرید را نشان بده.',
    '۱۲) برای نصب، بیلد، تست و lint از run_command استفاده کن (خودش اجازه می‌گیرد)؛ خروجی را برای کاربر خلاصه کن.',
    '۱۳) اگر دیپلوی شکست خورد (بیلد، اجرا یا سلامت‌سنجی)، خودت وارد دیباگ شو: اول diagnose_deploy، بعد فایل‌های مربوط را بخوان، ' +
      'علت واقعی را پیدا کن، با write_file (یا run_command برای نصب بستهٔ کم) اصلاح کن و بعد retry_deploy. ' +
      'تا وقتی تلاش دوباره را اجرا نکرده‌ای نگو «حل شد».',
    '۱۴) اگر کاربر گفت «همین پروژه را دوباره دیپلوی کن» یا فایل پروژه را دوباره نفرستاد، اول list_deployments را صدا بزن؛ ' +
      'اگر پروژهٔ زنده‌ای هست با redeploy همان را بالا بیاور و از کاربر نخواه دوباره zip بفرستد.',
    '۱۵) کار کدنویسی را مثل یک مهندس انجام بده: (الف) analyze_project برای تصویر کلی؛ (ب) فقط همان ۲–۳ فایلی را که واقعاً لازم است read_file کن — ' +
      'همهٔ فایل‌ها را نخوان؛ (ج) علت را در جملهٔ کوتاه بگو؛ (د) با patch_file اصلاح کن (یا write_file برای فایل جدید/بازنویسی)؛ ' +
      '(ه) بعد از تغییر، analyze_project را دوباره بزن تا مطمئن شوی مشکل رفع شده؛ (و) اگر لازم بود start_deploy/retry_deploy.',
    '۱۶) اگر پروژه‌ای آپلود نشده و کاربر می‌خواهد از صفر ساخته شود، خودت فایل‌ها را با write_file بساز ' +
      '(package.json با start، سرور، صفحات) و بعد analyze_project و در آخر start_deploy؛ منتظر آپلود نمان.',
    '۱۷) هرگز فایلی را که نخوانده‌ای بازنویسی نکن. اگر متن دقیق برای patch_file را نمی‌دانی، اول read_file.',
    '۱۸) ویرایش بعد از دیپلوی: اگر اپی در حال اجراست و کاربر تغییری خواست، فایل را در فضای کاری عوض کن و بعد ' +
      'apply_changes را صدا بزن تا کد تازه روی همان اپ بنشیند (کپی + بیلد + ری‌استارت). ' +
      'بدون apply_changes تغییر روی اپ دیده نمی‌شود؛ این را به کاربر هم بگو.',
    '۱۹) نسخه‌ها: هر دیپلوی و هر اعمال تغییر یک نسخه از سورس روی ماشین ما ذخیره می‌کند. ' +
      'با list_versions نسخه‌ها را ببین و با restore_version به نسخهٔ قبلی برگرد (بعدش apply_changes).',
    '',
    'وضعیت واقعی:',
    stateBlock(session),
  ].join('\n');
}

/** تاریخچهٔ ارسالی به مدل: کوتاه، بدون پیام‌های سیستمی و با سقف کاراکتر */
function trimHistory(messages) {
  const keep = messages.slice(-HISTORY_MESSAGES);
  return keep.map((m) => {
    const text = messageText(m);
    if (text.length <= HISTORY_CHARS) return m;
    const Cls = m.constructor;
    try {
      return new Cls({ ...m, content: text.slice(0, HISTORY_CHARS) + '…' });
    } catch {
      return m;
    }
  });
}

/* ---------------- وضعیت گراف ---------------- */

let compiled = null;
let checkpointer = null;

/** threadId → { session, emit, io, threadId } */
const contexts = new Map();
/** `${threadId}:${callId}` → { content } — اجرای یک‌بارهٔ ابزار در بازپخش گره */
const executed = new Map();
let executedPrunedAt = 0;

function rememberExecuted(key, content) {
  const now = Date.now();
  if (now - executedPrunedAt > 60_000) {
    executedPrunedAt = now;
    if (executed.size > 800) executed.clear();
  }
  executed.set(key, { content });
}

function contextOf(config) {
  const threadId = config?.configurable?.thread_id;
  return contexts.get(threadId) || contexts.get('__last__') || null;
}

/* ---------------- گره‌ها ---------------- */

async function agentNode(state, config) {
  const ctx = contextOf(config);
  if (!ctx) throw new Error('context ایجنت پیدا نشد');
  const model = new deps.ChatOpenAI(chatModelOptions({ maxTokens: 1200 }));
  const bound = model.bindTools(toolSchemas());

  const prompt = [new deps.SystemMessage(systemPrompt(ctx.session)), ...trimHistory(state.messages)];
  const res = await bound.invoke(prompt);
  const turns = (state.turns || 0) + 1;
  const toolCalls = res.tool_calls || [];

  if (!toolCalls.length) return { messages: [res], turns, status: 'done', pending: null };

  if (turns >= MAX_TURNS) {
    // سقف ابزار این دور: بدون ابزار جمع‌بندی کن تا حلقه بی‌نهایت نشود
    const filler = toolCalls.map(
      (call) => new deps.ToolMessage({ content: JSON.stringify({ skipped: true, reason: 'سقف مراحل این دور' }), tool_call_id: call.id }),
    );
    const final = await model.invoke([
      ...prompt,
      res,
      ...filler,
      new deps.HumanMessage('سقف گام‌های این دور پر شد. همین حالا بر اساس نتایجی که داری جمع‌بندی کن: چه چیزی را فهمیدی، چه کاری انجام شد و قدم بعدی دقیقاً چیست؛ ابزار جدید صدا نزن.'),
    ]);
    return { messages: [res, ...filler, final], turns, status: 'done', pending: null };
  }

  return { messages: [res], turns, status: 'running', pending: null };
}

/** سؤال‌های ابزار ask_user را نرمال می‌کند (۱ تا ۶ سؤال، نوع معتبر) */
function normalizeQuestions(args = {}) {
  const raw = Array.isArray(args.questions) ? args.questions : [];
  return raw
    .slice(0, 6)
    .map((q, i) => {
      const options = Array.isArray(q?.options)
        ? q.options.slice(0, 8).map((o) => (typeof o === 'string' ? { label: o, value: o } : { label: String(o?.label ?? o?.value ?? ''), value: String(o?.value ?? o?.label ?? '') }))
        : [];
      const type = ['choice', 'text', 'confirm'].includes(q?.type) ? q.type : options.length ? 'choice' : 'text';
      return {
        id: String(q?.id || `q${i + 1}`).slice(0, 40),
        label: String(q?.label || q?.question || `سؤال ${i + 1}`).slice(0, 300),
        type,
        options,
        placeholder: q?.placeholder ? String(q.placeholder).slice(0, 120) : '',
        required: q?.required !== false,
      };
    })
    .filter((q) => q.label);
}

async function toolsNode(state, config) {
  const ctx = contextOf(config);
  if (!ctx) throw new Error('context ایجنت پیدا نشد');

  const last = [...state.messages].reverse().find((m) => (m.tool_calls || []).length);
  const out = [];

  for (const call of last?.tool_calls || []) {
    const key = `${ctx.threadId}:${call.id}`;
    const cached = executed.get(key);
    if (cached) {
      out.push(new deps.ToolMessage({ content: cached.content, tool_call_id: call.id }));
      continue;
    }

    const def = TOOL_MAP.get(call.name);
    if (!def) {
      const content = JSON.stringify({ error: `ابزار ناشناخته: ${call.name}` });
      rememberExecuted(key, content);
      out.push(new deps.ToolMessage({ content, tool_call_id: call.id }));
      continue;
    }

    if (def.interactive) {
      const questions = normalizeQuestions(call.args);
      if (!questions.length) {
        const content = JSON.stringify({ error: 'هیچ سؤال معتبری داده نشد' });
        rememberExecuted(key, content);
        out.push(new deps.ToolMessage({ content, tool_call_id: call.id }));
        continue;
      }
      const askId = 'ask_' + call.id;
      const payload = {
        type: 'ask',
        askId,
        title: String(call.args.title || 'چند سؤال کوتاه').slice(0, 120),
        intro: String(call.args.intro || '').slice(0, 300),
        questions,
      };
      ctx.session.agent = ctx.session.agent || {};
      ctx.session.agent.ask = { id: askId, ...payload };
      // پاسخ کاربر (answers) از resume برمی‌گردد
      const answer = deps.interrupt(payload);
      ctx.session.agent.ask = null;
      const content = JSON.stringify({ answers: answer?.answers || {}, note: 'پاسخ کاربر به فرم' });
      rememberExecuted(key, content);
      out.push(new deps.ToolMessage({ content, tool_call_id: call.id }));
      continue;
    }

    if (def.approval) {
      const preview = await approvalPreview(def, call.args, ctx.session);
      // هیچ افکت جانبی قبل از interrupt نیست؛ کارت تأیید در orchestrator ساخته می‌شود.
      const decision = deps.interrupt({
        callId: call.id,
        name: call.name,
        label: def.label,
        preview,
      });
      if (!decision?.approved) {
        const content = JSON.stringify({ denied: true, note: 'کاربر با این تغییر موافقت نکرد؛ اعمال نشد.' });
        rememberExecuted(key, content);
        out.push(new deps.ToolMessage({ content, tool_call_id: call.id }));
        continue;
      }
    }

    const result = await execTool(ctx.session, ctx.emit, call.name, call.args || {});
    if (result.card) ctx.io.card(result.card);
    if (!result.error) {
      ctx.session.agent = ctx.session.agent || {};
      ctx.session.agent.lastTool = def.label;
    }
    const content = clip(result.error ? { error: result.error } : (result.data ?? result.summary));
    rememberExecuted(key, content);
    out.push(new deps.ToolMessage({ content, tool_call_id: call.id }));
  }

  return { messages: out, pending: null };
}

/* ---------------- ساخت گراف ---------------- */

async function ensureGraph() {
  if (compiled) return compiled;
  const ready = await loadGraphDeps();
  if (!ready) return null;

  const State = deps.Annotation.Root({
    messages: deps.Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
    turns: deps.Annotation({ reducer: (_, b) => b ?? 0, default: () => 0 }),
    status: deps.Annotation({ reducer: (_, b) => b ?? 'running', default: () => 'running' }),
    pending: deps.Annotation({ reducer: (_, b) => b ?? null, default: () => null }),
  });

  checkpointer = new deps.MemorySaver();
  compiled = new deps.StateGraph(State)
    .addNode('agent', agentNode)
    .addNode('tools', toolsNode)
    .addEdge(deps.START, 'agent')
    .addConditionalEdges('agent', (s) => (s.status === 'done' ? deps.END : 'tools'), {
      tools: 'tools',
      [deps.END]: deps.END,
    })
    .addEdge('tools', 'agent')
    .compile({ checkpointer });
  return compiled;
}

/* ---------------- API ---------------- */

export async function graphReady() {
  if (!llmInfo().configured) return false;
  return !!(await ensureGraph());
}

/**
 * حافظهٔ گفتگو: اگر thread تازه باشد (ری‌استارت سرور یا گفتگوی نو)، آخرین
 * پیام‌های همین سشن به‌عنوان تاریخچه به گراف داده می‌شود تا ایجنت «یادش» بماند.
 */
const seededThreads = new Set();

function transcriptMessages(session, currentText) {
  const texts = (session.messages || []).filter((m) => m.kind === 'text' && m.text && m.text.trim());
  const last = texts[texts.length - 1];
  if (last && last.role === 'user' && last.text === currentText) texts.pop();
  return texts
    .slice(-12)
    .map((m) =>
      m.role === 'user'
        ? new deps.HumanMessage(String(m.text).slice(0, 1200))
        : new deps.AIMessage(String(m.text).slice(0, 1200)),
    );
}

function ensureThread(session) {
  session.agent = session.agent || {};
  if (!session.agent.threadId) {
    session.agent.threadId = `${session.id}-${Date.now().toString(36)}`;
  }
  return session.agent.threadId;
}

/** گفتگو/ادامهٔ گفتگو را در گراف اجرا می‌کند */
export async function runGraphAgent(session, emit, text, io) {
  const graph = await ensureGraph();
  if (!graph) return { status: 'unavailable' };

  const threadId = ensureThread(session);
  const ctx = { session, emit, io, threadId };
  contexts.set(threadId, ctx);
  contexts.set('__last__', ctx);

  session.agent.status = 'running';
  session.agent.pending = null;

  // تاریخچه فقط یک‌بار برای هر thread تازه تزریق می‌شود
  const seed = seededThreads.has(threadId) ? [] : transcriptMessages(session, text);
  seededThreads.add(threadId);
  if (seed.length) logLine(session.id, 'model', `حافظهٔ گفتگو: ${seed.length} پیام قبلی به ایجنت داده شد`, 'dim');

  return drive(session, emit, io, threadId, {
    messages: [...seed, new deps.HumanMessage(text)],
    turns: 0,
    pending: null,
    status: 'running',
  });
}

/** ادامهٔ گراف بعد از «بله/نه» کاربر */
export async function resumeGraphAgent(session, emit, decision, io) {
  const pending = session.agent?.pending;
  if (!pending?.threadId) {
    io.say('درخواست تأییدی باز نیست؛ اگر کاری لازم است بگو تا انجام دهم.');
    return { status: 'no_pending' };
  }
  const graph = await ensureGraph();
  if (!graph) return { status: 'unavailable' };

  const threadId = pending.threadId;
  const ctx = { session, emit, io, threadId };
  contexts.set(threadId, ctx);
  contexts.set('__last__', ctx);

  session.agent.pending = null;
  session.agent.status = 'running';
  logLine(
    session.id,
    'approval',
    decision.answers
      ? 'پاسخ کاربر به فرم ثبت شد'
      : decision.approved
        ? 'کاربر اجازه داد: ' + (pending.preview?.title || pending.name)
        : 'کاربر اجازه نداد: ' + (pending.preview?.title || pending.name),
    decision.answers || decision.approved ? 'ok' : 'warn',
  );

  return drive(
    session,
    emit,
    io,
    threadId,
    new deps.Command({ resume: { approved: !!decision.approved, answers: decision.answers || null } }),
  );
}

async function drive(session, emit, io, threadId, input) {
  const graph = await ensureGraph();
  const config = { configurable: { thread_id: threadId }, recursionLimit: MAX_TURNS * 2 + 12 };

  let result;
  try {
    result = await graph.invoke(input, config);
  } catch (e) {
    session.agent.status = 'error';
    logLine(session.id, 'model', 'خطای گراف ایجنت: ' + e.message, 'err');
    return { status: 'error', error: e };
  }

  const interrupts = result?.__interrupt__;
  if (interrupts?.length) {
    const value = interrupts[0].value || {};

    // فرم چندسؤالی: کارت دکمه‌دار در چت، پاسخ یک‌جا برمی‌گردد
    if (value.type === 'ask') {
      session.agent.status = 'awaiting_answer';
      session.agent.pending = {
        threadId,
        askId: value.askId,
        name: 'ask_user',
        preview: { title: value.title || 'چند سؤال کوتاه' },
        ask: { askId: value.askId, title: value.title, intro: value.intro, questions: value.questions },
      };
      logLine(session.id, 'approval', 'منتظر پاسخ کاربر: ' + (value.title || 'فرم سؤال'), 'warn');
      io.card({ kind: 'ask', askId: value.askId, title: value.title, intro: value.intro, questions: value.questions });
      return { status: 'awaiting_answer' };
    }

    const preview = value.preview || { title: `اجرای ${value.label || value.name}`, reason: '', impact: '', diff: '' };
    session.agent.status = 'awaiting_approval';
    session.agent.pending = { threadId, callId: value.callId, name: value.name, preview };
    logLine(session.id, 'approval', 'در انتظار تأیید: ' + (preview.title || value.name), 'warn');
    io.card({
      kind: 'tool_approval',
      tool: value.name,
      toolLabel: value.label,
      title: preview.title,
      reason: preview.reason,
      impact: preview.impact,
      diff: preview.diff,
    });
    return { status: 'awaiting_approval' };
  }

  const finalText = messageText(result?.messages?.[result.messages.length - 1]);
  if (finalText) {
    io.say(finalText);
  } else if (session.agent.lastTool) {
    // مدل متن نداد؛ حداقل واقعیت را بگو تا کاربر معلق نماند
    io.say(`✓ ${session.agent.lastTool} انجام شد.`);
    session.agent.lastTool = null;
  }

  session.agent.status = 'done';
  session.agent.pending = null;
  return { status: 'done' };
}

/** شروع تازهٔ حافظهٔ ایجنت (بعد از restart یا پایان دیپلوی) */
export function resetGraphThread(session) {
  if (!session.agent) return;
  const old = session.agent.threadId;
  if (old) {
    contexts.delete(old);
    for (const key of [...executed.keys()]) if (key.startsWith(old + ':')) executed.delete(key);
  }
  session.agent.threadId = null;
  session.agent.pending = null;
  session.agent.status = 'idle';
  session.agent.turns = 0;
}

/** برای تست/دیباگ */
export function graphStats() {
  return { threads: contexts.size, executed: executed.size, compiled: !!compiled, error: loadError?.message || null };
}
