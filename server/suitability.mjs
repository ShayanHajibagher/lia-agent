/**
 * suitability.mjs — «این پروژه برای هاست وب مناسب است؟»
 *
 * وقتی کاربر zip آپلود می‌کند، لیا اول باید بفهمد آیا این پروژه اصلاً روی یک
 * هاست وب (لیارا) قابل اجراست یا نه: ربات تلگرام، ابزار CLI، اسکریپت پایتون،
 * اپ موبایل یا دسکتاپ «وب‌سرویس» نیستند.
 *
 * اگر مناسب نبود: دلیل‌ها + فهرست تغییرهای لازم را می‌گوید و می‌پرسد
 * «مناسبش کنم؟» — بدون تأیید، هیچ فایلی تغییر نمی‌کند.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readFile } from './workspace.mjs';

const BOT_DEPS = ['discord.js', 'telegraf', 'node-telegram-bot-api', '@slack/bolt', 'whatsapp-web.js', 'grammy'];
const WEB_DEPS = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', 'socket.io', 'hapi', '@hapi/hapi'];
const PY_WEB = ['flask', 'fastapi', 'django', 'uvicorn', 'gunicorn', 'starlette', 'aiohttp'];

function readSafe(session, rel) {
  try {
    return readFile(session.id, rel).text;
  } catch {
    return '';
  }
}

function parsePkg(session, files) {
  const pkgFile = files.find((f) => /(^|\/)package\.json$/.test(f.name) && f.name.split('/').length <= 3);
  if (!pkgFile) return null;
  try {
    return { file: pkgFile.name, json: JSON.parse(readSafe(session, pkgFile.name)) };
  } catch {
    return null;
  }
}

function requirementsText(session, files) {
  const req = files.find((f) => /(^|\/)requirements\.txt$/.test(f.name));
  const pyproject = files.find((f) => /(^|\/)pyproject\.toml$/.test(f.name));
  return (req ? readSafe(session, req.name) : '') + '\n' + (pyproject ? readSafe(session, pyproject.name) : '');
}

function mainEntry(pkg) {
  if (pkg?.json?.main) return pkg.json.main.replace(/^\.\//, '');
  return null;
}

/* ---------------- سازندهٔ تغییرها ---------------- */

function dockerfileFor({ port, install, build, start }) {
  const lines = ['# ساختهٔ لیا برای اجرا روی لیارا', 'FROM node:20-alpine', 'WORKDIR /app', 'COPY package*.json ./'];
  lines.push(`RUN ${install || 'npm ci --omit=dev || npm install --omit=dev'}`);
  lines.push('COPY . .');
  if (build) lines.push(`RUN ${build}`);
  lines.push(`ENV PORT=${port}`, `EXPOSE ${port}`, `CMD ${JSON.stringify(start)}`);
  return lines.join('\n') + '\n';
}

function botWrapper(entry) {
  return `// ساختهٔ لیا: پوشش وب برای اجرای ربات روی لیارا (سلامت‌سنجی + اجرای ربات)
const { createServer } = require('node:http');
const port = Number(process.env.PORT || 3000);

// ربات را همان‌طور که هست اجرا کن
require('./${entry}');

createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, service: 'bot', uptime: process.uptime(), at: new Date().toISOString() }));
}).listen(port, () => console.log('bot + health endpoint on ' + port));
`;
}

function cliWrapper(entry) {
  return `// ساختهٔ لیا: لایهٔ وب نازک روی ابزار خط فرمان تا روی هاست اجرا شود
const { createServer } = require('node:http');
const port = Number(process.env.PORT || 3000);
let tool = null;
try { tool = require('./${entry}'); } catch (e) { tool = null; }

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    service: 'cli-wrapper',
    hint: 'این ابزار در اصل CLI است؛ برای استفادهٔ وب باید API واقعی روی منطق آن ساخته شود.',
    exported: tool ? Object.keys(tool) : [],
  }));
}).listen(port, () => console.log('cli-wrapper on ' + port));
`;
}

function flaskWrapper(pyFile) {
  return `# ساختهٔ لیا: پوشش وب برای اسکریپت پایتون روی لیارا
import os
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("PORT", "8000"))

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"ok": True, "service": "python-wrapper", "script": "${pyFile}"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

if __name__ == "__main__":
    print(f"python wrapper on {PORT}")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
`;
}

function staticDockerfile() {
  return `# ساختهٔ لیا: سرو استاتیک روی لیارا
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;
}

function liaraJson(platform, port) {
  return JSON.stringify({ platform, port }, null, 2) + '\n';
}

/* ---------------- ارزیابی ---------------- */

export function assessSuitability(session, files, analysis) {
  const pkg = parsePkg(session, files);
  const deps = { ...(pkg?.json?.dependencies || {}), ...(pkg?.json?.devDependencies || {}) };
  const pkgText = pkg ? JSON.stringify(pkg.json) : '';
  const pyReq = requirementsText(session, files);
  const allNames = files.map((f) => f.name);
  const hasFile = (re) => allNames.some((n) => re.test(n));
  const anyPy = hasFile(/\.py$/);

  const reasons = [];
  const adaptations = [];
  const add = (code, title, detail, severity = 'high') => reasons.push({ code, title, detail, severity });

  // اگر Dockerfile پورت را expose کرده باشد، یعنی پروژه یک وب‌سرویس قابل اجراست
  // (مثلاً بعد از مناسب‌سازی، یا از قبل).
  const dockerfileFile = files.find((f) => /(^|\/)Dockerfile$/i.test(f.name));
  const dockerServesPort = !!dockerfileFile && /EXPOSE\s+\d{2,5}|CMD\s+\[|ENTRYPOINT/i.test(readSafe(session, dockerfileFile.name));

  /* --- ۱) اپ دسکتاپ/موبایل: قابل تبدیل نیست --- */
  if (deps.electron || /electron/i.test(pkgText)) {
    add('desktop-app', 'برنامهٔ دسکتاپ (Electron)', 'این پروژه یک اپ دسکتاپ است و روی هاست وب اجرا نمی‌شود؛ باید نسخهٔ وب/API جدا ساخته شود.');
  }
  if (deps['react-native'] || hasFile(/pubspec\.yaml$/) || hasFile(/AndroidManifest\.xml$/) || hasFile(/\.xcodeproj\//)) {
    add('mobile-app', 'اپ موبایل', 'اپ موبایل روی هاست وب اجرا نمی‌شود؛ فقط بک‌اند/API آن قابل میزبانی است.');
  }

  /* --- ۲) ربات --- */
  const botLib = BOT_DEPS.find((d) => deps[d]);
  if (botLib && !dockerServesPort) {
    add('bot', 'ربات پیام‌رسان', `پروژه از ${botLib} استفاده می‌کند و وب‌سرور ندارد؛ روی هاست فقط با یک پوشش وب (پورت + health) قابل اجراست.`, 'medium');
    const entry = mainEntry(pkg) || (hasFile(/(^|\/)index\.js$/) ? 'index.js' : 'bot.js');
    adaptations.push({
      id: 'web-cover',
      title: 'افزودن پوشش وب + Dockerfile',
      detail: `یک فایل server.js اضافه می‌شود که ربات را اجرا می‌کند و هم‌زمان روی PORT سلامت‌سنجی می‌دهد؛ سپس همان را به‌عنوان start ست می‌کنیم.`,
      files: [
        { path: 'server.js', content: botWrapper(entry) },
        { path: 'Dockerfile', content: dockerfileFor({ port: 3000, start: 'node server.js' }) },
        { path: 'liara.json', content: liaraJson('docker', 3000) },
      ],
      patchPackageJson: { start: 'node server.js', port: 3000 },
    });
  }

  /* --- ۳) ابزار CLI --- */
  if (!dockerServesPort && !botLib && pkg?.json?.bin && !deps.express && !deps.fastify && !deps.koa && !deps.hono) {
    const entry = typeof pkg.json.bin === 'string' ? pkg.json.bin : Object.values(pkg.json.bin || {})[0] || mainEntry(pkg) || 'index.js';
    add('cli', 'ابزار خط فرمان (CLI)', 'این پروژه برای اجرا در ترمینال ساخته شده و وب‌سرور/پورت ندارد؛ روی هاست فقط با یک لایهٔ وب نازک بالا می‌آید.', 'medium');
    adaptations.push({
      id: 'cli-wrapper',
      title: 'افزودن لایهٔ وب (server.js) + Dockerfile',
      detail: 'ابزار بدون تغییر منطق، پشت یک HTTP کوچک قرار می‌گیرد تا روی لیارا اجرا و سلامت‌سنجی شود.',
      files: [
        { path: 'server.js', content: cliWrapper(entry) },
        { path: 'Dockerfile', content: dockerfileFor({ port: 3000, start: 'node server.js' }) },
        { path: 'liara.json', content: liaraJson('docker', 3000) },
      ],
      patchPackageJson: { start: 'node server.js', port: 3000 },
    });
  }

  /* --- ۴) اسکریپت پایتون بدون وب --- */
  const pyWeb = PY_WEB.some((w) => pyReq.toLowerCase().includes(w)) || deps.flask || deps.fastapi || deps.django;
  if (!dockerServesPort && !pyWeb && anyPy) {
    const pyFile = allNames.find((n) => /\.py$/.test(n) && !/^(setup|conftest)\.py$/.test(path.basename(n))) || 'main.py';
    add('python-script', 'اسکریپت پایتون (بدون وب‌فریم‌ورک)', 'فایل‌های پایتون هست ولی Flask/FastAPI/Django نصب نیست؛ یعنی وب‌سرور ندارد.', 'medium');
    adaptations.push({
      id: 'python-wrapper',
      title: 'افزودن سرور HTTP پایتون + Dockerfile',
      detail: `یک فایل web.py با http.server اضافه می‌شود که روی PORT گوش می‌دهد و اسکریپت ${pyFile} را در کنارش نگه می‌دارد.`,
      files: [
        { path: 'web.py', content: flaskWrapper(pyFile) },
        {
          path: 'Dockerfile',
          content: `# ساختهٔ لیا برای اجرای اسکریپت پایتون روی لیارا\nFROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt ./\nRUN pip install --no-cache-dir -r requirements.txt || true\nCOPY . .\nENV PORT=8000\nEXPOSE 8000\nCMD ["python", "web.py"]\n`,
        },
        { path: 'liara.json', content: liaraJson('docker', 8000) },
      ],
    });
  }

  /* --- ۵) پروژهٔ خالی/فقط مستندات --- */
  const onlyDocs = files.length > 0 && allNames.every((n) => /\.(md|txt|pdf|png|jpg|jpeg|svg)$/i.test(n));
  const noEntry = files.length === 0 || (!pkg && !anyPy && !hasFile(/(^|\/)index\.html$/) && !hasFile(/(^|\/)composer\.json$/) && !dockerfileFile);
  if (onlyDocs || noEntry) {
    add('not-an-app', 'برنامهٔ قابل اجرا پیدا نشد', 'فایل ورودی وب/برنامه (package.json، index.html، composer.json، Dockerfile یا اسکریپت پایتون) دیده نمی‌شود. شاید zip اشتباه است یا سورس ناقص است.');
  }

  /* --- ۶) استاتیک بدون وب‌سرور: مناسب است ولی بهتر است سرو استاتیک شود --- */
  const staticOnly = !reasons.length && !pkg && hasFile(/(^|\/)index\.html$/) && !dockerfileFile;
  if (staticOnly) {
    adaptations.push({
      id: 'static-serve',
      title: 'افزودن Dockerfile برای سرو استاتیک',
      detail: 'پروژه فقط HTML/CSS/JS است؛ با nginx به‌عنوان سرویس استاتیک اجرا می‌شود (سریع‌تر و ارزان‌تر از پلتفرم Node).',
      files: [
        { path: 'Dockerfile', content: staticDockerfile() },
        { path: 'liara.json', content: liaraJson('docker', 80) },
      ],
    });
  }

  /* --- ۷) وب است ولی پورت/start ندارد --- */
  if (!reasons.length && pkg && !pkg.json.scripts?.start && !deps.next && !dockerfileFile) {
    adaptations.push({
      id: 'add-start',
      title: 'تعیین دستور اجرا (start) + Dockerfile',
      detail: 'وب‌اپ است ولی دستور start ندارد؛ یک اجرای مشخص و Dockerfile اضافه می‌شود تا لیارا بداند چطور بالا بیاید.',
      files: [
        { path: 'Dockerfile', content: dockerfileFor({ port: 3000, start: 'node index.js' }) },
        { path: 'liara.json', content: liaraJson('docker', 3000) },
      ],
      patchPackageJson: { start: 'node index.js', port: 3000 },
    });
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  reasons.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  const canAdapt = adaptations.length > 0 && !reasons.some((r) => r.code === 'desktop-app' || r.code === 'mobile-app');

  return {
    suitable: reasons.length === 0,
    reasons,
    adaptations,
    canAdapt,
    platform: analysis?.platform || null,
    summary: reasons.length
      ? `این پروژه ${reasons.length} مشکل ساختاری برای اجرا روی هاست وب دارد.`
      : 'این پروژه برای اجرا روی هاست وب مناسب است.',
  };
}

/**
 * اعمال تغییرهای پیشنهادی روی نسخهٔ کاری پروژه.
 * فقط بعد از تأیید صریح کاربر صدا زده می‌شود.
 */
export function applyAdaptations(session, adaptations, { writeFile, readFile }) {
  const applied = [];
  for (const adaptation of adaptations) {
    for (const file of adaptation.files) {
      let content = file.content;
      if (file.path === 'Dockerfile' && adaptation.patchPackageJson) {
        // تضمین پورت و start داخل Dockerfile با همان مقادیر
        content = content.replace('ENV PORT=3000', `ENV PORT=${adaptation.patchPackageJson.port}`);
      }
      const result = writeFile(session.id, file.path, content);
      applied.push({ path: file.path, created: result.created, changedLines: result.diff.changedLines });
    }
    if (adaptation.patchPackageJson) {
      const pkgPath = 'package.json';
      try {
        const current = JSON.parse(readFile(session.id, pkgPath).text);
        current.scripts = current.scripts || {};
        if (adaptation.patchPackageJson.start) current.scripts.start = adaptation.patchPackageJson.start;
        const result = writeFile(session.id, pkgPath, JSON.stringify(current, null, 2) + '\n');
        applied.push({ path: pkgPath, created: false, changedLines: result.diff.changedLines });
      } catch {
        /* package.json نبود؛ Dockerfile کافی است */
      }
    }
  }
  return applied;
}
