'use strict';
// Fee-rate lookups that failed: tooltip text and tap-to-retry on the record card.

// Last tap-to-retry failure per trade (session-only): surfaced as the Fee
// Fiat Rate row's tooltip so an unknown rate says WHY instead of just '—'.
// Cleared whenever a lookup for that trade succeeds.
var feeRateErr = {};
function feeRateWhy(t, kind) {
  if (t && feeRateErr[t.id]) return feeRateErr[t.id];
  var kd = String(kind || '').trim().toLowerCase();
  if (kd === 'custom' || kd === 'cash') return 'No market history for this account kind — tap to retry anyway';
  var sym = t ? String(t.symbol || '').toUpperCase() : '';
  if (kd === 'commodity') { if (!hasCommoditySource(sym)) return 'No market history for this asset — tap to retry anyway'; }
  else if (kd !== 'stock' && !SYMBOL_MAP[sym]) return 'No market history for this asset — tap to retry anyway';
  return 'Tap to retry the rate lookup';
}
// Point the row's tooltip at new text without repainting (a full render
// would yank the scroll to the top via route()).
function feeRateTitle(id, text) {
  try {
    var el = document.querySelector('[data-trade="' + cssAttrValue(id) + '"] [data-label="Fee in fiat rate"]');
    if (el) el.title = String(text);
  } catch (e) { /* ignore */ }
}
// Compose the fee-rate failure tooltip from the recorded per-host causes.
function feeFailMsg(id, key) {
  var detail = '';
  try { detail = histDiag[key] || ''; } catch (e) { detail = ''; }
  feeRateErr[id] = 'History lookup failed' + (detail ? ' (' + detail + ')' : '') + ' — tap to retry';
  feeRateTitle(id, feeRateErr[id]);
}
// Tap-path failure: same record plus a visible reason popup (hover tooltips
// don't exist on touch screens, and a silent row leaves nothing to debug).
function feeFailTap(id, key) {
  histNoteFail(key);
  feeFailMsg(id, key);
  try { openNoteDialog(feeRateErr[id], 'Fee in fiat rate'); } catch (e) { /* ignore */ }
}
function retryFeeRate(tradeId) {
  var st = null;
  try { st = loadState(); } catch (e) { return; }
  var tr = null;
  (st.trades || []).forEach(function (t) { if (t && t.id === tradeId) tr = t; });
  if (!tr) return;
  var sym = String(tr.symbol || '').toUpperCase();
  var day = (typeof tr.date === 'string') ? tr.date.slice(0, 10) : '';
  var mainU = String((st.settings && st.settings.mainCurrency) || '').toUpperCase();
  if (!sym || !isValidDateStr(day) || isFutureDateStr(day) || !mainU) return;
  var kd = '';
  try {
    var a = accountById(st, tr.accountId);
    if (a && typeof a.kind === 'string') kd = a.kind.trim().toLowerCase();
  } catch (e) { kd = ''; }
  if (kd === 'custom' || kd === 'cash') return;
  if (kd === 'commodity') { if (!hasCommoditySource(sym)) return; }
  else if (kd !== 'stock' && !SYMBOL_MAP[sym]) return;
  var kk = histKindFor(kd);
  var key = sym + '|' + day + '|' + mainU + '|' + kk;
  try { delete histFailKeys[key]; } catch (e) { /* ignore */ }
  if (histInflight[key]) return;
  var hit = null;
  try { hit = getHistCached(sym, day, mainU, kk); } catch (e) { hit = null; }
  if (hit) { try { render(); } catch (e) { /* ignore */ } return; }
  histInflight[key] = true;
  fetchHistoricalPrice(sym, day, mainU, kd).then(function (r) {
    delete histInflight[key];
    var price = (r && typeof r === 'object') ? r.price : r;
    if (isFinite(Number(price)) && Number(price) > 0) {
      try {
        setHistCached(sym, day, mainU, kk, Number(price),
          (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history',
          (r && typeof r === 'object') ? !!r.interpolated : false);
        saveHistCache();
      } catch (e) { /* ignore */ }
      try { delete feeRateErr[tradeId]; } catch (e) { /* ignore */ }
      try { render(); } catch (e) { /* ignore */ }
    } else { feeFailTap(tradeId, key); }
  }, function () { delete histInflight[key]; feeFailTap(tradeId, key); });
}
