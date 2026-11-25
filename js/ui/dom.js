'use strict';
// DOM helpers shared by the views: form values, hint targets, info pills and
// the mobile-view breakpoint.

function uiVal(id, fb) {
  var el = document.getElementById(id);
  return el ? el.value : fb;
}

function uiSetVal(id, v) {
  var el = document.getElementById(id);
  if (el) el.value = v;
}

// Mobile-only viewport check: phones + small tablets. Desktop always false,
// so every branch guarded by it leaves desktop behavior byte-identical.
function isMobileView() {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(max-width: 720px)').matches;
  } catch (e) { return false; }
}

// Info pill: a tiny (i) button whose text opens in a small popover, so
// screens carry labels instead of helper paragraphs. The popover lives in the
// top layer so it also shows above modal dialogs.
function infoPill(text, id) {
  var t = String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return '<button type="button" class="info-pill"' + (id ? ' id="' + id + '"' : '') + (t ? '' : ' hidden') +
    ' data-info="' + t + '" aria-label="' + t + '" aria-expanded="false">i</button>';
}
// Hints that became info pills are updated through data-info, so rewritten
// copy never replaces the visible marker.
function hintTextTarget(el) {
  if (!el || !el.classList || !el.classList.contains('info-pill')) return el;
  return {
    set textContent(v) {
      var t = String(v);
      el.setAttribute('data-info', t);
      el.setAttribute('aria-label', t);
      el.hidden = !t;
    },
    get textContent() { return el.getAttribute('data-info') || ''; }
  };
}
var infoPillReady = false;
function initInfoPills() {
  if (infoPillReady || typeof document === 'undefined') return;
  infoPillReady = true;
  var pop = document.createElement('div');
  pop.id = 'info-pop';
  pop.setAttribute('role', 'status');
  var canPop = typeof pop.showPopover === 'function';
  if (canPop) pop.setAttribute('popover', 'manual');
  pop.hidden = true;
  document.body.appendChild(pop);
  var current = null;
  function hide() {
    if (current) current.setAttribute('aria-expanded', 'false');
    current = null;
    pop.hidden = true;
    if (canPop) { try { pop.hidePopover(); } catch (e) { /* not open */ } }
  }
  function show(btn) {
    pop.textContent = btn.getAttribute('data-info') || '';
    if (!pop.textContent) return;
    pop.hidden = false;
    if (canPop) { try { pop.showPopover(); } catch (e) { /* already open */ } }
    current = btn;
    btn.setAttribute('aria-expanded', 'true');
    var r = btn.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var left = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2));
    var top = r.bottom + 8;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.info-pill') : null;
    if (btn) {
      e.preventDefault();
      if (current === btn) hide(); else { hide(); show(btn); }
      return;
    }
    hide();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); }, true);
  window.addEventListener('resize', hide);
  document.addEventListener('scroll', hide, true);
}
