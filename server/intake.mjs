/**
 * intake.mjs — گرفتن سورس کاربر و تبدیلش به «تحلیل»
 *
 * دو مسیر: آپلود zip، یا لینک مخزن گیت‌هاب. هیچ کدی اجرا نمی‌شود و فایل‌ها
 * بعد از تحلیل دور ریخته می‌شوند (چیزی روی دیسک نمی‌ماند).
 */
import { readZip } from './zip.mjs';
import { analyzeFiles, summarizeAnalysis } from './analyzer.mjs';

const GITHUB_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/i;

function stripCommonRoot(files) {
  const real = files.filter((f) => !f.isDir);
  if (!real.length) return files;
  const firstSegs = new Set(real.map((f) => f.name.split('/')[0]));
  if (firstSegs.size !== 1) return files;
  const [root] = [...firstSegs];
  if (!real.every((f) => f.name.startsWith(root + '/'))) return files;
  return files.map((f) => ({ ...f, name: f.name.slice(root.length + 1) }));
}

export function analyzeFromZip(buffer, fileName = 'project.zip') {
  const files = readZip(buffer);
  const normalized = stripCommonRoot(files);
  const analysis = analyzeFiles(normalized);
  return { analysis, name: fileName, files: normalized.length, entries: normalized };
}

export async function analyzeFromRepo(url) {
  const m = String(url || '').match(GITHUB_RE);
  if (!m) throw new Error('فقط لینک مخزن گیت‌هاب پشتیبانی می‌شود');

  const [, owner, repoRaw] = m;
  const repo = repoRaw.replace(/\.git$/, '');
  const attempts = [
    `https://codeload.github.com/${owner}/${repo}/zip/HEAD`,
    `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/main`,
    `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/master`,
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt, {
        headers: { 'user-agent': 'Lia-Deploy-Assistant' },
        redirect: 'follow',
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 80 * 1024 * 1024) throw new Error('حجم مخزن بیش از حد مجاز است');
      const { analysis, entries } = analyzeFromZip(buffer, `${owner}/${repo}`);
      return { analysis, entries, name: `${owner}/${repo}`, summary: summarizeAnalysis(analysis) };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(lastError?.message || 'دریافت مخزن ناموفق بود');
}
