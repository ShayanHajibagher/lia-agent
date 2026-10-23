/**
 * agent.js — رابط کاربری «بخش ایجنت» (صفحهٔ کامل، شبیه lovable/base44)
 *
 * همان API ویجت را استفاده می‌کند: /api/session، /api/chat (SSE)، /api/action (SSE)،
 * /api/intake، /api/project/:id/*، /api/account/*، /api/plans.
 * هیچ فریم‌ورکی لازم نیست.
 */
(function () {
  'use strict';

  const API = location.origin;
  const LS_SESSION = 'lia.agent.session';
  const LS_ACCOUNT = 'lia.account.id';

  const state = {
    sessionId: null,
    accountId: null,
    account: null,
    plan: null,
    plans: [],
    selectedPlan: null,
    deploy: null,
    busy: false,
    seen: new Set(),
    pendingUser: null,
    lastEvent: 0,
    pollTimer: null,
    toolChips: new Map(),
    currentFile: null, // { path, original, current }
    allFiles: [],
    activeTab: 'chat',
    sessions: [],
    historyOpen: false,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    msgs: $('msgs'),
    input: $('input'),
    send: $('send'),
    composer: $('composer'),
    files: $('files'),
    download: $('downloadLink'),
    deployPanel: $('deployPanel'),
    deployStatus: $('deployStatus'),
    autoFixBtn: $('autoFixBtn'),
    deployBar: $('deployBar'),
    deploySteps: $('deploySteps'),
    deployLogs: $('deployLogs'),
    accountName: $('accountName'),
    planBadge: $('planBadge'),
    accountBtn: $('accountBtn'),
    buyBtn: $('buyBtn'),
    newChat: $('newChat'),
    // History Drawer
    historyToggleBtn: $('historyToggleBtn'),
    historyCountBadge: $('historyCountBadge'),
    historyDrawer: $('historyDrawer'),
    historyOverlay: $('historyOverlay'),
    historyCloseBtn: $('historyCloseBtn'),
    historyNewBtn: $('historyNewBtn'),
    historySearchInput: $('historySearchInput'),
    historyList: $('historyList'),
    status: $('status'),
    // Auth & Account Modals
    login: $('loginDialog'),
    loginForm: $('loginForm'),
    loginEmail: $('loginEmail'),
    loginPassword: $('loginPassword'),
    loginSubmitBtn: $('loginSubmitBtn'),
    loginLater: $('loginLater'),
    loginCloseBtn: $('loginCloseBtn'),
    authTabLogin: $('authTabLogin'),
    authTabRegister: $('authTabRegister'),
    authModalTitle: $('authModalTitle'),
    registerForm: $('registerForm'),
    regName: $('regName'),
    regEmail: $('regEmail'),
    regPassword: $('regPassword'),
    regSubmitBtn: $('regSubmitBtn'),
    regCancelBtn: $('regCancelBtn'),
    // Profile Dialog
    profileDialog: $('profileDialog'),
    profileName: $('profileName'),
    profileEmail: $('profileEmail'),
    profileId: $('profileId'),
    profilePlan: $('profilePlan'),
    profileBuyBtn: $('profileBuyBtn'),
    logoutBtn: $('logoutBtn'),
    profileCloseBtn: $('profileCloseBtn'),
    profileDoneBtn: $('profileDoneBtn'),
    // Checkout
    checkout: $('checkoutDialog'),
    plans: $('plans'),
    months: $('months'),
    total: $('total'),
    pay: $('payBtn'),
    uploadBtn: $('uploadBtn'),
    fileInput: $('fileInput'),
    fileSearch: $('fileSearch'),
    openEditorBtn: $('openEditorBtn'),
    deployAppMeta: $('deployAppMeta'),
    deployedUrlLink: $('deployedUrlLink'),
    quickRedeployBtn: $('quickRedeployBtn'),
    goToPreviewTabBtn: $('goToPreviewTabBtn'),
    // Editor elements
    editorCurrentPath: $('editorCurrentPath'),
    editorFileLang: $('editorFileLang'),
    editorFileLines: $('editorFileLines'),
    editorToggleDiffBtn: $('editorToggleDiffBtn'),
    editorSaveBtn: $('editorSaveBtn'),
    editorRedeployBtn: $('editorRedeployBtn'),
    editorAiPrompt: $('editorAiPrompt'),
    editorAiApplyBtn: $('editorAiApplyBtn'),
    editorCodeView: $('editorCodeView'),
    editorGutter: $('editorGutter'),
    editorTextarea: $('editorTextarea'),
    editorDiffView: $('editorDiffView'),
    editorCloseDiffBtn: $('editorCloseDiffBtn'),
    editorDiffContent: $('editorDiffContent'),
    editorActiveBadge: $('editorActiveBadge'),
    // Preview elements
    previewUrlInput: $('previewUrlInput'),
    previewCopyUrlBtn: $('previewCopyUrlBtn'),
    previewReloadBtn: $('previewReloadBtn'),
    previewOpenTabBtn: $('previewOpenTabBtn'),
    previewFrameWrap: $('previewFrameWrap'),
    previewEmptyState: $('previewEmptyState'),
    previewIframe: $('previewIframe'),
    previewLiveIndicator: $('previewLiveIndicator'),
    previewStartSampleBtn: $('previewStartSampleBtn'),
    // Logs console
    systemLogsTerminal: $('systemLogsTerminal'),
    clearLogsBtn: $('clearLogsBtn'),
    copyLogsBtn: $('copyLogsBtn'),
    // Samples
    samplesBtn: $('samplesBtn'),
    samplesDialog: $('samplesDialog'),
    samplesClose: $('samplesClose'),
    samplesListContainer: $('samplesListContainer'),
    // Lia Hero Status Panel
    liaHero: $('liaHero'),
    heroImg: $('heroImg'),
    heroBadge: $('heroBadge'),
    heroTitle: $('heroTitle'),
    heroSub: $('heroSub'),
    heroBar: $('heroBar'),
    heroBarWrap: $('heroBarWrap'),
    heroPercent: $('heroPercent'),
    heroStage: $('heroStage'),
    heroTasks: $('heroTasks'),
  };

  /* ---------------- انیمیشن‌ها و آواتارهای کاراکتر لیا ---------------- */

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
    welcome: 'آماده به کار',
    thinking: 'در حال تفکر',
    analyzing: 'تحلیل سورس',
    planning: 'چیدن نقشه',
    working: 'در حال تغییر فایل',
    deploying: 'استقرار روی سرور',
    warning: 'هشدار مهم',
    error: 'نیاز به بررسی خطا',
    success: 'انجام شد ✓',
    idea: 'پیشنهاد هوشمند',
    waiting: 'منتظر پاسخ شما',
    done: ' آنلاین و فعال',
  };

  function setHero({ pose = 'welcome', title, sub, percent, stage, tasks } = {}) {
    if (!el.liaHero) return;
    const key = HERO_IMAGES[pose] ? pose : 'welcome';
    el.liaHero.dataset.pose = key;
    const src = HERO_IMAGES[key];
    if (el.heroImg && el.heroImg.getAttribute('src') !== src) {
      el.heroImg.style.opacity = '0.25';
      el.heroImg.style.transform = 'scale(0.92)';
      setTimeout(() => {
        if (!el.heroImg) return;
        el.heroImg.src = src;
        el.heroImg.style.opacity = '1';
        el.heroImg.style.transform = '';
      }, 110);
    }
    if (el.heroBadge) el.heroBadge.textContent = HERO_BADGES[key] || 'لیا';
    if (title !== undefined && el.heroTitle) el.heroTitle.textContent = title;
    if (sub !== undefined && el.heroSub) el.heroSub.textContent = sub;

    if (percent === null || percent === undefined) {
      if (el.heroBarWrap) el.heroBarWrap.hidden = true;
    } else if (el.heroBarWrap) {
      el.heroBarWrap.hidden = false;
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      if (el.heroBar) el.heroBar.style.width = p + '%';
      if (el.heroPercent) el.heroPercent.textContent = faNum(p) + '٪';
      if (stage !== undefined && el.heroStage) el.heroStage.textContent = stage;
    }

    if (Array.isArray(tasks) && el.heroTasks) {
      el.heroTasks.innerHTML = tasks
        .slice(0, 6)
        .map(
          (t) =>
            `<span class="t ${t.done ? 'done' : t.cur ? 'cur' : ''}">` +
            `<span class="ic">${t.done ? '✓' : t.cur ? '●' : '○'}</span>${esc(t.title)}</span>`,
        )
        .join('');
    } else if (tasks === null && el.heroTasks) {
      el.heroTasks.innerHTML = '';
    }
  }

  function heroIdle() {
    if (state.deploy && ['running', 'created', 'awaiting_approval', 'awaiting_fix'].includes(state.deploy.status)) {
      return;
    }
    setHero({
      pose: 'welcome',
      title: 'آماده برای ساخت، تغییر یا دیپلوی پروژه',
      sub: 'کافی است بگویی چه می‌خواهی؛ کدها را می‌خوانم و اجرا می‌کنم.',
      percent: null,
      tasks: null,
    });
  }

  function heroFromTool(ev) {
    const label = ev.label || ev.name;
    const map = {
      list_files: { pose: 'analyzing', title: 'دارم ساختار پروژه را می‌خوانم…', p: 25 },
      read_file: { pose: 'analyzing', title: 'دارم محتوای فایل را بررسی می‌کنم…', p: 38 },
      search_files: { pose: 'analyzing', title: 'جستجو در کدهای پروژه…', p: 42 },
      inspect_project: { pose: 'analyzing', title: 'تحلیل کامل فریم‌ورک و وابستگی‌ها…', p: 52 },
      check_web_suitability: { pose: 'planning', title: 'بررسی سازگاری با هاست ابری…', p: 58 },
      recommend_plan: { pose: 'idea', title: 'محاسبهٔ بهترین پلن و منابع سرور…', p: 64 },
      write_file: { pose: 'working', title: 'در حال نوشتن و ویرایش فایل…', p: 72 },
      edit_file: { pose: 'working', title: 'اعمال تغییر در کد پروژه…', p: 74 },
      delete_file: { pose: 'working', title: 'حذف فایل اضافی…', p: 70 },
      run_command: { pose: 'working', title: 'اجرای دستور در محیط ایزوله…', p: 78 },
      adapt_for_web: { pose: 'working', title: 'آماده‌سازی خودکار پروژه برای وب…', p: 82 },
      deploy_project: { pose: 'deploying', title: 'شروع ساخت و استقرار روی سرور…', p: 88 },
      deploy_Status: { pose: 'deploying', title: 'بررسی وضعیت استقرار…', p: 92 },
      ask_user: { pose: 'waiting', title: 'چند سؤال کوتاه از شما دارم', p: null },
    };
    const m = map[ev.name] || { pose: 'thinking', title: label, p: 45 };
    if (ev.status === 'error') {
      setHero({ pose: 'error', title: 'خطا در ' + label, sub: ev.summary || '', percent: null });
    } else if (ev.status === 'done') {
      setHero({
        pose: m.pose,
        title: label + ' انجام شد',
        sub: ev.summary || 'مرحله با موفقیت کامل شد.',
        percent: m.p ? Math.min(96, m.p + 10) : null,
        stage: label,
      });
    } else {
      setHero({
        pose: m.pose,
        title: m.title,
        sub: label,
        percent: m.p,
        stage: label,
      });
      showLiveActivity({ pose: m.pose, title: m.title, sub: label });
    }
  }

  function cardPoseHtml(pose = 'idea', badge = '') {
    const src = HERO_IMAGES[pose] || HERO_IMAGES.idea;
    return `
      <div class="card-pose-art" title="${esc(badge || HERO_BADGES[pose] || 'لیا')}" style="width:32px;height:32px;flex:0 0 32px;">
        <img src="${src}" alt="Lia ${esc(pose)}" width="32" height="32" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;" />
      </div>
    `;
  }

  let liveActivityNode = null;
  function showLiveActivity({ pose = 'thinking', title = 'لیا در حال پردازش است…', sub = 'لطفاً چند لحظه صبر کنید' } = {}) {
    const src = HERO_IMAGES[pose] || HERO_IMAGES.thinking;
    if (!liveActivityNode || !liveActivityNode.isConnected) {
      liveActivityNode = document.createElement('div');
      liveActivityNode.className = 'chat-live-activity';
      el.msgs.appendChild(liveActivityNode);
    }
    liveActivityNode.innerHTML = `
      <div class="activity-pose" style="width:26px;height:26px;flex:0 0 26px;">
        <img src="${src}" alt="Lia active" width="26" height="26" style="width:100%;height:100%;object-fit:cover;display:block;" />
      </div>
      <div class="activity-meta">
        <div class="activity-title">
          <span>${esc(title)}</span>
          <span class="typing-dots"><i></i><i></i><i></i></span>
        </div>
        <div class="activity-sub">${esc(sub)}</div>
      </div>
    `;
    scrollEnd();
  }

  function hideLiveActivity() {
    if (liveActivityNode && liveActivityNode.isConnected) {
      liveActivityNode.remove();
    }
    liveActivityNode = null;
  }

  /* ---------------- کمکی ---------------- */

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const fmt = (n) => Number(n || 0).toLocaleString('fa-IR');
  const faNum = (n) => Number(n || 0).toLocaleString('fa-IR');

  function md(text) {
    let out = esc(text || '');
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    return out;
  }

  function toast(text) {
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = text;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3200);
  }

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  }

  async function sse(path, body, onEvent) {
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
          /* ignore */
        }
      }
    }
  }

  function scrollEnd() {
    requestAnimationFrame(() => {
      el.msgs.scrollTop = el.msgs.scrollHeight;
    });
  }

  /* ---------------- حساب و احراز هویت ---------------- */

  function renderAccount() {
    if (state.account) {
      el.accountName.textContent = state.account.name || state.account.email;
      const plan = state.plan;
      if (plan?.active) {
        el.planBadge.textContent = `پلن ${plan.plan.name} · ${faNum(plan.daysLeft)} روز`;
        el.planBadge.className = 'badge';
      } else {
        el.planBadge.textContent = 'بدون پلن فعال';
        el.planBadge.className = 'badge warn';
      }
      el.buyBtn.hidden = false;
    } else {
      el.accountName.textContent = 'ورود / عضویت';
      el.planBadge.textContent = 'مهمان';
      el.planBadge.className = 'badge off';
      el.buyBtn.hidden = true;
    }
  }

  async function loadAccount(accountId) {
    try {
      const data = await api('/api/account', { method: 'POST', body: JSON.stringify({ accountId }) });
      state.account = data.account;
      state.plan = data.plan;
      state.accountId = data.account?.id || null;
      if (state.accountId) localStorage.setItem(LS_ACCOUNT, state.accountId);
      renderAccount();
      return true;
    } catch {
      localStorage.removeItem(LS_ACCOUNT);
      state.accountId = null;
      state.account = null;
      renderAccount();
      return false;
    }
  }

  function openLogin(tab = 'login') {
    switchAuthTab(tab);
    if (el.login && !el.login.open) el.login.showModal();
  }

  function switchAuthTab(tab = 'login') {
    const isLogin = tab === 'login';
    el.authTabLogin?.classList.toggle('active', isLogin);
    el.authTabRegister?.classList.toggle('active', !isLogin);
    el.loginForm?.classList.toggle('active', isLogin);
    el.registerForm?.classList.toggle('active', !isLogin);
    if (el.authModalTitle) {
      el.authModalTitle.textContent = isLogin ? 'ورود به حساب کاربری لیارا' : 'ساخت حساب کاربری تازه';
    }
  }

  function openProfile() {
    if (!state.account) return openLogin('login');
    if (el.profileName) el.profileName.textContent = state.account.name || 'کاربر لیارا';
    if (el.profileEmail) el.profileEmail.textContent = state.account.email || '—';
    if (el.profileId) el.profileId.textContent = state.account.id || '—';
    if (el.profilePlan) {
      el.profilePlan.textContent = state.plan?.active
        ? `پلن ${state.plan.plan.name} (${faNum(state.plan.daysLeft)} روز اعتبار)`
        : 'پلن فعالی برای این حساب ثبت نشده است.';
    }
    if (el.profileDialog && !el.profileDialog.open) el.profileDialog.showModal();
  }

  // تب‌های فرم احراز هویت
  el.authTabLogin?.addEventListener('click', () => switchAuthTab('login'));
  el.authTabRegister?.addEventListener('click', () => switchAuthTab('register'));
  el.loginCloseBtn?.addEventListener('click', () => el.login.close());
  el.loginLater?.addEventListener('click', () => el.login.close());
  el.regCancelBtn?.addEventListener('click', () => el.login.close());

  // ارسال فرم ورود
  el.loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el.loginEmail.value.trim();
    const password = el.loginPassword.value;
    if (!email || !password) return;
    if (el.loginSubmitBtn) el.loginSubmitBtn.disabled = true;
    try {
      const data = await api('/api/account/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, sessionId: state.sessionId }),
      });
      state.account = data.account;
      state.plan = data.plan;
      state.accountId = data.account.id;
      localStorage.setItem(LS_ACCOUNT, state.accountId);
      renderAccount();
      el.login.close();
      toast('خوش آمدی ' + (state.account.name || state.account.email));
      await loadHistorySessions();
    } catch (err) {
      toast(err.message);
    } finally {
      if (el.loginSubmitBtn) el.loginSubmitBtn.disabled = false;
    }
  });

  // ارسال فرم ثبت‌نام
  el.registerForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.regName.value.trim();
    const email = el.regEmail.value.trim();
    const password = el.regPassword.value;
    if (!name || !email || !password) return;
    if (el.regSubmitBtn) el.regSubmitBtn.disabled = true;
    try {
      const data = await api('/api/account/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, sessionId: state.sessionId }),
      });
      state.account = data.account;
      state.plan = data.plan;
      state.accountId = data.account.id;
      localStorage.setItem(LS_ACCOUNT, state.accountId);
      renderAccount();
      el.login.close();
      toast('حساب کاربری شما با موفقیت ساخته شد!');
      await loadHistorySessions();
    } catch (err) {
      toast(err.message);
    } finally {
      if (el.regSubmitBtn) el.regSubmitBtn.disabled = false;
    }
  });

  // کلیک روی دکمهٔ حساب کاربری در هدر
  el.accountBtn?.addEventListener('click', () => {
    if (state.account) openProfile();
    else openLogin('login');
  });

  el.profileBuyBtn?.addEventListener('click', () => {
    el.profileDialog?.close();
    openCheckout();
  });
  el.profileCloseBtn?.addEventListener('click', () => el.profileDialog?.close());
  el.profileDoneBtn?.addEventListener('click', () => el.profileDialog?.close());

  // خروج از حساب کاربری
  el.logoutBtn?.addEventListener('click', async () => {
    if (!confirm('آیا می‌خواهید از حساب کاربری خود خارج شوید؟')) return;
    try {
      await api('/api/account/logout', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId }) });
    } catch {}
    localStorage.removeItem(LS_ACCOUNT);
    state.accountId = null;
    state.account = null;
    state.plan = null;
    renderAccount();
    el.profileDialog?.close();
    toast('از حساب کاربری خارج شدید.');
    await loadHistorySessions();
  });

  el.buyBtn.addEventListener('click', () => openCheckout());

  async function openCheckout() {
    if (!state.accountId) return openLogin('login');
    try {
      const data = await api('/api/plans');
      state.plans = data.plans || [];
      state.selectedPlan = state.selectedPlan || state.plans[0]?.id || null;
      renderPlans();
      el.checkout.showModal();
    } catch (err) {
      toast(err.message);
    }
  }

  function renderPlans() {
    el.plans.innerHTML = state.plans
      .map(
        (p) => `<div class="plan ${p.id === state.selectedPlan ? 'on' : ''}" data-plan="${esc(p.id)}">
          <b>${esc(p.name)}</b>
          <span>${esc(p.ramGb)}GB RAM · ${esc(p.vcpu)} vCPU · ${esc(p.diskGb)}GB</span>
          <div class="p">${fmt(p.monthly)} تومان / ماه</div>
        </div>`,
      )
      .join('');
    el.plans.querySelectorAll('.plan').forEach((node) => {
      node.onclick = () => {
        state.selectedPlan = node.dataset.plan;
        renderPlans();
        renderTotal();
      };
    });
    renderTotal();
  }

  function renderTotal() {
    const plan = state.plans.find((p) => p.id === state.selectedPlan);
    const months = Number(el.months.value) || 1;
    el.total.textContent = plan ? `${fmt(plan.monthly * months)} تومان` : '—';
  }
  el.months.addEventListener('change', renderTotal);

  el.pay.addEventListener('click', async () => {
    if (!state.selectedPlan) return;
    el.pay.disabled = true;
    try {
      const data = await api(`/api/account/${encodeURIComponent(state.accountId)}/plan`, {
        method: 'POST',
        body: JSON.stringify({ planId: state.selectedPlan, months: Number(el.months.value) || 1, sessionId: state.sessionId }),
      });
      state.plan = data.plan;
      renderAccount();
      el.checkout.close();
      toast(`پلن ${data.plan.plan.name} فعال شد — ${fmt(data.payment.amount)} تومان`);
      // به ایجنت بگو پلن فعال شد تا ادامه بدهد
      send('پلن را خریدم و فعال شد؛ ادامه بده.');
    } catch (err) {
      toast(err.message);
    } finally {
      el.pay.disabled = false;
    }
  });

  $('checkoutClose').addEventListener('click', () => el.checkout.close());

  /* ---------------- تاریخچه و سشن‌ها (مخصوص کاربران عضو) ---------------- */

  function formatRelativeTime(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'همین الان';
    if (diff < 3600) return `${Math.floor(diff / 60).toLocaleString('fa-IR')} دقیقه پیش`;
    if (diff < 86400) return `${Math.floor(diff / 3600).toLocaleString('fa-IR')} ساعت پیش`;
    const days = Math.floor(diff / 86400);
    if (days < 7) return `${days.toLocaleString('fa-IR')} روز پیش`;
    return new Date(ts).toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' });
  }

  async function loadHistorySessions() {
    if (!state.accountId) {
      state.sessions = [];
      if (el.historyCountBadge) el.historyCountBadge.hidden = true;
      renderHistoryList([]);
      return;
    }
    try {
      const data = await api('/api/sessions?accountId=' + encodeURIComponent(state.accountId));
      state.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      if (el.historyCountBadge) {
        el.historyCountBadge.textContent = state.sessions.length.toLocaleString('fa-IR');
        el.historyCountBadge.hidden = !state.sessions.length;
      }
      renderHistoryList(state.sessions);
    } catch {
      if (el.historyList) el.historyList.innerHTML = '<div class="empty">تاریخچه موقتاً در دسترس نیست</div>';
    }
  }

  function renderHistoryList(sessionsToRender) {
    if (!el.historyList) return;

    // اگر کاربر لاگین نیست، قفل دسترسی و بنر احراز هویت را نشان بده
    if (!state.accountId) {
      el.historyList.innerHTML = `
        <div class="history-auth-gate">
          <div class="history-auth-gate-icon">🔒</div>
          <div class="history-auth-gate-title">تاریخچه گفتگوها مخصوص کاربران عضو است</div>
          <div class="history-auth-gate-desc">
            برای ذخیرهٔ خودکار پیام‌ها، سوابق دیپلوی، کدها و دسترسی دائمی به جلسات کاری خود، وارد حساب کاربری شوید یا حساب تازه بسازید.
          </div>
          <button class="btn primary history-auth-gate-btn" id="historyAuthActionBtn" type="button">
            ورود یا عضویت در حساب کاربری
          </button>
        </div>
      `;
      el.historyList.querySelector('#historyAuthActionBtn')?.addEventListener('click', () => {
        closeHistory();
        openLogin('login');
      });
      return;
    }

    const query = (el.historySearchInput?.value || '').trim().toLowerCase();
    const filtered = query
      ? sessionsToRender.filter((s) =>
          (s.title || '').toLowerCase().includes(query) ||
          (s.appName || '').toLowerCase().includes(query) ||
          (s.lastMessage || '').toLowerCase().includes(query) ||
          (s.platform || '').toLowerCase().includes(query),
        )
      : sessionsToRender;

    if (!filtered.length) {
      el.historyList.innerHTML = query
        ? '<div class="empty">هیچ گفتگویی با این عبارت پیدا نشد.</div>'
        : '<div class="empty">هنوز هیچ گفتگویی ثبت نشده است. با ارسال اولین پیام، سشن شما اینجا ذخیره خواهد شد.</div>';
      return;
    }

    el.historyList.innerHTML = filtered
      .map((s) => {
        const isActive = s.id === state.sessionId;
        const deployBadge = s.deployStatus === 'success'
          ? '<span class="history-badge deploy-ok">✓ مستقر شده</span>'
          : s.deployStatus === 'deploying'
            ? '<span class="history-badge" style="color:#93c5fd;border-color:#3b82f6">در حال استقرار</span>'
            : s.deployStatus === 'failed'
              ? '<span class="history-badge deploy-fail">خطای استقرار</span>'
              : '';
        const platformBadge = s.platform ? `<span class="history-badge">${esc(s.platform)}</span>` : '';
        const activeBadge = isActive ? '<span class="history-badge active-indicator">فعال</span>' : '';
        const previewText = s.lastMessage ? esc(s.lastMessage) : (s.appName ? `پروژهٔ ${esc(s.appName)}` : 'بدون پیام');

        return `
          <div class="history-card ${isActive ? 'active' : ''}" data-id="${esc(s.id)}">
            <div class="history-card-top">
              <span class="history-card-title">${esc(s.title || 'گفتگوی تازه')}</span>
              <button class="history-delete-btn" data-del="${esc(s.id)}" title="حذف این گفتگو">🗑️</button>
            </div>
            <div class="history-card-preview">${previewText}</div>
            <div class="history-card-foot">
              <div class="history-card-badges">
                ${activeBadge}
                ${platformBadge}
                ${deployBadge}
                <span class="history-badge">${(s.messageCount || 0).toLocaleString('fa-IR')} پیام</span>
              </div>
              <span class="history-time">${formatRelativeTime(s.updatedAt || s.createdAt)}</span>
            </div>
          </div>
        `;
      })
      .join('');

    // کلیک روی کارت برای سوئیچ سشن
    el.historyList.querySelectorAll('.history-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]')) return;
        switchSession(card.dataset.id);
      });
    });

    // کلیک دکمه حذف سشن
    el.historyList.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.del;
        if (!confirm('آیا این گفتگو و تاریخچهٔ آن حذف شود؟')) return;
        try {
          await api(`/api/session/${encodeURIComponent(id)}?accountId=${encodeURIComponent(state.accountId)}`, { method: 'DELETE' });
          toast('گفتگو با موفقیت حذف شد.');
          if (id === state.sessionId) {
            await startSession(null);
          }
          await loadHistorySessions();
        } catch (err) {
          toast('خطا در حذف گفتگو: ' + err.message);
        }
      });
    });
  }

  function openHistory() {
    if (!el.historyDrawer || !el.historyOverlay) return;
    state.historyOpen = true;
    el.historyOverlay.hidden = false;
    requestAnimationFrame(() => {
      el.historyOverlay.classList.add('open');
      el.historyDrawer.classList.add('open');
      el.historyDrawer.setAttribute('aria-hidden', 'false');
    });
    loadHistorySessions();
  }

  function closeHistory() {
    if (!el.historyDrawer || !el.historyOverlay) return;
    state.historyOpen = false;
    el.historyDrawer.classList.remove('open');
    el.historyOverlay.classList.remove('open');
    el.historyDrawer.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      if (!state.historyOpen) el.historyOverlay.hidden = true;
    }, 280);
  }

  function toggleHistory() {
    if (state.historyOpen) closeHistory();
    else openHistory();
  }

  async function switchSession(targetSessionId) {
    if (!targetSessionId) return;
    if (targetSessionId === state.sessionId) {
      closeHistory();
      return;
    }
    closeHistory();
    stopPolling();
    state.deploy = null;
    state.currentFile = null;
    try {
      const data = await api(`/api/session/${encodeURIComponent(targetSessionId)}`);
      state.sessionId = targetSessionId;
      localStorage.setItem(LS_SESSION, targetSessionId);
      renderSession(data.state);
      toast('گفتگوی انتخاب‌شده بارگذاری شد.');
      loadHistorySessions();
    } catch (err) {
      toast('خطا در بارگذاری گفتگو: ' + err.message);
    }
  }

  if (el.historyToggleBtn) el.historyToggleBtn.addEventListener('click', toggleHistory);
  if (el.historyCloseBtn) el.historyCloseBtn.addEventListener('click', closeHistory);
  if (el.historyOverlay) el.historyOverlay.addEventListener('click', closeHistory);
  if (el.historyNewBtn) {
    el.historyNewBtn.addEventListener('click', () => {
      closeHistory();
      el.newChat.click();
    });
  }
  if (el.historySearchInput) {
    el.historySearchInput.addEventListener('input', () => renderHistoryList(state.sessions));
  }

  /* ---------------- راه‌اندازی سشن ---------------- */

  async function boot() {
    const savedAccount = localStorage.getItem(LS_ACCOUNT);
    if (savedAccount) await loadAccount(savedAccount);
    renderAccount();

    try {
      const health = await api('/api/health');
      const info = health.llm || {};
      state.modelLabel = info.demo ? 'حالت دمو (بدون مدل)' : `مدل: ${info.model}`;
      el.status.textContent = state.modelLabel;
      el.status.className = 'status ok';
    } catch {
      el.status.textContent = 'سرور در دسترس نیست';
      el.status.className = 'status bad';
    }

    const saved = localStorage.getItem(LS_SESSION);
    await startSession(saved);
    await loadHistorySessions();
    if (!state.accountId) setTimeout(() => openLogin(), 600);
  }

  /** اگر سشن هنوز ساخته نشده (شبکهٔ کند/خطای اولیه)، قبل از هر درخواست بساز */
  let sessionReady = null;
  async function ensureSession() {
    if (state.sessionId) return state.sessionId;
    if (!sessionReady) {
      sessionReady = startSession(localStorage.getItem(LS_SESSION)).catch((e) => {
        sessionReady = null;
        throw e;
      });
    }
    await sessionReady;
    return state.sessionId;
  }

  async function startSession(sessionId) {
    const data = await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionId || undefined, accountId: state.accountId || undefined }),
    });
    state.sessionId = data.sessionId;
    localStorage.setItem(LS_SESSION, state.sessionId);
    renderSession(data.state);
    loadHistorySessions();
  }

  el.newChat.addEventListener('click', async () => {
    el.msgs.innerHTML = '';
    state.seen.clear();
    state.deploy = null;
    stopPolling();
    await startSession(null);
    el.input.focus();
  });

  function renderSession(s) {
    if (!s) return;
    el.msgs.innerHTML = '';
    state.seen.clear();
    for (const m of s.messages || []) {
      if (m.kind === 'text') renderText(m);
      else if (m.kind === 'card' && m.card) {
        if (m.id) state.seen.add(m.id);
        renderCard(m.card);
      } else if (m.kind === 'tool') {
        toolChip(m);
      }
    }
    applyState({ mode: s.mode, stage: s.stage, deploy: s.deploy, account: s.account });
    loadFiles();
    if (s.deploy) {
      state.lastEvent = 0;
      startPolling();
    }
  }

  function applyState(s) {
    if (!s) return;
    if (s.account) {
      state.account = s.account;
      state.plan = s.account.plan || null;
      state.accountId = s.account.id;
      renderAccount();
    }
    if (s.deploy !== undefined) updateDeploy(s.deploy);
    if (s.autoFix !== undefined) {
      state.autoFix = !!s.autoFix;
      renderAutoFix();
    }
    if (s.mode) el.status.dataset.mode = s.mode;
  }

  function renderAutoFix() {
    if (!el.autoFixBtn) return;
    el.autoFixBtn.textContent = `رفع خودکار: ${state.autoFix ? 'روشن' : 'خاموش'}`;
    el.autoFixBtn.classList.toggle('on', !!state.autoFix);
  }

  if (el.autoFixBtn) {
    el.autoFixBtn.onclick = () => {
      const next = !state.autoFix;
      state.autoFix = next;
      renderAutoFix();
      act('auto_fix_toggle', { value: next });
    };
  }

  /* ---------------- پیام‌ها ---------------- */

  function renderText(msg) {
    if (msg.id && state.seen.has(msg.id)) return;
    if (msg.role === 'user' && state.pendingUser && state.pendingUser.text === msg.text) {
      if (msg.id) state.seen.add(msg.id);
      state.pendingUser = null;
      return;
    }
    if (msg.id) state.seen.add(msg.id);
    hideLiveActivity();
    const wrap = document.createElement('div');
    const isUser = msg.role === 'user';
    wrap.className = 'msg ' + (isUser ? 'user' : 'lia');
    wrap.innerHTML = `
      <div class="msg-header">
        <div class="avatar">
          ${
            isUser
              ? '<span class="avatar-icon">👤</span>'
              : '<img src="/widget/assets/lia/avatar.webp" alt="لیا" class="msg-avatar-pic" width="34" height="34" style="width:34px;height:34px;max-width:34px;max-height:34px;border-radius:50%;object-fit:cover;flex:0 0 34px;display:block;" />'
          }
          <span class="avatar-name">${isUser ? 'شما' : 'لیا'}</span>
          ${!isUser ? '<span class="avatar-tag">دستیار هوشمند ابری</span>' : ''}
        </div>
      </div>
      <div class="bubble">${md(msg.text)}</div>
    `;
    el.msgs.appendChild(wrap);
    scrollEnd();
  }

  function addUserBubble(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    wrap.innerHTML = `
      <div class="msg-header">
        <div class="avatar">
          <span class="avatar-icon">👤</span>
          <span class="avatar-name">شما</span>
        </div>
      </div>
      <div class="bubble">${md(text)}</div>
    `;
    el.msgs.appendChild(wrap);
    scrollEnd();
  }

  const CARD_POSE_MAP = {
    chips: 'welcome',
    repair: 'working',
    repair_result: 'success',
    modes: 'idea',
    plan: 'idea',
    step: 'planning',
    analysis: 'analyzing',
    intake: 'waiting',
    approval: 'waiting',
    bug: 'error',
    deploy_plan: 'planning',
    reuse: 'idea',
    tool_approval: 'warning',
    ask: 'waiting',
    suitability: 'planning',
    adaptation_result: 'success',
    summary: 'done',
  };

  function renderCard(card) {
    hideLiveActivity();
    const wrap = document.createElement('div');
    wrap.className = 'msg lia card-msg';
    const box = document.createElement('div');
    box.className = 'card';
    wrap.appendChild(box);
    el.msgs.appendChild(wrap);

    const pose = CARD_POSE_MAP[card.kind] || 'idea';
    if (card.kind === 'analysis') {
      setHero({ pose: 'analyzing', title: `پروژهٔ ${card.platform || ''} تحلیل شد`, sub: 'آماده برای برنامه‌ریزی و استقرار', percent: 55, stage: 'تحلیل کامل شد' });
    } else if (card.kind === 'plan') {
      setHero({ pose: 'idea', title: `پیشنهاد پلن ${card.planName || ''}`, sub: 'منابع بهینه بر اساس ساختار پروژه شما', percent: null });
    } else if (card.kind === 'approval' || card.kind === 'tool_approval' || card.kind === 'ask') {
      setHero({ pose: 'waiting', title: 'منتظر تأیید یا پاسخ شما هستم', sub: card.title || 'یک تصمیم برای ادامه نیاز است', percent: null });
    } else if (card.kind === 'bug' || card.kind === 'repair') {
      setHero({ pose: 'error', title: 'خطا شناسایی شد — آماده رفع خودکار', sub: card.stepTitle || 'دیباگ هوشمند لیا', percent: null });
    } else if (card.kind === 'summary') {
      setHero({ pose: 'done', title: 'استقرار با موفقیت به پایان رسید 🎉', sub: card.summary?.url || 'اپلیکیشن شما آنلاین است', percent: 100, stage: 'تکمیل شد' });
    }

    const build = CARD_BUILDERS[card.kind];
    if (build) build(box, card, pose);
    else box.innerHTML = `<h4>${esc(card.title || card.kind)}</h4><div class="sub">${esc(JSON.stringify(card).slice(0, 300))}</div>`;
    scrollEnd();
    return box;
  }

  const CARD_BUILDERS = {
    chips(box, card, pose = 'welcome') {
      box.innerHTML = `
        <div class="card-head-with-pose">
          ${cardPoseHtml(pose, 'پیشنهاد شروع')}
          <div class="card-head-body">
            <div class="card-head">
              <h4><span class="card-head-icon">⚡</span> ${esc(card.title || 'از کجا شروع کنیم؟')}</h4>
            </div>
            <div class="sub">یکی از گزینه‌های زیر را انتخاب کن یا درخواستت را بنویس:</div>
          </div>
        </div>
        <div class="card-chips"></div>
      `;
      const row = box.querySelector('.card-chips');
      for (const item of card.items || []) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.innerHTML = `<span class="chip-spark">›</span> <span>${esc(item.label)}</span>`;
        b.onclick = () =>
          item.action === 'answer' || item.action === 'chat_send' ? send(item.value || item.label) : act(item.action, { value: item.value });
        row.appendChild(b);
      }
    },

    /* دیباگ خودکار: ایجنت وارد عمل شده */
    repair(box, card) {
      const findings = (card.findings || [])
        .map(
          (f) => `<div class="sub"><b style="color:var(--text)">${esc(f.title)}</b> — ${esc(f.detail || '')}</div>`,
        )
        .join('');
      const patches = (card.patches || [])
        .map(
          (p) =>
            `<div class="sub">${p.kind === 'file' ? '✎' : p.kind === 'command' ? '▶' : '↻'} <b style="color:var(--text)">${esc(p.title)}</b>` +
            `${p.path ? ` <code>${esc(p.path)}</code>` : ''}${p.detail ? ` — ${esc(p.detail)}` : ''}</div>`,
        )
        .join('');
      box.innerHTML = `
        <div class="step-num">دیباگ خودکار</div>
        <h4>«${esc(card.stepTitle || 'مرحلهٔ دیپلوی')}» شکست خورد</h4>
        ${card.error ? `<pre class="pre" style="max-height:120px;overflow:auto">${esc(String(card.error).slice(0, 600))}</pre>` : ''}
        ${findings}
        ${patches ? `<div class="sub" style="color:var(--accent-2)">تغییرهای پیشنهادی:</div>${patches}` : ''}
        <div class="btns">
          ${(card.patches || []).length ? '<button class="btn primary" data-autofix>اعمال کن و دوباره تلاش کن</button>' : ''}
          <button class="btn ghost" data-retry>فقط دوباره تلاش کن</button>
          <button class="btn ghost" data-explain>توضیح کامل</button>
        </div>`;
      box.querySelector('[data-autofix]')?.addEventListener('click', () =>
        act('deploy_autofix', { runId: card.runId, stepId: card.stepId }),
      );
      box.querySelector('[data-retry]').onclick = () => act('deploy_autofix', { runId: card.runId, stepId: card.stepId, retryOnly: true });
      box.querySelector('[data-explain]').onclick = () => send('این خطای دیپلوی را کامل توضیح بده و بگو چه کار کنم');
    },

    repair_result(box, card) {
      const rows = (card.applied || [])
        .map((a) =>
          a.kind === 'file'
            ? `<div class="sub">${a.created ? '＋' : '✎'} <code>${esc(a.path)}</code>${a.changedLines ? ` — ${fmt(a.changedLines)} خط` : ''}</div>`
            : `<div class="sub">${a.code === 0 ? '✓' : '✗'} <code>${esc(a.command)}</code></div>`,
        )
        .join('');
      box.innerHTML = `
        <h4>${(card.errors || []).length ? 'رفع ناقص ماند' : '✓ رفع اعمال شد'}</h4>
        ${rows || '<div class="sub">تغییری روی فایل‌ها لازم نبود.</div>'}
        ${(card.errors || []).length ? `<div class="sub">${esc(card.errors.join('، '))}</div>` : ''}
        <div class="sub">مرحله دوباره اجرا می‌شود.</div>`;
    },

    modes(box, card) {
      box.innerHTML = `<h4>${esc(card.title || '')}</h4><div class="btns" style="flex-direction:column"></div>`;
      const wrap = box.querySelector('.btns');
      for (const opt of card.options || []) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.style.cssText = 'text-align:right;display:flex;gap:10px;padding:10px 12px';
        b.innerHTML = `<span style="font-size:17px">${esc(opt.icon || '•')}</span><span><b>${esc(opt.title)}</b><br><span class="sub">${esc(opt.desc)}</span></span>`;
        b.onclick = () => act(opt.action, { value: opt.value });
        wrap.appendChild(b);
      }
    },

    plan(box, card, pose = 'idea') {
      const c = card.cost || {};
      const s = card.specs || {};
      box.innerHTML = `
        <div class="card-head-with-pose">
          ${cardPoseHtml(pose, 'پیشنهاد پلن')}
          <div class="card-head-body">
            <h4>${esc(card.title || 'پیشنهاد پلن')}</h4>
            <div class="price">${esc(card.planName)} — ${fmt(c.monthlyTotal)} <small>/ ماه</small></div>
          </div>
        </div>
        <div class="specs"><span>RAM ${esc(s.ram)}GB</span><span>${esc(s.vcpu)} vCPU</span><span>دیسک ${esc(s.disk)}GB</span></div>
        <div class="sub">جمع ${fmt(c.months)} ماه: <b style="color:var(--accent-2)">${fmt(c.periodTotal)} تومان</b></div>
        <div class="btns">
          <button class="btn primary" data-buy>خرید و فعال‌سازی</button>
          <button class="btn ghost" data-got>پلن را دارم</button>
        </div>`;
      box.querySelector('[data-buy]').onclick = () => openCheckout();
      box.querySelector('[data-got]').onclick = () => act('purchased', {});
    },

    step(box, card) {
      const st = card.step || {};
      box.innerHTML = `
        <div class="sub">مرحلهٔ ${fmt((st.index || 0) + 1)} از ${fmt(st.total || 0)}</div>
        <h4>${esc(st.title)}</h4>
        <div class="sub">${esc(st.action)}</div>
        <div class="sub" style="color:var(--warn)">چرا: ${esc(st.why || '')}</div>
        <div class="btns"><a class="btn ghost" href="${esc(st.route || '/')}" target="_blank" rel="noopener">برو به این صفحه</a></div>`;
    },

    analysis(box, card, pose = 'analyzing') {
      const findings = card.findings || [];
      box.innerHTML = `
        <div class="card-head-with-pose">
          ${cardPoseHtml(pose, 'تحلیل پروژه')}
          <div class="card-head-body">
            <h4>پروژه را خواندم و تحلیل کردم</h4>
            <div class="specs">
              <span>پلتفرم ${esc(card.platform)}</span>
              <span>${fmt(card.stats?.fileCount)} فایل</span>
              ${card.port ? `<span>پورت ${esc(card.port)}</span>` : ''}
            </div>
          </div>
        </div>
        ${card.build ? `<div class="sub">build: <code>${esc(card.build)}</code></div>` : ''}
        ${findings.length ? '<div class="sub" style="margin-top:8px">نکته‌ها:</div>' : ''}
        <div>${findings
          .slice(0, 6)
          .map((f) => `<div style="display:flex;gap:7px;margin-top:5px"><span class="verdict ${esc(f.severity)}">${f.severity === 'high' ? 'مهم' : f.severity === 'medium' ? 'متوسط' : 'کم'}</span><span class="sub">${esc(f.title)}</span></div>`)
          .join('')}</div>
        <div class="btns"><button class="btn primary" data-deploy>شروع دیپلوی با تأیید من</button></div>`;
      box.querySelector('[data-deploy]').onclick = () => act('start_deploy', {});
    },

    intake(box, card) {
      box.innerHTML = `<h4>${esc(card.title || 'سورس پروژه')}</h4><div class="sub">${esc(card.hint || '')}</div>
        <div class="btns"><button class="btn primary" data-up>انتخاب فایل zip</button></div>`;
      box.querySelector('[data-up]').onclick = () => el.fileInput.click();
    },

    approval(box, card, pose = 'waiting') {
      const a = card.approval || {};
      // کارت‌های تأیید قبلی دیگر معتبر نیستند؛ دکمه‌هایشان خاموش شود
      lockApprovalButtons();
      box.innerHTML = `
        <div class="card-head-with-pose">
          ${cardPoseHtml(pose, 'منتظر تأیید')}
          <div class="card-head-body">
            <div class="sub">مرحلهٔ ${fmt((a.index || 0) + 1)} از ${fmt(a.total || 0)}</div>
            <h4>${esc(a.title)}</h4>
            <div class="sub">${esc(a.detail)}</div>
          </div>
        </div>
        <div class="sub" style="color:var(--warn)">اثر: ${esc(a.effect)}</div>
        <div class="btns">
          <button class="btn primary" data-yes>انجام بده</button>
          <button class="btn danger" data-no>نه</button>
          <button class="btn ghost" data-stop>فقط تا اینجا</button>
        </div>`;
      const yes = box.querySelector('[data-yes]');
      const no = box.querySelector('[data-no]');
      const stop = box.querySelector('[data-stop]');
      const lock = (label) => {
        for (const b of [yes, no, stop]) {
          b.disabled = true;
          b.style.opacity = '0.55';
          b.style.cursor = 'default';
        }
        if (label) yes.textContent = label;
      };
      yes.onclick = () => {
        lock('در حال اجرا…');
        act('approve', { stepId: a.stepId, title: a.title });
      };
      no.onclick = () => {
        lock('متوقف شد');
        act('reject', { stepId: a.stepId, title: a.title });
      };
      stop.onclick = () => {
        lock('متوقف شد');
        act('stop', {});
      };
    },

    bug(box, card) {
      const b = card.bug || {};
      box.innerHTML = `
        <h4>${esc(b.title || 'مشکل در بیلد')}</h4>
        <div class="sub">${esc(b.reason || '')}</div>
        ${(b.findings || [])
          .map(
            (f) => `<div style="border:1px solid var(--line);border-radius:9px;padding:8px 10px;margin-top:7px">
              <b style="font-size:12.5px">${esc(f.title)}</b>
              <div class="sub">${esc(f.detail)}</div>
              ${f.fix ? `<div class="sub" style="color:var(--accent-2)">راه‌حل: ${esc(f.fix)}</div>` : ''}
            </div>`,
          )
          .join('')}
        <div class="btns">
          <button class="btn primary" data-fix>${b.retryable ? 'تلاش دوباره' : 'رفعش کن'}</button>
          <button class="btn ghost" data-skip>${b.retryable ? 'رد شو و ادامه بده' : 'فقط گزارش بده'}</button>
        </div>`;
      box.querySelector('[data-fix]').onclick = () => act('fix', { accept: true });
      box.querySelector('[data-skip]').onclick = () => act('fix', { accept: false });
    },

    deploy_plan(box, card) {
      const skipped = (card.skipped || []).map((s) => `<div class="sub">— ${esc(s.title)}: ${esc(s.why || 'لازم نیست')}</div>`).join('');
      box.innerHTML = `<h4>${card.reused ? 'نقشهٔ دیپلوی مجدد' : 'نقشهٔ دیپلوی'}</h4>
        <div class="sub"><code>${esc(card.appName)}</code> — ${fmt((card.steps || []).length)} مرحله${card.reused ? ' · بدون آپلود دوباره' : ''}</div>
        <div class="steps">${(card.steps || []).map((s) => `<span>${esc(s.title)}</span>`).join('')}</div>
        ${skipped ? `<div class="sub" style="margin-top:8px;color:var(--muted)">لازم نیست:</div>${skipped}` : ''}
        ${(card.notes || []).length ? `<div class="sub" style="color:var(--warn)">${esc(card.notes.join('، '))}</div>` : ''}`;
    },

    /* همین پروژه قبلاً دیپلوی شده — بدون آپلود دوباره */
    reuse(box, card) {
      const when = card.deployedAt ? new Date(card.deployedAt).toLocaleString('fa-IR') : '';
      box.innerHTML = `
        <div class="sub" style="color:var(--accent-2)">پروژهٔ آشنا</div>
        <h4>این پروژه قبلاً دیپلوی شده</h4>
        <div class="sub"><code>${esc(card.appName)}</code>${when ? ` — آخرین دیپلوی ${esc(when)}` : ''}
          ${card.url ? `<br>${esc(card.url)}` : ''}</div>
        <div class="sub">لازم نیست دوباره zip بفرستی.</div>
        <div class="btns">
          <button class="btn primary" data-redeploy>همین را دوباره دیپلوی کن</button>
          <button class="btn ghost" data-fresh>فایل تازه می‌فرستم</button>
        </div>`;
      box.querySelector('[data-redeploy]').onclick = () => act('redeploy', { appName: card.appName });
      box.querySelector('[data-fresh]').onclick = () => act('reuse_skip', {});
    },

    tool_approval(box, card) {
      const diff = String(card.diff || '');
      const lines = diff
        .split('\n')
        .slice(0, 60)
        .map((l) => `<div class="${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}">${esc(l)}</div>`)
        .join('');
      box.innerHTML = `
        <div class="sub" style="color:var(--warn)">ایجنت لیا · نیاز به اجازه</div>
        <h4>${esc(card.title || card.toolLabel || card.tool)}</h4>
        ${card.reason ? `<div class="sub">${esc(card.reason)}</div>` : ''}
        ${card.impact ? `<div class="sub">اثر: ${esc(card.impact)}</div>` : ''}
        ${diff ? `<div class="diff">${lines}</div>` : ''}
        <div class="btns">
          <button class="btn primary" data-yes>اجازه بده و اعمال کن</button>
          <button class="btn danger" data-no>نه، اعمال نکن</button>
        </div>`;
      box.querySelector('[data-yes]').onclick = () => act('agent_approve', {});
      box.querySelector('[data-no]').onclick = () => act('agent_deny', {});
    },

    /* فرم چندسؤالی: کاربر همه را جواب می‌دهد و یک‌جا می‌فرستد */
    ask(box, card) {
      box.classList.add('ask');
      const answers = {};
      const questions = card.questions || [];
      box.innerHTML = `
        <h4>${esc(card.title || 'چند سؤال کوتاه')}</h4>
        ${card.intro ? `<div class="sub">${esc(card.intro)}</div>` : ''}
        <div data-qs></div>
        <div class="btns"><button class="btn primary" data-submit>ارسال پاسخ‌ها</button></div>`;
      const qs = box.querySelector('[data-qs]');

      for (const q of questions) {
        const wrap = document.createElement('div');
        wrap.className = 'q';
        wrap.dataset.qid = q.id;
        const label = `<div class="q-label">${esc(q.label)}${q.required ? ' *' : ''}</div>`;

        if (q.type === 'choice' && q.options?.length) {
          wrap.innerHTML = label + '<div class="q-opts"></div>';
          const opts = wrap.querySelector('.q-opts');
          for (const o of q.options) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'opt';
            b.textContent = o.label;
            b.onclick = () => {
              answers[q.id] = o.value;
              opts.querySelectorAll('.opt').forEach((x) => x.classList.toggle('on', x === b));
            };
            opts.appendChild(b);
          }
        } else if (q.type === 'confirm') {
          wrap.innerHTML = label + '<div class="q-opts"></div>';
          const opts = wrap.querySelector('.q-opts');
          [
            ['بله', 'بله'],
            ['نه', 'نه'],
          ].forEach(([text, value]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'opt';
            b.textContent = text;
            b.onclick = () => {
              answers[q.id] = value;
              opts.querySelectorAll('.opt').forEach((x) => x.classList.toggle('on', x === b));
            };
            opts.appendChild(b);
          });
        } else {
          wrap.innerHTML = label;
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = q.placeholder || '';
          inp.oninput = () => {
            answers[q.id] = inp.value.trim();
            inp.classList.remove('bad');
          };
          wrap.appendChild(inp);
        }
        qs.appendChild(wrap);
      }

      const submit = box.querySelector('[data-submit]');
      submit.onclick = () => {
        const missing = questions.filter((q) => q.required && !String(answers[q.id] || '').trim());
        if (missing.length) {
          for (const q of missing) {
            const node = box.querySelector(`[data-qid="${q.id}"] input`);
            if (node) node.classList.add('bad');
          }
          toast('این سؤال‌ها هنوز جواب ندارند: ' + missing.map((q) => q.label).join('، '));
          return;
        }
        box.querySelectorAll('button, input').forEach((n) => (n.disabled = true));
        submit.textContent = 'ارسال شد ✓';
        act('ask_answer', { askId: card.askId, answers });
      };
    },

    suitability(box, card) {
      box.innerHTML = `
        <h4>${card.suitable ? 'برای هاست وب مناسب است' : 'برای هاست وب مناسب نیست'}</h4>
        <div class="sub">${esc(card.summary || '')}</div>
        ${(card.reasons || []).map((r) => `<div class="sub" style="color:var(--warn)">• ${esc(r.title)} — ${esc(r.detail || '')}</div>`).join('')}
        ${(card.adaptations || []).length ? `<div class="sub" style="margin-top:6px">تغییرهای پیشنهادی: ${card.adaptations.map((a) => esc(a.title)).join('، ')}</div>` : ''}
        <div class="btns">
          ${card.canAdapt ? '<button class="btn primary" data-apply>مناسبش کن</button>' : ''}
          <button class="btn ghost" data-skip>${card.suitable ? 'دست نزن' : 'نه، دست نزن'}</button>
        </div>`;
      const apply = box.querySelector('[data-apply]');
      if (apply) apply.onclick = () => act('suitability_apply', {});
      box.querySelector('[data-skip]').onclick = () => act('suitability_skip', {});
    },

    adaptation_result(box, card) {
      box.innerHTML = `<h4>تغییرهای اعمال‌شده</h4>
        <div class="sub">${(card.files || []).map((f) => `<code>${esc(f.path)}</code>`).join(' ')}</div>`;
    },

    summary(box, card) {
      const s = card.summary || {};
      const abs = s.url ? (s.url.startsWith('http') ? s.url : location.origin + s.url) : '';
      const urlLine = !s.url
        ? ''
        : s.simulated
          ? `<div class="sub" style="color:var(--warn)">آدرس شبیه‌سازی‌شده: <code>${esc(s.url)}</code> — اپ واقعی ساخته نشده</div>`
          : `<div class="sub">پیش‌نمایش: <a href="${esc(abs)}" target="_blank" rel="noopener">${esc(abs)}</a></div>`;
      const ok = s.status === 'success' || s.status === 'success_after_fix' || s.status === 'success_with_warnings';
      box.innerHTML = `<h4>${ok ? 'دیپلوی انجام شد' : 'خلاصه'}</h4>
        ${urlLine}
        <div class="sub">مرحله‌های انجام‌شده: ${fmt(s.steps)}</div>
        ${(s.warnings || []).map((w) => `<div class="sub" style="color:var(--warn)">• ${esc(w)}</div>`).join('')}
        ${s.stoppedAt ? `<div class="sub">توقف در: ${esc(s.stoppedAt)}</div>` : ''}
        <div class="btns">
          ${abs && ok && !s.simulated ? `<a class="btn primary" href="${esc(abs)}" target="_blank" rel="noopener">باز کردن اپ</a>` : ''}
          ${abs && ok && !s.simulated ? `<button class="btn danger" data-stopapp>توقف اپ</button>` : ''}
          <button class="btn ghost" data-again>شروع دوباره</button>
        </div>`;
      const stopBtn = box.querySelector('[data-stopapp]');
      if (stopBtn) stopBtn.onclick = async () => {
        const name = s.appName;
        if (!name) return;
        stopBtn.disabled = true;
        try {
          await fetch(`${API}/api/apps/${encodeURIComponent(name)}/stop`, { method: 'POST' });
          toast('اپ متوقف شد');
        } catch {
          toast('توقف ناموفق بود');
        }
      };
      box.querySelector('[data-again]').onclick = () => act('restart', {});
    },
  };

  /* ---------------- ابزارها ---------------- */

  function toolChip(ev) {
    if (ev.status === 'start') {
      const chip = document.createElement('div');
      chip.className = 'tool';
      chip.innerHTML = `<span class="spin"></span><span>${esc(ev.label || ev.name)}…</span>`;
      el.msgs.appendChild(chip);
      state.toolChips.set(ev.name, chip);
      heroFromTool(ev);
      scrollEnd();
      return;
    }
    let chip = state.toolChips.get(ev.name);
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'tool';
      el.msgs.appendChild(chip);
    }
    heroFromTool(ev);
    chip.classList.add(ev.status === 'error' ? 'error' : 'done');
    chip.innerHTML = `<span class="spin"></span><span>${esc(ev.label || ev.name)}</span>${ev.summary ? `<span style="opacity:.7">— ${esc(ev.summary)}</span>` : ''}`;
    scrollEnd();
    if (['write_file', 'run_command'].includes(ev.name) && ev.status === 'done') setTimeout(loadFiles, 400);
  }

  /* ---------------- ارسال ---------------- */

  function handleEvent(ev) {
    switch (ev.t) {
      case 'meta':
        if (ev.mode) el.status.dataset.mode = ev.mode;
        break;
      case 'msg':
        if (ev.msg?.kind === 'text') renderText(ev.msg);
        else if (ev.msg?.card) {
          if (ev.msg.id) state.seen.add(ev.msg.id);
          renderCard(ev.msg.card);
        }
        break;
      case 'tool':
        toolChip(ev);
        break;
      case 'state':
        applyState(ev.state);
        break;
      case 'typing':
        if (ev.on) {
          el.status.textContent = 'لیا دارد فکر می‌کند…';
          setHero({
            pose: 'thinking',
            title: 'لیا دارد فکر می‌کند…',
            sub: 'در حال بررسی درخواست و انتخاب بهترین اقدام',
            percent: 20,
            stage: 'پردازش هوشمند',
          });
          showLiveActivity({
            pose: 'thinking',
            title: 'لیا دارد فکر می‌کند…',
            sub: 'در حال تحلیل و آماده‌سازی پاسخ',
          });
        } else {
          hideLiveActivity();
          // وضعیت هدر به حالت عادی برگردد (قبلاً روی «در حال فکر کردن» گیر می‌کرد)
          if (state.modelLabel) {
            el.status.textContent = state.modelLabel;
            el.status.className = 'status ok';
          }
        }
        break;
      case 'navigate':
        if (ev.url) window.open(ev.url, '_blank');
        break;
      case 'error':
        hideLiveActivity();
        setHero({ pose: 'error', title: 'خطا در اجرای عملیات', sub: ev.message || 'خطایی رخ داد', percent: null });
        toast(ev.message || 'خطا');
        break;
      default:
        break;
    }
  }

  async function send(text) {
    const value = String(text || '').trim();
    if (!value || state.busy) return;
    state.busy = true;
    el.send.disabled = true;
    addUserBubble(value);
    state.pendingUser = { text: value };
    el.input.value = '';
    el.input.style.height = 'auto';

    setHero({
      pose: 'thinking',
      title: 'در حال بررسی پیام شما…',
      sub: value.slice(0, 70),
      percent: 15,
      stage: 'دریافت پیام',
    });
    showLiveActivity({
      pose: 'thinking',
      title: 'لیا در حال بررسی پیام شماست…',
      sub: value.slice(0, 65),
    });

    try {
      await ensureSession();
      await sse('/api/chat', { sessionId: state.sessionId, text: value }, handleEvent);
    } catch (err) {
      setHero({ pose: 'error', title: 'ارتباط با سرور برقرار نشد', sub: err.message, percent: null });
      toast('ارتباط با سرور برقرار نشد: ' + err.message);
    } finally {
      hideLiveActivity();
      state.busy = false;
      state.pendingUser = null;
      el.send.disabled = false;
      if (el.liaHero?.dataset.pose === 'thinking') {
        setHero({
          pose: 'success',
          title: 'پاسخ آماده شد ✓',
          sub: 'می‌توانید ادامه دهید یا مرحلهٔ بعد را انتخاب کنید.',
          percent: null,
        });
      }
      startPolling();
      loadHistorySessions();
    }
  }

  /** دکمه‌های کارت‌های تأیید قدیمی را خاموش می‌کند */
  function lockApprovalButtons() {
    for (const b of document.querySelectorAll('.card [data-yes], .card [data-no], .card [data-stop]')) {
      b.disabled = true;
      b.style.opacity = '0.5';
      b.style.cursor = 'default';
    }
  }

  /**
   * اگر یک درخواست به هر دلیلی معلق بماند، قفل صفحه برای همیشه نمی‌ماند.
   */
  function armBusyWatchdog() {
    clearTimeout(state.busyTimer);
    state.busyTimer = setTimeout(() => {
      if (state.busy) {
        hideLiveActivity();
        state.busy = false;
        el.send.disabled = false;
        toast('درخواست قبلی طولانی شد؛ صفحه آزاد شد. اگر مرحله انجام نشد دوباره بزن.');
        startPolling();
      }
    }, 25_000);
  }

  async function act(name, payload = {}) {
    if (state.busy) {
      toast('یک کار در جریان است؛ چند لحظه صبر کن.');
      return;
    }
    try {
      await ensureSession();
    } catch {
      toast('اتصال به سرور برقرار نشد؛ یک‌بار دیگر تلاش کن.');
      return;
    }
    state.busy = true;
    armBusyWatchdog();
    el.send.disabled = true;
    const poseByAction = {
      start_deploy: 'deploying',
      redeploy: 'deploying',
      approve: 'deploying',
      deploy_autofix: 'working',
      fix: 'working',
      suitability_apply: 'working',
    };
    const nextPose = poseByAction[name] || 'working';
    setHero({
      pose: nextPose,
      title: nextPose === 'deploying' ? 'در حال اجرای مراحل استقرار…' : 'در حال انجام عملیات…',
      sub: payload.title || name,
      percent: nextPose === 'deploying' ? 40 : 30,
      stage: payload.title || 'اجرای دستور',
    });
    showLiveActivity({
      pose: nextPose,
      title: nextPose === 'deploying' ? 'لیا در حال استقرار پروژه است…' : 'لیا در حال انجام عملیات…',
      sub: payload.title || name,
    });
    try {
      await sse('/api/action', { sessionId: state.sessionId, action: name, payload }, handleEvent);
    } catch (err) {
      toast(err.message);
    } finally {
      hideLiveActivity();
      state.busy = false;
      clearTimeout(state.busyTimer);
      el.send.disabled = false;
      startPolling();
      setTimeout(loadFiles, 500);
    }
  }

  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    send(el.input.value);
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(el.input.value);
    }
  });
  el.input.addEventListener('input', () => {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(180, el.input.scrollHeight) + 'px';
  });

  /* ---------------- تب‌ها (Tabs Navigation) ---------------- */

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    const target = $('view' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
    if (target) target.classList.add('active');

    if (tabName === 'editor') {
      if (state.currentFile) updateGutter();
    }
    if (tabName === 'logs' && el.systemLogsTerminal) {
      el.systemLogsTerminal.scrollTop = el.systemLogsTerminal.scrollHeight;
    }
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  if (el.openEditorBtn) {
    el.openEditorBtn.addEventListener('click', () => {
      if (!state.currentFile && state.allFiles.length) {
        openFileInEditor(state.allFiles[0]);
      } else {
        switchTab('editor');
      }
    });
  }

  if (el.goToPreviewTabBtn) {
    el.goToPreviewTabBtn.addEventListener('click', () => switchTab('preview'));
  }

  /* ---------------- مدیریت فایل‌ها و استودیوی کد ---------------- */

  function getFileIcon(path) {
    const ext = path.split('.').pop().toLowerCase();
    if (['js', 'mjs', 'cjs'].includes(ext)) return '🟨';
    if (['ts', 'tsx'].includes(ext)) return '🔷';
    if (['jsx'].includes(ext)) return '⚛️';
    if (['json'].includes(ext)) return '📋';
    if (['html'].includes(ext)) return '🌐';
    if (['css'].includes(ext)) return '🎨';
    if (['py'].includes(ext)) return '🐍';
    if (['php'].includes(ext)) return '🐘';
    if (['md'].includes(ext)) return '📝';
    return '📄';
  }

  function getFileLang(path) {
    const ext = path.split('.').pop().toLowerCase();
    const map = {
      js: 'JAVASCRIPT', mjs: 'JAVASCRIPT', ts: 'TYPESCRIPT', tsx: 'REACT TSX',
      jsx: 'REACT JSX', json: 'JSON', html: 'HTML', css: 'CSS', py: 'PYTHON',
      php: 'PHP', md: 'MARKDOWN', sh: 'SHELL'
    };
    return map[ext] || ext.toUpperCase();
  }

  async function loadFiles() {
    if (!state.sessionId) return;
    try {
      const data = await api(`/api/project/${encodeURIComponent(state.sessionId)}/tree`);
      state.allFiles = (data.files || []).slice(0, 500);
      renderFileList(state.allFiles);
      if (state.allFiles.length) {
        el.download.href = `/api/project/${encodeURIComponent(state.sessionId)}/download`;
        el.download.classList.remove('disabled');
      } else {
        el.download.classList.add('disabled');
      }
    } catch {
      /* ignore */
    }
  }

  function renderFileList(files) {
    if (!files.length) {
      el.files.innerHTML = '<div class="empty">هنوز پروژه‌ای آپلود نشده است</div>';
      return;
    }
    const query = (el.fileSearch?.value || '').toLowerCase().trim();
    const filtered = query ? files.filter((p) => p.toLowerCase().includes(query)) : files;

    if (!filtered.length) {
      el.files.innerHTML = '<div class="empty">فایلی مطابق جستجو پیدا نشد</div>';
      return;
    }

    el.files.innerHTML = filtered
      .map((p) => {
        const isActive = state.currentFile && state.currentFile.path === p;
        return `<div class="row ${isActive ? 'active' : ''}" data-path="${esc(p)}" title="${esc(p)}">
          <span class="icon">${getFileIcon(p)}</span>
          <span class="path">${esc(p)}</span>
        </div>`;
      })
      .join('');

    el.files.querySelectorAll('.row').forEach((row) => {
      row.onclick = () => openFileInEditor(row.dataset.path);
    });
  }

  if (el.fileSearch) {
    el.fileSearch.addEventListener('input', () => renderFileList(state.allFiles));
  }

  async function openFileInEditor(filePath) {
    try {
      const data = await api(`/api/project/${encodeURIComponent(state.sessionId)}/file?path=${encodeURIComponent(filePath)}`);
      const text = data.file.text || '';
      state.currentFile = {
        path: filePath,
        original: text,
        current: text,
      };

      if (el.editorCurrentPath) el.editorCurrentPath.textContent = filePath;
      if (el.editorFileLang) el.editorFileLang.textContent = getFileLang(filePath);
      if (el.editorActiveBadge) el.editorActiveBadge.hidden = false;
      if (el.editorTextarea) {
        el.editorTextarea.value = text;
        updateGutter();
      }
      if (el.editorSaveBtn) el.editorSaveBtn.disabled = true;

      // هایلایت ردیف انتخاب شده در سایدبار
      el.files.querySelectorAll('.row').forEach((r) => {
        r.classList.toggle('active', r.dataset.path === filePath);
      });

      // نمایش نمای ادیتور و مخفی کردن دیف
      if (el.editorCodeView) el.editorCodeView.hidden = false;
      if (el.editorDiffView) el.editorDiffView.hidden = true;

      switchTab('editor');
    } catch (err) {
      toast('خطا در باز کردن فایل: ' + err.message);
    }
  }

  function updateGutter() {
    if (!el.editorTextarea || !el.editorGutter) return;
    const lines = (el.editorTextarea.value || '').split('\n').length;
    let numbers = '';
    for (let i = 1; i <= lines; i++) numbers += i + '\n';
    el.editorGutter.textContent = numbers;
    if (el.editorFileLines) el.editorFileLines.textContent = `${lines.toLocaleString('fa-IR')} سطر`;
  }

  if (el.editorTextarea) {
    el.editorTextarea.addEventListener('input', () => {
      updateGutter();
      if (state.currentFile) {
        state.currentFile.current = el.editorTextarea.value;
        const changed = state.currentFile.current !== state.currentFile.original;
        if (el.editorSaveBtn) el.editorSaveBtn.disabled = !changed;
      }
    });

    el.editorTextarea.addEventListener('scroll', () => {
      if (el.editorGutter) el.editorGutter.scrollTop = el.editorTextarea.scrollTop;
    });

    // تب‌گذاری با کلید Tab
    el.editorTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = el.editorTextarea.selectionStart;
        const end = el.editorTextarea.selectionEnd;
        el.editorTextarea.value = el.editorTextarea.value.substring(0, start) + '  ' + el.editorTextarea.value.substring(end);
        el.editorTextarea.selectionStart = el.editorTextarea.selectionEnd = start + 2;
        updateGutter();
        if (state.currentFile) {
          state.currentFile.current = el.editorTextarea.value;
          el.editorSaveBtn.disabled = false;
        }
      }
    });
  }

  // دکمه ذخیره فایل
  if (el.editorSaveBtn) {
    el.editorSaveBtn.addEventListener('click', async () => {
      if (!state.currentFile) return;
      el.editorSaveBtn.disabled = true;
      try {
        const res = await fetch(`${API}/api/project/${encodeURIComponent(state.sessionId)}/file`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: state.currentFile.path,
            content: state.currentFile.current,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'خطا در ذخیره');
        state.currentFile.original = state.currentFile.current;
        toast(`✓ فایل ${state.currentFile.path} با موفقیت ذخیره شد. آماده دیپلوی مجدد.`);
        loadFiles();
      } catch (err) {
        toast('ذخیره ناموفق بود: ' + err.message);
        el.editorSaveBtn.disabled = false;
      }
    });
  }

  // نمایش دیف
  function computeLineDiff(original, current) {
    const origLines = (original || '').split('\n');
    const currLines = (current || '').split('\n');
    const result = [];
    let i = 0, j = 0;
    while (i < origLines.length || j < currLines.length) {
      if (i < origLines.length && j < currLines.length) {
        if (origLines[i] === currLines[j]) {
          result.push(`  ${origLines[i]}`);
          i++; j++;
        } else {
          result.push(`- ${origLines[i]}`);
          result.push(`+ ${currLines[j]}`);
          i++; j++;
        }
      } else if (i < origLines.length) {
        result.push(`- ${origLines[i]}`);
        i++;
      } else {
        result.push(`+ ${currLines[j]}`);
        j++;
      }
    }
    return result;
  }

  if (el.editorToggleDiffBtn) {
    el.editorToggleDiffBtn.addEventListener('click', () => {
      if (!state.currentFile) return toast('ابتدا فایلی را باز کنید.');
      const diffView = el.editorDiffView;
      const codeView = el.editorCodeView;
      if (!diffView.hidden) {
        diffView.hidden = true;
        codeView.hidden = false;
        el.editorToggleDiffBtn.textContent = 'نمایش دیف (Diff)';
      } else {
        const diffLines = computeLineDiff(state.currentFile.original, state.currentFile.current);
        if (el.editorDiffContent) {
          el.editorDiffContent.innerHTML = diffLines
            .map((line) => {
              if (line.startsWith('+')) return `<span class="diff-add">${esc(line)}</span>`;
              if (line.startsWith('-')) return `<span class="diff-del">${esc(line)}</span>`;
              return esc(line);
            })
            .join('\n');
        }
        diffView.hidden = false;
        codeView.hidden = true;
        el.editorToggleDiffBtn.textContent = 'بازگشت به کد';
      }
    });
  }

  if (el.editorCloseDiffBtn) {
    el.editorCloseDiffBtn.addEventListener('click', () => {
      if (el.editorDiffView) el.editorDiffView.hidden = true;
      if (el.editorCodeView) el.editorCodeView.hidden = false;
      if (el.editorToggleDiffBtn) el.editorToggleDiffBtn.textContent = 'نمایش دیف (Diff)';
    });
  }

  // ویرایش هوشمند با لیا از داخل ادیتور
  if (el.editorAiApplyBtn && el.editorAiPrompt) {
    el.editorAiApplyBtn.addEventListener('click', () => {
      const prompt = (el.editorAiPrompt.value || '').trim();
      if (!prompt) return toast('لطفاً توضیح تغییر مورد نظرت را بنویس.');
      if (!state.currentFile) return toast('ابتدا یک فایل انتخاب کن.');

      const fullPrompt = `در فایل «${state.currentFile.path}» این تغییر را اعمال کن:\n${prompt}`;
      el.editorAiPrompt.value = '';
      switchTab('chat');
      send(fullPrompt);
    });

    el.editorAiPrompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.editorAiApplyBtn.click();
      }
    });
  }

  // دیپلوی مجدد
  async function triggerRedeploy() {
    if (!state.sessionId) return;
    toast('🚀 دیپلوی مجدد آغاز شد...');
    try {
      const res = await fetch(`${API}/api/project/${encodeURIComponent(state.sessionId)}/redeploy`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دیپلوی مجدد');

      state.lastEvent = 0;
      if (data.runId) {
        state.deploy = { id: data.runId, appName: data.appName, url: data.url, status: data.status, steps: data.steps };
        updateDeploy(state.deploy);
        startPolling();
      }
      addUserBubble('🚀 دیپلوی مجدد پروژه را انجام بده');
      toast('دیپلوی مجدد با موفقیت فراخوانی شد');
    } catch (err) {
      toast('خطا: ' + err.message);
    }
  }

  if (el.editorRedeployBtn) el.editorRedeployBtn.addEventListener('click', triggerRedeploy);
  if (el.quickRedeployBtn) el.quickRedeployBtn.addEventListener('click', triggerRedeploy);

  /* ---------------- پیش‌نمایش زنده اپ (Live Preview Iframe) ---------------- */

  /**
   * پیش‌نمایش زنده فقط وقتی لود می‌شود که اپ واقعاً بالا باشد.
   * قبلاً در هر poll دوباره src ست می‌شد و برای اپ شبیه‌سازی‌شده هم تلاش می‌کرد
   * (سیل 503 و هشدار sandbox در کنسول).
   */
  function showPreviewPlaceholder(text) {
    if (el.previewIframe) {
      el.previewIframe.hidden = true;
      el.previewIframe.removeAttribute('src');
      delete el.previewIframe.dataset.src;
    }
    if (el.previewLiveIndicator) el.previewLiveIndicator.hidden = true;
    if (el.previewEmptyState) {
      el.previewEmptyState.hidden = false;
      const h = el.previewEmptyState.querySelector('h3');
      const p = el.previewEmptyState.querySelector('p');
      if (h) h.textContent = 'پیش‌نمایش در دسترس نیست';
      if (p) p.textContent = text;
    }
  }

  function updateLivePreview(url, appName, { simulated = false, ready = false } = {}) {
    if (!url) return;

    if (simulated) {
      if (el.previewUrlInput) el.previewUrlInput.value = url;
      if (el.previewOpenTabBtn) el.previewOpenTabBtn.href = '#';
      showPreviewPlaceholder('این اجرا شبیه‌سازی است؛ اپی روی لیارا ساخته نشده و پیش‌نمایشی وجود ندارد.');
      return;
    }
    if (!ready) {
      if (el.previewUrlInput) el.previewUrlInput.value = url;
      showPreviewPlaceholder('پیش‌نمایش بعد از پایان موفق دیپلوی فعال می‌شود.');
      return;
    }

    const targetUrl = url.startsWith('/') ? `${location.origin}${url}` : url;
    if (el.previewUrlInput) el.previewUrlInput.value = targetUrl;
    if (el.previewOpenTabBtn) el.previewOpenTabBtn.href = targetUrl;
    if (el.previewEmptyState) el.previewEmptyState.hidden = true;
    if (el.previewLiveIndicator) el.previewLiveIndicator.hidden = false;

    if (el.previewIframe && el.previewIframe.dataset.src !== targetUrl) {
      el.previewIframe.dataset.src = targetUrl;
      el.previewIframe.src = targetUrl;
      el.previewIframe.hidden = false;
    }
  }

  if (el.previewReloadBtn && el.previewIframe) {
    el.previewReloadBtn.addEventListener('click', () => {
      try {
        el.previewIframe.contentWindow?.location?.reload();
      } catch {
        el.previewIframe.src = el.previewIframe.src;
      }
      toast('پیش‌نمایش تازه شد');
    });
  }

  if (el.previewCopyUrlBtn && el.previewUrlInput) {
    el.previewCopyUrlBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(el.previewUrlInput.value).then(() => toast('آدرس کپی شد'));
    });
  }

  // کلیدهای ابعاد ویوپورت
  document.querySelectorAll('.vp-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.vp-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const vp = btn.dataset.vp;
      if (el.previewFrameWrap) {
        el.previewFrameWrap.className = `preview-frame-wrap vp-${vp}`;
      }
    });
  });

  /* ---------------- پروژه‌های نمونه (Samples) ---------------- */

  async function loadSampleProject(sampleName) {
    toast(`در حال بارگذاری پروژه نمونه ${sampleName}…`);
    try {
      const res = await fetch(`/test-projects/dist/${sampleName}.zip`);
      if (!res.ok) throw new Error('فایل نمونه پیدا نشد');
      const blob = await res.blob();
      const file = new File([blob], `${sampleName}.zip`, { type: 'application/zip' });
      await upload(file);
      if (el.samplesDialog) el.samplesDialog.close();
      toast(`✓ پروژه ${sampleName} بارگذاری شد و تحلیل آغاز گردید`);
    } catch (err) {
      toast('خطا در بارگذاری نمونه: ' + err.message);
    }
  }

  // کلیک روی چیپ‌های نمونه در سایدبار
  document.querySelectorAll('.sample-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const sample = chip.dataset.sample;
      if (sample) loadSampleProject(sample);
    });
  });

  if (el.previewStartSampleBtn) {
    el.previewStartSampleBtn.addEventListener('click', () => loadSampleProject('nextjs-shop'));
  }

  // باز کردن مدال نمونه‌ها
  if (el.samplesBtn) {
    el.samplesBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/sample-projects');
        const data = await res.json();
        const list = data.projects || [];
        if (el.samplesListContainer) {
          el.samplesListContainer.innerHTML = list
            .map(
              (p) => `<div class="sample-card" data-sample="${esc(p.name)}">
              <div class="sample-card-head">
                <span class="sample-card-title">${esc(p.label || p.name)}</span>
                <span class="sample-card-meta">${p.files} فایل · ${p.sizeKb}KB</span>
              </div>
              <span class="sample-card-desc">کلیک برای دانلود و استقرار آنی در فضای کاری</span>
            </div>`
            )
            .join('');

          el.samplesListContainer.querySelectorAll('.sample-card').forEach((card) => {
            card.onclick = () => loadSampleProject(card.dataset.sample);
          });
        }
        if (el.samplesDialog) el.samplesDialog.showModal();
      } catch (err) {
        toast('خطا در دریافت لیست نمونه‌ها: ' + err.message);
      }
    });
  }

  if (el.samplesClose && el.samplesDialog) {
    el.samplesClose.addEventListener('click', () => el.samplesDialog.close());
  }

  // چیپ‌های پرامپت سریع در چت
  document.querySelectorAll('.quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt;
      if (prompt) {
        if (el.input) {
          el.input.value = prompt;
          send(prompt);
        }
      }
    });
  });

  /* ---------------- کنسول لاگ‌ها ---------------- */

  function appendLog(line) {
    if (!el.systemLogsTerminal) return;
    const time = new Date().toLocaleTimeString('fa-IR');
    el.systemLogsTerminal.textContent += `[${time}] ${line}\n`;
    el.systemLogsTerminal.scrollTop = el.systemLogsTerminal.scrollHeight;
  }

  if (el.clearLogsBtn) {
    el.clearLogsBtn.addEventListener('click', () => {
      if (el.systemLogsTerminal) el.systemLogsTerminal.textContent = '';
      toast('لاگ‌ها پاک شدند');
    });
  }

  if (el.copyLogsBtn) {
    el.copyLogsBtn.addEventListener('click', () => {
      if (!el.systemLogsTerminal) return;
      navigator.clipboard.writeText(el.systemLogsTerminal.textContent).then(() => toast('لاگ‌ها کپی شدند'));
    });
  }

  /* ---------------- آپلود فایل ---------------- */

  el.uploadBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    const file = el.fileInput.files?.[0];
    if (file) upload(file);
    el.fileInput.value = '';
  });

  async function upload(file) {
    if (!/\.zip$/i.test(file.name)) return toast('فقط فایل zip قبول می‌کنم.');
    if (file.size > 55 * 1024 * 1024) return toast('حجم فایل بیش از ۵۵ مگابایت است.');
    addUserBubble(`📦 ${file.name} (${(file.size / 1048576).toFixed(1)}MB)`);
    appendLog(`آپلود بسته ${file.name} آغاز شد...`);
    try {
      const res = await fetch(`${API}/api/intake?sessionId=${encodeURIComponent(state.sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) return toast(data.error || 'آپلود ناموفق بود');
      for (const ev of data.events || []) handleEvent(ev);
      loadFiles();
      appendLog(`بسته ${file.name} با موفقیت در فضای کاری ذخیره شد.`);
    } catch (err) {
      toast('آپلود ناموفق بود: ' + err.message);
    }
  }

  /* ---------------- دیپلوی و وضعیت ---------------- */

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function updateDeploy(snap) {
    if (!snap) {
      state.deploy = null;
      el.deployPanel.hidden = true;
      if (el.deployAppMeta) el.deployAppMeta.hidden = true;
      return;
    }
    state.deploy = snap;
    el.deployPanel.hidden = false;
    const labels = {
      created: 'آماده',
      running: 'در حال اجرا',
      awaiting_approval: 'منتظر تأیید',
      awaiting_fix: 'منتظر تصمیم',
      stopped: 'متوقف',
      done: 'استقرار یافته (آنلاین)',
      error: 'خطا',
      unknown: 'نامشخص',
    };
    el.deployStatus.textContent = labels[snap.status] || snap.status;
    el.deployStatus.className = 'badge' + (snap.status === 'done' ? '' : snap.status === 'error' ? ' warn' : '');
    const done = (snap.steps || []).filter((s) => s.done).length;
    const total = snap.total || (snap.steps || []).length || 1;
    const pct = Math.round((done / total) * 100);
    el.deployBar.style.width = `${pct}%`;
    el.deploySteps.innerHTML = (snap.steps || [])
      .map((s) => `<span class="${s.done ? 'done' : s.current ? 'cur' : ''}">${esc(s.title)}</span>`)
      .join('');
    el.deployLogs.innerHTML = (snap.logs || [])
      .slice(-30)
      .map((l) => `<div class="${l.level === 'err' ? 'err' : ''}">${esc(l.text)}</div>`)
      .join('');

    // همگام‌سازی انیمیشن کاراکتر لیا با وضعیت استقرار
    const curStep = (snap.steps || []).find((s) => s.current) || (snap.steps || [])[done];
    const heroTasks = (snap.steps || []).map((s) => ({ title: s.title, done: !!s.done, cur: !!s.current }));
    if (snap.status === 'running' || snap.status === 'created') {
      setHero({
        pose: 'deploying',
        title: curStep ? `در حال اجرا: ${curStep.title}` : 'در حال استقرار پروژه…',
        sub: snap.appName ? `اپلیکیشن: ${snap.appName}` : 'ساخت و راه‌اندازی کانتینر',
        percent: pct,
        stage: curStep ? curStep.title : 'استقرار',
        tasks: heroTasks,
      });
    } else if (snap.status === 'awaiting_approval') {
      setHero({
        pose: 'waiting',
        title: 'منتظر اجازهٔ شما برای ادامه استقرار',
        sub: snap.pendingApproval?.title || 'لطفاً کارت تأیید را در گفتگو بررسی کنید',
        percent: pct,
        stage: 'منتظر تأیید',
        tasks: heroTasks,
      });
    } else if (snap.status === 'awaiting_fix' || snap.status === 'error') {
      setHero({
        pose: 'error',
        title: 'خطا در مرحلهٔ استقرار شناسایی شد',
        sub: snap.bug?.title || 'لیا آمادهٔ رفع خودکار مشکل است',
        percent: pct,
        stage: 'نیاز به رفع خطا',
        tasks: heroTasks,
      });
    } else if (snap.status === 'done') {
      setHero({
        pose: 'done',
        title: 'اپلیکیشن با موفقیت مستقر و آنلاین شد!',
        sub: snap.url || snap.appName || 'استقرار کامل شد',
        percent: 100,
        stage: 'آنلاین ✓',
        tasks: heroTasks,
      });
    }

    // ثبت در لاگ‌های ترمینال
    if (snap.logs?.length) {
      const last = snap.logs[snap.logs.length - 1];
      if (last) appendLog(`[${snap.appName || 'deploy'}] ${last.text}`);
    }

    // آدرس و پیش‌نمایش: فقط وقتی اپ واقعاً بالا آمده باشد
    if (snap.url) {
      if (el.deployAppMeta) el.deployAppMeta.hidden = false;
      if (el.deployedUrlLink) {
        el.deployedUrlLink.textContent = snap.url;
        el.deployedUrlLink.href = snap.url;
      }
      const isFakeDomain = /^https?:\/\/[^/]+\.liara\.run\/?$/i.test(String(snap.url));
      const simulated = snap.simulated === true || snap.summary?.simulated === true || isFakeDomain;
      const ready = snap.status === 'done' && snap.summary?.status !== 'failed';
      updateLivePreview(snap.url, snap.appName, { simulated, ready });
    }

    if (snap.status === 'awaiting_approval' && snap.pendingApproval && !state.seen.has('ap-' + snap.pendingApproval.stepId)) {
      state.seen.add('ap-' + snap.pendingApproval.stepId);
      renderCard({ kind: 'approval', approval: snap.pendingApproval });
    }
    if (snap.status === 'awaiting_fix' && snap.bug && !state.seen.has('bug-' + snap.id)) {
      state.seen.add('bug-' + snap.id);
      renderCard({ kind: 'bug', bug: snap.bug });
    }
    // خلاصهٔ پایان دیپلوی
    if (snap.status === 'done' && snap.summary && !state.seen.has('sum-' + snap.id)) {
      state.seen.add('sum-' + snap.id);
      renderCard({ kind: 'summary', summary: { ...snap.summary, appName: snap.appName, url: snap.summary.url || snap.url } });
    }
    if (snap.repair) {
      const key = 'repair-' + (snap.repair.id || `${snap.id}-${snap.repair.stepId}`);
      if (!state.seen.has(key)) {
        state.seen.add(key);
        renderCard(snap.repair);
      }
    }
  }

  function startPolling() {
    if (state.pollTimer || !state.deploy) return;
    state.pollTimer = setInterval(async () => {
      const snap = state.deploy;
      if (!snap?.id) return stopPolling();
      try {
        const res = await fetch(`${API}/api/deploy/${encodeURIComponent(snap.id)}?since=${state.lastEvent}`);
        if (res.status === 404) {
          stopPolling();
          return;
        }
        const next = await res.json();
        if (next.events?.length) state.lastEvent = next.lastEvent;
        updateDeploy(next);
        if (['done', 'stopped', 'error'].includes(next.status)) stopPolling();
      } catch {
        /* شبکه لرزید */
      }
    }, 1200);
  }

  /* ---------------- شروع ---------------- */

  boot().catch((e) => {
    el.status.textContent = 'خطا در بارگذاری';
    el.status.className = 'status bad';
    toast(e.message);
  });

  window.__AGENT__ = { state, send, act, openCheckout, loadFiles, openFileInEditor, switchTab, triggerRedeploy };
})();
