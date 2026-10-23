/**
 * start.mjs — نقطهٔ شروع روی هاست (لیارا)
 *
 * لیارا پورت را با متغیر PORT می‌دهد و ترافیک را از بیرون می‌فرستد؛ پس برنامه
 * باید روی 0.0.0.0 گوش بدهد. برای اجرای محلی همان دستور کار می‌کند و اگر HOST
 * را خودت ست کنی، همان استفاده می‌شود.
 */
process.env.HOST = process.env.HOST || '0.0.0.0';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

await import('./server/index.mjs');
