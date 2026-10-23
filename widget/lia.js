/**
 * lia.js — ویجت «لیا»: دکمهٔ شناور + سایدبار چت روی هر صفحه‌ای
 *
 * مستقل و بدون وابستگی: یک Web Component با Shadow DOM تا CSS سایت میزبان
 * (liara.ir) با استایل‌های لیا قاطی نشود. کل ارتباط با سرور از همان دامنه است.
 *
 * قابلیت‌ها:
 *  - دکمهٔ دایره‌ای گوشهٔ راست → سایدبار کشویی سمت راست (باز/بسته‌شدن ماندگار)
 *  - چت ماندگار بین صفحه‌ها (سشن سمت سرور + localStorage)
 *  - رندر کارت‌ها: دو حالت، پلن، مرحله، تأیید، باگ، خلاصه، آپلود
 *  - هایلایت کردن عنصر هدف روی صفحه («اینجا کلیک کن»)
 *  - اعلام مسیر صفحه به سرور برای «آگاهی از صفحه»
 *  - پنل زندهٔ دیپلوی با لاگ
 */
(function () {
  'use strict';

  if (window.__LIA_LOADED__) return;
  window.__LIA_LOADED__ = true;

  const SCRIPT_URL = document.currentScript?.src || location.origin + '/widget/lia.js';
  const API = new URL(SCRIPT_URL).origin;
  const LS_SESSION = 'lia.sessionId';
  const LS_OPEN = 'lia.open';
  const LS_ACCOUNT = 'lia.accountId';

  const state = {
    sessionId: localStorage.getItem(LS_SESSION) || null,
    open: localStorage.getItem(LS_OPEN) === '1',
    messages: [],
    seenMessageIds: new Set(),
    meta: { mode: 'idle', stage: 'greet' },
    deploy: null,
    lastEvent: 0,
    pollTimer: null,
    busy: false,
    provider: { demo: false, blocked: false },
    highlight: null,
    booted: false,
    renderedApproval: null,
    renderedEvents: new Set(),
    account: null,
    plan: null,
    autoFix: false,
    sheetKind: null,
  };

  /* ---------------- CSS ---------------- */

  const CSS = `
    @font-face { font-family: 'liaYekan'; src: url('/widget/fonts/yekan-400.woff2') format('woff2'); font-weight: 400; font-display: swap; }
    @font-face { font-family: 'liaYekan'; src: url('/widget/fonts/yekan-600.woff2') format('woff2'); font-weight: 600; font-display: swap; }
    @font-face { font-family: 'liaYekan'; src: url('/widget/fonts/yekan-700.woff2') format('woff2'); font-weight: 700; font-display: swap; }

    :host { all: initial; }
    * { box-sizing: border-box; }

    .wrap {
      position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;
      font-family: 'liaYekan', system-ui, sans-serif; direction: rtl; color: #e7eef4;
    }

    /* ---------- دکمهٔ شناور ---------- */
    .fab {
      position: absolute; right: 22px; bottom: 22px; width: 60px; height: 60px;
      border-radius: 50%; border: 2px solid #0b0f14; cursor: pointer; pointer-events: auto;
      background: #0e1a20; overflow: visible;
      box-shadow: 0 10px 30px rgba(0, 178, 150, .45), 0 0 0 2px rgba(46,230,176,.35);
      display: grid; place-items: center; transition: transform .18s ease, box-shadow .18s ease;
    }
    .fab-img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
    .fab-badge {
      position: absolute; bottom: -1px; left: -1px; width: 20px; height: 20px; border-radius: 50%;
      background: linear-gradient(145deg, #9dffd0, #2ee6b0); color: #06231d; font-size: 10px;
      display: grid; place-items: center; border: 2px solid #0b0f14;
    }
    .fab:hover { transform: translateY(-2px) scale(1.04); }
    .fab svg { width: 27px; height: 27px; }
    .fab .dot {
      position: absolute; top: 4px; left: 5px; width: 11px; height: 11px; border-radius: 50%;
      background: #ff5d5d; border: 2px solid #0b0f14; opacity: 0; transition: opacity .2s;
    }
    .fab .dot.on { opacity: 1; }
    .fab.hidden { opacity: 0; pointer-events: none; transform: translateY(10px) scale(.9); }
    .fab .label {
      position: absolute; bottom: 66px; right: 2px; white-space: nowrap;
      background: #0f151b; color: #cfe4dd; font-size: 12px; padding: 5px 10px; border-radius: 8px;
      border: 1px solid #22303c; opacity: 0; transform: translateY(4px); transition: .18s; pointer-events: none;
    }
    .fab:hover .label { opacity: 1; transform: none; }

    /* ---------- سایدبار ---------- */
    .panel {
      position: absolute; top: 0; right: 0; height: 100%; width: min(430px, 100vw);
      background: #0b0f14; border-left: 1px solid #1d2833;
      display: flex; flex-direction: column; pointer-events: auto;
      transform: translateX(102%); transition: transform .28s cubic-bezier(.22,.8,.25,1);
      box-shadow: -18px 0 50px rgba(0,0,0,.45);
    }
    .panel.open { transform: none; }

    .head {
      display: flex; align-items: center; gap: 10px; padding: 14px 16px;
      border-bottom: 1px solid #1d2833; background: linear-gradient(180deg, #101a20, #0b0f14);
    }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 0; overflow: hidden; }
    .brand > div { min-width: 0; }
    .brand .name, .brand .status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px; }
    .avatar {
      width: 36px; height: 36px; border-radius: 50%; flex: 0 0 auto; overflow: hidden;
      border: 2px solid #1d3a34; box-shadow: 0 0 0 2px rgba(46,230,176,.14);
      background: #0e1a20;
    }
    .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .brand .name { font-weight: 700; font-size: 15px; line-height: 1.3; }
    .brand .status { font-size: 11px; color: #93a4b3; display: flex; align-items: center; gap: 5px; }
    .pulse { width: 6px; height: 6px; border-radius: 50%; background: #2ee6b0; box-shadow: 0 0 0 0 rgba(46,230,176,.7); animation: pulse 2.4s infinite; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(46,230,176,.55); } 70% { box-shadow: 0 0 0 7px rgba(46,230,176,0); } 100% { box-shadow: 0 0 0 0 rgba(46,230,176,0); } }
    .head .spacer { flex: 1; }
    .icon-btn {
      width: 30px; height: 30px; border-radius: 9px; border: 1px solid #22303c; background: #101820;
      color: #cfdae4; cursor: pointer; display: grid; place-items: center; font-size: 15px;
    }
    .icon-btn:hover { background: #16222c; }

    /* ---------- نوار ابزار (پروژه / حساب / رفع خودکار) ---------- */
    .bar-tools {
      display: flex; align-items: center; gap: 6px; padding: 6px 12px;
      border-bottom: 1px solid #1d2833; background: #0b0f14; flex: 0 0 auto;
    }
    .tbtn {
      display: inline-flex; align-items: center; gap: 5px; font-family: inherit; font-size: 10.5px;
      color: #b7c6d2; background: #101820; border: 1px solid #22303c; border-radius: 9px;
      padding: 4px 8px; cursor: pointer; text-decoration: none; white-space: nowrap;
    }
    .tbtn:hover { background: #16222c; color: #e7f3ee; }
    .tbtn b { font-weight: 700; color: #cfe4dd; max-width: 110px; overflow: hidden; text-overflow: ellipsis; }
    .tbtn.fx .fxdot { width: 6px; height: 6px; border-radius: 50%; background: #4a5a66; display: inline-block; }
    .tbtn.on { border-color: #1f4a3d; color: #9dffd0; }
    .tbtn.fx.on { border-color: #1f4a3d; color: #9dffd0; }
    .tbtn.fx.on .fxdot { background: #2ee6b0; box-shadow: 0 0 6px #2ee6b0; }

    /* ---------- پنل کشویی پروژه/حساب ---------- */
    .sheet {
      position: absolute; inset: 0; background: #0a0f14; z-index: 6;
      display: flex; flex-direction: column;
    }
    .sheet[hidden] { display: none; }
    .sheet-head {
      display: flex; align-items: center; gap: 8px; padding: 14px 16px;
      border-bottom: 1px solid #1d2833; background: linear-gradient(180deg, #101a20, #0b0f14);
    }
    .sheet-head b { font-size: 14px; color: #eaf5f0; }
    .sheet-body { flex: 1; overflow-y: auto; padding: 11px 12px; display: flex; flex-direction: column; gap: 9px; }
    .sheet-body::-webkit-scrollbar { width: 7px; }
    .sheet-body::-webkit-scrollbar-thumb { background: #22303c; border-radius: 8px; }
    .frow {
      display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: #b7c6d2;
      border: 1px solid #1c2831; border-radius: 8px; padding: 6px 8px; cursor: pointer;
      direction: ltr; text-align: left; font-family: ui-monospace, Consolas, monospace;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    }
    .frow:hover { background: #121c24; border-color: #2a3d4b; }
    .frow .ico { color: #6f8a99; }
    .fpre {
      background: #060a0d; border: 1px solid #1d2833; border-radius: 9px; padding: 9px;
      font-family: ui-monospace, Consolas, monospace; font-size: 10px; line-height: 1.7;
      color: #cfe4dd; direction: ltr; text-align: left; white-space: pre-wrap; word-break: break-word;
      max-height: 48vh; overflow: auto;
    }
    .sheet .field { display: flex; flex-direction: column; gap: 4px; }
    .sheet .field label { font-size: 11px; color: #93a4b3; }
    .sheet .field input, .sheet .field select {
      background: #0a1119; border: 1px solid #26333f; border-radius: 8px; padding: 7px 9px;
      color: #e7eef4; font-family: inherit; font-size: 12px;
    }
    .prow {
      display: flex; align-items: center; gap: 8px; border: 1px solid #1c2831; border-radius: 10px;
      padding: 8px 10px; cursor: pointer; background: #0e161d;
    }
    .prow.on { border-color: #2a7a68; background: #0f2019; }
    .prow .p { color: #9dffd0; font-size: 11.5px; font-weight: 700; margin-inline-start: auto; }
    .prow .meta { font-size: 10px; color: #7d95a3; }
    .badge-plan { font-size: 10px; border-radius: 999px; padding: 2px 7px; border: 1px solid #2a7a68; color: #9dffd0; }
    .badge-plan.off { border-color: #5a3a2a; color: #ffd699; }

    .scroll { flex: 1 1 0%; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 14px 14px 6px; scroll-behavior: smooth; }

    /* ---------- قهرمان: تصویر و وضعیت لیا ---------- */
    .hero {
      display: flex; gap: 10px; padding: 9px 12px 7px; border-bottom: 1px solid #1d2833; flex: 0 0 auto;
      background: linear-gradient(180deg, #0e1a20 0%, #0b0f14 100%);
    }
    .art {
      position: relative; width: 88px; height: 88px; flex: 0 0 auto;
      border-radius: 14px; overflow: hidden; border: 1px solid #23414a;
      box-shadow: 0 0 0 0 rgba(46,230,176,.35), inset 0 0 30px rgba(0,0,0,.35);
      animation: liaGlow 3.6s ease-in-out infinite;
    }
    .art img { width: 100%; height: 100%; object-fit: cover; display: block; animation: liaFloat 5s ease-in-out infinite; }
    .art .scan {
      position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(180deg, transparent 0%, rgba(46,230,176,.18) 48%, transparent 100%);
      transform: translateY(-100%); animation: liaScan 3.2s linear infinite;
    }
    .art .spark { position: absolute; width: 4px; height: 4px; border-radius: 50%; background: #9dffd0; opacity: .0; }
    .art .spark.s1 { top: 16%; left: 18%; animation: twinkle 2.4s ease-in-out infinite; }
    .art .spark.s2 { top: 68%; left: 12%; animation: twinkle 3.1s ease-in-out .5s infinite; }
    .art .spark.s3 { top: 30%; left: 82%; animation: twinkle 2.8s ease-in-out 1s infinite; }
    .art .badge {
      position: absolute; bottom: 6px; right: 6px; font-size: 9.5px; font-weight: 700;
      background: rgba(6,10,13,.78); color: #9dffd0; border: 1px solid #2a5b4d;
      border-radius: 999px; padding: 2px 7px; backdrop-filter: blur(4px);
    }
    .hero-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; justify-content: center; }
    .hero-title { font-size: 12.5px; font-weight: 700; color: #eaf5f0; line-height: 1.6; }
    .hero-sub { font-size: 11px; color: #8fa6b4; min-height: 15px; }
    .hero-sub .dotdot::after { content: '…'; animation: dots 1.2s steps(4) infinite; }
    .bar-wrap { height: 6px; background: #16222c; border-radius: 999px; overflow: hidden; position: relative; }
    .bar-wrap > i {
      display: block; height: 100%; width: 0%; border-radius: 999px;
      background: linear-gradient(90deg, #2ee6b0, #9dffd0); transition: width .45s cubic-bezier(.22,.8,.25,1);
    }
    .bar-wrap.busy > i {
      width: 40% !important; background: linear-gradient(90deg, transparent, #2ee6b0, transparent);
      animation: slide 1.1s linear infinite;
    }
    .hero-meta { display: flex; justify-content: space-between; font-size: 10.5px; color: #7d95a3; }
    .hero-meta b { color: #9dffd0; font-weight: 700; }
    .hero.working .art { animation-duration: 2s; }
    .hero.error .art { animation: none; box-shadow: 0 0 0 3px rgba(255,138,138,.16); border-color: #5a2a2a; }
    .hero.success .art { animation: none; box-shadow: 0 0 0 3px rgba(46,230,176,.25); border-color: #2a7a68; }

    @keyframes liaFloat { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-3px) scale(1.012); } }
    @keyframes liaGlow { 0%, 100% { box-shadow: 0 0 0 0 rgba(46,230,176,.22), inset 0 0 30px rgba(0,0,0,.35); } 50% { box-shadow: 0 0 18px 2px rgba(46,230,176,.18), inset 0 0 30px rgba(0,0,0,.35); } }
    @keyframes liaScan { 0% { transform: translateY(-100%); } 100% { transform: translateY(100%); } }
    @keyframes twinkle { 0%, 100% { opacity: 0; transform: scale(.6); } 45% { opacity: .95; transform: scale(1.25); } }
    @keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
    @keyframes slide { 0% { transform: translateX(-60%); } 100% { transform: translateX(160%); } }

    /* ---------- نوار تسک ---------- */
    .tasks {
      display: flex; gap: 5px; padding: 2px 12px 8px; background: #0b0f14; overflow-x: auto;
      flex: 0 0 auto; min-height: 26px; scroll-behavior: smooth;
      mask-image: linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
    }
    .tasks::-webkit-scrollbar { height: 0; }
    .task {
      display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; color: #7d95a3;
      border: 1px solid #1d2833; border-radius: 999px; padding: 2px 7px; white-space: nowrap; flex: 0 0 auto;
      background: #0e161d;
    }
    .task.current { color: #08231d; background: linear-gradient(145deg, #9dffd0, #2ee6b0); border-color: transparent; font-weight: 700; }
    .task.done { color: #8fd8bd; border-color: #1f4a3d; }
    .task .tick { font-size: 9px; }

    /* ---------- لاگ زنده ---------- */
    .log-toggle {
      display: flex; align-items: center; gap: 7px; width: 100%; background: #0a0f14; border: 0;
      border-bottom: 1px solid #1d2833; color: #8fa6b4; font-family: inherit; font-size: 11px;
      padding: 6px 14px; cursor: pointer; text-align: right;
    }
    .log-toggle:hover { background: #0d151b; color: #cfe4dd; }
    .log-toggle .live { width: 7px; height: 7px; border-radius: 50%; background: #2ee6b0; box-shadow: 0 0 0 0 rgba(46,230,176,.6); animation: pulse 2s infinite; }
    .log-toggle .preview { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5f7684; font-size: 10px; direction: ltr; text-align: left; }
    .log-toggle .chev { transition: transform .2s; }
    .log-toggle.open .chev { transform: rotate(180deg); }
    .live-log {
      display: none; background: #060a0d; border-bottom: 1px solid #1d2833;
      font-family: ui-monospace, Consolas, monospace; font-size: 9.5px; line-height: 1.7;
      height: 96px; overflow-y: auto; padding: 5px 9px; direction: ltr; text-align: left;
      flex: 0 0 auto;
    }
    .live-log.open { display: block; }
    .live-log .row { white-space: pre-wrap; word-break: break-word; color: #86a0af; padding: 1px 0; }
    .live-log .row .ts { color: #4e6472; margin-left: 4px; }
    .live-log .row.ok { color: #7ee2b8; }
    .live-log .row.err { color: #ff9b9b; }
    .live-log .row.warn { color: #ffd699; }
    .live-log .row.model { color: #9fc7dc; }
    .live-log .row.tool { color: #b6d7f0; }
    .live-log .row.deploy { color: #cfe4dd; }
    .live-log .row .src { color: #5a7484; }    .scroll::-webkit-scrollbar { width: 8px; }
    .scroll::-webkit-scrollbar-thumb { background: #22303c; border-radius: 8px; }

    .msgs { display: flex; flex-direction: column; gap: 10px; }

    .msg { max-width: 92%; font-size: 13.5px; line-height: 1.85; }
    .msg.lia { align-self: flex-start; }
    .msg.user { align-self: flex-end; }
    .bubble {
      background: #111a22; border: 1px solid #1f2c38; border-radius: 14px;
      padding: 10px 13px; white-space: pre-wrap; word-break: break-word; color: #dbe7ef;
    }
    .msg.user .bubble { background: #12312b; border-color: #1c5a4d; color: #d8fff1; border-start-end-radius: 5px; }
    .msg.lia .bubble { border-start-start-radius: 5px; }
    .bubble code { background: #0b1116; border: 1px solid #22303c; border-radius: 5px; padding: 1px 5px; font-family: monospace; font-size: 12px; direction: ltr; display: inline-block; }
    .bubble a { color: #6ff0c8; }

    .typing { display: inline-flex; gap: 4px; align-items: center; padding: 4px 2px; }
    .typing i { width: 6px; height: 6px; border-radius: 50%; background: #4f6472; animation: blink 1.2s infinite; }
    .typing i:nth-child(2) { animation-delay: .2s; } .typing i:nth-child(3) { animation-delay: .4s; }
    @keyframes blink { 0%,80%,100% { opacity: .25; } 40% { opacity: 1; } }

    /* ---------- کارت‌ها ---------- */
    .card {
      background: #101a22; border: 1px solid #22303c; border-radius: 14px;
      padding: 13px 14px; display: flex; flex-direction: column; gap: 9px; width: 100%;
    }
    .card h4 { margin: 0; font-size: 13.5px; color: #eaf5f0; font-weight: 700; }
    .card .sub { font-size: 12px; color: #93a4b3; line-height: 1.8; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; }

    .btn {
      font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
      border-radius: 10px; padding: 8px 13px; border: 1px solid #2a3a48; background: #16222c; color: #dbe7ef;
      transition: .15s;
    }
    .btn:hover { background: #1c2c38; }
    .btn.primary { background: linear-gradient(145deg, #8dffcf, #2ee6b0); color: #06231d; border-color: transparent; }
    .btn.primary:hover { filter: brightness(1.05); }
    .btn.ghost { background: transparent; }
    .btn.danger { color: #ffb3b3; border-color: #5a2a2a; }
    .btn:disabled { opacity: .5; cursor: default; }

    .chip {
      font-family: inherit; font-size: 12px; cursor: pointer; color: #c8f7e5;
      background: #0e2a24; border: 1px solid #1e5d4d; border-radius: 999px; padding: 7px 12px;
    }
    .chip:hover { background: #123a31; }

    .verdict { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px; border-radius: 999px; }
    .verdict.high { background: #3a1618; color: #ffb3b3; border: 1px solid #5d2527; }
    .verdict.medium { background: #3a2c12; color: #ffd699; border: 1px solid #5d4a1e; }
    .verdict.low { background: #1a2632; color: #a9c3d6; border: 1px solid #2b3d4d; }

    /* ---------- ابزارهای ایجنت ---------- */
    .tool {
      align-self: flex-start; display: flex; align-items: center; gap: 8px;
      background: #0e1a22; border: 1px solid #1f3240; border-radius: 10px;
      padding: 6px 10px; font-size: 11.5px; color: #9fb6c4; max-width: 92%;
    }
    .tool .spin {
      width: 10px; height: 10px; border: 2px solid #24404f; border-top-color: #2ee6b0;
      border-radius: 50%; animation: spin .8s linear infinite; flex: 0 0 auto;
    }
    .tool.done { color: #a9d9c9; border-color: #1d463a; }
    .tool.done .spin { animation: none; border-color: #2ee6b0; background: #2ee6b0; }
    .tool.error { color: #ffb3b3; border-color: #4a2527; }
    .tool.error .spin { animation: none; border-color: #ff8a8a; background: #ff8a8a; }
    .tool .sum { color: #7f97a6; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .diff {
      background: #060a0d; border: 1px solid #182530; border-radius: 8px; padding: 8px 10px;
      font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; line-height: 1.7;
      direction: ltr; text-align: left; max-height: 190px; overflow: auto;
      white-space: pre; color: #9fb3c1;
    }
    .diff .add { color: #7ee2b8; } .diff .del { color: #ff9b9b; }

    .plan-specs { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: #a9bfcc; }
    .plan-specs b { color: #eaf5f0; }
    .price { font-size: 15px; font-weight: 700; color: #7dfac9; }
    .price small { font-size: 11px; color: #93a4b3; font-weight: 400; }
    details summary { cursor: pointer; font-size: 12px; color: #93a4b3; }
    details ul { margin: 6px 0 0; padding-inline-start: 18px; font-size: 12px; color: #a9bfcc; }

    .step-num { font-size: 11px; color: #93a4b3; }
    .step-title { font-weight: 700; font-size: 13.5px; }
    .check { font-size: 12px; color: #8fd8bd; }

    /* ---------- پنل دیپلوی ---------- */
    .deploy { border-top: 1px solid #1d2833; background: #0a0f14; padding: 10px 14px; display: none; }
    .deploy.on { display: block; }
    .deploy .top { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #a9bfcc; margin-bottom: 7px; }
    .deploy .top b { color: #eaf5f0; font-size: 12.5px; }
    .bar { height: 5px; background: #1d2833; border-radius: 999px; overflow: hidden; margin-bottom: 8px; }
    .bar > i { display: block; height: 100%; background: linear-gradient(90deg, #2ee6b0, #8dffcf); transition: width .35s ease; }
    .logs {
      font-family: ui-monospace, Consolas, monospace; font-size: 10.5px; line-height: 1.7;
      background: #060a0d; border: 1px solid #182530; border-radius: 9px; padding: 7px 9px;
      max-height: 96px; overflow: auto; direction: ltr; text-align: left; color: #9fb3c1;
    }
    .logs .ok { color: #7ee2b8; } .logs .err { color: #ff9b9b; } .logs .dim { color: #7d8b96; }

    /* ---------- کامپوزر ---------- */
    .composer { padding: 10px 12px 12px; border-top: 1px solid #1d2833; background: #0b0f14; }
    .inputwrap {
      display: flex; align-items: flex-end; gap: 8px; background: #111a22;
      border: 1px solid #22303c; border-radius: 14px; padding: 7px 8px 7px 10px;
    }
    .inputwrap:focus-within { border-color: #2a7a68; box-shadow: 0 0 0 3px rgba(46,230,176,.08); }
    textarea {
      flex: 1; resize: none; border: 0; outline: 0; background: transparent; color: #e7eef4;
      font-family: inherit; font-size: 13px; line-height: 1.7; max-height: 110px; padding: 4px 2px;
    }
    textarea::placeholder { color: #6b7d8b; }
    .send {
      width: 34px; height: 34px; border-radius: 10px; border: 0; cursor: pointer; flex: 0 0 auto;
      background: linear-gradient(145deg, #8dffcf, #2ee6b0); color: #06231d; display: grid; place-items: center;
    }
    .send:disabled { opacity: .5; }
    .foot { font-size: 10.5px; color: #5c6f7d; text-align: center; margin-top: 7px; }
    .foot b { color: #7ea3b8; font-weight: 400; }

    /* ---------- هایلایت روی صفحه ---------- */
    .ring {
      position: fixed; border: 2px solid #2ee6b0; border-radius: 12px; pointer-events: none;
      box-shadow: 0 0 0 3px rgba(46,230,176,.22), 0 0 26px rgba(46,230,176,.35);
      transition: all .18s ease; z-index: 2147483001; display: none;
    }
    .ring.on { display: block; }
    .ring .tip {
      position: absolute; top: -38px; right: -2px; background: #0b0f14; color: #c8f7e5;
      border: 1px solid #2ee6b0; font-size: 11.5px; padding: 5px 10px; border-radius: 8px; white-space: nowrap;
      direction: rtl;
    }
    .ring .arrow { position: absolute; top: -10px; right: 10px; width: 0; height: 0; border: 6px solid transparent; border-bottom-color: #2ee6b0; }

    @media (max-width: 520px) {
      .panel { width: 100vw; }
      .fab { right: 16px; bottom: 16px; }
    }
  `;

  /* ---------------- امن‌سازی متن ---------------- */

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  function md(text) {
    let html = esc(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    html = html.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    return html;
  }

  /* ---------------- ساخت DOM ---------------- */

  const host = document.createElement('lia-root');
  host.setAttribute('dir', 'rtl');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${CSS}</style>
    <div class="wrap">
      <button class="fab" id="fab" aria-label="باز کردن دستیار لیا" aria-expanded="false">
        <img class="fab-img" src="/widget/assets/lia/avatar.webp" alt="لیا" />
        <span class="fab-badge" aria-hidden="true">💬</span>
        <span class="dot" id="dot"></span>
        <span class="label">لیا — دستیار دیپلوی</span>
      </button>

      <section class="panel" id="panel" role="dialog" aria-label="لیا، دستیار دیپلوی لیارا" aria-modal="false">
        <header class="head">
          <div class="brand">
            <div class="avatar"><img src="/widget/assets/lia/avatar.webp" alt="لیا" /></div>
            <div>
              <div class="name">لیا</div>
              <div class="status"><span class="pulse"></span><span id="statusText">دستیار دیپلوی لیارا</span></div>
            </div>
          </div>
          <div class="spacer"></div>
          <button class="icon-btn" id="resetBtn" title="شروع دوباره" aria-label="شروع دوباره">↺</button>
          <button class="icon-btn" id="closeBtn" title="بستن" aria-label="بستن">✕</button>
        </header>

        <div class="bar-tools">
          <button class="tbtn" id="projBtn" title="فایل‌های پروژه، آپلود و دانلود"><span>📦</span>پروژه</button>
          <button class="tbtn" id="accBtn" title="حساب و پلن"><span>👤</span><b id="accLabel">مهمان</b></button>
          <button class="tbtn fx" id="autoFixBtn" title="اگر مرحله‌ای از دیپلوی بشکند، خودم دیباگ و رفع می‌کنم">
            <span class="fxdot" id="autoFixDot"></span><span id="autoFixLabel">رفع خودکار</span>
          </button>
          <a class="tbtn" href="/agent/" target="_blank" rel="noopener" title="باز کردن صفحهٔ کامل ایجنت">⤢</a>
        </div>

        <div class="hero" id="hero">
          <div class="art">
            <img id="heroImg" src="/widget/assets/lia/welcome.webp" alt="لیا" />
            <span class="scan"></span>
            <span class="spark s1"></span><span class="spark s2"></span><span class="spark s3"></span>
            <span class="badge" id="heroBadge">آماده</span>
          </div>
          <div class="hero-info">
            <div class="hero-title" id="heroTitle">سلام، من لیا هستم</div>
            <div class="hero-sub" id="heroSub">دستیار دیپلوی لیارا</div>
            <div class="bar-wrap" id="heroBarWrap"><i id="heroBar"></i></div>
            <div class="hero-meta"><span id="heroStage">آمادهٔ شروع</span><b id="heroPercent">۰٪</b></div>
          </div>
        </div>
        <div class="tasks" id="heroTasks"></div>

        <button class="log-toggle" id="logToggle" aria-expanded="false">
          <span class="live"></span>
          <span>لاگ زنده</span>
          <span class="preview" id="logPreview">در انتظار رویداد…</span>
          <span class="chev">▾</span>
        </button>
        <div class="live-log" id="liveLog" role="log" aria-live="polite"></div>

        <div class="scroll" id="scroll">
          <div class="msgs" id="msgs" role="log" aria-live="polite"></div>
        </div>

        <div class="deploy" id="deployPanel">
          <div class="top">
            <b id="deployApp">—</b>
            <span id="deployStatus"></span>
            <span style="flex:1"></span>
            <span id="deployCount"></span>
          </div>
          <div class="bar"><i id="deployBar" style="width:0%"></i></div>
          <div class="logs" id="deployLogs"></div>
        </div>

        <div class="composer">
          <div class="inputwrap">
            <button class="icon-btn" id="attachBtn" title="آپلود zip پروژه" aria-label="آپلود zip پروژه">📎</button>
            <textarea id="input" rows="1" placeholder="سؤالت را بنویس… (Enter = ارسال)"></textarea>
            <button class="send" id="sendBtn" aria-label="ارسال">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 12 20 4l-4 16-4-6-8-2Z" fill="#06231d"/></svg>
            </button>
          </div>
          <div class="foot">لیا هیچ کاری روی حسابت <b>بدون تأیید</b> انجام نمی‌دهد.</div>
          <input type="file" id="file" accept=".zip" hidden>
        </div>

        <!-- پنل کشویی پروژه/حساب (همان قابلیت‌های صفحهٔ /agent/) -->
        <div class="sheet" id="sheet" hidden>
          <div class="sheet-head">
            <b id="sheetTitle">—</b>
            <span style="flex:1"></span>
            <button class="icon-btn" id="sheetClose" title="بستن" aria-label="بستن">✕</button>
          </div>
          <div class="sheet-body" id="sheetBody"></div>
        </div>
      </section>

      <div class="ring" id="ring"><span class="tip" id="ringTip"></span><span class="arrow"></span></div>
    </div>
  `;
  document.documentElement.appendChild(host);

  const $ = (id) => shadow.getElementById(id);
  const el = {
    fab: $('fab'),
    dot: $('dot'),
    panel: $('panel'),
    msgs: $('msgs'),
    scroll: $('scroll'),
    status: $('statusText'),
    input: $('input'),
    send: $('sendBtn'),
    attach: $('attachBtn'),
    file: $('file'),
    close: $('closeBtn'),
    reset: $('resetBtn'),
    ring: $('ring'),
    ringTip: $('ringTip'),
    deployPanel: $('deployPanel'),
    deployApp: $('deployApp'),
    deployStatus: $('deployStatus'),
    deployCount: $('deployCount'),
    deployBar: $('deployBar'),
    deployLogs: $('deployLogs'),
    hero: $('hero'),
    heroImg: $('heroImg'),
    heroBadge: $('heroBadge'),
    heroTitle: $('heroTitle'),
    heroSub: $('heroSub'),
    heroBar: $('heroBar'),
    heroBarWrap: $('heroBarWrap'),
    heroPercent: $('heroPercent'),
    heroStage: $('heroStage'),
    heroTasks: $('heroTasks'),
    logToggle: $('logToggle'),
    logPreview: $('logPreview'),
    liveLog: $('liveLog'),
    projBtn: $('projBtn'),
    accBtn: $('accBtn'),
    accLabel: $('accLabel'),
    autoFixBtn: $('autoFixBtn'),
    autoFixDot: $('autoFixDot'),
    autoFixLabel: $('autoFixLabel'),
    sheet: $('sheet'),
    sheetTitle: $('sheetTitle'),
    sheetBody: $('sheetBody'),
    sheetClose: $('sheetClose'),
  };

  /* ---------------- API ---------------- */

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'خطای شبکه' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  /** جریان SSE روی POST را می‌خواند و هر رویداد را به handler می‌دهد */
  async function stream(path, body, onEvent) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* رویداد ناقص */
        }
      }
    }
  }

  /* ---------------- قهرمان: تصویر/وضعیت/درصد ---------------- */

  const HERO_IMAGES = {
    welcome: '/widget/assets/lia/welcome.webp',
    thinking: '/widget/assets/lia/thinking.webp',
    analyzing: '/widget/assets/lia/analyzing.webp',
    planning: '/widget/assets/lia/planning.webp',
    working: '/widget/assets/lia/working.webp',
    deploying: '/widget/assets/lia/deploying.webp',
    warning: '/widget/assets/lia/warning.webp',
    error: '/widget/assets/lia/error.webp',
    success: '/widget/assets/lia/success.webp',
    idea: '/widget/assets/lia/idea.webp',
    waiting: '/widget/assets/lia/waiting.webp',
    done: '/widget/assets/lia/done.webp',
  };

  const HERO_BADGES = {
    welcome: 'آماده',
    thinking: 'در حال فکر',
    analyzing: 'در حال بررسی',
    planning: 'در حال برنامه‌ریزی',
    working: 'در حال کار',
    deploying: 'در حال دیپلوی',
    warning: 'نیاز به تو',
    error: 'خطا',
    success: 'موفق',
    idea: 'پیشنهاد',
    waiting: 'منتظر',
    done: 'تمام',
  };

  const FA_PERCENT = (n) => `${Number(n || 0).toLocaleString('fa-IR')}٪`;

  function setHero(state, opts = {}) {
    const key = HERO_IMAGES[state] ? state : 'welcome';
    const { title, sub, percent, stage, busy = false, tasks = null } = opts;

    if (el.heroImg.dataset.state !== key) {
      el.heroImg.src = HERO_IMAGES[key];
      el.heroImg.dataset.state = key;
    }
    el.hero.classList.toggle('working', ['thinking', 'analyzing', 'planning', 'working', 'deploying'].includes(key) && busy);
    el.hero.classList.toggle('error', key === 'error');
    el.hero.classList.toggle('success', key === 'success' || key === 'done');
    el.heroBadge.textContent = HERO_BADGES[key];

    if (title) el.heroTitle.textContent = title;
    if (sub !== undefined) el.heroSub.textContent = sub;

    el.heroBarWrap.classList.toggle('busy', busy && percent == null);
    if (percent != null) el.heroBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    el.heroPercent.textContent = FA_PERCENT(percent == null ? 0 : percent);
    if (stage) el.heroStage.textContent = stage;

    if (tasks) renderHeroTasks(tasks);
  }

  function renderHeroTasks(tasks) {
    if (!tasks.length) {
      el.heroTasks.innerHTML = '';
      return;
    }
    el.heroTasks.innerHTML = tasks
      .slice(0, 8)
      .map(
        (t) =>
          `<span class="task ${t.current ? 'current' : t.done ? 'done' : ''}">` +
          (t.done ? '<span class="tick">✓</span>' : t.current ? '<span class="tick">●</span>' : '') +
          `${esc(t.title)}</span>`,
      )
      .join('');
    const current = el.heroTasks.querySelector('.task.current');
    if (current && current.scrollIntoView) current.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function heroIdle() {
    setHero('welcome', {
      title: 'سلام، من لیا هستم',
      sub: 'همه‌کارهٔ پروژه‌ات: بررسی، پلن، دیپلوی',
      percent: 0,
      stage: 'آمادهٔ شروع',
      tasks: [],
    });
  }

  /** نگاشت ابزار ایجنت به حالت تصویری */
  function heroFromTool(ev) {
    const stateByTool = {
      analyze_project: 'analyzing',
      list_files: 'analyzing',
      read_file: 'analyzing',
      search_code: 'analyzing',
      quote_plan: 'planning',
      get_step_guide: 'idea',
      write_file: 'working',
      start_deploy: 'deploying',
      deploy_status: 'deploying',
      fetch_docs: 'thinking',
      remember: 'working',
    };
    if (ev.status === 'start') {
      const state = stateByTool[ev.name] || 'working';
      setHero(state, { sub: `دارم ${ev.label || ev.name} را انجام می‌دهم`, busy: true, percent: null });
    } else if (ev.status === 'error') {
      setHero('error', { sub: ev.summary || 'مشکلی پیش آمد', busy: false, percent: null });
    }
  }

  /* ---------------- لاگ زنده ---------------- */

  let logSource = null;
  const logLines = [];

  function fmtTime(ts) {
    const d = new Date(ts || Date.now());
    return d.toTimeString().slice(0, 8);
  }

  function appendLog(entry) {
    logLines.push(entry);
    if (logLines.length > 200) logLines.shift();
    const row = document.createElement('div');
    row.className = `row ${entry.level || 'dim'} ${entry.source || ''}`;
    row.innerHTML = `<span class="ts">${esc(fmtTime(entry.at))}</span><span class="src">[${esc(entry.source || 'sys')}]</span> ${esc(entry.text || '')}`;
    el.liveLog.appendChild(row);
    while (el.liveLog.children.length > 200) el.liveLog.removeChild(el.liveLog.firstChild);
    if (el.liveLog.classList.contains('open')) el.liveLog.scrollTop = el.liveLog.scrollHeight;
    el.logPreview.textContent = entry.text || '';
  }

  function connectLogs() {
    if (!state.sessionId || logSource) return;
    logSource = new EventSource(`${API}/api/logs/${encodeURIComponent(state.sessionId)}`);
    logSource.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.t === 'log' && data.entry) appendLog(data.entry);
      } catch {
        /* ignore */
      }
    };
    logSource.onerror = () => {
      // اتصال قطع شد؛ مرورگر خودش تلاش می‌کند
    };
  }

  function scrollToEnd() {
    requestAnimationFrame(() => {
      el.scroll.scrollTop = el.scroll.scrollHeight;
    });
  }

  function bubbleShell(role) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);
    el.msgs.appendChild(wrap);
    scrollToEnd();
    return { wrap, bubble };
  }

  function renderTextMessage(msg) {
    if (msg.id && state.seenMessageIds.has(msg.id)) return;
    // پیامی که خودمان خوش‌بینانه نشان داده‌ایم دوباره رندر نشود (اکوی سرور)
    if (msg.role === 'user' && state.pendingUser && state.pendingUser.text === msg.text) {
      if (msg.id) state.seenMessageIds.add(msg.id);
      state.pendingUser.serverId = msg.id;
      return;
    }
    if (msg.id) state.seenMessageIds.add(msg.id);
    const { bubble } = bubbleShell(msg.role === 'user' ? 'user' : 'lia');
    bubble.innerHTML = md(msg.text || '');
    scrollToEnd();
  }

  function renderCardMessage(card) {
    const wrap = document.createElement('div');
    wrap.className = 'msg lia';
    wrap.appendChild(buildCard(card));
    el.msgs.appendChild(wrap);
    scrollToEnd();
  }

  /** نشانگر ابزار ایجنت: «در حال اجرا» → «انجام شد» */
  const toolChips = new Map();

  function renderToolChip(ev) {
    const key = ev.name;
    if (ev.status === 'start') {
      const chip = document.createElement('div');
      chip.className = 'tool';
      chip.innerHTML = `<span class="spin"></span><span class="label">${esc(ev.label || ev.name)}…</span><span class="sum"></span>`;
      el.msgs.appendChild(chip);
      toolChips.set(key, chip);
      scrollToEnd();
      return;
    }
    let chip = toolChips.get(key);
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'tool';
      chip.innerHTML = '<span class="spin"></span><span class="label"></span><span class="sum"></span>';
      el.msgs.appendChild(chip);
      toolChips.set(key, chip);
    }
    chip.classList.toggle('done', ev.status === 'done');
    chip.classList.toggle('error', ev.status === 'error');
    chip.querySelector('.label').textContent = ev.label || ev.name;
    chip.querySelector('.sum').textContent = ev.summary ? ` — ${ev.summary}` : '';
    scrollToEnd();
  }

  /* ---------------- کارت‌ها ---------------- */

  function buildCard(card) {
    const box = document.createElement('div');
    box.className = 'card';

    switch (card.kind) {
      case 'chips': {
        box.innerHTML = `<h4>${esc(card.title || '')}</h4><div class="row" data-chips></div>`;
        const row = box.querySelector('[data-chips]');
        for (const item of card.items || []) {
          const b = document.createElement('button');
          b.className = 'chip';
          b.textContent = item.label;
          b.onclick = () => {
            if (item.action === 'answer' || item.action === 'chat_send') send(item.value || item.label);
            else if (item.action === 'autofix') action('deploy_autofix', { runId: item.runId, stepId: item.stepId });
            else action(item.action, { value: item.value });
          };
          row.appendChild(b);
        }
        break;
      }

      case 'modes': {
        box.innerHTML = `<h4>${esc(card.title || '')}</h4><div class="btns" style="flex-direction:column" data-opts></div>`;
        const wrap = box.querySelector('[data-opts]');
        for (const opt of card.options || []) {
          const b = document.createElement('button');
          b.className = 'btn';
          b.style.cssText = 'text-align:right;display:flex;gap:10px;align-items:flex-start;padding:11px 13px';
          b.innerHTML = `<span style="font-size:18px">${esc(opt.icon || '•')}</span>
            <span style="display:flex;flex-direction:column;gap:2px">
              <b style="color:#eaf5f0;font-size:13px">${esc(opt.title)}</b>
              <span style="color:#93a4b3;font-size:11.5px;font-weight:400">${esc(opt.desc)}</span>
            </span>`;
          b.onclick = () => action(opt.action, { value: opt.value });
          wrap.appendChild(b);
        }
        break;
      }

      case 'plan': {
        const c = card.cost || {};
        const s = card.specs || {};
        box.innerHTML = `
          <h4>${esc(card.title || 'پیشنهاد پلن')}</h4>
          <div class="price">${esc(card.planName)} — ${fmt(c.monthlyTotal)} <small>/ ماه</small></div>
          <div class="plan-specs">
            <span>RAM <b>${esc(s.ram)}GB</b></span>
            <span><b>${esc(s.vcpu)}</b> vCPU</span>
            <span>دیسک <b>${esc(s.disk)}GB</b></span>
          </div>
          <div class="sub">جمع ${fmt(c.months)} ماه: <b style="color:#7dfac9">${fmt(c.periodTotal)} تومان</b>
            ${card.db ? `<br>دیتابیس ${esc(card.db.name)}: ${fmt(card.db.monthly)} تومان/ماه` : ''}
            <br>ترافیک تخمینی: ${fmt(c.trafficMonthly)} تومان/ماه
          </div>
          <details><summary>چرا این پلن؟</summary><ul>${(card.assumptions || []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul></details>
          <div class="btns">
            <button class="btn primary" data-act="buy">خرید کردم</button>
            <button class="btn" data-act="cheaper">${card.cheaper ? 'گزینهٔ ارزان‌تر' : 'تغییر پلن'}</button>
            <button class="btn ghost" data-act="pricing">صفحهٔ قیمت‌ها</button>
          </div>
          <div class="sub" style="opacity:.7">تعرفه: نسخهٔ ${esc(card.catalogVersion)} — منبع: liara.ir/pricing</div>`;
        box.querySelector('[data-act="buy"]').onclick = () => action('purchased', {});
        box.querySelector('[data-act="cheaper"]').onclick = () => send('گزینهٔ ارزان‌تر را می‌خواهم');
        box.querySelector('[data-act="pricing"]').onclick = () => {
          window.location.href = '/pricing/';
        };
        break;
      }

      case 'step': {
        const s = card.step || {};
        box.innerHTML = `
          <div class="step-num">مرحلهٔ ${fmt((s.index || 0) + 1)} از ${fmt(s.total || 0)}</div>
          <div class="step-title">${esc(s.title)}</div>
          <div class="sub">${esc(s.action)}</div>
          <div class="sub" style="color:#8fb3a5">چرا: ${esc(s.why || '')}</div>
          ${s.check ? `<div class="check">✓ نشانهٔ درستی: ${esc(s.check)}</div>` : ''}
          <div class="btns">
            <button class="btn primary" data-act="show">نشانم بده کجا</button>
            <button class="btn ghost" data-act="route">باز کن ${esc(s.route || '')}</button>
          </div>`;
        box.querySelector('[data-act="show"]').onclick = () => focusStep(s);
        box.querySelector('[data-act="route"]').onclick = () => {
          if (s.route) window.location.href = s.route;
        };
        // اگر همین صفحه‌ایم، خودکار هایلایت کن
        setTimeout(() => focusStep(s, true), 350);
        break;
      }

      case 'analysis': {
        box.innerHTML = `
          <h4>پروژه را خواندم</h4>
          <div class="plan-specs">
            <span>پلتفرم <b>${esc(card.platform)}</b></span>
            <span><b>${fmt(card.stats?.fileCount || 0)}</b> فایل</span>
            <span><b>${fmt(card.stats?.sourceMb || 0)}</b>MB</span>
            ${card.port ? `<span>پورت <b>${esc(card.port)}</b></span>` : ''}
          </div>
          ${card.build ? `<div class="sub">build: <code>${esc(card.build)}</code></div>` : ''}
          ${card.envKeys?.length ? `<div class="sub">متغیرها: <code>${esc(card.envKeys.slice(0, 6).join(', '))}</code></div>` : ''}
          ${(card.findings || []).length ? `<div class="sub">نکته‌ها:</div>` : ''}
          <div style="display:flex;flex-direction:column;gap:6px">
            ${(card.findings || [])
              .slice(0, 5)
              .map(
                (f) => `<div style="display:flex;gap:7px;align-items:flex-start">
                  <span class="verdict ${esc(f.severity)}">${f.severity === 'high' ? 'مهم' : f.severity === 'medium' ? 'متوسط' : 'کم'}</span>
                  <span class="sub" style="flex:1">${esc(f.title)}</span></div>`,
              )
              .join('')}
          </div>
          <div class="btns">
            <button class="btn primary" data-act="deploy">شروع دیپلوی با تأیید من</button>
            <button class="btn ghost" data-act="ask">سؤال دارم</button>
          </div>`;
        box.querySelector('[data-act="deploy"]').onclick = () => action('start_deploy', {});
        box.querySelector('[data-act="ask"]').onclick = () => {
          send('این باگ‌ها را برایم توضیح بده');
        };
        // قهرمان با تحلیل عوض می‌شود (کارت «مناسب‌بودن» هم اگر بیاید حالت دقیق‌تر می‌دهد)
        setHero('analyzing', {
          title: 'پروژه را خواندم',
          sub: `پلتفرم ${card.platform} — ${fmt(card.stats?.fileCount || 0)} فایل`,
          percent: null,
          busy: false,
        });
        break;
      }

      case 'intake': {
        box.innerHTML = `
          <h4>${esc(card.title || 'سورس پروژه')}</h4>
          <div class="sub">${esc(card.hint || '')}</div>
          <div class="btns">
            <button class="btn primary" data-act="pick">آپلود zip</button>
            <button class="btn ghost" data-act="gh">لینک گیت‌هاب دارم</button>
          </div>`;
        box.querySelector('[data-act="pick"]').onclick = () => el.file.click();
        box.querySelector('[data-act="gh"]').onclick = () => {
          el.input.value = 'https://github.com/';
          el.input.focus();
          el.input.setSelectionRange(el.input.value.length, el.input.value.length);
        };
        break;
      }

      case 'approval': {
        const a = card.approval || {};
        box.innerHTML = `
          <div class="step-num">مرحلهٔ ${fmt((a.index || 0) + 1)} از ${fmt(a.total || 0)}</div>
          <h4>${esc(a.title)}</h4>
          <div class="sub">${esc(a.detail)}</div>
          <div class="sub" style="color:#ffd699">اثر: ${esc(a.effect)}</div>
          <div class="btns">
            <button class="btn primary" data-act="yes">انجام بده</button>
            <button class="btn danger" data-act="no">نه</button>
            <button class="btn ghost" data-act="stop">فقط تا اینجا</button>
          </div>`;
        box.querySelector('[data-act="yes"]').onclick = () => action('approve', { stepId: a.stepId, title: a.title });
        box.querySelector('[data-act="no"]').onclick = () => action('reject', { stepId: a.stepId, title: a.title });
        box.querySelector('[data-act="stop"]').onclick = () => action('stop', {});
        break;
      }

      case 'bug': {
        const b = card.bug || {};
        box.innerHTML = `
          <h4>${esc(b.title || 'مشکل در بیلد')}</h4>
          <div class="sub">${esc(b.reason || '')}</div>
          <div style="display:flex;flex-direction:column;gap:7px">
            ${(b.findings || [])
              .map(
                (f) => `<div style="border:1px solid #22303c;border-radius:9px;padding:8px 10px">
                  <div style="display:flex;gap:6px;align-items:center">
                    <span class="verdict ${esc(f.severity)}">${f.severity === 'high' ? 'مهم' : f.severity === 'medium' ? 'متوسط' : 'کم'}</span>
                    <b style="font-size:12.5px">${esc(f.title)}</b>
                  </div>
                  <div class="sub" style="margin-top:4px">${esc(f.detail)}</div>
                  ${f.fix ? `<div class="sub" style="color:#8fd8bd">راه‌حل: ${esc(f.fix)}</div>` : ''}
                </div>`,
              )
              .join('')}
          </div>
          <div class="btns">
            <button class="btn primary" data-act="fix">${b.retryable ? 'تلاش دوباره' : 'رفعش کن'}</button>
            <button class="btn" data-act="skip">${b.retryable ? 'رد شو و ادامه بده' : 'فقط گزارش بده'}</button>
          </div>`;
        box.querySelector('[data-act="fix"]').onclick = () => action('fix', { accept: true });
        box.querySelector('[data-act="skip"]').onclick = () => action('fix', { accept: false });
        break;
      }

      case 'deploy_plan': {
        const skipped = (card.skipped || [])
          .map((s) => `<div class="sub" style="opacity:.75">— ${esc(s.title)}: ${esc(s.why || 'لازم نیست')}</div>`)
          .join('');
        box.innerHTML = `
          <h4>${card.reused ? 'نقشهٔ دیپلوی مجدد' : 'نقشهٔ دیپلوی'}</h4>
          <div class="sub"><code>${esc(card.simulated ? `${card.appName}.liara.run` : card.url || `/apps/${card.appName}/`)}</code> — ${fmt((card.steps || []).length)} مرحله${card.reused ? ' · بدون آپلود دوباره' : ''}${card.simulated ? ' · شبیه‌سازی' : ''}</div>
          ${card.simulated ? '<div class="sub" style="color:#ffd699;font-size:10.5px">این اجرا شبیه‌سازی است؛ اپی روی لیارا ساخته نمی‌شود.</div>' : ''}
          <div style="display:flex;flex-direction:column;gap:4px">
            ${(card.steps || [])
              .map(
                (s, i) => `<div class="sub">${fmt(i + 1)}. ${esc(s.title)}${s.approval ? ' <span style="opacity:.6">(تأیید لازم)</span>' : ''}${s.why ? `<br><span style="opacity:.6;font-size:10.5px">${esc(s.why)}</span>` : ''}</div>`,
              )
              .join('')}
          </div>
          ${skipped ? `<div class="sub" style="margin-top:6px;color:#8fa6b4">لازم نیست:</div>${skipped}` : ''}
          ${(card.notes || []).length ? `<div class="sub" style="color:#ffd699">${esc(card.notes.join('، '))}</div>` : ''}`;
        break;
      }

      /* همین پروژه قبلاً دیپلوی شده — بدون آپلود دوباره */
      case 'reuse': {
        const when = card.deployedAt ? new Date(card.deployedAt).toLocaleString('fa-IR') : '';
        box.innerHTML = `
          <div class="step-num">پروژهٔ آشنا</div>
          <h4>این پروژه قبلاً دیپلوی شده</h4>
          <div class="sub">نام: <code>${esc(card.appName)}</code>${when ? `<br>آخرین دیپلوی: ${esc(when)}` : ''}
            ${card.url ? `<br>آدرس قبلی: <span style="direction:ltr;display:inline-block">${esc(card.url)}</span>` : ''}</div>
          <div class="sub" style="color:#8fd8bd">لازم نیست دوباره zip بفرستی؛ همان فایل‌ها و وابستگی‌ها سر جایشان هستند.</div>
          <div class="btns">
            <button class="btn primary" data-act="redeploy">همین را دوباره دیپلوی کن</button>
            <button class="btn ghost" data-act="fresh">فایل تازه می‌فرستم</button>
            <button class="btn ghost" data-act="diff">چه چیزی عوض شده؟</button>
          </div>`;
        box.querySelector('[data-act="redeploy"]').onclick = () => action('redeploy', { appName: card.appName });
        box.querySelector('[data-act="fresh"]').onclick = () => action('reuse_skip', {});
        box.querySelector('[data-act="diff"]').onclick = () =>
          send('این پروژه قبلاً دیپلوی شده؛ چه چیزهایی از آن موقع عوض شده و چه کاری لازم است؟');
        break;
      }

      case 'tool_approval': {
        const diffLines = String(card.diff || '')
          .split('\n')
          .map((line) => {
            const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
            return `<span class="${cls}">${esc(line)}</span>`;
          })
          .join('\n');
        box.innerHTML = `
          <div class="step-num">ایجنت لیا · نیاز به اجازه</div>
          <h4>${esc(card.title || card.toolLabel || 'اجرای ابزار')}</h4>
          ${card.reason ? `<div class="sub">${esc(card.reason)}</div>` : ''}
          ${card.impact ? `<div class="sub" style="color:#ffd699">اثر: ${esc(card.impact)}</div>` : ''}
          ${card.diff ? `<div class="diff">${diffLines}</div>` : ''}
          <div class="btns">
            <button class="btn primary" data-act="allow">اجازه بده و اعمال کن</button>
            <button class="btn danger" data-act="deny">نه، اعمال نکن</button>
          </div>`;
        box.querySelector('[data-act="allow"]').onclick = () => action('agent_approve', {});
        box.querySelector('[data-act="deny"]').onclick = () => action('agent_deny', {});
        break;
      }

      /* فرم چندسؤالی: همه را جواب بده، یک‌جا بفرست */
      case 'ask': {
        const answers = {};
        box.innerHTML = `
          <h4>${esc(card.title || 'چند سؤال کوتاه')}</h4>
          ${card.intro ? `<div class="sub">${esc(card.intro)}</div>` : ''}
          <div data-qs></div>
          <div class="btns"><button class="btn primary" data-submit>ارسال پاسخ‌ها</button></div>`;
        const qs = box.querySelector('[data-qs]');

        for (const q of card.questions || []) {
          const w = document.createElement('div');
          w.style.marginTop = '10px';
          w.dataset.qid = q.id;
          const lab = document.createElement('div');
          lab.className = 'sub';
          lab.style.color = '#dfeaf3';
          lab.textContent = q.label + (q.required ? ' *' : '');
          w.appendChild(lab);

          if (q.type === 'choice' && q.options?.length) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px';
            for (const o of q.options) {
              const b = document.createElement('button');
              b.className = 'btn';
              b.style.cssText = 'padding:5px 10px;font-size:11.5px';
              b.textContent = o.label;
              b.onclick = () => {
                answers[q.id] = o.value;
                row.querySelectorAll('button').forEach((x) => x.classList.toggle('primary', x === b));
              };
              row.appendChild(b);
            }
            w.appendChild(row);
          } else if (q.type === 'confirm') {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:6px;margin-top:6px';
            for (const [text, value] of [
              ['بله', 'بله'],
              ['نه', 'نه'],
            ]) {
              const b = document.createElement('button');
              b.className = 'btn';
              b.style.cssText = 'padding:5px 12px;font-size:11.5px';
              b.textContent = text;
              b.onclick = () => {
                answers[q.id] = value;
                row.querySelectorAll('button').forEach((x) => x.classList.toggle('primary', x === b));
              };
              row.appendChild(b);
            }
            w.appendChild(row);
          } else {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.placeholder = q.placeholder || '';
            inp.style.cssText =
              'width:100%;margin-top:6px;background:#0a1119;border:1px solid #26333f;border-radius:8px;padding:7px 9px;color:#e7eef4;font-family:inherit;font-size:12px';
            inp.oninput = () => {
              answers[q.id] = inp.value.trim();
              inp.style.borderColor = '#26333f';
            };
            w.appendChild(inp);
          }
          qs.appendChild(w);
        }

        box.querySelector('[data-submit]').onclick = () => {
          const missing = (card.questions || []).filter((q) => q.required && !String(answers[q.id] || '').trim());
          if (missing.length) {
            for (const q of missing) {
              const inp = box.querySelector(`[data-qid="${q.id}"] input`);
              if (inp) inp.style.borderColor = '#7a3030';
            }
            toast('این سؤال‌ها هنوز جواب ندارند: ' + missing.map((q) => q.label).join('، '));
            return;
          }
          box.querySelectorAll('button, input').forEach((n) => (n.disabled = true));
          box.querySelector('[data-submit]').textContent = 'ارسال شد ✓';
          action('ask_answer', { askId: card.askId, answers });
        };
        break;
      }

      /* دیباگ خودکار: ایجنت وارد عمل شده */
      case 'repair': {
        const findings = (card.findings || [])
          .map(
            (f) => `<div style="display:flex;gap:7px;align-items:flex-start;margin-bottom:5px">
                <span class="verdict ${f.severity === 'high' ? 'high' : 'medium'}">${f.severity === 'high' ? 'مهم' : 'بررسی'}</span>
                <span class="sub" style="flex:1"><b style="color:#eaf5f0">${esc(f.title)}</b><br>${esc(f.detail || '')}</span>
              </div>`,
          )
          .join('');
        const patches = (card.patches || [])
          .map(
            (p) => `<div style="border:1px solid #22303c;border-radius:9px;padding:7px 9px;margin-top:5px">
                <b style="font-size:12px;color:#eaf5f0">${p.kind === 'file' ? '✎' : p.kind === 'command' ? '▶' : '↻'} ${esc(p.title)}</b>
                ${p.detail ? `<div class="sub" style="margin-top:2px">${esc(p.detail)}</div>` : ''}
                ${p.path ? `<div class="sub" style="direction:ltr;text-align:left;color:#8fd8bd">${esc(p.path)}</div>` : ''}
              </div>`,
          )
          .join('');
        box.innerHTML = `
          <div class="step-num">ایجنت لیا · دیباگ خودکار</div>
          <h4>«${esc(card.stepTitle || 'مرحلهٔ دیپلوی')}» شکست خورد</h4>
          ${card.error ? `<div class="sub" style="direction:ltr;text-align:left;color:#ffb3b3;font-size:10.5px;max-height:70px;overflow:auto">${esc(String(card.error).slice(0, 400))}</div>` : ''}
          ${findings ? `<div style="margin-top:4px">${findings}</div>` : ''}
          ${patches ? `<div class="sub" style="margin-top:6px;color:#cfe4dd">تغییرهایی که پیشنهاد می‌دهم:</div>${patches}` : ''}
          <div class="btns">
            ${(card.patches || []).length ? '<button class="btn primary" data-act="autofix">اعمال کن و دوباره تلاش کن</button>' : ''}
            <button class="btn ${(card.patches || []).length ? 'ghost' : 'primary'}" data-act="retry">فقط دوباره تلاش کن</button>
            <button class="btn ghost" data-act="explain">توضیح کامل بده</button>
          </div>`;
        box.querySelector('[data-act="autofix"]')?.addEventListener('click', () =>
          action('deploy_autofix', { runId: card.runId, stepId: card.stepId }),
        );
        box.querySelector('[data-act="retry"]').onclick = () =>
          action('deploy_autofix', { runId: card.runId, stepId: card.stepId, retryOnly: true });
        box.querySelector('[data-act="explain"]').onclick = () => send('این خطای دیپلوی را کامل توضیح بده و بگو چه کار کنم');
        setHero('error', {
          title: 'دیپلوی شکست خورد — در حال دیباگ',
          sub: card.summary || 'علت را پیدا کردم؛ تأیید کن تا رفع کنم',
          percent: null,
        });
        break;
      }

      case 'repair_result': {
        const rows = (card.applied || [])
          .map((a) =>
            a.kind === 'file'
              ? `<div class="sub">${a.created ? '＋ فایل جدید' : '✎ اصلاح'}: <code>${esc(a.path)}</code>${a.changedLines ? ` — ${fmt(a.changedLines)} خط` : ''}</div>`
              : `<div class="sub">${a.code === 0 ? '✓' : '✗'} <code>${esc(a.command)}</code></div>`,
          )
          .join('');
        box.innerHTML = `
          <h4>${(card.errors || []).length ? 'رفع ناقص ماند' : '✓ رفع اعمال شد'}</h4>
          ${rows || '<div class="sub">تغییری روی فایل‌ها لازم نبود.</div>'}
          ${(card.errors || []).length ? `<div class="sub" style="color:#ffd699">${esc(card.errors.join('، '))}</div>` : ''}
          <div class="sub" style="color:#8fd8bd">مرحله دوباره اجرا می‌شود و نتیجه را می‌بینیم.</div>`;
        break;
      }

      case 'suitability': {
        const bad = card.suitable === false;
        const reasons = (card.reasons || [])
          .map(
            (r) =>
              `<div style="display:flex;gap:7px;align-items:flex-start;margin-bottom:4px">
                 <span class="verdict ${r.severity === 'high' ? 'high' : 'medium'}">${r.severity === 'high' ? 'بحرانی' : 'مهم'}</span>
                 <span class="sub" style="flex:1"><b style="color:#eaf5f0">${esc(r.title)}</b><br>${esc(r.detail)}</span>
               </div>`,
          )
          .join('');
        const changes = (card.adaptations || [])
          .map(
            (a) =>
              `<div style="border:1px solid #22303c;border-radius:9px;padding:8px 10px;margin-top:6px">
                 <b style="font-size:12.5px;color:#eaf5f0">${esc(a.title)}</b>
                 <div class="sub" style="margin-top:3px">${esc(a.detail)}</div>
                 <div class="sub" style="color:#8fd8bd;margin-top:3px">فایل‌ها: ${esc((a.files || []).join('، '))}</div>
               </div>`,
          )
          .join('');

        box.innerHTML = `
          <div class="step-num">بررسی مناسب‌بودن برای هاست وب</div>
          <h4>${bad ? 'این پروژه برای هاست وب مناسب نیست' : 'پروژه مناسب است'}</h4>
          <div class="sub">${esc(card.summary || '')}</div>
          ${reasons ? `<div style="margin-top:6px">${reasons}</div>` : ''}
          ${changes ? `<div class="sub" style="margin-top:8px;color:#cfe4dd">تغییرهایی که پیشنهاد می‌دهم:</div>${changes}` : ''}
          <div class="btns">
            ${card.canAdapt ? '<button class="btn primary" data-act="adapt">مناسبش کن (با این تغییرها)</button>' : ''}
            <button class="btn ${card.canAdapt ? 'ghost' : 'primary'}" data-act="skip">${bad ? 'نه، دست نزن' : 'الان لازم نیست'}</button>
          </div>
          ${bad && !card.canAdapt ? '<div class="sub" style="color:#ffd699">این نوع پروژه با تغییر فایل به وب‌سرویس تبدیل نمی‌شود؛ نسخهٔ وب/API را بفرست.</div>' : ''}`;

        if (card.canAdapt) box.querySelector('[data-act="adapt"]').onclick = () => action('suitability_apply', {});
        box.querySelector('[data-act="skip"]').onclick = () => action('suitability_skip', {});
        if (bad) {
          setHero('warning', {
            title: 'این پروژه مناسب هاست وب نیست',
            sub: card.canAdapt ? 'اگر تأیید کنی مناسبش می‌کنم' : 'تغییر فایل کافی نیست',
            percent: null,
          });
        } else if (card.canAdapt) {
          setHero('idea', { title: 'پروژه مناسب است', sub: 'یک بهبود کوچک پیشنهاد دارم', percent: null });
        } else {
          setHero('done', { title: 'پروژه مناسب هاست وب است', sub: 'بررسی ساختار انجام شد', percent: null });
        }
        break;
      }

      case 'adaptation_result': {
        box.innerHTML = `
          <h4>✓ مناسب‌سازی اعمال شد</h4>
          <div style="display:flex;flex-direction:column;gap:4px">
            ${(card.files || [])
              .map((f) => `<div class="sub">${f.created ? '＋ فایل جدید' : '✎ تغییر'}: <code>${esc(f.path)}</code>${f.changedLines ? ` — ${f.changedLines} بخش` : ''}</div>`)
              .join('')}
          </div>
          <div class="sub" style="color:#8fd8bd">پروژه دوباره تحلیل شد و پلتفرم/پورت به‌روز شدند.</div>`;
        break;
      }

      case 'summary': {
        const s = card.summary || {};
        const fullUrl = s.url ? (s.url.startsWith('http') ? s.url : location.origin + s.url) : '';
        const ok = s.status === 'success' || s.status === 'success_after_fix' || s.status === 'success_with_warnings';
        box.innerHTML = `
          <h4>${ok ? '✓ دیپلوی انجام شد' : 'متوقف شد'}</h4>
          ${s.simulated && fullUrl
            ? `<div class="sub" style="color:#ffd699">آدرس شبیه‌سازی‌شده: <span style="direction:ltr;display:inline-block">${esc(fullUrl)}</span><br>
                 این اپ واقعاً روی لیارا ساخته نشده؛ آدرس بالا فقط نمایشی است.</div>`
            : fullUrl
              ? `<div class="sub">آدرس پیش‌نمایش: <a href="${esc(fullUrl)}" target="_blank" rel="noopener">${esc(fullUrl)}</a></div>`
              : ''}
          ${s.local && s.port && !s.simulated ? `<div class="sub" style="color:#8fd8bd">پورت ${esc(s.port)} — فقط از 127.0.0.1 در دسترس است.</div>` : ''}
          <div class="sub">مراحل انجام‌شده: ${fmt(s.steps || 0)}${s.stoppedAt ? ` — توقف در «${esc(s.stoppedAt)}»` : ''}${s.reused ? ' — دیپلوی مجدد بدون آپلود' : ''}</div>
          ${(s.fixed || []).length ? `<div class="sub" style="color:#8fd8bd">رفع شد: ${esc((s.fixed || []).join('، '))}</div>` : ''}
          ${(s.warnings || []).length ? `<div class="sub" style="color:#ffd699">هشدارها: ${esc((s.warnings || []).join(' — '))}</div>` : ''}
          <div class="btns">
            ${fullUrl && ok && !s.simulated ? `<a class="btn primary" href="${esc(fullUrl)}" target="_blank" rel="noopener">باز کردن اپ</a>` : ''}
            ${fullUrl && ok && !s.simulated ? `<button class="btn danger" data-act="stopapp">توقف اپ</button>` : ''}
            <button class="btn ghost" data-act="again">شروع دوباره</button>
          </div>`;
        box.querySelector('[data-act="again"]').onclick = () => action('restart', {});
        const stopBtn = box.querySelector('[data-act="stopapp"]');
        if (stopBtn) stopBtn.onclick = async () => {
          try {
            await fetch(`${API}/api/apps/${encodeURIComponent(s.appName)}/stop`, { method: 'POST' });
            stopBtn.textContent = 'متوقف شد';
            stopBtn.disabled = true;
          } catch {
            toast('توقف اپ ناموفق بود');
          }
        };
        break;
      }

      default:
        box.innerHTML = `<div class="sub">${esc(card.text || '')}</div>`;
    }

    return box;
  }

  const fmt = (n) => Number(n || 0).toLocaleString('fa-IR');

  /* ---------------- هایلایت ---------------- */

  let ringRaf = null;

  function focusStep(step, silent = false) {
    if (!step?.selector) return;
    // بین چند المان منطبق، اولین عنصر «دیده‌شدنی» را انتخاب کن (منوهای مخفی/بنرهای تزئینی را رد کن)
    const candidates = [...document.querySelectorAll(step.selector)];
    const target = candidates.find((node) => {
      const r = node.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && r.top < innerHeight * 3;
    });
    if (!target) {
      if (!silent) {
        const here = step.route && location.pathname.startsWith(step.route.replace(/\/$/, ''));
        toast(
          here
            ? 'عنصر این مرحله روی صفحه پیدا نشد؛ شاید صفحه هنوز کامل لود نشده.'
            : `این مرحله در صفحهٔ ${step.route} است. اول آن صفحه را باز کن.`,
        );
      }
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.highlight = { target, label: 'اینجا کلیک کن' };
    el.ringTip.textContent = 'اینجا کلیک کن';
    el.ring.classList.add('on');

    const place = () => {
      if (!state.highlight) return;
      const r = state.highlight.target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      Object.assign(el.ring.style, {
        top: `${Math.max(4, r.top - 5)}px`,
        left: `${Math.max(4, r.left - 5)}px`,
        width: `${Math.min(r.width + 10, innerWidth - 8)}px`,
        height: `${r.height + 10}px`,
      });
      // اگر عنصر نزدیک بالای صفحه است، تولتیپ زیر آن برود تا بیرون کادر نیفتد
      const tipBelow = r.top < 52;
      el.ringTip.style.top = tipBelow ? `calc(100% + 8px)` : '';
      el.ringTip.style.bottom = tipBelow ? 'auto' : '';
      el.ring.querySelector('.arrow').style.display = tipBelow ? 'none' : '';
      ringRaf = requestAnimationFrame(place);
    };
    cancelAnimationFrame(ringRaf);
    place();
    setTimeout(clearHighlight, 9000);
  }

  function clearHighlight() {
    state.highlight = null;
    el.ring.classList.remove('on');
    cancelAnimationFrame(ringRaf);
  }

  function toast(text) {
    const { bubble } = bubbleShell('lia');
    bubble.innerHTML = `<span style="color:#ffd699">${esc(text)}</span>`;
    scrollToEnd();
  }

  /* ---------------- وضعیت سرور ---------------- */

  function applyState(s) {
    if (!s) return;
    if (s.mode) state.meta.mode = s.mode;
    if (s.stage) state.meta.stage = s.stage;
    if (s.llm) {
      state.provider = {
        demo: !!s.llm.demo,
        blocked: !!(s.llm.probe && !s.llm.probe.ok && !s.llm.probe.skipped),
      };
    }
    if (s.deploy !== undefined) updateDeploy(s.deploy);
    // نقطهٔ اعلان فقط وقتی واقعاً کاری از کاربر مانده (تأیید/تصمیم)
    const waiting =
      (state.deploy && ['awaiting_approval', 'awaiting_fix'].includes(state.deploy.status)) ||
      (s.agent && s.agent.status === 'awaiting_approval');
    el.dot.classList.toggle('on', !!waiting);
    el.status.textContent = statusLabel();
  }

  function statusLabel() {
    if (state.provider.blocked) return 'کلید مدل: نیاز به فعال‌سازی حساب';
    if (state.provider.demo) return 'حالت دمو — کلید مدل تنظیم نشده';
    if (state.meta.mode === 'guided') return 'حالت راهنمای مرحله‌به‌مرحله';
    if (state.meta.mode === 'auto') return 'حالت دیپلوی خودکار';
    if (state.meta.mode === 'chat') return 'حالت چت — بعد از دیپلوی';
    if (state.meta.mode === 'agent') return 'حالت خودمختار — لیا کارها را انجام می‌دهد';
    return 'دستیار دیپلوی لیارا';
  }

  function renderSession(sessionState) {
    el.msgs.innerHTML = '';
    state.seenMessageIds.clear();
    state.sessionId = sessionState.id;
    localStorage.setItem(LS_SESSION, state.sessionId);
    for (const m of sessionState.messages || []) {
      if (m.kind === 'text') renderTextMessage(m);
      else if (m.kind === 'card' && m.card) {
        // کارت دیباگ از پیام‌ها رندر شده؛ از snapshot دوباره نیاید
        if (m.card.kind === 'repair' && m.card.id) state.renderedEvents.add('repair-' + m.card.id);
        renderCardMessage(m.card);
      }
    }
    applyState({ mode: sessionState.mode, stage: sessionState.stage, llm: sessionState.llm, deploy: sessionState.deploy });
    if (typeof sessionState.autoFix === 'boolean') {
      state.autoFix = sessionState.autoFix;
      refreshAutoFixChip();
    }
    if (sessionState.account) {
      state.account = sessionState.account;
      state.plan = sessionState.account.plan || null;
      refreshAccountChip();
    }
    if (!sessionState.deploy) heroIdle();
    connectLogs();
  }

  /* ---------------- پنل دیپلوی ---------------- */

  function updateDeploy(snap) {
    if (!snap) {
      el.deployPanel.classList.remove('on');
      state.deploy = null;
      if (!state.busy) heroIdle();
      return;
    }
    state.deploy = snap;
    el.deployPanel.classList.add('on');
    el.deployApp.textContent = snap.appName || '—';
    const labels = {
      created: 'آماده',
      running: 'در حال اجرا',
      awaiting_approval: 'منتظر تأیید تو',
      awaiting_fix: 'منتظر تصمیم تو',
      stopped: 'متوقف',
      done: 'تمام',
      error: 'خطا',
      unknown: 'نامشخص',
    };
    el.deployStatus.textContent = labels[snap.status] || snap.status;
    el.deployCount.textContent = `${fmt((snap.index || 0) + 1)}/${fmt(snap.total || 0)}`;
    el.deployBar.style.width = `${Math.round(((snap.index || 0) / Math.max(1, snap.total || 1)) * 100)}%`;
    el.deployLogs.innerHTML = (snap.logs || [])
      .slice(-6)
      .map((l) => `<div class="${esc(l.level || 'dim')}">${esc(l.text)}</div>`)
      .join('');

    if (snap.status === 'awaiting_approval' && snap.pendingApproval) {
      const key = snap.pendingApproval.stepId;
      if (state.renderedApproval !== key) {
        state.renderedApproval = key;
        renderCardMessage({ kind: 'approval', approval: snap.pendingApproval });
      }
    }
    if (snap.status === 'awaiting_fix' && snap.bug && !state.renderedEvents.has('bug')) {
      state.renderedEvents.add('bug');
      renderCardMessage({ kind: 'bug', bug: snap.bug });
    }
    // کارت دیباگ خودکار: ایجنت بدون پرسش وارد عمل شده
    if (snap.repair) {
      const key = 'repair-' + (snap.repair.id || `${snap.id}-${snap.repair.stepId}`);
      if (!state.renderedEvents.has(key)) {
        state.renderedEvents.add(key);
        renderCardMessage(snap.repair);
      }
    }
    if (snap.status === 'done' || snap.status === 'stopped' || snap.status === 'error') {
      if (!state.renderedEvents.has('done-' + snap.id)) {
        state.renderedEvents.add('done-' + snap.id);
        if (snap.summary) renderCardMessage({ kind: 'summary', summary: snap.summary });
      }
    }

    // قهرمان: درصد و مرحلهٔ دیپلوی
    const steps = snap.steps || [];
    const doneCount = steps.filter((s) => s.done).length;
    const percent = Math.round((doneCount / Math.max(1, snap.total || steps.length)) * 100);
    const current = steps.find((s) => s.current);
    const stageLabel =
      snap.status === 'awaiting_approval'
        ? `منتظر اجازه: ${snap.pendingApproval?.title || 'مرحلهٔ بعد'}`
        : snap.status === 'awaiting_fix'
          ? 'رفع باگ پیش از ادامه'
          : current
            ? `مرحله ${faNum(snap.index + 1)}: ${current.title}`
            : 'در حال انجام';

    const tasks = steps.map((s) => ({ title: s.title, done: !!s.done, current: !!s.current }));
    const app = snap.url || '';

    if (snap.status === 'done') {
      setHero('success', { title: 'دیپلوی با موفقیت انجام شد', sub: app, percent: 100, stage: 'پایان', tasks });
    } else if (snap.status === 'stopped') {
      setHero('warning', { title: 'کار متوقف شد', sub: 'به خواست تو', percent, stage: stageLabel, tasks });
    } else if (snap.status === 'error') {
      setHero('error', { title: 'دیپلوی ناتمام ماند', sub: snap.summary?.error || 'یک مرحله خطا داد', percent, stage: stageLabel, tasks });
    } else if (snap.status === 'awaiting_fix') {
      setHero('error', { title: 'بیلد شکست خورد', sub: 'منتظر تصمیم تو برای رفع باگ', percent, stage: stageLabel, tasks });
    } else if (snap.status === 'awaiting_approval') {
      setHero('deploying', {
        title: 'منتظر اجازهٔ تو هستم',
        sub: snap.pendingApproval?.title || 'برای ادامه تأیید لازم است',
        percent,
        stage: stageLabel,
        tasks,
      });
    } else {
      setHero('deploying', {
        title: 'دارم دیپلوی می‌کنم',
        sub: 'مرحله‌ها را یکی‌یکی انجام می‌دهم',
        percent,
        stage: stageLabel,
        busy: true,
        tasks,
      });
    }

    scrollToEnd();
  }

  const faNum = (n) => Number(n || 0).toLocaleString('fa-IR');

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  /**
   * پیام‌های تازه را از سرور می‌گیرد و فقط چیزهای جدید را اضافه می‌کند.
   * لازم است چون بعد از پایان دیپلوی، سرور یک پیام «حالت چت» + چیپ می‌فرستد.
   */
  async function refreshSession({ append = true } = {}) {
    if (!state.sessionId) return null;
    try {
      const res = await fetch(`${API}/api/session/${encodeURIComponent(state.sessionId)}`, {
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) return null;
      const { state: s } = await res.json();
      if (!s) return null;
      for (const m of s.messages || []) {
        if (m.id && state.seenMessageIds.has(m.id)) continue;
        if (m.kind === 'text') renderTextMessage(m);
        else if (m.kind === 'card' && m.card) {
          if (m.id) state.seenMessageIds.add(m.id);
          renderCardMessage(m.card);
        }
      }
      applyState({ mode: s.mode, stage: s.stage, llm: s.llm, deploy: s.deploy, agent: s.agent });
      return s;
    } catch {
      return null;
    }
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(async () => {
      if (!state.sessionId) return;
      const snap = state.deploy;
      if (!snap) return;
      try {
        const res = await fetch(`${API}/api/deploy/${encodeURIComponent(snap.id)}?since=${state.lastEvent}`);
        if (res.status === 404) {
          // اجرا بعد از ری‌استارت سرور از حافظه رفته؛ بی‌صدا متوقف شو
          stopPolling();
          await refreshSession();
          return;
        }
        const next = await res.json();
        if (next.events?.length) state.lastEvent = next.lastEvent;
        updateDeploy(next);
        if (['done', 'stopped', 'error'].includes(next.status) || next.missing) {
          stopPolling();
          // پیام‌ها و چیپ‌های «قدم بعد» که سرور در حالت چت ثبت می‌کند.
          // سرور ممکن است چند ثانیه بعد از «done» آن‌ها را بنویسد؛ چند بار تلاش می‌کنیم.
          await refreshSession();
          let tries = 0;
          const followUp = setInterval(async () => {
            tries += 1;
            const s = await refreshSession();
            if (!s || s.mode === 'chat' || tries >= 5) clearInterval(followUp);
          }, 2500);
        }
      } catch {
        /* شبکه لرزید؛ دفعهٔ بعد */
      }
    }, 900);
  }

  /* ---------------- صف درخواست‌ها ---------------- */
  // کلیک سریع کاربر نباید گم شود: اگر پاسخ قبلی در جریان است، در صف می‌ماند.
  const queue = [];
  let draining = false;

  function enqueue(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const item = queue.shift();
      try {
        await item.task();
        item.resolve();
      } catch (e) {
        item.reject(e);
      }
    }
    draining = false;
  }

  /* ---------------- ارسال ---------------- */

  async function doSend(text) {
    const value = String(text || '').trim();
    if (!value) return;
    state.busy = true;
    el.send.disabled = true;
    el.input.value = '';
    el.input.style.height = 'auto';

    bubbleShell('user').bubble.textContent = value;
    state.pendingUser = { text: value };
    setTimeout(() => {
      state.pendingUser = null;
    }, 30_000);

    const typing = document.createElement('div');
    typing.className = 'msg lia';
    typing.innerHTML = '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    el.msgs.appendChild(typing);
    scrollToEnd();

    try {
      await stream('/api/chat', { sessionId: state.sessionId, text: value }, (ev) => {
        if (typing.parentNode) typing.remove();
        handleEvent(ev);
      });
    } catch (e) {
      toast('ارتباط با سرور برقرار نشد: ' + e.message);
    } finally {
      typing.remove();
      state.busy = false;
      state.pendingUser = null;
      el.send.disabled = false;
      startPolling();
    }
  }

  async function doAction(name, payload = {}) {
    state.busy = true;
    el.send.disabled = true;
    const typing = document.createElement('div');
    typing.className = 'msg lia';
    typing.innerHTML = '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    el.msgs.appendChild(typing);
    scrollToEnd();

    try {
      await stream('/api/action', { sessionId: state.sessionId, action: name, payload }, (ev) => {
        if (typing.parentNode) typing.remove();
        handleEvent(ev);
      });
    } catch (e) {
      toast('ارتباط با سرور برقرار نشد: ' + e.message);
    } finally {
      typing.remove();
      state.busy = false;
      el.send.disabled = false;
      startPolling();
    }
  }

  const send = (text) => (String(text || '').trim() ? enqueue(() => doSend(text)) : Promise.resolve());
  const action = (name, payload) => enqueue(() => doAction(name, payload));

  function handleEvent(ev) {
    switch (ev.t) {
      case 'meta':
        applyState({ mode: ev.mode, stage: ev.stage });
        break;
      case 'msg':
        if (ev.msg?.kind === 'text') renderTextMessage(ev.msg);
        else if (ev.msg?.card) renderCardMessage(ev.msg.card);
        break;
      case 'msg_start':
        state.seenMessageIds.add(ev.msg.id);
        var shell = bubbleShell('lia');
        shell.bubble.dataset.streamId = ev.msg.id;
        if (!state.deploy || ['done', 'stopped'].includes(state.deploy.status)) {
          setHero('thinking', { sub: 'دارم پاسخ را می‌نویسم', busy: true, percent: null });
        }
        break;
      case 'delta': {
        const target = shadow.querySelector(`[data-stream-id="${ev.id}"]`);
        if (target) {
          target.dataset.raw = (target.dataset.raw || '') + ev.text;
          target.innerHTML = md(target.dataset.raw);
          scrollToEnd();
        }
        break;
      }
      case 'msg_end': {
        const target = shadow.querySelector(`[data-stream-id="${ev.msg.id}"]`);
        if (target) {
          target.dataset.raw = ev.msg.text || target.dataset.raw || '';
          target.innerHTML = md(target.dataset.raw);
          target.removeAttribute('data-stream-id');
        }
        break;
      }
      case 'typing':
        if (ev.on) {
          if (!state.deploy || state.deploy.status === 'done' || state.deploy.status === 'stopped') {
            setHero('thinking', { sub: 'دارم فکر می‌کنم', busy: true, percent: null });
          }
        }
        break;
      case 'tool':
        renderToolChip(ev);
        heroFromTool(ev);
        break;
      case 'state':
        applyState(ev.state);
        break;
      case 'navigate':
        if (ev.url) window.location.href = ev.url;
        break;
      case 'error':
        toast(ev.message || 'خطا');
        setHero('error', { sub: ev.message || 'خطای غیرمنتظره', percent: null });
        break;
      default:
        break;
    }
  }

  /* ---------------- آپلود ---------------- */

  async function upload(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) return toast('فقط فایل zip قبول می‌کنم.');
    if (file.size > 55 * 1024 * 1024) return toast('حجم فایل بیش از ۵۵ مگابایت است؛ پروژه را بدون node_modules بفرست.');

    const { bubble } = bubbleShell('user');
    bubble.textContent = `📦 ${file.name} (${(file.size / 1048576).toFixed(1)}MB)`;

    const typing = document.createElement('div');
    typing.className = 'msg lia';
    typing.innerHTML = '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    el.msgs.appendChild(typing);
    scrollToEnd();

    try {
      const res = await fetch(`${API}/api/intake?sessionId=${encodeURIComponent(state.sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      const data = await res.json();
      typing.remove();
      if (!res.ok) return toast(data.error || 'آپلود ناموفق بود');
      for (const ev of data.events || []) handleEvent(ev);
      if (state.sheetKind === 'project' && !el.sheet.hidden) renderProjectSheet();
    } catch (e) {
      typing.remove();
      toast('آپلود ناموفق بود: ' + e.message);
    }
  }

  /* ---------------- پنل پروژه / حساب (همان قابلیت‌های صفحهٔ /agent/) ---------------- */

  function openSheet(title, kind) {
    state.sheetKind = kind;
    el.sheetTitle.textContent = title;
    el.sheetBody.innerHTML = '';
    el.sheet.hidden = false;
    if (kind === 'project') renderProjectSheet();
    else if (kind === 'account') renderAccountSheet();
  }

  function closeSheet() {
    el.sheet.hidden = true;
    state.sheetKind = null;
  }

  function sheetNote(text) {
    const d = document.createElement('div');
    d.className = 'sub';
    d.textContent = text;
    el.sheetBody.appendChild(d);
    return d;
  }

  function sheetBtn(label, primary, onClick) {
    const b = document.createElement('button');
    b.className = 'btn' + (primary ? ' primary' : '');
    b.textContent = label;
    b.onclick = onClick;
    el.sheetBody.appendChild(b);
    return b;
  }

  /* ---------- پروژه ---------- */

  async function renderProjectSheet() {
    el.sheetBody.innerHTML = '';
    const actions = document.createElement('div');
    actions.className = 'btns';
    el.sheetBody.appendChild(actions);

    const up = document.createElement('button');
    up.className = 'btn primary';
    up.textContent = '📎 آپلود zip پروژه';
    up.onclick = () => el.file.click();
    actions.appendChild(up);

    const dl = document.createElement('a');
    dl.className = 'btn';
    dl.textContent = '⬇ دانلود نسخهٔ کاری';
    dl.href = `${API}/api/project/${encodeURIComponent(state.sessionId || '')}/download`;
    dl.target = '_blank';
    dl.rel = 'noopener';
    actions.appendChild(dl);

    const openFull = document.createElement('a');
    openFull.className = 'btn ghost';
    openFull.textContent = '⤢ صفحهٔ کامل';
    openFull.href = '/agent/';
    openFull.target = '_blank';
    openFull.rel = 'noopener';
    actions.appendChild(openFull);

    if (!state.sessionId) return sheetNote('اول گفتگو را شروع کن.');

    try {
      const data = await api(`/api/project/${encodeURIComponent(state.sessionId)}/tree`);
      const files = (data.files || []).slice(0, 400);
      if (!files.length) {
        sheetNote('هنوز پروژه‌ای آپلود نشده. با دکمهٔ بالا zip را بفرست.');
        return;
      }
      sheetNote(`${files.length} فایل — روی هر کدام بزن تا محتوایش را ببینی.`);
      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:5px';
      for (const p of files) {
        const row = document.createElement('div');
        row.className = 'frow';
        row.title = p;
        row.innerHTML = `<span class="ico">▤</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(p)}</span>`;
        row.onclick = () => openProjectFile(p);
        list.appendChild(row);
      }
      el.sheetBody.appendChild(list);
    } catch (e) {
      sheetNote('فهرست فایل‌ها خوانده نشد: ' + e.message);
    }
  }

  async function openProjectFile(path) {
    el.sheetBody.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'btn ghost';
    back.textContent = '→ برگشت به فهرست';
    back.onclick = () => renderProjectSheet();
    el.sheetBody.appendChild(back);

    const title = document.createElement('div');
    title.className = 'sub';
    title.style.direction = 'ltr';
    title.style.textAlign = 'left';
    title.textContent = path;
    el.sheetBody.appendChild(title);

    try {
      const data = await api(`/api/project/${encodeURIComponent(state.sessionId)}/file?path=${encodeURIComponent(path)}`);
      const pre = document.createElement('div');
      pre.className = 'fpre';
      pre.textContent = data.file.text + (data.file.truncated ? '\n…(کوتاه شد)' : '');
      el.sheetBody.appendChild(pre);
    } catch (e) {
      sheetNote('فایل خوانده نشد: ' + e.message);
    }
  }

  /* ---------- حساب و پلن ---------- */

  function planBadgeText() {
    if (!state.account) return 'مهمان';
    if (state.plan?.active) return `${state.plan.plan.name} · ${fmt(state.plan.daysLeft)} روز`;
    return 'بدون پلن';
  }

  function refreshAccountChip() {
    if (!el.accLabel) return;
    el.accLabel.textContent = planBadgeText();
    el.accBtn.classList.toggle('on', !!state.plan?.active);
  }

  async function loadAccount(accountId) {
    if (!accountId) return false;
    try {
      const data = await api('/api/account', { method: 'POST', body: JSON.stringify({ accountId }) });
      state.account = data.account;
      state.plan = data.plan;
      localStorage.setItem(LS_ACCOUNT, data.account?.id || accountId);
      refreshAccountChip();
      return true;
    } catch {
      localStorage.removeItem(LS_ACCOUNT);
      state.account = null;
      state.plan = null;
      refreshAccountChip();
      return false;
    }
  }

  async function renderAccountSheet() {
    el.sheetBody.innerHTML = '';

    if (!state.account) {
      sheetNote('برای دیدن پلن و خرید، یک حساب بساز (ایمیل کافی است).');
      const f1 = document.createElement('div');
      f1.className = 'field';
      f1.innerHTML = '<label>ایمیل</label><input id="accEmail" type="email" placeholder="you@example.com" />';
      const f2 = document.createElement('div');
      f2.className = 'field';
      f2.innerHTML = '<label>نام (اختیاری)</label><input id="accName" type="text" placeholder="نام تو" />';
      el.sheetBody.appendChild(f1);
      el.sheetBody.appendChild(f2);
      sheetBtn('ساخت / ورود به حساب', true, async () => {
        const email = el.sheetBody.querySelector('#accEmail').value.trim();
        const name = el.sheetBody.querySelector('#accName').value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('ایمیل معتبر نیست.');
        try {
          const data = await api('/api/account', { method: 'POST', body: JSON.stringify({ email, name }) });
          state.account = data.account;
          state.plan = data.plan;
          localStorage.setItem(LS_ACCOUNT, data.account.id);
          if (state.sessionId) {
            await api('/api/session', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId, accountId: data.account.id }) }).catch(() => {});
          }
          refreshAccountChip();
          toast('خوش آمدی ' + (state.account.name || state.account.email));
          renderAccountSheet();
        } catch (e) {
          toast(e.message);
        }
      });
      return;
    }

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px';
    head.innerHTML = `<b style="font-size:12.5px;color:#eaf5f0">${esc(state.account.name || state.account.email)}</b>
      <span class="badge-plan ${state.plan?.active ? '' : 'off'}">${state.plan?.active ? 'پلن ' + esc(state.plan.plan.name) : 'بدون پلن فعال'}</span>`;
    el.sheetBody.appendChild(head);

    if (state.plan?.active) {
      sheetNote(
        `پلن فعال تا ${new Date(state.plan.expiresAt).toLocaleDateString('fa-IR')} — ${fmt(state.plan.daysLeft)} روز باقی مانده.`,
      );
    }

    let plans = [];
    try {
      const data = await api('/api/plans');
      plans = data.plans || [];
    } catch {
      return sheetNote('فهرست پلن‌ها خوانده نشد.');
    }

    let selected = plans[0]?.id || null;
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    const months = document.createElement('div');
    months.className = 'field';
    months.innerHTML = `<label>مدت</label><select id="accMonths">${[1, 3, 6, 12]
      .map((m) => `<option value="${m}">${m} ماه</option>`)
      .join('')}</select>`;

    const draw = () => {
      list.innerHTML = '';
      for (const p of plans) {
        const row = document.createElement('div');
        row.className = 'prow' + (p.id === selected ? ' on' : '');
        row.innerHTML = `<div style="display:flex;flex-direction:column;gap:2px">
            <b style="font-size:12px;color:#eaf5f0">${esc(p.name)}</b>
            <span class="meta">${esc(p.ramGb)}GB RAM · ${esc(p.vcpu)} vCPU · ${esc(p.diskGb)}GB</span>
          </div>
          <span class="p">${fmt(p.monthly)} <small style="font-weight:400">/ماه</small></span>`;
        row.onclick = () => {
          selected = p.id;
          draw();
        };
        list.appendChild(row);
      }
    };
    draw();
    el.sheetBody.appendChild(list);
    el.sheetBody.appendChild(months);

    sheetBtn('خرید / تمدید پلن', true, async () => {
      if (!selected) return toast('یک پلن انتخاب کن.');
      const m = Number(el.sheetBody.querySelector('#accMonths').value) || 1;
      try {
        const data = await api(`/api/account/${encodeURIComponent(state.account.id)}/plan`, {
          method: 'POST',
          body: JSON.stringify({ planId: selected, months: m, sessionId: state.sessionId }),
        });
        state.plan = data.plan;
        refreshAccountChip();
        toast(`پلن ${data.plan.plan.name} فعال شد — ${fmt(data.payment.amount)} تومان`);
        closeSheet();
        send('پلن را خریدم و فعال شد؛ ادامه بده.');
      } catch (e) {
        toast(e.message);
      }
    });

    sheetBtn('خروج از حساب', false, () => {
      localStorage.removeItem(LS_ACCOUNT);
      state.account = null;
      state.plan = null;
      refreshAccountChip();
      renderAccountSheet();
    });
  }

  function refreshAutoFixChip() {
    if (!el.autoFixBtn) return;
    el.autoFixBtn.classList.toggle('on', !!state.autoFix);
    el.autoFixLabel.textContent = state.autoFix ? 'رفع خودکار: روشن' : 'رفع خودکار: خاموش';
  }

  /* ---------------- آگاهی از صفحه ---------------- */

  let contextTimer = null;
  function reportContext() {
    if (!state.sessionId) return;
    clearTimeout(contextTimer);
    contextTimer = setTimeout(async () => {
      try {
        const headings = [...document.querySelectorAll('h1,h2')]
          .slice(0, 6)
          .map((h) => h.textContent.trim().slice(0, 80));
        const data = await api('/api/context', {
          method: 'POST',
          body: JSON.stringify({ sessionId: state.sessionId, path: location.pathname, title: document.title, headings }),
        });
        for (const ev of data.events || []) handleEvent(ev);
      } catch {
        /* بی‌صدا */
      }
    }, 600);
  }

  function hookNavigation() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const out = original.apply(this, args);
        reportContext();
        return out;
      };
    }
    window.addEventListener('popstate', reportContext);
    new MutationObserver(() => reportContext()).observe(document.documentElement, { childList: true, subtree: false });
  }

  /* ---------------- باز/بسته ---------------- */

  function setOpen(open) {
    state.open = open;
    el.panel.classList.toggle('open', open);
    el.fab.classList.toggle('hidden', open);
    el.fab.setAttribute('aria-expanded', String(open));
    localStorage.setItem(LS_OPEN, open ? '1' : '0');
    if (open) {
      scrollToEnd();
      setTimeout(() => el.input.focus({ preventScroll: true }), 250);
      reportContext();
    }
  }

  function boot() {
    if (state.booted) return;
    state.booted = true;

    if (state.open) setOpen(true);
    el.fab.addEventListener('click', () => setOpen(!state.open));
    el.close.addEventListener('click', () => setOpen(false));
    el.reset.addEventListener('click', () => action('restart', {}));

    el.projBtn.addEventListener('click', () => openSheet('پروژه', 'project'));
    el.accBtn.addEventListener('click', () => openSheet('حساب و پلن', 'account'));
    el.sheetClose.addEventListener('click', closeSheet);
    el.autoFixBtn.addEventListener('click', () => {
      state.autoFix = !state.autoFix;
      refreshAutoFixChip();
      action('auto_fix_toggle', { value: state.autoFix });
    });
    refreshAutoFixChip();
    refreshAccountChip();

    el.send.addEventListener('click', () => send(el.input.value));
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(el.input.value);
      }
    });
    el.input.addEventListener('input', () => {
      el.input.style.height = 'auto';
      el.input.style.height = Math.min(110, el.input.scrollHeight) + 'px';
    });
    el.attach.addEventListener('click', () => el.file.click());
    el.file.addEventListener('change', () => {
      const f = el.file.files?.[0];
      el.file.value = '';
      if (f) upload(f);
    });

    el.logToggle.addEventListener('click', () => {
      const open = !el.liveLog.classList.contains('open');
      el.liveLog.classList.toggle('open', open);
      el.logToggle.classList.toggle('open', open);
      el.logToggle.setAttribute('aria-expanded', String(open));
      if (open) el.liveLog.scrollTop = el.liveLog.scrollHeight;
    });
    document.addEventListener('click', (e) => {
      if (state.highlight && !e.composedPath().includes(host)) clearHighlight();
    });

    hookNavigation();

    // ?lia=open برای تست/اسکرین‌شات (باز شدن خودکار سایدبار)
    const forceOpen = new URLSearchParams(location.search).get('lia') === 'open';
    if (forceOpen) setTimeout(() => setOpen(true), 300);

    (async () => {
      try {
        const data = await api('/api/session', {
          method: 'POST',
          body: JSON.stringify({ sessionId: state.sessionId }),
        });
        renderSession(data.state);
        if (data.state.deploy) {
          state.lastEvent = 0;
          startPolling();
        }
      } catch (e) {
        el.status.textContent = 'اتصال به سرور برقرار نشد';
        console.error('Lia boot:', e);
      }
      // حساب ذخیره‌شده (اگر باشد) → نشان پلن در نوار ابزار
      await loadAccount(localStorage.getItem(LS_ACCOUNT));
      reportContext();
    })();

    // تست‌پذیری: دسترسی از کنسول/ابزار تست
    window.__LIA__ = {
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen(!state.open),
      send,
      action,
      state: () => ({
        sessionId: state.sessionId,
        open: state.open,
        busy: state.busy,
        mode: state.meta.mode,
        stage: state.meta.stage,
        messages: state.messages,
        deploy: state.deploy,
      }),
      highlight: (selector) => focusStep({ selector }),
      openSheet,
      closeSheet,
      // تست/دیباگ: رندر یک کارت دلخواه بدون رفت‌وبرگشت سرور
      renderCard: (card) => renderCardMessage(card),
      uploadFile: (file) => upload(file),
      shadow,
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
