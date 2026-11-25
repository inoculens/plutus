'use strict';
// Routing: home vs account detail, with clean /account/<id> URLs (History API)
// and a hash fallback for file:// and legacy links.

// --- Account detail view (list → detail navigation) ---
// Home shows minimal folder cards; clicking one routes to #/account/<id>
// and this renders the full account page: header, figures, stacked position
// facts and trades, and a ··· menu (trade / default / rename / delete).
// Facts carry data-label/data-value, so numbers read top to bottom and the
// FX conversion always gets its own line. Unknown account id routes home.

function historyOK() {
  try {
    return typeof history !== 'undefined' && !!history.pushState &&
      String((typeof location !== 'undefined' && location.protocol) || '').indexOf('http') === 0;
  } catch (e) { return false; }
}

// Current account route, history path first (clean production URLs), hash
// fallback (file://, tests, legacy links).
// decodeURIComponent throws URIError on a malformed escape such as "%" or
// "%E0%A4%A". Anyone can type or share such a link, and route() runs during
// boot, so a throw here would leave the app blank. Malformed ids count as "no
// account route".
function safeDecodeRouteId(raw) {
  try { return decodeURIComponent(raw); } catch (e) { return null; }
}

function currentRouteId() {
  try {
    var p = String((typeof location !== 'undefined' && location.pathname) || '');
    var m = /^\/account\/([^\/?#]+)/.exec(p);
    if (m) {
      var id = safeDecodeRouteId(m[1]);
      if (id !== null) return id;
    }
  } catch (e) { /* fall through to hash */ }
  return accountDetailIdHash();
}

function accountDetailIdHash() {
  var h = String((typeof location !== 'undefined' && location.hash) || '');
  var hm = /^#\/account\/([^\/?#]+)/.exec(h);
  return hm ? safeDecodeRouteId(hm[1]) : null;
}

function accountDetailId() {
  return currentRouteId();
}

function navTo(id) {
  if (historyOK()) {
    try {
      history.pushState({ accountId: id || null }, '', id ? '/account/' + encodeURIComponent(id) : '/');
      route();
      return;
    } catch (e) { /* fall through to hash */ }
  }
  if (typeof location !== 'undefined') location.hash = id ? '#/account/' + encodeURIComponent(id) : '#/';
  route();
}

function navHome() {
  navTo(null);
}

// Account id route() last painted. Scroll resets only when this changes
// (real navigation); re-renders of the same page keep the scroll position.
var lastRouteId = null;

function route() {
  var home = document.getElementById('view-home');
  var det = document.getElementById('view-account');
  if (!home || !det) return;
  var id = accountDetailId();
  // Record selection belongs to the account page: it ends when the reader
  // leaves it (or opens another account). A drag in flight is abandoned too.
  if (tradeSelectionMode) {
    var leaving = !id || (lastRouteId !== null && lastRouteId !== id);
    if (leaving) {
      tradeSelectionMode = false;
      selectedTrades = {};
      tradeActionOpen = false;
      tradeDragCleanup();
    }
  }
  if (id) {
    home.hidden = true;
    det.hidden = false;
    var st;
    try {
      st = loadState();
    } catch (e) {
      st = defaultState();
    }
    if (!st || !st.settings) st = defaultState();
    renderAccountDetail(st, id);
    var acc = accountById(st, id);
    try { document.title = (acc ? acc.name + ' · ' + String(acc.ticker).toUpperCase() + ' — ' : '') + 'INOCULENS PLUTUS'; } catch (e) { /* ignore */ }
    var back = document.getElementById('acct-back');
    if (back && typeof back.focus === 'function') {
      try {
        if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.account-card')) back.focus({ preventScroll: true });
      } catch (e) { /* ignore */ }
    }
    // Scroll reset belongs to navigation only: every in-page interaction
    // (filter, pager, per-page, checkboxes) re-renders through here, and
    // yanking to top each time is the snap. Home never scrolls on
    // interaction — same rule here: reset only when the page changed.
    if (lastRouteId !== id) {
      try { if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    }
    lastRouteId = id;
  } else {
    det.hidden = true;
    home.hidden = false;
    try { document.title = 'INOCULENS PLUTUS — Local-First Portfolio Tracker'; } catch (e) { /* ignore */ }
    lastRouteId = null;
  }
  // Views just toggled: hidden-while-rendered content (e.g. the hero after
  // deleting the open account) measures zero until now — sync sizes now that
  // the right view is visible.
  try { syncHeroAllocHeight(); } catch (e) { /* ignore */ }
  // Route rebuilds rows (fresh ⓘ dots start visible): gate them now, so hash
  // navigation never flashes dots that have nothing to show.
  try { syncInfoDots(); } catch (e) { /* ignore */ }
  // The pinned-corner caps lift for pills that wrapped under the buttons:
  // needs a fresh measurement after every layout change.
  try { syncTradeHeadRows(); } catch (e) { /* ignore */ }
  syncTradeFab();
}

// Trade entry lives inside accounts only; first-run onboarding keeps its own CTA.
function syncTradeFab() {
  var st = null;
  try {
    st = peekState();
  } catch (e) {
    st = null;
  }
  if (!st || !st.settings) {
    try {
      st = defaultState();
    } catch (e2) {
      st = { settings: {}, accounts: [], trades: [] };
    }
  }
  var id = null;
  try {
    id = accountDetailId();
  } catch (e) {
    id = null;
  }
  var inAccount = !!id && !!accountById(st, id);
  var hasAccts = Array.isArray(st.accounts) && st.accounts.length > 0;
  var hasTrades = Array.isArray(st.trades) && st.trades.length > 0;
  var fab = document.getElementById('fab-trade');
  if (fab) fab.hidden = !(inAccount && hasAccts && hasTrades);
}
