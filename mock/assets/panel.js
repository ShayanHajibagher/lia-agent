/**
 * panel.js — رفتار حداقلی پنل جعلی لیارا
 *
 * همه‌چیز سمت کلاینت و بدون بک‌اند است: انتخاب پلتفرم/پلن، انتقال آن بین
 * مرحله‌های ویزارد (localStorage)، تب‌ها، و شبیه‌سازی آپلود/دیپلوی.
 * هدف: محیطی قابل‌کلیک برای تست «راهنمای مرحله‌به‌مرحله» و «دیپلوی خودکار».
 */
(function () {
  'use strict';

  var STATE_KEY = 'lia-mock-panel-state';

  function readState() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function writeState(patch) {
    var next = Object.assign(readState(), patch);
    localStorage.setItem(STATE_KEY, JSON.stringify(next));
    return next;
  }

  function fmt(n) {
    return n.toLocaleString('fa-IR');
  }

  function money(n) {
    return fmt(n) + ' تومان';
  }

  /* ---------- انتخاب پلتفرم ---------- */
  function initPlatforms() {
    var current = readState().platform;
    document.querySelectorAll('.platform').forEach(function (el) {
      if (el.dataset.platform === current) el.classList.add('selected');
      el.addEventListener('click', function () {
        document.querySelectorAll('.platform').forEach(function (x) {
          x.classList.remove('selected');
        });
        el.classList.add('selected');
        writeState({ platform: el.dataset.platform });
        document.dispatchEvent(new CustomEvent('lia:selection', { detail: { type: 'platform', value: el.dataset.platform } }));
        var next = document.getElementById('next-step');
        if (next) {
          next.removeAttribute('aria-disabled');
          next.classList.remove('is-disabled');
        }
      });
    });
  }

  /* ---------- انتخاب پلن + مدت ---------- */
  function initPlans() {
    var state = readState();
    var durationEl = document.getElementById('duration');
    var summary = document.getElementById('plan-summary');

    function recalc() {
      var months = durationEl ? Number(durationEl.value) : 1;
      document.querySelectorAll('.plan').forEach(function (plan) {
        var monthly = Number(plan.dataset.monthly || 0);
        var totalEl = plan.querySelector('.plan-total');
        if (totalEl) totalEl.textContent = money(monthly * months);
      });
      var selected = document.querySelector('.plan.selected');
      if (summary && selected) {
        var monthly = Number(selected.dataset.monthly || 0);
        summary.textContent =
          selected.dataset.planName + ' — ' + money(monthly * months) + ' برای ' + fmt(months) + ' ماه';
      }
    }

    document.querySelectorAll('.plan').forEach(function (plan) {
      if (plan.dataset.plan === state.plan) plan.classList.add('selected');
      plan.addEventListener('click', function () {
        document.querySelectorAll('.plan').forEach(function (x) {
          x.classList.remove('selected');
        });
        plan.classList.add('selected');
        writeState({ plan: plan.dataset.plan, planName: plan.dataset.planName, monthly: plan.dataset.monthly });
        document.dispatchEvent(new CustomEvent('lia:selection', { detail: { type: 'plan', value: plan.dataset.plan } }));
        recalc();
      });
    });

    // اگر در HTML یک پلن به‌صورت پیش‌فرض انتخاب شده، همان را در وضعیت ثبت کن
    var visible = document.querySelector('.plan.selected');
    if (!state.plan && visible) {
      writeState({ plan: visible.dataset.plan, planName: visible.dataset.planName, monthly: visible.dataset.monthly });
    }

    if (durationEl) {
      durationEl.value = state.duration || '1';
      durationEl.addEventListener('change', function () {
        writeState({ duration: durationEl.value });
        recalc();
      });
    }
    recalc();
  }

  /* ---------- تب‌ها ---------- */
  function initTabs() {
    document.querySelectorAll('.tabs').forEach(function (tabs) {
      var buttons = tabs.querySelectorAll('button[data-tab]');
      buttons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          buttons.forEach(function (b) {
            b.classList.toggle('active', b === btn);
          });
          var scope = tabs.parentElement;
          scope.querySelectorAll('.tabpane').forEach(function (pane) {
            pane.hidden = pane.dataset.tab !== btn.dataset.tab;
          });
        });
      });
    });
  }

  /* ---------- env rows ---------- */
  function initEnvs() {
    document.querySelectorAll('[data-add-env]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var list = document.getElementById('env-list');
        if (!list) return;
        var row = document.createElement('div');
        row.className = 'env-row';
        row.innerHTML =
          '<input type="text" placeholder="KEY" dir="ltr">' +
          '<input type="text" placeholder="value" dir="ltr">' +
          '<button class="btn ghost sm" type="button" data-del-env>×</button>';
        list.appendChild(row);
      });
    });
    document.addEventListener('click', function (e) {
      var del = e.target.closest && e.target.closest('[data-del-env]');
      if (del) del.parentElement.remove();
    });
  }

  /* ---------- نام برنامه → پیش‌نمایش دامنه ---------- */
  function initName() {
    var name = document.getElementById('app-name');
    var preview = document.getElementById('domain-preview');
    if (!name || !preview) return;
    var saved = readState().appName;
    if (saved) name.value = saved;
    function sync() {
      var v = (name.value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      preview.textContent = (v || 'my-app') + '.liara.run';
      writeState({ appName: v });
    }
    name.addEventListener('input', sync);
    sync();
  }

  /* ---------- شبیه‌سازی استقرار ---------- */
  function initDeploy() {
    var zone = document.getElementById('dropzone');
    var fileLabel = document.getElementById('file-name');
    var startBtn = document.getElementById('start-deploy');
    var logs = document.getElementById('deploy-logs');
    var bar = document.getElementById('deploy-progress');
    var status = document.getElementById('deploy-status');
    if (!zone || !startBtn || !logs) return;

    var picked = null;

    function pick(name) {
      picked = name;
      if (fileLabel) {
        fileLabel.innerHTML = '<span class="file-chip">📦 ' + name + '</span>';
      }
      startBtn.disabled = false;
    }

    zone.addEventListener('click', function () {
      pick('project.zip');
    });
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('drag');
    });
    zone.addEventListener('dragleave', function () {
      zone.classList.remove('drag');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('drag');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      pick(f ? f.name : 'project.zip');
    });

    var LINES = [
      ['dim', 'Cloning source...'],
      ['dim', 'Building image for platform: ' + (readState().platform || 'nextjs')],
      ['dim', '> npm ci --omit=dev'],
      ['dim', '> next build'],
      ['err', 'Error: Could not find a production build in the ".next" directory.'],
      ['err', 'Try building your app with "next build" before starting the production server.'],
      ['dim', 'Build finished with exit code 1'],
      ['err', 'Deployment failed.'],
    ];

    startBtn.addEventListener('click', function () {
      if (!picked) return;
      startBtn.disabled = true;
      logs.innerHTML = '';
      if (status) status.innerHTML = '<span class="badge warn">در حال ساخت</span>';
      var i = 0;
      var timer = setInterval(function () {
        if (i >= LINES.length) {
          clearInterval(timer);
          if (status) status.innerHTML = '<span class="badge err">ناموفق</span>';
          return;
        }
        var line = document.createElement('div');
        line.className = LINES[i][0];
        line.textContent = LINES[i][1];
        logs.appendChild(line);
        logs.scrollTop = logs.scrollHeight;
        if (bar) bar.querySelector('i').style.width = Math.round(((i + 1) / LINES.length) * 100) + '%';
        i += 1;
      }, 650);
    });
  }

  /* ---------- ناوبری «بعدی» در ویزارد ---------- */
  // باگ قبلی: هندلر «مسدودکردن» یک‌بار در زمان لود نصب می‌شد و بعد از انتخاب
  // پلتفرم هم فعال می‌ماند؛ حالا وضعیت در لحظهٔ کلیک خوانده می‌شود.
  function initWizardLinks() {
    var next = document.getElementById('next-step');
    if (!next) return;
    var require = next.dataset.require || null;

    function sync() {
      var s = readState();
      var ok = !require || (require === 'platform' ? !!s.platform : require === 'plan' ? !!s.plan : true);
      next.classList.toggle('is-disabled', !ok);
      next.setAttribute('aria-disabled', ok ? 'false' : 'true');
      var hint = document.getElementById('step-hint');
      if (hint) hint.remove();
      if (!ok) {
        var span = document.createElement('span');
        span.id = 'step-hint';
        span.className = 'req-hint';
        span.textContent = require === 'platform' ? 'اول یک پلتفرم انتخاب کن' : 'اول یک پلن انتخاب کن';
        next.insertAdjacentElement('beforebegin', span);
      }
    }

    sync();
    document.addEventListener('lia:selection', sync);

    next.addEventListener('click', function (e) {
      var s = readState();
      if (require === 'platform' && !s.platform) {
        e.preventDefault();
        alert('اول یک پلتفرم انتخاب کن.');
        return;
      }
      if (require === 'plan' && !s.plan) {
        e.preventDefault();
        alert('اول یک پلن انتخاب کن.');
        return;
      }
      var name = document.getElementById('app-name');
      if (name) writeState({ appName: name.value });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initPlatforms();
    initPlans();
    initTabs();
    initEnvs();
    initName();
    initDeploy();
    initWizardLinks();
    window.__LIA_PANEL__ = { kind: 'mock-console', path: location.pathname, state: readState() };
  });
})();
