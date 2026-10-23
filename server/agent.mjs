/**
 * agent.mjs — هستهٔ خودمختار لیا
 *
 * دو موتور دارد:
 *
 *  ۱) **LangGraph** (موتور اصلی): حلقهٔ tool-calling با وضعیت پایدار بین نوبت‌ها،
 *     تأیید انسانی و سقف مراحل — پیاده‌سازی در `server/graph/lia-graph.mjs`.
 *  ۲) **برنامه‌ریز داخلی/دمو**: اگر کلید مدل نباشد یا سرویس در دسترس نباشد، همان
 *     ابزارها با قواعد ساده صدا زده می‌شوند تا جریان کامل (تحلیل، رفع، پلن،
 *     دیپلوی) بدون مدل هم کار کند و تست‌پذیر بماند.
 *
 * قاعدهٔ مشترک: خواندن آزاد است؛ نوشتن روی فایل، ساخت اپ و دیپلوی بدون اجازهٔ
 * صریح کاربر انجام نمی‌شود.
 */
import { TOOL_MAP, toolSchemas, buildFixProposal } from './toolbox.mjs';
import { llmInfo, chatWithTools } from './llm.mjs';
import { hasProject } from './workspace.mjs';
import { logLine } from './bus.mjs';
import { execTool } from './tool-runner.mjs';

const MAX_STEPS = 8;
const HISTORY_KEEP = 24;

/* ---------------- کمکی‌ها ---------------- */

function toNumber(text) {
  const normalized = String(text || '')
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/,/g, '');
  const m = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  let n = Number(m[1]);
  if (/هزار/.test(normalized)) n *= 1000;
  if (/میلیون/.test(normalized)) n *= 1_000_000;
  return n;
}

function clip(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > 4500 ? text.slice(0, 4500) + '\n…(کوتاه شد)' : text;
}

function systemPrompt(session) {
  const analysis = session.analysis;
  const notes = session.agent?.notes || [];
  const deploy = session.deploySummary;
  return [
    'تو «لیا» هستی: ایجنت خودمختار فارسی‌زبان برای پروژهٔ کاربر روی لیارا (PaaS).',
    'با ابزارها کار می‌کنی. قاعده‌ها:',
    '۱) قبل از هر ادعا دربارهٔ کد/پروژه، ابزار مناسب را صدا بزن (list_files/read_file/search_code/analyze_project).',
    '۲) هیچ عدد قیمت یا مشخصات پلنی از خودت نساز؛ فقط از quote_plan استفاده کن.',
    '۳) برای تغییر کد از write_file استفاده کن؛ خود ابزار دیف را نشان می‌دهد و از کاربر اجازه می‌گیرد.',
    '۴) برای دیپلوی از start_deploy استفاده کن؛ هر مرحلهٔ هزینه‌زا جداگانه تأیید می‌گیرد.',
    '۵) پاسخ نهایی کوتاه، فارسی و بدون مارک‌داون سنگین باشد؛ جزئیات را از نتایج ابزارها بگیر.',
    '',
    hasProject(session.id) ? 'پروژه در فضای کاری موجود است.' : 'هنوز پروژه‌ای آپلود نشده؛ اول از کاربر zip یا لینک گیت‌هاب بخواه.',
    analysis ? `پلتفرم: ${analysis.platform} — build: ${analysis.build || '—'} — پورت: ${analysis.port}` : '',
    session.quote?.plan ? `پلن پیشنهادی فعلی: ${session.quote.plan.name}` : '',
    deploy ? `آخرین دیپلوی: ${deploy.status} — ${deploy.url || ''}` : '',
    notes.length ? `یادداشت‌ها: ${notes.join(' | ')}` : '',
    session.context?.path ? `صفحهٔ فعلی کاربر: ${session.context.path}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ---------------- وضعیت ایجنت ---------------- */

function ensureAgent(session) {
  session.agent = session.agent || {};
  if (!Array.isArray(session.agent.messages)) session.agent.messages = [];
  session.agent.notes = session.agent.notes || [];
  return session.agent;
}

/** تاریخچهٔ حلقهٔ قدیمی را کوتاه نگه می‌دارد (پیام سیستمی همیشه اول می‌ماند) */
function trimLegacyMessages(agent) {
  const system = agent.messages[0]?.role === 'system' ? agent.messages[0] : null;
  const rest = agent.messages.slice(system ? 1 : 0);
  if (rest.length <= HISTORY_KEEP) return;
  agent.messages = [...(system ? [system] : []), ...rest.slice(-HISTORY_KEEP)];
}

/* ---------------- انتخاب موتور ---------------- */

let graphModule = null;
let graphTried = false;

async function loadGraph() {
  if (graphTried) return graphModule;
  graphTried = true;
  try {
    graphModule = await import('./graph/lia-graph.mjs');
    const ready = await graphModule.graphReady();
    if (!ready) graphModule = null;
  } catch (e) {
    console.warn('[lia] گراف در دسترس نیست:', e.message);
    graphModule = null;
  }
  return graphModule;
}

/** حافظهٔ ایجنت را پاک می‌کند (بعد از restart یا پایان دیپلوی) */
export async function resetAgentMemory(session) {
  const graph = await loadGraph();
  if (graph) graph.resetGraphThread(session);
  const agent = ensureAgent(session);
  agent.messages = [];
  agent.pending = null;
  agent.status = 'idle';
  agent.turns = 0;
}

/* ---------------- ورودی اصلی ---------------- */

export async function runAgent(session, emit, userText, io) {
  const agent = ensureAgent(session);
  agent.status = 'running';
  agent.pending = null;
  agent.turns = 0;

  if (!llmInfo().demo) {
    const graph = await loadGraph();
    if (graph) {
      agent.mode = 'graph';
      const res = await graph.runGraphAgent(session, emit, userText, io);
      if (['done', 'awaiting_approval', 'awaiting_answer'].includes(res.status)) return;
      if (res.status === 'error') {
        // یک پیام کوتاه — نه دو پیام هشدار پشت سر هم
        const reason = res.error?.userHint || res.error?.explained?.hint || '';
        agent.status = 'error';
        io.say('سرویس مدل پاسخ نداد؛ با برنامه‌ریز داخلی ادامه می‌دهم.' + (reason ? ` (${reason})` : ''));
        return runDemo(session, emit, userText, io);
      }
    }
    // گراف نصب/فعال نیست: حلقهٔ قدیمی (اگر مدل کار کند)
    if (!graph) return runLegacy(session, emit, userText, io);
  }

  return runDemo(session, emit, userText, io);
}

/** ادامهٔ کار بعد از پاسخ کاربر به درخواست تأیید */
export async function resumeAgent(session, emit, decision, io) {
  const agent = ensureAgent(session);
  const pending = agent.pending;
  if (!pending) {
    io.say('درخواست تأییدی باز نیست؛ اگر کاری لازم است بگو تا انجام دهم.');
    return;
  }

  if (agent.mode === 'graph') {
    const graph = await loadGraph();
    if (graph) return graph.resumeGraphAgent(session, emit, decision, io);
    agent.pending = null;
    io.say('حافظهٔ ایجنت در دسترس نیست؛ درخواستت را یک‌بار دیگر بفرست تا از نو انجامش بدهم.');
    return;
  }
  if (agent.mode === 'demo') return resumeDemo(session, emit, decision, io, pending);
  return resumeLegacy(session, emit, decision, io, pending);
}

/* ---------------- حلقهٔ قدیمی (بدون گراف) ---------------- */

async function runLegacy(session, emit, userText, io) {
  const agent = ensureAgent(session);
  agent.mode = 'llm';
  agent.status = 'running';
  agent.pending = null;

  if (!agent.messages.length) {
    agent.messages.push({ role: 'system', content: systemPrompt(session) });
  } else {
    agent.messages[0] = { role: 'system', content: systemPrompt(session) };
  }
  agent.messages.push({ role: 'user', content: userText });
  trimLegacyMessages(agent);

  await loop(session, emit, io);
}

async function resumeLegacy(session, emit, decision, io, pending) {
  const agent = ensureAgent(session);
  agent.pending = null;
  agent.status = 'running';

  if (decision.approved) {
    const result = await execTool(session, emit, pending.name, pending.args);
    agent.messages.push({
      role: 'tool',
      tool_call_id: pending.callId,
      content: clip(result.error ? { error: result.error } : (result.data ?? result.summary)),
    });
  } else {
    agent.messages.push({
      role: 'tool',
      tool_call_id: pending.callId,
      content: JSON.stringify({ denied: true, note: 'کاربر با این تغییر موافقت نکرد؛ اعمال نشد.' }),
    });
  }
  await loop(session, emit, io);
}

async function loop(session, emit, io) {
  const agent = ensureAgent(session);
  // شمارندهٔ مراحل مخصوص همین نوبت است؛ بین نوبت‌ها ریست می‌شود تا ایجنت
  // بعد از چند گفتگو در «سقف مراحل» گیر نکند.
  let steps = 0;

  while (steps < MAX_STEPS) {
    steps += 1;
    agent.iterations = steps;

    let turn = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2 && !turn; attempt++) {
      try {
        logLine(session.id, 'model', 'ارسال درخواست به مدل (' + agent.messages.length + ' پیام)');
        turn = await chatWithTools({ messages: agent.messages, tools: toolSchemas(), temperature: 0.2 });
        logLine(
          session.id,
          'model',
          turn.toolCalls.length
            ? 'مدل ' + turn.toolCalls.length + ' ابزار خواست: ' + turn.toolCalls.map((c) => c.name).join(', ')
            : 'پاسخ مدل دریافت شد',
          'ok',
        );
      } catch (e) {
        lastError = e;
        console.error(`agent model error (try ${attempt + 1}):`, e.status || '', e.message);
        const fatal = e.explained?.blocked || e.status === 401 || e.status === 403 || /tool/i.test(e.userHint || '') || /کلید/.test(e.message || '');
        if (fatal) break;
        await new Promise((r) => setTimeout(r, 700));
      }
    }

    if (!turn) {
      emit({ t: 'tool', name: 'model', label: 'مدل زبانی', status: 'error', summary: lastError?.message || 'خطای مدل' });
      agent.status = 'error';
      const reason = lastError?.explained?.hint || lastError?.userHint || lastError?.message || '';
      io.say('سرویس مدل در دسترس نیست؛ با برنامه‌ریز داخلی ادامه می‌دهم.' + (reason ? `\n(${reason})` : ''));
      return runDemo(session, emit, lastUserText(agent), io);
    }

    if (turn.text) io.say(turn.text);
    if (!turn.toolCalls?.length) {
      agent.status = 'done';
      return;
    }

    // پیام دستیار باید با tool_calls در شکل استاندارد OpenAI برگردد
    agent.messages.push({
      role: 'assistant',
      content: turn.text || '',
      tool_calls: turn.rawToolCalls?.length
        ? turn.rawToolCalls
        : turn.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
          })),
    });

    for (let i = 0; i < turn.toolCalls.length; i++) {
      const call = turn.toolCalls[i];
      const tool = TOOL_MAP.get(call.name);
      const args = call.args || {};

      if (tool?.approval) {
        let preview = { title: `اجرای ${tool.label}`, reason: '', impact: '', diff: '' };
        try {
          preview = { ...preview, ...(await tool.preview(args, { session })) };
        } catch (e) {
          preview.impact = e.message;
        }
        agent.status = 'awaiting_approval';
        agent.pending = { callId: call.id, name: call.name, args, preview };

        // بقیهٔ فراخوانی‌های همین پیام باید پاسخ ابزار داشته باشند، وگرنه درخواست
        // بعدی به مدل با خطای «tool_calls بدون tool message» رد می‌شود.
        for (let j = i + 1; j < turn.toolCalls.length; j++) {
          const rest = turn.toolCalls[j];
          agent.messages.push({
            role: 'tool',
            tool_call_id: rest.id,
            content: JSON.stringify({ skipped: true, reason: 'منتظر تأیید کاربر برای فراخوانی قبلی' }),
          });
        }

        logLine(session.id, 'approval', 'در انتظار تأیید: ' + preview.title, 'warn');
        io.card({
          kind: 'tool_approval',
          tool: call.name,
          toolLabel: tool.label,
          title: preview.title,
          reason: preview.reason,
          impact: preview.impact,
          diff: preview.diff,
        });
        return;
      }

      const result = await execTool(session, emit, call.name, args);
      if (result.card) io.card(result.card);
      agent.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: clip(result.error ? { error: result.error } : (result.data ?? result.summary)),
      });
    }

    trimLegacyMessages(agent);
  }

  agent.status = 'done';
  io.say('به سقف مراحل این دور رسیدم. اگر بخواهی ادامه می‌دهم.');
}

function lastUserText(agent) {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    if (agent.messages[i].role === 'user') return String(agent.messages[i].content || '');
  }
  return '';
}

/* ---------------- برنامه‌ریز دمو ---------------- */

function pickPath(text) {
  // توجه: پسوندهای طولانی‌تر اول می‌آیند تا «package.json» به‌جای «package.js» برداشت نشود
  const m = String(text || '').match(
    /([\w./-]+?\.(?:json|tsx|jsx|mjs|cjs|yaml|yml|env|html|css|scss|md|sql|prisma|js|ts|py|php|go))(?![\w])/i,
  );
  return m ? m[1] : null;
}

function pickSearchQuery(text) {
  const quoted = String(text || '').match(/["'«”]([^"'»”]{2,60})["'»”]/);
  if (quoted) return quoted[1];
  const latin = String(text || '').match(/[A-Za-z0-9_./:@-]{3,}/);
  if (latin) return latin[0];
  return 'localhost';
}

function planDemo(session, text) {
  const t = String(text || '');
  const projectReady = hasProject(session.id);
  const plan = [];
  const redeployAsk = /(همین|همون|همان).{0,15}(دوباره|مجدد).{0,10}(دیپلوی|deploy)|(دوباره|مجدد).{0,12}(دیپلوی|deploy)/i.test(t);

  if (!projectReady) {
    // پروژه‌ای در فضای کاری نیست؛ شاید قبلاً دیپلوی شده باشد
    if (redeployAsk) {
      plan.push({ name: 'list_deployments', args: {} });
      plan.push({ name: 'redeploy', args: {} });
      return { plan };
    }
    return {
      plan: [],
      note: 'برای شروع، فایل zip پروژه را در چت آپلود کن یا لینک مخزن گیت‌هاب بده؛ بعد از آن می‌توانم بخوانم، تحلیل کنم و تغییر بدهم.',
    };
  }

  if (/رفع|اصلاح|درستش|درست کن|حل کن|پچ|دیباگ|fix/i.test(t)) {
    plan.push({ name: 'analyze_project', args: {} });
    plan.push({ name: '__propose_fix__', args: { reason: t } });
    return { plan };
  }
  if (/چه مشکل|مشکل|باگ|ایراد|بررسی|تحلیل|نظافت|بهداشت|کیفیت/i.test(t)) {
    plan.push({ name: 'analyze_project', args: {} });
    return { plan };
  }
  const filePath = pickPath(t);
  if (filePath) {
    plan.push({ name: 'read_file', args: { path: filePath } });
    return { plan };
  }
  if (/جستجو|پیدا|کجا|search/i.test(t)) {
    plan.push({ name: 'search_code', args: { query: pickSearchQuery(t) } });
    return { plan };
  }
  if (/پلن|قیمت|هزینه|تومان|بودجه/i.test(t)) {
    plan.push({
      name: 'quote_plan',
      args: { visitors: toNumber(t) || session.requirement?.visitors || 1000, months: 1 },
    });
    return { plan };
  }
  if (redeployAsk) {
    plan.push({ name: 'list_deployments', args: {} });
    plan.push({ name: 'redeploy', args: {} });
    return { plan };
  }
  if (/دیپلوی|منتشر|بالا بیار|استقرار|deploy/i.test(t)) {
    plan.push({ name: 'analyze_project', args: {} });
    plan.push({ name: 'plan_deploy', args: {} });
    plan.push({ name: 'start_deploy', args: {} });
    return { plan };
  }
  if (/وضعیت|لاگ|چی شد/i.test(t)) {
    plan.push({ name: 'deploy_status', args: {} });
    return { plan };
  }
  if (/مرحله|راهنما|کجا کلیک|پنل/i.test(t)) {
    plan.push({ name: 'get_step_guide', args: {} });
    return { plan };
  }
  if (/فایل|فهرست|ساختار|پروژه چیه/i.test(t)) {
    plan.push({ name: 'list_files', args: {} });
    return { plan };
  }

  plan.push({ name: 'analyze_project', args: {} });
  return { plan };
}

export async function runDemo(session, emit, text, io) {
  const agent = ensureAgent(session);
  agent.mode = 'demo';
  agent.status = 'running';
  agent.pending = null;

  const { plan, note } = planDemo(session, text || lastUserText(agent));
  if (note) {
    io.say(note);
    agent.status = 'done';
    return;
  }

  const demo = { plan, index: 0, results: [] };
  agent.demo = demo;
  await continueDemo(session, emit, io);
}

async function continueDemo(session, emit, io) {
  const agent = ensureAgent(session);
  const demo = agent.demo;

  while (demo.index < demo.plan.length) {
    const step = demo.plan[demo.index];

    if (step.name === '__propose_fix__') {
      const analysis = session.analysis;
      const finding = analysis?.findings?.find((f) => f.fix);
      if (!finding) {
        io.say('موردی که بتوانم خودکار رفعش کنم پیدا نکردم؛ فقط گزارش می‌دهم: ' + (analysis?.findings?.map((f) => f.title).join('، ') || 'موردی نبود.'));
        demo.index += 1;
        continue;
      }
      const proposal = buildFixProposal(session, finding);
      if (!proposal.path || proposal.content == null) {
        io.say(`برای «${finding.title}» رفع خودکار ندارم. ${proposal.reason}`);
        demo.index += 1;
        continue;
      }
      step.name = 'write_file';
      step.args = { path: proposal.path, content: proposal.content, reason: proposal.reason };
    }

    const tool = TOOL_MAP.get(step.name);

    if (tool?.approval) {
      const preview = await tool.preview(step.args, { session });
      agent.status = 'awaiting_approval';
      agent.pending = { demoIndex: demo.index, name: step.name, args: step.args, preview };
      io.card({
        kind: 'tool_approval',
        tool: step.name,
        toolLabel: tool.label,
        title: preview.title,
        reason: preview.reason,
        impact: preview.impact,
        diff: preview.diff,
      });
      return;
    }

    const result = await execTool(session, emit, step.name, step.args);
    demo.results.push({ name: step.name, result });
    if (result.card) io.card(result.card);
    demo.index += 1;
  }

  io.say(composeDemoAnswer(session, demo));
  agent.status = 'done';
  agent.demo = null;
}

async function resumeDemo(session, emit, decision, io, pending) {
  const agent = ensureAgent(session);
  const demo = agent.demo;
  if (!demo) {
    io.say('اجرای دمو پیدا نشد.');
    return;
  }

  if (decision.approved) {
    const result = await execTool(session, emit, pending.name, pending.args);
    demo.results.push({ name: pending.name, result });
  } else {
    demo.results.push({ name: pending.name, result: { denied: true } });
  }
  demo.index = (pending.demoIndex ?? demo.index) + 1;
  await continueDemo(session, emit, io);
}

function composeDemoAnswer(session, demo) {
  const lines = [];
  for (const { name, result } of demo.results) {
    if (!result) continue;
    if (result.denied) {
      lines.push('تغییر را اعمال نکردم؛ هر وقت خواستی دوباره پیشنهاد می‌دهم.');
      continue;
    }
    if (result.error) {
      lines.push(`${name}: ${result.error}`);
      continue;
    }
    const d = result.data;

    if (name === 'analyze_project') {
      lines.push(`پروژه: پلتفرم ${d.platform}، ${d.stats.fileCount} فایل (${d.stats.sourceMb}MB).`);
      if (d.findings.length) {
        lines.push('مهم‌ترین نکته‌ها:');
        d.findings.slice(0, 4).forEach((f) => lines.push(`• ${f.title}${f.fix ? ' — قابل رفع' : ''}`));
      } else {
        lines.push('مشکل خاصی پیدا نکردم؛ برای دیپلوی آماده است.');
      }
    } else if (name === 'list_files') {
      const files = (d || []).filter((e) => e.type === 'file').slice(0, 12).map((e) => e.path);
      lines.push(`فایل‌ها (${d.length} مورد): ${files.join('، ')}${d.length > 12 ? ' و…' : ''}`);
    } else if (name === 'read_file') {
      const head = String(d.content || '').split('\n').slice(0, 8).join('\n');
      lines.push(`محتوای ${d.path}:\n${head}${String(d.content).split('\n').length > 8 ? '\n…' : ''}`);
    } else if (name === 'search_code') {
      lines.push(`جست‌وجو: ${d.length} نتیجه` + (d.length ? ` — اولی در ${d[0].path}:${d[0].line}` : ''));
    } else if (name === 'quote_plan') {
      lines.push(`پلن ${d.plan.name}: ماهی ${d.cost.monthlyTotal.toLocaleString('fa-IR')} تومان؛ برای ${d.cost.months} ماه ${d.cost.periodTotal.toLocaleString('fa-IR')} تومان.`);
    } else if (name === 'write_file') {
      lines.push(`اعمال شد: ${d.path} (${d.changedLines} تغییر).`);
    } else if (name === 'start_deploy') {
      lines.push(`دیپلوی شروع شد؛ ${d.steps.length} مرحله. منتظر تأیید مرحلهٔ اول باش.`);
    } else if (name === 'deploy_status') {
      lines.push(`وضعیت دیپلوی: ${d.status} — مرحله ${d.index + 1}/${d.total}.`);
    } else if (name === 'get_step_guide') {
      lines.push(`مرحله: ${d.title} — ${d.action}`);
    }
  }
  return lines.join('\n') || 'انجام شد.';
}

/* ---------------- وضعیت برای کلاینت ---------------- */

export function agentState(session) {
  const agent = session.agent || {};
  return {
    mode: agent.mode || null,
    status: agent.status || 'idle',
    engine: agent.mode === 'graph' ? 'langgraph' : agent.mode === 'demo' ? 'demo' : agent.mode || 'idle',
    pending: agent.pending
      ? {
          name: agent.pending.name,
          preview: agent.pending.preview,
          askId: agent.pending.askId || null,
          ask: agent.pending.ask || null,
        }
      : null,
    notes: agent.notes || [],
  };
}
