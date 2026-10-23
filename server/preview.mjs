/**
 * preview.mjs — پیش‌نمایش عمومی اپ‌های دیپلوی‌شده روی همین دامنه
 *
 * چرا لازم است: هر اپی که دیپلوی می‌شود روی `127.0.0.1:<port>` گوش می‌دهد و از
 * بیرون در دسترس نیست. این ماژول درخواست‌های `/apps/<name>/…` را به همان پورت
 * پروکسی می‌کند تا لینک واقعی و قابل کلیک داشته باشیم.
 *
 * اگر روزی دامنهٔ وایلدکارد داشتی، `LIA_PREVIEW_DOMAIN` را ست کن (مثلاً
 * `preview.example.com`) تا `<name>.preview.example.com` هم مستقیم کار کند.
 */
import http from 'node:http';
import { deploymentInfo } from './deploy.mjs';

const PREVIEW_DOMAIN = (process.env.LIA_PREVIEW_DOMAIN || '').toLowerCase().replace(/^\./, '');
const PROXY_TIMEOUT_MS = 30_000;

/** نام اپ از روی Host در حالت ساب‌دامین (null = این درخواست مربوط به پیش‌نمایش نیست) */
export function appFromHost(hostHeader) {
  if (!PREVIEW_DOMAIN) return null;
  const host = String(hostHeader || '').split(':')[0].toLowerCase();
  if (!host.endsWith('.' + PREVIEW_DOMAIN)) return null;
  const sub = host.slice(0, -(PREVIEW_DOMAIN.length + 1));
  if (!sub || sub.includes('.')) return null;
  return sub;
}

export function previewDomain() {
  return PREVIEW_DOMAIN || null;
}

function fail(res, status, message, appName) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>پیش‌نمایش</title>
    <body style="font-family:system-ui;background:#0b0f14;color:#e7eef4;padding:40px;line-height:1.9">
    <h1 style="margin:0 0 8px">${status === 503 ? 'برنامه در حال اجرا نیست' : 'اپ پیدا نشد'}</h1>
    <p style="color:#93a4b3">${message}</p>
    ${appName ? `<p><a style="color:#2ee6b0" href="/api/apps">فهرست اپ‌ها</a></p>` : ''}
    </body></html>`);
}

/**
 * درخواست را به اپ پروکسی می‌کند.
 * @returns {boolean} true اگر درخواست مدیریت شد (یا خطای آن برگردانده شد)
 */
export function proxyToApp(req, res, appName, { stripPrefix = '', prefix = '' } = {}) {
  const info = deploymentInfo(appName);
  if (!info) return false;
  if (info.staticDir) return false; // استاتیک را خود سرور از دیسک سرو می‌کند
  if (!info.port) return false;

  if (info.status !== 'running') {
    fail(res, 503, `اپ «${appName}» الان در حال اجرا نیست.`, appName);
    return true;
  }

  let targetPath = req.url || '/';
  if (stripPrefix && targetPath.startsWith(stripPrefix)) {
    targetPath = targetPath.slice(stripPrefix.length) || '/';
  }
  if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;

  const headers = { ...req.headers };
  delete headers.connection;
  delete headers['proxy-connection'];
  headers.host = `127.0.0.1:${info.port}`;
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'https';
  headers['x-forwarded-for'] = req.socket?.remoteAddress || '';
  if (prefix) headers['x-forwarded-prefix'] = prefix;

  const proxyReq = http.request(
    {
      host: '127.0.0.1',
      port: info.port,
      method: req.method,
      path: targetPath,
      headers,
      timeout: PROXY_TIMEOUT_MS,
    },
    (proxyRes) => {
      const out = { ...proxyRes.headers };
      // اگر اپ ریدایرکت مطلق داد، زیر مسیر پیش‌نمایش بماند
      if (prefix && typeof out.location === 'string' && out.location.startsWith('/') && !out.location.startsWith(prefix)) {
        out.location = prefix + out.location;
      }
      res.writeHead(proxyRes.statusCode || 502, out);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('timeout', () => proxyReq.destroy(new Error('پاسخ اپ در ۳۰ ثانیه نیامد')));
  proxyReq.on('error', (e) => fail(res, 502, `ارتباط با اپ برقرار نشد: ${e.message}`, appName));
  req.pipe(proxyReq);
  return true;
}
