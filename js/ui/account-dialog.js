'use strict';
// New-account dialog.

// --- New-account dialog ---
// Name + ticker only (story step one). Wired once; empty-state inline row
// keeps its own acct-* ids so the two never collide.

// Example copy per asset kind: the name and label hints (create dialog and
// the detail-page label editor) adapt so nothing suggests "Cold wallet" for
// a bank, broker or collectible account. Crypto keeps the original wording.
var ACCOUNT_KIND_EXAMPLES = {
  crypto: { name: 'e.g. Cold wallet', label: 'e.g. cold storage' },
  stock: { name: 'e.g. etoro', label: 'e.g. brokerage account' },
  commodity: { name: 'e.g. My Vault', label: 'e.g. bank vault' },
  custom: { name: 'e.g. My wallet', label: 'e.g. collectible' },
  cash: { name: 'e.g. Org. Name', label: 'e.g. company account' }
};

function accountKindExample(kind, field) {
  var e = ACCOUNT_KIND_EXAMPLES[String(kind || '').toLowerCase()] || ACCOUNT_KIND_EXAMPLES.crypto;
  return e[field] || ACCOUNT_KIND_EXAMPLES.crypto[field];
}

function naError(msg) {
  dockError('na-error', msg);
}

function buildAccountDialog() {
  var host = document.getElementById('account-dialog-body');
  if (!host || document.getElementById('na-create')) return;
  wireDialog('account-dialog');
  // Aborting a group-flow creation must not leak the pending selection
  // into a later, unrelated account creation.
  try {
    var adlg = document.getElementById('account-dialog');
    if (adlg && !adlg.getAttribute('data-group-wired')) {
      adlg.setAttribute('data-group-wired', '1');
      adlg.addEventListener('close', function () { pendingGroupIds = null; });
    }
  } catch (e) { /* ignore */ }
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<label for="na-name">Account name</label>' +
    '<input id="na-name" autocomplete="off" spellcheck="false" placeholder="' + accountKindExample('cash', 'name') + '">' +
    '<label for="na-kind">Asset type</label>' +
    '<select id="na-kind"><option value="cash">Cash</option><option value="crypto">Crypto (live via CoinGecko)</option><option value="stock">Stock / ETF (live prices)</option><option value="commodity">Commodity / Metal (live prices)</option><option value="custom">Custom (manual price only)</option></select>' +
    '<div id="na-ticker-row"><label for="na-ticker">Ticker</label>' +
    '<input id="na-ticker" autocomplete="off" spellcheck="false" placeholder="e.g. BTC"></div>' +
    '<div id="na-fiat-row" hidden><label for="na-fiat">Currency</label>' +
    '<select id="na-fiat"><option value="EUR">EUR</option><option value="USD">USD</option><option value="GBP">GBP</option><option value="CHF">CHF</option><option value="RON">RON</option><option value="CUSTOM">Other…</option></select></div>' +
    '<div id="na-fiatcode-row" hidden><label for="na-fiatcode">Currency code</label>' +
    '<input id="na-fiatcode" autocomplete="off" spellcheck="false" placeholder="Code, e.g. JPY"></div>' +
    '<label for="na-address">Label (optional)</label>' +
    '<input id="na-address" autocomplete="off" spellcheck="false" placeholder="' + accountKindExample('cash', 'label') + '">' +
    dockMarkup('na-error', 'Create account', 'na-create', 'button');
  host.appendChild(wrap);
  function syncAccountKindUI() {
    // Cash is the first option, so it is the default when the dialog opens.
    var kindNow = uiVal('na-kind', 'cash');
    var isCash = kindNow === 'cash';
    var tRow = document.getElementById('na-ticker-row');
    if (tRow) tRow.hidden = isCash;
    // Ticker hint follows the asset kind so the example is always relevant.
    var tick = document.getElementById('na-ticker');
    if (tick) {
      tick.placeholder = kindNow === 'stock' ? 'e.g. SPCX'
        : (kindNow === 'commodity' ? 'e.g. XAU' : 'e.g. BTC');
    }
    // Name + label examples follow the asset kind too.
    var nmEl = document.getElementById('na-name');
    if (nmEl) nmEl.setAttribute('placeholder', accountKindExample(kindNow, 'name'));
    var labEl = document.getElementById('na-address');
    if (labEl) labEl.setAttribute('placeholder', accountKindExample(kindNow, 'label'));
    var fRow = document.getElementById('na-fiat-row');
    if (fRow) fRow.hidden = !isCash;
    var fcRow = document.getElementById('na-fiatcode-row');
    var needCustom = isCash && uiVal('na-fiat', 'EUR') === 'CUSTOM';
    if (fcRow) fcRow.hidden = !needCustom;
  }
  document.getElementById('na-kind').addEventListener('change', syncAccountKindUI);
  document.getElementById('na-fiat').addEventListener('change', syncAccountKindUI);
  syncAccountKindUI();
  document.getElementById('na-create').addEventListener('click', function () {
    naError(null);
    var kind = uiVal('na-kind', 'cash');
    var tk;
    if (kind === 'cash') {
      var fiat = uiVal('na-fiat', 'EUR');
      tk = (fiat === 'CUSTOM' ? uiVal('na-fiatcode', '').trim().toUpperCase() : String(fiat).toUpperCase());
      if (!isValidCurrencyCode(tk)) { naError('Pick a currency for the cash account (or enter a 2–10 letter code).'); return; }
    } else {
      tk = uiVal('na-ticker', '').trim().toUpperCase();
      if (!tk) { naError('Ticker is required (e.g. BTC).'); return; }
      if (!/^[A-Z0-9._-]{1,12}$/.test(tk)) { naError('Ticker looks invalid — letters/numbers, up to 12 chars.'); return; }
    }
    var hadTrades = (loadState().trades || []).length > 0;
    var acc = createAccount(uiVal('na-name', ''), tk, kind, { address: uiVal('na-address', '') });
    if (!acc) { naError('Could not create the account — storage unavailable.'); return; }
    // Group flow: the new account becomes the main for the pending selection.
    if (pendingGroupIds && pendingGroupIds.length) {
      var pg = pendingGroupIds;
      pendingGroupIds = null;
      try {
        var st2 = loadState();
        var gerr = assignGroup(st2, pg, acc.id);
        if (gerr) { naError(gerr); }
        else if (!saveStateGuarded(st2)) { naError('Storage unavailable — accounts were not grouped.'); }
        else {
          uiSetVal('na-name', '');
          uiSetVal('na-ticker', '');
          uiSetVal('na-address', '');
          uiSetVal('na-fiatcode', '');
          closeDialog('account-dialog');
          clearBanner();
          selectedAccounts = {};
          selectionMode = false;
          navTo(acc.id);
          render();
          return;
        }
      } catch (e) { /* fall through to the normal close below */ }
    }
    uiSetVal('na-name', '');
    uiSetVal('na-ticker', '');
    uiSetVal('na-address', '');
    uiSetVal('na-fiatcode', '');
    closeDialog('account-dialog');
    // Story guidance: first account + no trades yet → continue straight
    // to Step 2 instead of leaving the user on a quiet screen.
    if (!hadTrades) openPrefillTrade(acc.id, true);
  });
}
