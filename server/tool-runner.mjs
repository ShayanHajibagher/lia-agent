/**
 * tool-runner.mjs — اجرای مشترک ابزارهای ایجنت
 *
 * هم حلقهٔ LangGraph و هم «برنامه‌ریز دمو» از همین‌جا ابزار را اجرا می‌کنند تا:
 *  - رویداد «ابزار» (چیپ در چت) و لاگ زنده یکسان باشد،
 *  - پیام خطا به‌جای پرتاب استثنا به مدل برگردد،
 *  - پیش‌نمایش تأیید (دیف/اثر) یک‌جا ساخته شود.
 */
import { TOOL_MAP } from './toolbox.mjs';
import { logLine } from './bus.mjs';
import { addMessage } from './store.mjs';

export async function execTool(session, emit, name, args) {
  const tool = TOOL_MAP.get(name);
  if (!tool) return { error: `ابزار ناشناخته: ${name}` };
  emit({ t: 'tool', name, label: tool.label, status: 'start' });
  logLine(session.id, 'tool', 'اجرای «' + tool.label + '»');
  try {
    const result = await tool.handler(args || {}, { session });
    emit({ t: 'tool', name, label: tool.label, status: 'done', summary: result.summary });
    logLine(session.id, 'tool', '✓ ' + tool.label + ' — ' + result.summary, 'ok');
    addMessage(session, {
      kind: 'tool',
      role: 'system',
      name,
      label: tool.label,
      status: 'done',
      summary: result.summary,
    });
    return result;
  } catch (e) {
    emit({ t: 'tool', name, label: tool.label, status: 'error', summary: e.message });
    logLine(session.id, 'tool', '✗ ' + tool.label + ' — ' + e.message, 'err');
    addMessage(session, {
      kind: 'tool',
      role: 'system',
      name,
      label: tool.label,
      status: 'error',
      summary: e.message,
    });
    return { error: e.message };
  }
}

/** پیش‌نمایش کارت تأیید: عنوان، دلیل، اثر و دیف */
export async function approvalPreview(tool, args, session) {
  let preview = { title: `اجرای ${tool.label}`, reason: '', impact: '', diff: '' };
  try {
    preview = { ...preview, ...(await tool.preview(args || {}, { session })) };
  } catch (e) {
    preview.impact = e.message;
  }
  return preview;
}
