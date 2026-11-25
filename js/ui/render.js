'use strict';
// Render loop: render() repaints everything from stored state;
// refreshPrices() fetches live prices then repaints; refreshDisplayRates()
// fills missing historical FX / execution prices, then repaints once.

// Generation guard: rapid fiat switches (or a slow first paint racing init's
// fetch) can leave two refreshes in flight; without a guard the STALE one may
// resolve last and paint live values in the wrong fiat (e.g. EUR numbers
// labeled RON against a correctly converted cost → a phantom ~200 RON loss
// on a 50 EUR trade). Only the latest request for the CURRENT main may write
// livePrices, banner, or repaint — anything older is quietly discarded.
var priceReqGen = 0;

function refreshPrices() {
  var st = loadState();
  var mainNow = st.settings.mainCurrency;
  // One entry per price identity (see "Price identity"): the bare ticker, or
  // KIND:SYM for a ticker held under several asset kinds.
  var syms = [];
  var kinds = {};
  function addPrice(sym, kind) {
    var up = String(sym || '').toUpperCase();
    if (!up) return;
    if (PRICE_COLLISIONS[up]) {
      var held = PRICE_KINDS_BY_SYMBOL[up] || {};
      Object.keys(held).forEach(function (k) {
        var key = priceKeyOf(up, k);
        if (syms.indexOf(key) === -1) syms.push(key);
        kinds[key] = k;
      });
      return;
    }
    if (syms.indexOf(up) === -1) syms.push(up);
    if (kind && !kinds[up]) kinds[up] = kind;
  }
  uniqueSymbols(st.trades).forEach(function (s) { addPrice(s); });
  (st.accounts || []).forEach(function (a) {
    if (!a) return;
    if (a.ticker) addPrice(a.ticker, a.kind);
    accountDebtPositions(a).forEach(function (position) {
      var ticker = position.assetTicker || a.ticker;
      var kind = position.assetKind || a.kind;
      if (ticker && !isCashKind(kind)) addPrice(ticker, kind);
    });
  });
  // Trade symbols inherit their account's kind (stock/commodity accounts fetch live).
  (st.trades || []).forEach(function (tr) {
    if (!tr || !tr.symbol || !tr.accountId) return;
    var a = accountById(st, tr.accountId);
    if (a && a.kind) addPrice(tr.symbol, a.kind);
  });
  if (!syms.length) {
    priceLoading = {};
    render();
    return Promise.resolve({});
  }
  var gen = ++priceReqGen;
  function isCurrent() {
    if (gen !== priceReqGen) return false; // superseded by a newer refresh
    try { return peekState().settings.mainCurrency === mainNow; }
    catch (e) { return false; }
  }
  // Loading paint: actionable symbols with no known price yet show the
  // loading placeholder (never an error) until this generation settles.
  // Painted synchronously so even slow proxy chains show "loading" at once.
  var loadingSyms = syms.filter(function (s) {
    if (isFinite(Number(livePrices[s])) && Number(livePrices[s]) > 0) return false;
    return isActionablePriceSymbol(s, kinds);
  });
  var loadingTouched = false;
  Object.keys(priceLoading).forEach(function (k) {
    if (loadingSyms.indexOf(k) === -1) { delete priceLoading[k]; loadingTouched = true; }
  });
  loadingSyms.forEach(function (s) {
    if (!priceLoading[s]) { priceLoading[s] = true; loadingTouched = true; }
  });
  if (loadingTouched) render();
  return refreshAllPrices(syms, mainNow, kinds).then(function (out) {
    if (!isCurrent()) return out; // stale: newer refresh owns livePrices + paint
    Object.keys(out).forEach(function (k) {
      var v = out[k];
      if (isFinite(Number(v)) && Number(v) > 0) { livePrices[k] = Number(v); delete priceLoading[k]; }
    });
    // Only symbols with a real live source can be "unreachable". Cash /
    // custom kinds and unmapped tickers are manual-by-design: they stay
    // unknown (—) without ever raising the price banner. An override that
    // is set yet still missing failed conversion, so it stays actionable.
    function isActionable(s) { return isActionablePriceSymbol(s, kinds); }
    var missing = syms.filter(function (s) { return !(isFinite(Number(livePrices[s])) && Number(livePrices[s]) > 0); });
    var actionable = missing.filter(isActionable);
    if (!actionable.length) {
      clearPriceBanner();
      render();
      return out;
    }
    // One gentle retry for transient failures (e.g. CoinGecko 429) before
    // telling the user anything — most hiccups heal within seconds.
    // Manual-by-design symbols are not retried: they would fail forever.
    return new Promise(function (res) { setTimeout(res, 2500); }).then(function () {
      if (!isCurrent()) return out; // main moved on during the wait: stay quiet
      return refreshAllPrices(actionable, mainNow, kinds);
    }).then(function (out2) {
      if (!isCurrent()) return out; // stale retry: discard, no paint, no banner
      Object.keys(out2).forEach(function (k) {
        var v = out2[k];
        if (isFinite(Number(v)) && Number(v) > 0) livePrices[k] = Number(v);
      });
      // Generation settled: nothing is "loading" anymore. Still-missing
      // actionable symbols become failed (placeholder + banner below).
      syms.forEach(function (s) { delete priceLoading[s]; });
      var stillMissing = syms.filter(function (s) { return !(isFinite(Number(livePrices[s])) && Number(livePrices[s]) > 0); });
      var actionableStill = stillMissing.filter(isActionable);
      if (actionableStill.length) {
        var detailLines = actionableStill.map(function (s) {
          var kp = splitPriceKey(s);
          var label = kp ? kp.sym + ' (' + kp.kind + ')' : s;
          return label + ' — ' + (lastPriceErrors[s] || 'price unavailable');
        });
        showBanner('Live prices are unreachable right now — your data is safe and numbers will fill in automatically.', 'info', {
          title: 'Price errors',
          lines: detailLines
        }, 'price');
      } else {
        clearPriceBanner();
      }
      render();
      return out;
    });
  });
}

function render() {
  var st;
  try {
    st = loadState();
  } catch (e) {
    st = defaultState();
  }
  if (!st || !st.settings) st = defaultState();
  renderAccounts(st);
  try { renderHeroAlloc(st); } catch (e) { /* best-effort */ }
  syncTopbar(st);
  var ver = document.getElementById('app-ver');
  if (ver) {
    // The version number doubles as the repo link: paint only the text span
    // so the icon survives, and keep working if the markup ever loses it.
    var verText = ver.querySelector ? ver.querySelector('[data-ver-text]') : null;
    if (verText) verText.textContent = APP_VERSION;
    else ver.textContent = APP_VERSION;
  }
  route(); // show home or the routed account page
  refreshDisplayRates(st); // fill missing historical pairs, then repaint once
  try { syncInfoDots(); } catch (e) { /* hide decorative ⓘ where nothing overflows */ }
  try { syncTradeHeadRows(); } catch (e) { /* pinned-corner caps follow the wrap */ }
}

// Fire-and-forget: fetch historical FX pairs AND historical execution prices
// the current paint still lacks, then repaint a single time. Never rejects;
// offline keeps the current paint (Exec rows show "—" until history lands).
function refreshDisplayRates(st) {
  if (!st || !st.settings) return;
  var main = st.settings.mainCurrency;
  var trades = st.trades;
  var kinds = {};
  try {
    (st.accounts || []).forEach(function (a) {
      if (a && a.ticker) kinds[String(a.ticker).toUpperCase()] = a.kind;
    });
    (trades || []).forEach(function (tr) {
      if (!tr || !tr.symbol || !tr.accountId) return;
      var s = String(tr.symbol).toUpperCase();
      if (kinds[s]) return;
      var a = accountById(st, tr.accountId);
      if (a && a.kind) kinds[s] = a.kind;
    });
  } catch (e) { kinds = {}; }
  try {
    try { fxFailedList = []; } catch (e) { /* ignore */ }
    var kindsByAccount = {};
    try {
      (st.accounts || []).forEach(function (a) {
        if (a && a.id) kindsByAccount[a.id] = (typeof a.kind === 'string') ? a.kind : '';
      });
    } catch (e) { kindsByAccount = {}; }
    var fills = [
      ensureDisplayRates(trades, main, kindsByAccount).catch(function () { return false; }),
      ensureDebtDisplayRates(st.accounts || [], main).catch(function () { return false; })
    ];
    var gf = [];
    try { gf = groupFillFiats(st); } catch (e) { gf = []; }
    gf.forEach(function (f) { fills.push(ensureDisplayRates(trades, f, kindsByAccount).catch(function () { return false; })); });
    fills.push(ensureHistoricalExec(trades, main, kinds).catch(function () { return false; }));
    Promise.all(fills).then(function (flags) {
      var changed = false;
      (flags || []).forEach(function (f) { if (f) changed = true; });
      try {
        var failed = fxFailedPairs();
        if (failed.length && !fxWarnedSession) {
          fxWarnedSession = true;
          var fm = fxFailedMessage(failed);
          showBanner(fm.msg, 'error', { title: fm.title, lines: fm.lines });
        }
      } catch (e) { /* the warning never breaks render */ }
      if (!changed) return;
      var s2;
      try {
        s2 = loadState();
      } catch (e) { return; }
      if (!s2 || !s2.settings) return;
      renderAccounts(s2);
      try { renderHeroAlloc(s2); } catch (e) { /* ignore */ }
      syncTopbar(s2);
      route();
      try { syncInfoDots(); } catch (e) { /* ignore */ }
    }, function () { /* offline: keep current paint */ });
  } catch (e) { /* ignore */ }
}
