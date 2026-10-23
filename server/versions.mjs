/**
 * versions.mjs — نسخه‌های کد روی ماشین خودمان
 *
 * ایجنت یک نسخهٔ کامل از سورس هر اپ نگه می‌دارد تا بتواند بعداً همان را
 * بخواند، ویرایش کند، دیپلوی کند یا به نسخهٔ قبلی برگردد.
 *
 * ساختار: `.data/versions/<app>/<YYYYMMDD-HHMMSS>/` + `meta.json`
 * (بدون node_modules/.next/dist/.env — فقط سورس واقعی)
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.mjs';

const ROOT = dataPath('versions');
const KEEP = Number(process.env.LIA_KEEP_VERSIONS) || 12;
const MAX_BYTES = 300 * 1024 * 1024;
const SKIP = ['node_modules', '.git', '.next', 'dist', 'build', 'vendor', '.env'];

function safeApp(name) {
  return String(name || 'app').replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dirSize(dir) {
  let total = 0;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.includes(item.name)) continue;
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) total += dirSize(abs);
    else {
      try {
        total += fs.statSync(abs).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

/**
 * یک نسخه از سورس می‌گیرد.
 * @returns {{id:string, app:string, files:number, bytes:number, label:string}|null}
 */
export function snapshotVersion(appName, fromDir, label = 'deploy') {
  try {
    if (!fromDir || !fs.existsSync(fromDir)) return null;
    const size = dirSize(fromDir);
    if (size > MAX_BYTES) return null;

    const app = safeApp(appName);
    const id = `${stamp()}-${Math.random().toString(36).slice(2, 5)}`;
    const target = path.join(ROOT, app, id);
    fs.mkdirSync(target, { recursive: true });

    let files = 0;
    const copy = (src, out) => {
      for (const item of fs.readdirSync(src, { withFileTypes: true })) {
        if (SKIP.includes(item.name)) continue;
        const s = path.join(src, item.name);
        const d = path.join(out, item.name);
        if (item.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          copy(s, d);
        } else {
          try {
            fs.copyFileSync(s, d);
            files += 1;
          } catch {
            /* ignore */
          }
        }
      }
    };
    copy(fromDir, target);

    const meta = { id, app, label, files, bytes: size, at: Date.now() };
    fs.writeFileSync(path.join(target, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    // فقط آخرین نسخه‌ها بمانند
    const all = listVersions(app);
    for (const old of all.slice(KEEP)) removeVersion(app, old.id);

    return meta;
  } catch {
    return null;
  }
}

export function listVersions(appName) {
  const app = safeApp(appName);
  const base = path.join(ROOT, app);
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        let meta = {};
        try {
          meta = JSON.parse(fs.readFileSync(path.join(base, d.name, 'meta.json'), 'utf8'));
        } catch {
          /* ignore */
        }
        return { id: d.name, at: meta.at || 0, files: meta.files || 0, bytes: meta.bytes || 0, label: meta.label || '' };
      })
      .sort((a, b) => b.id.localeCompare(a.id));
  } catch {
    return [];
  }
}

export function versionPath(appName, id) {
  return path.join(ROOT, safeApp(appName), String(id).replace(/[^a-zA-Z0-9_.-]/g, ''));
}

function removeVersion(appName, id) {
  try {
    fs.rmSync(versionPath(appName, id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** نسخه را روی یک پوشه کپی می‌کند (برای برگشت) */
export function restoreVersion(appName, id, toDir) {
  const from = versionPath(appName, id);
  if (!fs.existsSync(from)) throw new Error('این نسخه پیدا نشد');
  fs.mkdirSync(toDir, { recursive: true });
  let files = 0;
  const copy = (src, out) => {
    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
      if (item.name === 'meta.json') continue;
      const s = path.join(src, item.name);
      const d = path.join(out, item.name);
      if (item.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copy(s, d);
      } else {
        fs.copyFileSync(s, d);
        files += 1;
      }
    }
  };
  copy(from, toDir);
  return files;
}
