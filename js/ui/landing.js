'use strict';
// First-run landing (guide panel) and its live price ticker.

function buildGuidePanel() {
  var box = document.createElement('section');
  box.className = 'guide-panel';
  box.setAttribute('aria-label', 'Next step');
  var step = document.createElement('p');
  step.className = 'guide-step';
  step.textContent = 'Step 2 of 2';
  box.appendChild(step);
  var title = document.createElement('h2');
  title.className = 'guide-title';
  title.textContent = 'Add your first record';
  box.appendChild(title);
  var sub = document.createElement('p');
  sub.className = 'guide-sub';
  sub.textContent = 'Tell INOCULENS PLUTUS what you bought, how much, what you paid, and when. Prices and currency math are automatic.';
  box.appendChild(sub);
  var ctas = document.createElement('div');
  ctas.className = 'guide-ctas';
  var go = document.createElement('button');
  go.type = 'button';
  go.className = 'primary';
  go.textContent = 'Add my first record';
  go.setAttribute('data-guide-trade', '1');
  ctas.appendChild(go);
  box.appendChild(ctas);
  return box;
}

function wireLanding() {
  var c = document.getElementById('landing-create');
  if (c && !c.getAttribute('data-wired')) {
    c.setAttribute('data-wired', '1');
    c.addEventListener('click', function () { openAccountDialog(); });
  }
  var r = document.getElementById('landing-restore');
  if (r && !r.getAttribute('data-wired')) {
    r.setAttribute('data-wired', '1');
    r.addEventListener('click', function () {
      buildSettings();
      showSettingsTab('backup');
      openDialog('settings-dialog');
    });
  }
  refreshLandingTicker();
}

// Landing ticker: live sample prices for BTC (crypto), XAU (commodity) and
// SPCX (stock) in the current main fiat. Display-only: unknown stays '—'
// (never 0) and failures stay silent — no banner, the empty state has no
// data to protect. Same resilience as the portfolio refresh: every pill
// resolves on its own (a slow stock feed never holds back BTC), gets one
// gentle retry before settling on '—', and a pill that ended unknown is
// re-attempted on the next paint after a short cooldown instead of staying
// blank. A pill that already shows a price keeps it if a later refresh fails.
// Fresh prices are throttled to one fetch per 60s per fiat.
var LANDING_TICK_SYMS = ['BTC', 'XAU', 'SPCX'];
var LANDING_TICK_IDS = ['tick-btc', 'tick-xau', 'tick-spcx'];
var LANDING_TICK_KINDS = { BTC: 'crypto', XAU: 'commodity', SPCX: 'stock' };
var LANDING_TICK_FRESH_MS = 60000; // a resolved pill is not refetched sooner
var LANDING_TICK_FAIL_MS = 10000; // an unknown pill may be re-attempted after this
var LANDING_TICK_RETRY_MS = 2500; // one gentle retry inside a run
var landingTickCur = '';
var landingTickGen = 0;
var landingTickState = {}; // sym -> { at, ok, busy, shown } for the current fiat

function landingTickFiat() {
  try { return String(peekState().settings.mainCurrency || 'EUR').toUpperCase(); } catch (e) { return 'EUR'; }
}

function paintLandingTick(i, value, main) {
  var el = document.getElementById(LANDING_TICK_IDS[i]);
  if (!el) return;
  paintLoading(el, false);
  el.textContent = (isFinite(Number(value)) && Number(value) > 0) ? fmtMoney(Number(value), main) : '—';
}

// One symbol, one run. Resolves a positive price or null — never rejects.
// refreshAllPrices records the run in lastPriceErrors: save/restore it so the
// ticker never disturbs the portfolio error state.
function landingTickFetch(sym, main) {
  var prevErr = null;
  try { prevErr = lastPriceErrors; } catch (e) { prevErr = null; }
  function restore() { try { lastPriceErrors = prevErr; } catch (e) { /* keep */ } }
  var kinds = {};
  kinds[sym] = LANDING_TICK_KINDS[sym];
  return refreshAllPrices([sym], main, kinds).then(function (out) {
    restore();
    var v = out ? Number(out[sym]) : NaN;
    return (isFinite(v) && v > 0) ? v : null;
  }, function () {
    restore();
    return null;
  });
}

function refreshLandingTicker() {
  var main = landingTickFiat();
  var now = Date.now();
  if (main !== landingTickCur) {
    // New fiat: older runs are discarded (generation guard) and every pill
    // starts over in the loading state.
    landingTickCur = main;
    landingTickGen++;
    landingTickState = {};
    LANDING_TICK_IDS.forEach(function (id, i) {
      var el = document.getElementById(id);
      if (el) { el.textContent = '…'; paintLoading(el, true, LANDING_TICK_SYMS[i]); }
    });
  }
  var gen = landingTickGen;
  LANDING_TICK_SYMS.forEach(function (sym, i) {
    var prev = landingTickState[sym];
    if (prev) {
      if (prev.busy) return;
      if (prev.ok && (now - prev.at) < LANDING_TICK_FRESH_MS) return;
      if (!prev.ok && (now - prev.at) < LANDING_TICK_FAIL_MS) return;
    }
    var shown = !!(prev && prev.shown);
    var st = { at: now, ok: false, busy: true, shown: shown };
    landingTickState[sym] = st;
    if (!shown) {
      // Nothing to show yet (first load or a previous '—'): back to loading.
      var el = document.getElementById(LANDING_TICK_IDS[i]);
      if (el) { el.textContent = '…'; paintLoading(el, true, sym); }
    }
    landingTickFetch(sym, main).then(function (v) {
      if (v !== null || gen !== landingTickGen) return v;
      return new Promise(function (res) { setTimeout(res, LANDING_TICK_RETRY_MS); }).then(function () {
        if (gen !== landingTickGen) return null;
        return landingTickFetch(sym, main);
      });
    }).then(function (v) {
      if (gen !== landingTickGen) return; // fiat moved mid-fetch: a newer run owns the paint
      st.busy = false;
      st.at = Date.now();
      st.ok = v !== null;
      if (v !== null) {
        st.shown = true;
        paintLandingTick(i, v, main);
      } else if (!st.shown) {
        paintLandingTick(i, null, main); // '—', and the next paint re-attempts
      }
    });
  });
}
