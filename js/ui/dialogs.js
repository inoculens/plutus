'use strict';
// Modal dialogs: open/close with scroll lock and focus return, custom
// confirm dialogs (no browser alerts), keyboard avoidance on phones and
// outside-click handling for menus.

// The record form and settings live in modal <dialog>s so the page never
// scrolls through them.

var dialogOpener = null;

// While any modal dialog is open the page underneath is frozen: no
// background scroll (body lock) and no background interaction (native
// showModal already makes the backdrop inert + traps focus). Stacked
// dialogs (e.g. Settings + confirm) count, so closing one never unlocks
// while another is still open. Ancient browsers without showModal fall
// back to the [open] attribute: scroll still locks, clicks do not.
var MODAL_IDS = ['trade-dialog', 'account-dialog', 'ledger-dialog', 'group-dialog', 'settings-dialog', 'confirm-dialog', 'note-dialog', 'error-dialog', 'color-dialog', 'attach-dialog', 'txdup-dialog'];

function updateModalLock() {
  try {
    if (typeof document === 'undefined') return;
    var open = 0;
    var i, d;
    for (i = 0; i < MODAL_IDS.length; i++) {
      d = document.getElementById(MODAL_IDS[i]);
      if (d && (d.open || (d.hasAttribute && d.hasAttribute('open')))) open++;
    }
    var body = document.body;
    if (!body || !body.classList) return;
    // The class goes on <html> as well as <body>: on phones html carries
    // overflow-x: clip, so it is the real scroller and body's overflow no
    // longer propagates to the viewport. Locking body alone left the page
    // scrollable from the dimmed area around a bottom sheet.
    var root = document.documentElement;
    if (open > 0) {
      try { body.classList.add('modal-open'); } catch (e) { /* ignore */ }
      try { if (root && root.classList) root.classList.add('modal-open'); } catch (e) { /* ignore */ }
    } else {
      try { body.classList.remove('modal-open'); } catch (e) { /* ignore */ }
      try { if (root && root.classList) root.classList.remove('modal-open'); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

function openDialog(id) {
  var dlg = document.getElementById(id);
  if (!dlg) return;
  dialogOpener = document.activeElement;
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
  try { updateModalLock(); } catch (e) { /* ignore */ }
  if (id === 'settings-dialog') {
    try { refreshSettingsAlert(); } catch (e) { /* ignore */ }
    try { refreshLedgerList(); } catch (e) { /* ignore */ }
  }
  var first = dlg.querySelector('input, select, button:not([data-close])');
  // Mobile: long forms (trade / account / settings) must not pop the
  // keyboard on open — it would cover the very fields being configured.
  // The user taps a field when ready; the kb-avoidance handler below then
  // scrolls it clear. Desktop keeps the old autofocus; confirms keep it
  // everywhere (keyboard choice is the point there).
  var isLongForm = (id === 'trade-dialog' || id === 'account-dialog' || id === 'settings-dialog');
  var skipAutoFocus = false;
  try { skipAutoFocus = isLongForm && isMobileView(); } catch (e) { skipAutoFocus = false; }
  if (!skipAutoFocus && first && typeof first.focus === 'function') {
    try { first.focus(); } catch (e) { /* ignore */ }
  }
}

// Mobile-only keyboard avoidance: when the on-screen keyboard opens inside
// an open bottom-sheet dialog, a focused field that ended up hidden is
// scrolled just far enough to be visible (visible fields never move).
// Purely additive — no dialog geometry, focus order or ledger/price logic
// changes; every handler early-returns off-mobile.
(function mobileKbAvoid() {
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    if (!document.addEventListener) return;
    function scrollFieldIntoSheet(field) {
      try {
        if (!field || !isMobileView()) return;
        var dlg = field.closest ? field.closest('dialog') : null;
        if (!dlg || !dlg.open) return;
        var scroller = dlg.querySelector('.set-panels') || dlg;
        // Let the keyboard finish animating before measuring.
        setTimeout(function () {
          try {
            if (document.activeElement !== field) return;
            // Only move when the field is actually hidden (behind the
            // keyboard or scrolled out of the sheet). A field the user can
            // already see stays put: re-centering it on every tap yanked the
            // form around while scrolling through it.
            var fr = null;
            try { fr = field.getBoundingClientRect(); } catch (e7) { fr = null; }
            if (fr) {
              var visTop = 0;
              var visBottom = window.innerHeight || 0;
              try {
                var vv = window.visualViewport;
                if (vv && vv.height) { visTop = vv.offsetTop || 0; visBottom = visTop + vv.height; }
              } catch (e8) { /* layout viewport bounds */ }
              try {
                var dr = scroller.getBoundingClientRect();
                if (dr.top > visTop) visTop = dr.top;
                if (dr.bottom < visBottom) visBottom = dr.bottom;
              } catch (e9) { /* viewport bounds only */ }
              if (fr.top >= visTop && fr.bottom <= visBottom) return;
            }
            if (field.scrollIntoView) {
              try { field.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' }); } catch (e2) {
                try { field.scrollIntoView(false); } catch (e3) { /* ignore */ }
              }
            }
            // Keep the sheet itself settled: nudge its scroll so a tall
            // scroller (settings panels) follows the field, never the page.
            if (scroller && scroller !== document.body && typeof scroller.scrollTop === 'number') {
              var r = null;
              try { r = field.getBoundingClientRect(); } catch (e4) { r = null; }
              var sr = null;
              try { sr = scroller.getBoundingClientRect(); } catch (e5) { sr = null; }
              if (r && sr && r.bottom > sr.bottom - 16) {
                try { scroller.scrollTop += (r.bottom - sr.bottom) + 24; } catch (e6) { /* ignore */ }
              }
            }
          } catch (e) { /* never break typing */ }
        }, 320);
      } catch (e) { /* ignore */ }
    }
    document.addEventListener('focusin', function (e) {
      try {
        var t = e && e.target;
        if (!t || !t.tagName) return;
        var tag = String(t.tagName).toUpperCase();
        if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return;
        scrollFieldIntoSheet(t);
      } catch (err) { /* ignore */ }
    });
    // Folding/rotating phones and split keyboards change the visual viewport
    // without a new focus event: re-seat the focused field if one is typing.
    if (window.visualViewport && window.visualViewport.addEventListener) {
      var lastH = 0;
      try { lastH = window.visualViewport.height || 0; } catch (e) { lastH = 0; }
      window.visualViewport.addEventListener('resize', function () {
        try {
          if (!isMobileView()) return;
          var h = 0;
          try { h = window.visualViewport.height || 0; } catch (e) { h = 0; }
          var shrank = (lastH && h && h < lastH - 60);
          lastH = h;
          if (!shrank) return;
          var ae = document.activeElement;
          if (ae && ae.tagName && /^(INPUT|SELECT|TEXTAREA)$/.test(String(ae.tagName).toUpperCase())) {
            scrollFieldIntoSheet(ae);
          }
        } catch (e) { /* ignore */ }
      });
    }
  } catch (e) { /* never break boot */ }
})();

function closeDialog(id) {
  var dlg = typeof id === 'string' ? document.getElementById(id) : id;
  if (!dlg) return;
  if (typeof dlg.close === 'function' && dlg.open) dlg.close();
  else dlg.removeAttribute('open');
  try { updateModalLock(); } catch (e) { /* ignore */ }
}

function returnFocus() {
  if (dialogOpener && typeof dialogOpener.focus === 'function') {
    try { dialogOpener.focus(); } catch (e) { /* ignore */ }
  }
  dialogOpener = null;
}

// --- Custom confirm (no browser alerts) ---
// confirmAction renders the in-app confirm dialog and resolves true/false.
// Only one pending confirm exists at a time; a newer call settles the older
// one as cancelled. Esc settles as cancelled via close/cancel.

var confirmSettle = null;

function confirmAction(title, message, okText, danger) {
  if (confirmSettle) settleConfirm(false);
  if (confirmSettle3) settleConfirm3('dismiss');
  var dlg = document.getElementById('confirm-dialog');
  var t = document.getElementById('confirm-title');
  var m = document.getElementById('confirm-message');
  var ok = document.getElementById('confirm-ok');
  var cancel = document.getElementById('confirm-cancel');
  if (!dlg || !t || !m || !ok) {
    return Promise.resolve(typeof window.confirm === 'function' ? window.confirm(message) : true);
  }
  t.textContent = title || 'Are you sure?';
  m.textContent = message || '';
  ok.textContent = okText || 'Confirm';
  ok.className = danger === false ? 'primary' : 'primary danger-btn';
  // A three-way confirm may have relabeled/restyled the shared buttons:
  // always restore the plain Cancel look here.
  if (cancel) {
    cancel.textContent = 'Cancel';
    cancel.className = '';
  }
  openDialog('confirm-dialog');
  return new Promise(function (resolve) { confirmSettle = resolve; });
}

function settleConfirm(v) {
  var dlg = document.getElementById('confirm-dialog');
  if (dlg) closeDialog(dlg);
  if (confirmSettle) {
    var s = confirmSettle;
    confirmSettle = null;
    s(v);
  }
}

// Three-way variant for decisions with two real actions (e.g. a taken sync
// name: download the drive copy OR upload over it). Resolves 'primary',
// 'secondary', or 'dismiss' (Esc/close, preemption). The shared
// buttons route to whichever confirm is pending; bool callers are unaffected.
var confirmSettle3 = null;

function settleConfirm3(v) {
  var dlg = document.getElementById('confirm-dialog');
  if (dlg) closeDialog(dlg);
  if (confirmSettle3) {
    var s = confirmSettle3;
    confirmSettle3 = null;
    s(v);
  }
}

function confirmAction3(title, message, primaryText, secondaryText) {
  if (confirmSettle) settleConfirm(false);
  if (confirmSettle3) settleConfirm3('dismiss');
  var dlg = document.getElementById('confirm-dialog');
  var t = document.getElementById('confirm-title');
  var m = document.getElementById('confirm-message');
  var ok = document.getElementById('confirm-ok');
  var cancel = document.getElementById('confirm-cancel');
  if (!dlg || !t || !m || !ok || !cancel) {
    return Promise.resolve(typeof window.confirm === 'function' ? (window.confirm(message) ? 'primary' : 'dismiss') : 'dismiss');
  }
  t.textContent = title || 'Are you sure?';
  m.textContent = message || '';
  ok.textContent = primaryText || 'Confirm';
  ok.className = 'primary';
  cancel.textContent = secondaryText || 'Cancel';
  cancel.className = 'primary danger-btn';
  openDialog('confirm-dialog');
  return new Promise(function (resolve) { confirmSettle3 = resolve; });
}

function wireDialog(id) {
  var dlg = document.getElementById(id);
  if (!dlg || dlg.getAttribute('data-wired')) return;
  dlg.setAttribute('data-wired', '1');
  dlg.addEventListener('click', function (e) {
    // No backdrop dismiss: dialogs close only via their X / action buttons
    // or Esc. (A stray outside click must never silently drop a form.)
    var c = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (c) closeDialog(dlg);
  });
  dlg.addEventListener('close', returnFocus);
  // Native Esc closes bypass closeDialog(): recompute the
  // background freeze here so it can never stick (or lift early).
  dlg.addEventListener('close', updateModalLock);
}

var menuOutsideWired = false;

// The account ··· menu is a native <details>: it only toggles on its own
// summary, so dismiss it on outside click / focus leave / Escape.
function wireMenuOutside() {
  if (menuOutsideWired) return;
  menuOutsideWired = true;
  function closeOpenMenus(except) {
    var open = (typeof document !== 'undefined' && document.querySelectorAll)
      ? document.querySelectorAll('details.menu[open]')
      : [];
    for (var i = 0; i < open.length; i++) {
      if (except && (open[i] === except || open[i].contains(except))) continue;
      open[i].removeAttribute('open');
    }
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', function (e) {
      var t = e ? e.target : null;
      if (t && t.closest && t.closest('details.menu')) return; // inside: native toggle / buttons handle it
      closeOpenMenus(null);
    });
    document.addEventListener('focusin', function (e) {
      var t = e ? e.target : null;
      if (t && t.closest && t.closest('details.menu')) return;
      closeOpenMenus(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) closeOpenMenus(null);
    });
  }
}
