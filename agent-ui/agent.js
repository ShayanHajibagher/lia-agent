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
    status: $('status'),
    login: $('loginDialog'),
    loginForm: $('loginForm'),
    email: $('email'),
    name: $('name'),
    checkout: $('checkoutDialog'),
    plans: $('plans'),
    months: $('months'),
    total: $('total'),
    pay: $('payBtn'),
    fileDialog: $('fileDialog'),
    fileName: $('fileName'),
    fileBody: $('fileBody'),
    uploadBtn: $('uploadBtn'),
    fileInput: $('fileInput'),
  };

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

  /* ---------------- حساب و پلن ---------------- */

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
      el.accountName.textContent = 'مهمان';
      el.planBadge.textContent = 'بدون حساب';
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

  function openLogin() {
    el.email.value = state.account?.email || '';
    el.name.value = state.account?.name || '';
    el.login.showModal();
  }

  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/api/account', {
        method: 'POST',
        body: JSON.stringify({ email: el.email.value.trim(), name: el.name.value.trim() }),
      });
      state.account = data.account;
      state.plan = data.plan;
      state.accountId = data.account.id;
      localStorage.setItem(LS_ACCOUNT, state.accountId);
      renderAccount();
      el.login.close();
      // سشن فعلی را به حساب وصل کن
      if (state.sessionId) {
        await api('/api/session', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId, accountId: state.accountId }) }).catch(() => {});
      }
      toast('خوش آمدی ' + (state.account.name || state.account.email));
    } catch (err) {
      toast(err.message);
    }
  });

  $('loginLater').addEventListener('click', () => el.login.close());

  el.accountBtn.addEventListener('click', () => {
    if (state.account) openCheckout();
    else openLogin();
  });
  el.buyBtn.addEventListener('click', () => openCheckout());

  async function openCheckout() {
    if (!state.accountId) return openLogin();
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

  /* ---------------- سشن ---------------- */

  async function boot() {
    const savedAccount = localStorage.getItem(LS_ACCOUNT);
    if (savedAccount) await loadAccount(savedAccount);
    renderAccount();

    try {
      const health = await api('/api/health');
      const info = health.llm || {};
      el.status.textContent = info.demo ? 'حالت دمو (بدون مدل)' : `مدل: ${info.model}`;
      el.status.className = 'status ok';
    } catch {
      el.status.textContent = 'سرور در دسترس نیست';
      el.status.className = 'status bad';
    }

    const saved = localStorage.getItem(LS_SESSION);
    await startSession(saved);
    if (!state.accountId) setTimeout(() => openLogin(), 600);
  }

  async function startSession(sessionId) {
    const data = await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ sessionId: sessionId || undefined, accountId: state.accountId || undefined }),
    });
    state.sessionId = data.sessionId;
    localStorage.setItem(LS_SESSION, state.sessionId);
    renderSession(data.state);
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
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (msg.role === 'user' ? 'user' : 'lia');
    wrap.innerHTML = `<div class="avatar">${msg.role === 'user' ? 'تو' : 'لیا'}</div><div class="bubble">${md(msg.text)}</div>`;
    el.msgs.appendChild(wrap);
    scrollEnd();
  }

  function addUserBubble(text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    wrap.innerHTML = `<div class="avatar">تو</div><div class="bubble">${md(text)}</div>`;
    el.msgs.appendChild(wrap);
    scrollEnd();
  }

  function renderCard(card) {
    const wrap = document.createElement('div');
    wrap.className = 'msg lia';
    const box = document.createElement('div');
    box.className = 'card';
    wrap.appendChild(box);
    el.msgs.appendChild(wrap);

    const build = CARD_BUILDERS[card.kind];
    if (build) build(box, card);
    else box.innerHTML = `<h4>${esc(card.title || card.kind)}</h4><div class="sub">${esc(JSON.stringify(card).slice(0, 300))}</div>`;
    scrollEnd();
    return box;
  }

  const CARD_BUILDERS = {
    chips(box, card) {
      box.innerHTML = `<h4>${esc(card.title || '')}</h4><div class="row"></div>`;
      const row = box.querySelector('.row');
      for (const item of card.items || []) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = item.label;
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

    plan(box, card) {
      const c = card.cost || {};
      const s = card.specs || {};
      box.innerHTML = `
        <h4>${esc(card.title || 'پیشنهاد پلن')}</h4>
        <div class="price">${esc(card.planName)} — ${fmt(c.monthlyTotal)} <small>/ ماه</small></div>
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

    analysis(box, card) {
      const findings = card.findings || [];
      box.innerHTML = `
        <h4>پروژه را خواندم</h4>
        <div class="specs">
          <span>پلتفرم ${esc(card.platform)}</span>
          <span>${fmt(card.stats?.fileCount)} فایل</span>
          ${card.port ? `<span>پورت ${esc(card.port)}</span>` : ''}
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

    approval(box, card) {
      const a = card.approval || {};
      // کارت‌های تأیید قبلی دیگر معتبر نیستند؛ دکمه‌هایشان خاموش شود
      lockApprovalButtons();
      box.innerHTML = `
        <div class="sub">مرحلهٔ ${fmt((a.index || 0) + 1)} از ${fmt(a.total || 0)}</div>
        <h4>${esc(a.title)}</h4>
        <div class="sub">${esc(a.detail)}</div>
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
    const key = ev.name + ':' + (ev.status === 'start' ? Math.random().toString(36).slice(2, 6) : '');
    if (ev.status === 'start') {
      const chip = document.createElement('div');
      chip.className = 'tool';
      chip.innerHTML = `<span class="spin"></span><span>${esc(ev.label || ev.name)}…</span>`;
      el.msgs.appendChild(chip);
      state.toolChips.set(ev.name, chip);
      scrollEnd();
      return;
    }
    const chip = state.toolChips.get(ev.name);
    if (!chip) return;
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
        if (ev.on) el.status.textContent = 'لیا دارد فکر می‌کند…';
        break;
      case 'navigate':
        if (ev.url) window.open(ev.url, '_blank');
        break;
      case 'error':
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

    try {
      await sse('/api/chat', { sessionId: state.sessionId, text: value }, handleEvent);
    } catch (err) {
      toast('ارتباط با سرور برقرار نشد: ' + err.message);
    } finally {
      state.busy = false;
      state.pendingUser = null;
      el.send.disabled = false;
      startPolling();
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
    state.busy = true;
    armBusyWatchdog();
    el.send.disabled = true;
    try {
      await sse('/api/action', { sessionId: state.sessionId, action: name, payload }, handleEvent);
    } catch (err) {
      toast(err.message);
    } finally {
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

  /* ---------------- فایل‌ها ---------------- */

  async function loadFiles() {
    if (!state.sessionId) return;
    try {
      const data = await api(`/api/project/${encodeURIComponent(state.sessionId)}/tree`);
      const files = (data.files || []).slice(0, 400);
      if (!files.length) {
        el.files.innerHTML = '<div class="empty">هنوز پروژه‌ای آپلود نشده</div>';
        el.download.classList.add('disabled');
        return;
      }
      el.files.innerHTML = files
        .map((p) => `<div class="row" data-path="${esc(p)}" title="${esc(p)}"><span class="ico">▤</span>${esc(p)}</div>`)
        .join('');
      el.files.querySelectorAll('.row').forEach((row) => {
        row.onclick = () => openFile(row.dataset.path);
      });
      el.download.href = `/api/project/${encodeURIComponent(state.sessionId)}/download`;
      el.download.classList.remove('disabled');
    } catch {
      /* ignore */
    }
  }

  async function openFile(path) {
    try {
      const data = await api(`/api/project/${encodeURIComponent(state.sessionId)}/file?path=${encodeURIComponent(path)}`);
      el.fileName.textContent = data.file.path;
      el.fileBody.textContent = data.file.text + (data.file.truncated ? '\n…(کوتاه شد)' : '');
      el.fileDialog.showModal();
    } catch (err) {
      toast(err.message);
    }
  }
  $('fileClose').addEventListener('click', () => el.fileDialog.close());

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
    } catch (err) {
      toast('آپلود ناموفق بود: ' + err.message);
    }
  }

  /* ---------------- دیپلوی ---------------- */

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function updateDeploy(snap) {
    if (!snap) {
      state.deploy = null;
      el.deployPanel.hidden = true;
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
      done: 'تمام',
      error: 'خطا',
      unknown: 'نامشخص',
    };
    el.deployStatus.textContent = labels[snap.status] || snap.status;
    el.deployStatus.className = 'badge' + (snap.status === 'done' ? '' : snap.status === 'error' ? ' warn' : '');
    const done = (snap.steps || []).filter((s) => s.done).length;
    const total = snap.total || (snap.steps || []).length || 1;
    el.deployBar.style.width = `${Math.round((done / total) * 100)}%`;
    el.deploySteps.innerHTML = (snap.steps || [])
      .map((s) => `<span class="${s.done ? 'done' : s.current ? 'cur' : ''}">${esc(s.title)}</span>`)
      .join('');
    el.deployLogs.innerHTML = (snap.logs || [])
      .slice(-30)
      .map((l) => `<div class="${l.level === 'err' ? 'err' : ''}">${esc(l.text)}</div>`)
      .join('');

    if (snap.status === 'awaiting_approval' && snap.pendingApproval && !state.seen.has('ap-' + snap.pendingApproval.stepId)) {
      state.seen.add('ap-' + snap.pendingApproval.stepId);
      renderCard({ kind: 'approval', approval: snap.pendingApproval });
    }
    if (snap.status === 'awaiting_fix' && snap.bug && !state.seen.has('bug-' + snap.id)) {
      state.seen.add('bug-' + snap.id);
      renderCard({ kind: 'bug', bug: snap.bug });
    }
    // خلاصهٔ پایان دیپلوی (مثل ویجت) — یک‌بار
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

  window.__AGENT__ = { state, send, act, openCheckout, loadFiles };
})();
