/**
 * exec.mjs — اجرای کنترل‌شدهٔ دستور در پوشهٔ پروژه (برای ابزار run_command)
 *
 * قواعد امنیتی:
 *  - دستورهای مخرب (حذف ریشه، فرمت دیسک، خاموش‌کردن سیستم، pipe به شل) رد می‌شوند.
 *  - همیشه داخل پوشهٔ همان سشن اجرا می‌شود (cwd)، نه جای دیگر.
 *  - سقف زمان دارد و در پایان، کل درخت پروسه بسته می‌شود.
 *  - خروجی محدود می‌شود تا حافظه/کانتکست پر نشود.
 *
 * این ابزار برای «کار کردن واقعی ایجنت» است (نصب، بیلد، تست، lint) و همیشه
 * پشت تأیید کاربر قرار دارد.
 */
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 20_000;

const DENY = [
  /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+\/(?:\s|$)/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bdel\s+\/[a-z]*[sq]/i,
  /\brd\s+\/s\b/i,
  /:\(\)\s*\{/, // fork bomb
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z)?sh\b/i,
  /\bnpm\s+publish\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
];

export function checkCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('دستور خالی است');
  if (cmd.length > 600) throw new Error('دستور بیش از حد طولانی است');
  for (const re of DENY) {
    if (re.test(cmd)) throw new Error(`این دستور به‌خاطر ریسک امنیتی مجاز نیست: ${cmd.slice(0, 80)}`);
  }
  return cmd;
}

function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @returns {Promise<{ code:number, output:string, ms:number, timedOut:boolean }>}
 */
export function runShell(command, { cwd, timeoutMs = 60_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;

    let child;
    try {
      child = spawn(command, {
        cwd,
        env: { ...process.env, ...env },
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      return resolve({ code: -1, output: e.message, ms: 0, timedOut: false });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(3_000, timeoutMs));

    const push = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: output + '\n' + e.message, ms: Date.now() - started, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: output.trim(), ms: Date.now() - started, timedOut });
    });
  });
}
