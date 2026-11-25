'use strict';
/* INOCULENS PLUTUS — js/app.js: boot.
 *
 * Vanilla JS, no framework, no build step. The app is a set of classic
 * scripts that share one global scope, loaded in order by index.html:
 *   js/core     generic helpers, dates
 *   js/data     state model, validation, storage, backup
 *   js/fx       ECB rates and display conversion
 *   js/ledger   pure accounting engine (cost basis, portfolio, cash books)
 *   js/prices   live and historical prices, manual overrides
 *   js/ui       views, dialogs, record form, render loop
 *   js/sync     end-to-end encrypted sync
 *   js/analytics  consent-gated analytics
 * This file loads last: it holds the version and boots the app on
 * DOMContentLoaded. Only code here and in the files' own top-level
 * declarations runs at load time; everything else runs after boot, so the
 * files may call each other freely.
 *
 * Version contract (full rules in AGENTS.md): the footer shows the commit id
 * + commit count, e.g. "c03f772 (#110)". The id only exists after
 * committing, so the deploy build (stamp-version.sh, wired in netlify.toml)
 * stamps it into APP_VERSION below (and a content checksum into every ?v=
 * cache-buster in index.html). Keep a sane fallback value here for
 * local/file:// use.
 */

var APP_VERSION = '35056ef (#140)';

var uiBooted = false;

var hashWired = false;
var heroResizeWired = false;

function init() {
  if (uiBooted) {
    render();
    return;
  }
  try { repairBakedExecLocksOnce(); } catch (e) { /* repair never breaks boot */ }
  if (!document.getElementById('accounts')) return;
  buildTopbar();
  buildAccounts();
  buildTradeForm();
  buildSettings();
  buildAccountDialog();
  wireMenuOutside();
  if (!hashWired && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    hashWired = true;
    window.addEventListener('hashchange', route); // hash mode (file://, legacy links)
    window.addEventListener('popstate', route); // history mode (clean URLs)
  }
  if (!heroResizeWired && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    heroResizeWired = true;
    var heroRt = null;
    window.addEventListener('resize', function () {
      // The corner-aware wrap decision must track width live: run it at once,
      // then the debounced tail still covers the hero and the ⓘ dots.
      try { syncTradeHeadRows(); } catch (e) { /* corner wrap tracks on the debounce */ }
      if (heroRt) { try { clearTimeout(heroRt); } catch (e) { /* ignore */ } }
      heroRt = setTimeout(function () { fitHeroValue(); syncHeroAllocHeight(); try { syncInfoDots(); } catch (e) { /* ignore */ } try { syncTradeHeadRows(); } catch (e2) { /* wrap caps follow the width */ } }, 150);
    });
    try {
      if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
        document.fonts.ready.then(function () { syncHeroAllocHeight(); try { syncInfoDots(); } catch (e) { /* webfont metrics settle truncation */ } try { syncTradeHeadRows(); } catch (e2) { /* webfont metrics re-wrap the head lines */ } });
      }
    } catch (e) { /* ignore */ }
    try {
      window.addEventListener('load', function () { try { syncInfoDots(); } catch (e) { /* late layout settles truncation */ } });
    } catch (e) { /* ignore */ }
  }
  var back = document.getElementById('acct-back');
  if (back && !back.getAttribute('data-wired')) {
    back.setAttribute('data-wired', '1');
    back.addEventListener('click', function (e) {
      // Back climbs one level: a sub-account returns to its main, anything
      // else returns home. Stateless — no trail to go stale.
      var main = null;
      try {
        var cur = accountDetailId();
        if (cur) main = groupMainOf(peekState(), cur);
      } catch (err) { main = null; }
      if (e && e.preventDefault) e.preventDefault();
      if (main) navTo(main.id);
      else navHome();
    });
  }
  var d = document.getElementById('t-date');
  if (d && !d.value) d.value = todayDmy();
  uiBooted = true;
  render();
  // js/boot/startup-loader.js closes the intro once it has finished playing.
  if (typeof window.finishStartupLoader === 'function') window.finishStartupLoader();
  try { announceStorageRecovery(); } catch (e) { /* the notice never breaks boot */ }
  refreshPrices();
  try { syncCheckOnLoad(); } catch (e) { /* the check never breaks boot */ }
  try {
    syncWatchStart();
  } catch (e) { /* the watch never breaks boot */ }
}

// Runs the baked-quote repair once per page load (see dropBakedExecLocks).
// Later init() calls must not re-save.
var execRepairDone = false;
function repairBakedExecLocksOnce() {
  if (execRepairDone) return false;
  execRepairDone = true;
  var st = null;
  try { st = loadState(); } catch (e) { return false; }
  var changed = false;
  try { changed = dropBakedExecLocks(st.trades, st.priceOverrides); } catch (e) { changed = false; }
  if (!changed) return false;
  try { saveStateGuarded(st); } catch (e) { return false; }
  return true;
}

// --- Boot wiring (runs once, when this last script loads) ---
// DOMContentLoaded handlers, in this order: the app, the OAuth redirect of
// a sync sign-in, the cookie banner, the floating dock. The banner and the
// dock also run at once when the document is already parsed (deferred
// scripts run while readyState is 'interactive').
function whenParsed(fn, alsoNow) {
  document.addEventListener('DOMContentLoaded', fn);
  if (!alsoNow) return;
  try {
    if (document.readyState === 'interactive' || document.readyState === 'complete') fn();
  } catch (e) { /* the listener covers it */ }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  whenParsed(init);
  whenParsed(syncHandleOAuthRedirect);
  whenParsed(consentInitBanner, true);
  whenParsed(dockFooterInit, true);
}

// Surface unexpected errors visibly so users can report them with the version above.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('error', function (e) {
    try {
      showBanner('App error — please report this text plus your app version (bottom of page).', 'error', {
        title: 'App error',
        lines: [String((e && e.message) || 'unknown error'), 'Version ' + APP_VERSION]
      });
    } catch (err) { /* ignore */ }
  });
}
