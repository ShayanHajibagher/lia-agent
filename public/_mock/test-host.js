/**
 * test-host.js — «میزبان تست» برای صفحه‌های آینه‌شدهٔ liara.ir
 *
 * کارها:
 *   ۱) حذف نویز محیط واقعی: پاپ‌آپ کمپین (حتی داخل Shadow DOM)، ویجت‌های چت بیرونی
 *   ۲) برگرداندن لینک‌های پنل به مسیر محلی (ری‌اکت بعد از هیدریت، آدرس‌ها را برمی‌گرداند)
 *   ۳) اعلام مسیر/عنوان صفحه برای «آگاهی از صفحه»ی ویجت لیا
 */
(function () {
  'use strict';

  var PROMO_TEXT = /(راه‌اندازی سریع|پیشنهاد ویژه|کمپین|فرصت محدود|تخفیف)/;

  /** همهٔ عناصر صفحه + داخل shadow rootهای باز (تا عمق ۳) */
  function allElements(root, depth, out) {
    if (depth > 3 || !root) return out;
    var nodes = root.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      out.push(el);
      if (el.shadowRoot) allElements(el.shadowRoot, depth + 1, out);
    }
    return out;
  }

  function isOpaqueOverlay(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    var fixed = cs.position === 'fixed' || cs.position === 'absolute';
    if (!fixed) return false;
    var r = el.getBoundingClientRect();
    return r.width >= innerWidth * 0.55 && r.height >= innerHeight * 0.55;
  }

  function removeNoise() {
    var nodes = allElements(document.body, 0, []);

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.isConnected) continue;

      // ۱) پاپ‌آپ کمپین: لایهٔ بزرگی که متن کمپین دارد
      if (isOpaqueOverlay(el) && PROMO_TEXT.test(el.textContent || '')) {
        el.remove();
        continue;
      }

      // ۲) تبلیغ/ویجت بیرونی: یوکتاننت، چت پشتیبانی و مشابه
      //    (پاپ‌آپ کمپین در واقع یک iframe تبلیغاتی cross-origin است و متنش در DOM ما نیست)
      if (el.tagName === 'IFRAME') {
        var src = el.getAttribute('src') || '';
        if (/yektanet|goftino|crisp|raychat|tawk|intercom|zendesk|doubleclick|adservice|adsystem/i.test(src)) {
          el.remove();
          continue;
        }
      }
      var id = (el.id || '') + ' ' + (el.className && typeof el.className === 'string' ? el.className : '');
      if (/goftino|crisp-chat|raychat|yektanet|ad-slot|advertisement/i.test(id)) {
        el.remove();
        continue;
      }
    }

    // ۳) اگر صفحه تار شده باشد، برش را برمی‌داریم
    var blurred = document.querySelectorAll('[style*="blur"]');
    for (var j = 0; j < blurred.length; j++) blurred[j].style.filter = 'none';

    killCenterOverlay();
  }

  /**
   * بعضی پاپ‌آپ‌های تبلیغاتی متن قابل‌جست‌وجو ندارند (داخل iframe/شادو).
   * راه مطمئن: هر لایهٔ بزرگی که روی مرکز صفحه افتاده و ویجت ما نیست را بردار.
   */
  function killCenterOverlay() {
    var el = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
    if (!el || el.closest('lia-root')) return;

    var node = el;
    var depth = 0;
    var overlay = null;
    while (node && depth < 10) {
      var cs = getComputedStyle(node);
      var z = parseInt(cs.zIndex, 10);
      if ((cs.position === 'fixed' || cs.position === 'absolute') && !isNaN(z) && z >= 50) overlay = node;
      node = node.parentElement;
      depth += 1;
    }
    if (overlay && (overlay.textContent || '').length < 800) overlay.remove();
  }

  function fixPanelLinks() {
    var links = document.querySelectorAll('a[href^="https://console.liara.ir"], a[href^="http://console.liara.ir"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      links[i].setAttribute('href', href.replace(/^https?:\/\/console\.liara\.ir/, '/panel'));
    }
  }

  function announce() {
    window.__LIA_HOST__ = {
      kind: 'mirrored-liara',
      path: location.pathname,
      title: document.title,
      at: Date.now(),
    };
  }

  function injectStyle() {
    if (document.getElementById('lia-test-host-style')) return;
    var style = document.createElement('style');
    style.id = 'lia-test-host-style';
    style.textContent = [
      'iframe[src*="yektanet"], iframe[src*="goftino"], iframe[src*="crisp"], iframe[src*="raychat"],',
      'iframe[src*="tawk"], iframe[src*="intercom"], iframe[src*="doubleclick"], iframe[src*="adservice"]',
      '{ display: none !important; visibility: hidden !important; }',
      '[id*="yektanet" i], [class*="yektanet" i], [id*="goftino" i], [class*="goftino" i]',
      '{ display: none !important; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function boot() {
    injectStyle();
    removeNoise();
    fixPanelLinks();
    announce();

    new MutationObserver(function () {
      removeNoise();
      fixPanelLinks();
    }).observe(document.body, { childList: true, subtree: true });

    // پاپ‌آپ کمپین با تأخیر باز می‌شود؛ نگهبان دائمی (هزینه‌اش ناچیز است)
    setInterval(function () {
      removeNoise();
      fixPanelLinks();
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
