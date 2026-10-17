'use strict';
/* INOCULENS PLUTUS — app.js
 * Vanilla JS, no framework, no build step. Organized in sections:
 * Store, Prices, Fx, Ledger, Ui. Tasks 3-6 append their sections below.
 */

// === Store ===
// Local-first persistence: localStorage + versioned export/import.
// Key: exactly 'inoculens.v2' (v1 is never read at runtime; v1 files import
// via the grouping branch in importState). Export envelope: exactly
// {app:"inoculens-plutus", version:2, exportedAt, settings, accounts, trades, priceOverrides}.
// Failed imports throw Error(reason) and leave stored data untouched.

var STORAGE_KEY = 'inoculens.v2';
var APP_ID = 'inoculens-plutus';
var STORE_VERSION = 2;

function defaultState() {
  return {
    settings: { mainCurrency: 'EUR', costMethod: 'average', assetLedgers: true },
    accounts: [],
    trades: [],
    priceOverrides: {}
  };
}

var MAIN_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'RON'];

function isValidDateStr(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  var p = d.slice(0, 10).split('-');
  var y = Number(p[0]);
  var m = Number(p[1]);
  var day = Number(p[2]);
  if (!isFinite(y) || !isFinite(m) || !isFinite(day)) return false;
  if (m < 1 || m > 12 || day < 1 || day > 31) return false;
  var t = Date.UTC(y, m - 1, day);
  if (!isFinite(t)) return false;
  var chk = new Date(t);
  return chk.getUTCFullYear() === y && (chk.getUTCMonth() + 1) === m && chk.getUTCDate() === day;
}

function isFutureDateStr(d) {
  if (!isValidDateStr(d)) return false;
  var n = new Date();
  var mm = n.getMonth() + 1;
  var dd = n.getDate();
  var today = n.getFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
  return d.slice(0, 10) > today;
}

function isValidSettings(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.mainCurrency === 'string' && MAIN_CURRENCIES.indexOf(v.mainCurrency.toUpperCase()) !== -1 &&
    (v.costMethod === 'average' || v.costMethod === 'fifo');
}

function isValidAccount(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  if (typeof a.id !== 'string' || a.id.length === 0) return false;
  if (typeof a.name !== 'string' || a.name.trim().length === 0) return false;
  if (typeof a.ticker !== 'string') return false;
  var tk = a.ticker.trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,12}$/.test(tk)) return false;
  if (a.kind !== undefined && a.kind !== null && String(a.kind).trim() !== '') {
    var kd = String(a.kind).trim().toLowerCase();
    if (kd !== 'crypto' && kd !== 'stock' && kd !== 'commodity' && kd !== 'custom' && kd !== 'cash') return false;
  }
  return true;
}

function normalizeAccount(a) {
  var tk = String(a.ticker || '').trim().toUpperCase();
  var nm = String(a.name == null ? '' : a.name).trim() || tk;
  var kd = (a && typeof a.kind === 'string') ? a.kind.trim().toLowerCase() : 'crypto';
  if (kd !== 'crypto' && kd !== 'stock' && kd !== 'commodity' && kd !== 'custom' && kd !== 'cash') kd = 'crypto';
  var out = {
    id: a.id,
    name: nm,
    ticker: tk,
    kind: kd,
    createdAt: (typeof a.createdAt === 'string' && a.createdAt.length > 0)
      ? a.createdAt
      : new Date().toISOString()
  };
  if (a && typeof a.address === 'string' && a.address.trim() !== '') out.address = a.address.trim().slice(0, 128);
  if (a && typeof a.note === 'string' && a.note.trim() !== '') out.note = a.note.trim().slice(0, 280);
  if (a && isValidHexColor(a.color)) out.color = String(a.color).trim().toUpperCase();
  // Own ledger chart (bookkeeping): absent means "use the global default".
  // Invalid maps are dropped to the default rather than breaking the account.
  if (a && a.ledgers !== undefined && a.ledgers !== null && a.ledgers && typeof a.ledgers === 'object' && !Array.isArray(a.ledgers)) {
    var nl = normalizeLedgerLabels(a.ledgers);
    if (Object.keys(nl).length) out.ledgers = nl;
  }
  // Group link: members carry their main account's id. Self-links and
  // non-strings are dropped; dangling links simply match no main.
  if (typeof a.groupId === 'string' && a.groupId.trim() !== '' && a.groupId !== a.id) out.groupId = a.groupId;
  // Group ledger currency (mains): a MAIN_CURRENCIES fiat, else dropped.
  if (typeof a.groupCurrency === 'string' && MAIN_CURRENCIES.indexOf(a.groupCurrency.trim().toUpperCase()) !== -1) {
    out.groupCurrency = a.groupCurrency.trim().toUpperCase();
  }
  return out;
}

// Flat groups, guaranteed: an account that is both a member (live main)
// and a main (has members) loses its member link and stays a main — one
// main, one round of subs, never nested. In-memory only (load + import
// repair pattern): accounts and records are never deleted, dangling links
// stay (they match no main and render standalone).
function sanitizeGroups(accounts) {
  var list = accounts || [];
  var byId = {};
  list.forEach(function (a) { if (a && a.id) byId[a.id] = a; });
  list.filter(function (a) {
    if (!a || typeof a.groupId !== 'string' || a.groupId === '') return false;
    var main = byId[a.groupId];
    if (!main || main === a) return false;
    return list.some(function (m) { return m && m.groupId === a.id; });
  }).forEach(function (a) {
    try { delete a.groupId; } catch (e) { a.groupId = undefined; }
  });
  return list;
}

function normalizeAccountFilter(v) {
  if (v === undefined || v === null) return null; // null = show all assets
  if (!Array.isArray(v)) return null;
  var seen = {};
  var out = [];
  v.forEach(function (t) {
    var u = String(t === undefined || t === null ? '' : t).trim().toUpperCase();
    if (!isValidSymbolCode(u) || seen[u]) return;
    seen[u] = true;
    out.push(u);
  });
  return out; // [] = none selected
}

function normalizeSettings(s, fallback) {
  var fb = fallback || { mainCurrency: 'EUR', costMethod: 'average', assetLedgers: true };
  if (!isValidSettings(s)) {
    var outFb = { mainCurrency: fb.mainCurrency, costMethod: fb.costMethod, assetLedgers: (fb.assetLedgers === false) ? false : true };
    var fbf = normalizeAccountFilter(fb.accountFilter);
    if (fbf !== null) outFb.accountFilter = fbf;
    return outFb;
  }
  var res = {
    mainCurrency: String(s.mainCurrency).toUpperCase(),
    costMethod: s.costMethod,
    assetLedgers: (s.assetLedgers === false) ? false : true
  };
  var flt = normalizeAccountFilter(s.accountFilter);
  if (flt !== null) res.accountFilter = flt;
  // Default chart of accounts: code -> label. Bad keys are dropped
  // individually; valid entries persist through export/import.
  if (s.ledgerLabels !== undefined && s.ledgerLabels !== null && s.ledgerLabels && typeof s.ledgerLabels === 'object' && !Array.isArray(s.ledgerLabels)) {
    res.ledgerLabels = normalizeLedgerLabels(s.ledgerLabels);
  }
  return res;
}

function loadState() {
  var fallback = defaultState();
  var raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    return fallback;
  }
  if (raw === null || raw === undefined) return fallback;
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  var accounts = Array.isArray(parsed.accounts)
    ? sanitizeGroups(parsed.accounts.filter(isValidAccount).map(normalizeAccount))
    : [];
  var accountIds = accounts.map(function (a) { return a.id; });
  var trades = Array.isArray(parsed.trades)
    ? parsed.trades.filter(function (t) { return isValidImportTrade(t, accountIds); }).map(normalizeTradeForStore)
    : [];
  try { repairCashTradeAmounts(trades, accounts); } catch (e) { /* repair never breaks load */ }
  var priceOverrides = {};
  if (parsed.priceOverrides && typeof parsed.priceOverrides === 'object' && !Array.isArray(parsed.priceOverrides) && isValidPriceOverrides(parsed.priceOverrides)) {
    priceOverrides = parsed.priceOverrides;
  }
  var settings = normalizeSettings(parsed.settings, fallback.settings);
  return {
    settings: settings,
    accounts: accounts,
    trades: trades,
    priceOverrides: priceOverrides
  };
}

function saveState(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    throw new Error('storage-unavailable');
  }
  // Any persisted change may make the drive copy stale: let auto-sync
  // (opt-in, Sync tab) schedule an encrypted push. Never breaks saving.
  try { syncScheduleAuto(); } catch (e) { /* ignore */ }
}

var TRADE_TYPES = ['buy', 'sell', 'transfer', 'income', 'expense'];

function isValidCurrencyCode(c) {
  if (typeof c !== 'string') return false;
  var u = c.trim().toUpperCase();
  if (u === 'CUSTOM') return false;
  return /^[A-Z]{2,10}$/.test(u);
}

function isValidSymbolCode(s) {
  if (typeof s !== 'string') return false;
  var u = s.trim().toUpperCase();
  return /^[A-Z0-9._-]{1,12}$/.test(u);
}

function isValidHexColor(v) {
  return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

function contrastText(hex) {
  var h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var r = parseInt(h.slice(0, 2), 16);
  var g = parseInt(h.slice(2, 4), 16);
  var b = parseInt(h.slice(4, 6), 16);
  if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return '#1a1408';
  return ((r * 299 + g * 587 + b * 114) / 1000) >= 128 ? '#1a1408' : '#ffffff';
}

function numGte0(v, allowEmpty) {
  if (v === undefined || v === null || String(v).trim() === '') return allowEmpty ? null : false;
  if (typeof v !== 'number' && typeof v !== 'string') return false;
  var n = Number(v);
  if (!isFinite(n) || n < 0) return false;
  return n;
}

// Optional on-chain transaction hash, stored on the trade and linked to
// mempool.space in the record view. Blank/missing means absent (valid);
// when present it must look like a real hash: optional 0x prefix, then
// 8–128 alphanumerics (covers 64-hex BTC, 0x EVM and base58-style ids).
function isValidTxid(v) {
  if (v === undefined || v === null || String(v).trim() === '') return true;
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  return /^(0x)?[A-Za-z0-9]{8,128}$/.test(String(v).trim());
}

// --- Record attachments (invoices / receipts) ---
// One file per record: PDF, PNG or JPG, max ATTACH_MAX_BYTES. The trade
// carries only small metadata {name, mime, size, hash}; the binary lives
// in IndexedDB (never in localStorage, which caps at ~5-10 MB per origin).
// Cloud sync / zip backup (phase 2) move the same blobs by content hash.
var ATTACH_MAX_BYTES = 10 * 1024 * 1024;
var ATTACH_MIMES = ['application/pdf', 'image/png', 'image/jpeg'];
function isValidAttachment(v) {
  if (v === undefined || v === null) return true; // absent is valid
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  if (typeof v.name !== 'string' || v.name.trim().length < 1 || v.name.trim().length > 120) return false;
  if (ATTACH_MIMES.indexOf(String(v.mime)) === -1) return false;
  if (typeof v.size !== 'number' || !isFinite(v.size) || v.size <= 0 || v.size > ATTACH_MAX_BYTES) return false;
  if (typeof v.hash !== 'string' || !/^[0-9a-f]{8,64}$/.test(v.hash)) return false;
  return true;
}
// Small promise-free IndexedDB blob store keyed by content hash.
// Every helper resolves (never rejects) so a missing/private-mode IDB can
// never break saving: callers treat null/false as "blob unavailable".
var ATTACH_DB = 'inoculens.plutus.attachments';
var ATTACH_STORE = 'blobs';
function attDb() {
  return new Promise(function (resolve) {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      var req = indexedDB.open(ATTACH_DB, 1);
      req.onupgradeneeded = function () {
        try { req.result.createObjectStore(ATTACH_STORE); } catch (e) { /* exists */ }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    } catch (e) { resolve(null); }
  });
}
function attPut(hash, blob, meta) {
  return attDb().then(function (db) {
    if (!db) return false;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(ATTACH_STORE, 'readwrite');
        tx.oncomplete = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(true); };
        tx.onerror = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(false); };
        tx.objectStore(ATTACH_STORE).put({ hash: hash, blob: blob, name: meta.name, mime: meta.mime, size: meta.size, createdAt: new Date().toISOString() }, hash);
      } catch (e) { try { db.close(); } catch (e2) { /* ignore */ } resolve(false); }
    });
  });
}
function attGet(hash) {
  return attDb().then(function (db) {
    if (!db) return null;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(ATTACH_STORE, 'readonly');
        var rq = tx.objectStore(ATTACH_STORE).get(hash);
        rq.onsuccess = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(rq.result || null); };
        rq.onerror = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(null); };
      } catch (e) { try { db.close(); } catch (e2) { /* ignore */ } resolve(null); }
    });
  });
}
function attDelete(hash) {
  return attDb().then(function (db) {
    if (!db) return false;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(ATTACH_STORE, 'readwrite');
        tx.oncomplete = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(true); };
        tx.onerror = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(false); };
        tx.objectStore(ATTACH_STORE).delete(hash);
      } catch (e) { try { db.close(); } catch (e2) { /* ignore */ } resolve(false); }
    });
  });
}
function attHashBytes(buf) {
  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) { var h = bytes[i].toString(16); s += (h.length < 2 ? '0' : '') + h; }
    return s;
  }
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', buf).then(function (d) { return hex(new Uint8Array(d)); });
    }
  } catch (e) { /* fall through to FNV */ }
  return Promise.resolve().then(function () {
    var b = new Uint8Array(buf);
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 16777619) >>> 0; h2 = Math.imul(h2 + b[i], 16777619) >>> 0; }
    function p(n) { var s = n.toString(16); while (s.length < 8) s = '0' + s; return s; }
    return (p(h1) + p(h2)).toLowerCase();
  });
}

// --- Cash ledgers (bookkeeping) ---
// Ledger codes are free-form: any printable label the user wants
// ('1000', '1100', '1110', '3000 VAT', …). Hierarchy nests by prefix, with
// digit-level parents for numeric schemes (1110 under 1100 under 1000) —
// so any numbering scheme rolls up correctly.
function isValidLedgerCode(v) {
  if (v === undefined || v === null || String(v).trim() === '') return true;
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  var s = String(v).trim();
  if (s.length < 1 || s.length > 24) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  return true;
}

function isValidLedgerLabel(v) {
  if (v === undefined || v === null || String(v).trim() === '') return true;
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  return String(v).trim().length <= 80;
}

function isValidLedgerLabels(map) {
  if (map === undefined || map === null) return true;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  var keys = Object.keys(map);
  if (keys.length > 500) return false;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (typeof k !== 'string' || k.trim() === '' || k.trim().length > 24) return false;
    var lv = map[k];
    if (typeof lv !== 'string' || lv.trim() === '' || lv.trim().length > 80) return false;
  }
  return true;
}

function normalizeLedgerLabels(map) {
  var out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  Object.keys(map).forEach(function (k) {
    if (typeof k !== 'string') return;
    var ck = k.trim();
    if (ck === '' || ck.length > 24) return;
    var lv = map[k];
    if (typeof lv !== 'string' || lv.trim() === '' || lv.trim().length > 80) return;
    out[ck] = lv.trim();
  });
  return out;
}

function isCashKind(k) {
  return String(k === undefined || k === null ? '' : k).trim().toLowerCase() === 'cash';
}

function isCashAccount(st, id) {
  var a = accountById(st, id);
  return !!a && isCashKind(a.kind);
}

// Effective ledger chart for an account: its own chart when present,
// otherwise the global default. Own charts diverge by copy-on-first-edit,
// so accounts stay strictly isolated after diverging.
function ledgerChartFor(st, accountId) {
  try {
    var acc = accountById(st, accountId);
    if (acc && acc.ledgers && typeof acc.ledgers === 'object' && !Array.isArray(acc.ledgers)) {
      return normalizeLedgerLabels(acc.ledgers);
    }
    return normalizeLedgerLabels(st && st.settings ? st.settings.ledgerLabels : null);
  } catch (e) { return {}; }
}

// Ensure the account owns its chart: snapshot the current effective chart
// on first per-account change, then hand back the live map to edit.
function ensureAccountChart(st, accountId) {
  var acc = accountById(st, accountId);
  if (!acc) return {};
  if (!acc.ledgers || typeof acc.ledgers !== 'object' || Array.isArray(acc.ledgers)) {
    acc.ledgers = ledgerChartFor(st, accountId);
  }
  return acc.ledgers;
}

// --- Account groups (organisation of bank accounts and more) ---
// Members link to their main via groupId; records never move on grouping —
// the main view only aggregates. Flat by design: a main can never join
// another group (nesting is refused in assignGroup).
function groupMembers(st, mainId) {
  if (!st || !mainId || !accountById(st, mainId)) return [];
  return ((st.accounts) || []).filter(function (a) {
    return !!a && a.id !== mainId && typeof a.groupId === 'string' && a.groupId === mainId;
  });
}

// The live main of a grouped account, or null (standalone, dangling or
// self link). Use this — never the raw groupId — to decide member views.
function groupMainOf(st, id) {
  if (!st || !id) return null;
  var acc = accountById(st, id);
  if (!acc || typeof acc.groupId !== 'string' || acc.groupId === '' || acc.groupId === id) return null;
  return accountById(st, acc.groupId);
}

function isGroupMain(st, id) {
  return groupMembers(st, id).length > 0;
}

// Group ledger currency: a cash main's own fiat, else the header fiat at
// merge time. Always a MAIN_CURRENCIES fiat, never the asset ticker.
function defaultGroupCurrency(st, mainAcc) {
  var t = mainAcc && typeof mainAcc.ticker === 'string' ? mainAcc.ticker.trim().toUpperCase() : '';
  if (mainAcc && isCashKind(mainAcc.kind) && MAIN_CURRENCIES.indexOf(t) !== -1) return t;
  var m = st && st.settings ? String(st.settings.mainCurrency || '').toUpperCase() : '';
  return MAIN_CURRENCIES.indexOf(m) !== -1 ? m : 'EUR';
}

// Read the main's group currency, persisting the default when absent.
function ensureGroupCurrency(st, mainId) {
  var acc = accountById(st, mainId);
  if (!acc) return 'EUR';
  var g = typeof acc.groupCurrency === 'string' ? acc.groupCurrency.trim().toUpperCase() : '';
  if (MAIN_CURRENCIES.indexOf(g) !== -1) return g;
  g = defaultGroupCurrency(st, acc);
  acc.groupCurrency = g;
  return g;
}

// Link members under a main (mutates, no save): flat only — mains can't
// nest and sub-accounts can't be grouped. Unknown ids and self-links fail.
function assignGroup(st, memberIds, mainId) {
  var main = accountById(st, mainId);
  if (!main) return 'Main account not found.';
  if (groupMainOf(st, mainId)) return '"' + main.name + '" is already grouped — ungroup it first or pick another main.';
  var seen = {};
  var ids = [];
  (memberIds || []).forEach(function (id) {
    if (typeof id !== 'string' || id === '' || id === mainId || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  });
  for (var i = 0; i < ids.length; i++) {
    var a = accountById(st, ids[i]);
    if (!a) return 'Account not found.';
    if (isGroupMain(st, ids[i])) return '"' + a.name + '" is already a main account — ungroup it first.';
    if (groupMainOf(st, ids[i])) return '"' + a.name + '" is a sub-account and cannot be grouped.';
  }
  ids.forEach(function (id) { accountById(st, id).groupId = mainId; });
  ensureGroupCurrency(st, mainId);
  return null;
}

// Release every member of a main (mutates, no save). Records and charts
// stay exactly where they are.
function ungroupAll(st, mainId) {
  var n = 0;
  groupMembers(st, mainId).forEach(function (a) {
    try { delete a.groupId; } catch (e) { a.groupId = undefined; }
    n++;
  });
  return n;
}

// Delete scope: ids plus the members of any main among them, so removing
// a main removes its whole group (records included). Pure.
function expandDeleteIds(st, ids) {
  var set = {};
  (ids || []).forEach(function (id) {
    if (typeof id === 'string' && id !== '' && accountById(st, id)) set[id] = true;
  });
  Object.keys(set).forEach(function (id) {
    groupMembers(st, id).forEach(function (m) { set[m.id] = true; });
  });
  return Object.keys(set);
}

// Fresh sub-account name under a main: sub-<name>, sub-<name> 2, …
function uniqueSubName(st, base) {
  base = String(base === undefined || base === null ? '' : base).trim() || 'Account';
  var taken = {};
  ((st && st.accounts) || []).forEach(function (a) {
    if (a && typeof a.name === 'string') taken[a.name] = true;
  });
  var nm = 'sub-' + base;
  if (!taken[nm]) return nm;
  var i = 2;
  while (taken['sub-' + base + ' ' + i]) i++;
  return 'sub-' + base + ' ' + i;
}

// Global asset-ledgers switch. Absent (legacy states) means ON.
function assetLedgersOn(st) {
  return !st || !st.settings || st.settings.assetLedgers !== false;
}

function cashAccountIds(st) {
  var out = {};
  ((st && st.accounts) || []).forEach(function (a) {
    if (a && a.id && isCashKind(a.kind)) out[a.id] = true;
  });
  return out;
}

function txExplorerUrl(txid) {
  return 'https://mempool.space/tx/' + encodeURIComponent(String(txid).trim());
}

function shortTxid(txid) {
  var s = String(txid).trim();
  if (s.length <= 20) return s;
  return s.slice(0, 8) + '…' + s.slice(-6);
}

// --- Multi-recipient transfers (one on-chain tx, N recipients) ---
// A transfer may carry `outputs`: one entry per recipient of the same tx.
// Internal entries move into an own account ({toAccountId, qty}); external
// entries pay someone else ({label, qty, spend}). Each row may attribute
// part of the tx fee ({fee}, optional — blank means unattributed shared
// fee). Row qty is always denominated in the SOURCE symbol (for a cash
// cross-fiat row it is the sent portion; the converted arrival rides
// {toQty, toSymbol}). Top-level qty is the total leaving the source:
// sum(row qty) + networkFee == qty. Absent/empty outputs = legacy behavior
// (single toAccountId, or a same-account on-chain move when no dest).
// External rows default to spend:true (expense-like: cost books as a loss);
// spend:false is a neutral hand-over (holdings drop, no P&L beyond the fee).
var TRANSFER_MAX_OUTPUTS = 20;
var TRANSFER_LABEL_MAX = 80;

function isTransferOutputInternal(o) {
  return !!o && typeof o.toAccountId === 'string' && o.toAccountId.trim() !== '';
}

function transferOutputsSum(outs) {
  var q = 0, f = 0;
  (outs || []).forEach(function (o) {
    var rq = o ? Number(o.qty) : NaN;
    if (isFinite(rq) && rq > 0) q += rq;
    var rf = (o && o.fee !== undefined && o.fee !== null && String(o.fee).trim() !== '') ? Number(o.fee) : 0;
    if (isFinite(rf) && rf > 0) f += rf;
  });
  return { qty: q, fee: f };
}

// Arrival credited to an internal destination: same-ticker rows arrive as
// qty; a cash cross-fiat row arrives as its converted toQty.
function transferRowArrival(o, symbol) {
  if (!o) return 0;
  var symU = String(symbol || '').toUpperCase();
  var toU = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
    ? symU : String(o.toSymbol).trim().toUpperCase();
  if (toU !== symU) {
    var cross = Number(o.toQty);
    return (isFinite(cross) && cross > 0) ? cross : 0;
  }
  var q = Number(o.qty);
  return (isFinite(q) && q > 0) ? q : 0;
}

// Normalized recipient list: stored outputs win; otherwise a legacy single
// destination degrades to one row; no destination at all means a
// same-account move (no rows — only the fee leaves).
function transferOutputsOf(t) {
  if (t && Array.isArray(t.outputs) && t.outputs.length) return t.outputs;
  var hasTo = t && t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
  if (t && t.type === 'transfer' && hasTo) {
    var symU = String(t.symbol || '').toUpperCase();
    var toU = (t.toSymbol === undefined || t.toSymbol === null || String(t.toSymbol).trim() === '')
      ? symU : String(t.toSymbol).trim().toUpperCase();
    if (toU !== symU) {
      var sent = Number(t.qty);
      var tq = Number(t.toQty);
      var row = { toAccountId: String(t.toAccountId).trim(), qty: (isFinite(sent) && sent > 0) ? sent : 0 };
      if (isFinite(tq) && tq > 0) { row.toQty = tq; row.toSymbol = toU; }
      return [row];
    }
    var sent2 = Number(t.qty);
    var nfRaw = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
    var nf = (isFinite(nfRaw) && nfRaw >= 0) ? nfRaw : 0;
    var recv = (isFinite(sent2) && sent2 > 0) ? sent2 - nf : NaN;
    return [{ toAccountId: String(t.toAccountId).trim(), qty: (isFinite(recv) && recv > 0) ? recv : 0 }];
  }
  return [];
}

function transferDestIds(t) {
  var seen = {};
  var out = [];
  function add(id) {
    var s = String(id === undefined || id === null ? '' : id).trim();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  }
  if (t && Array.isArray(t.outputs)) {
    t.outputs.forEach(function (o) { if (isTransferOutputInternal(o)) add(o.toAccountId); });
  }
  if (t && t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '') add(t.toAccountId);
  return out;
}

function transferInvolvesAccount(t, id) {
  if (!t || typeof id !== 'string' || id === '') return false;
  if (t.accountId === id) return true;
  return transferDestIds(t).indexOf(id) !== -1;
}

// Amount of this transfer credited to one internal destination (0 when the
// account is not a recipient). Covers legacy single-dest trades too.
function transferArrivalFor(t, accountId) {
  if (!t || t.type !== 'transfer' || typeof accountId !== 'string' || accountId === '') return 0;
  if (t.accountId === accountId) return 0;
  var sum = 0;
  var outs = transferOutputsOf(t);
  for (var i = 0; i < outs.length; i++) {
    var o = outs[i];
    if (isTransferOutputInternal(o) && String(o.toAccountId).trim() === accountId) {
      sum += transferRowArrival(o, t.symbol);
    }
  }
  return sum;
}

// Structural check for one recipient row. accountIds (when supplied) is the
// known-account roster; sourceId guards the no-self-payment rule.
function isValidTransferOutput(o, symbol, sourceId, accountIds) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  var internal = isTransferOutputInternal(o);
  var hasLabel = o.label !== undefined && o.label !== null && String(o.label).trim() !== '';
  if (internal === hasLabel) return false; // exactly one of account / label
  if (internal) {
    if (typeof o.toAccountId !== 'string') return false;
    var id = o.toAccountId.trim();
    if (id === '' || id === sourceId) return false;
    if (accountIds !== undefined) {
      if (!Array.isArray(accountIds)) return false;
      if (accountIds.indexOf(id) === -1) return false;
    }
  } else {
    if (typeof o.label !== 'string') return false;
    var lab = o.label.trim();
    if (lab.length < 1 || lab.length > TRANSFER_LABEL_MAX) return false;
    if (o.spend !== undefined && o.spend !== null && typeof o.spend !== 'boolean') return false;
  }
  if (typeof o.qty !== 'number' && typeof o.qty !== 'string') return false;
  var q = Number(o.qty);
  if (!isFinite(q) || q <= 0) return false;
  if (o.fee !== undefined && o.fee !== null && String(o.fee).trim() !== '') {
    if (typeof o.fee !== 'number' && typeof o.fee !== 'string') return false;
    var f = Number(o.fee);
    if (!isFinite(f) || f < 0) return false;
  }
  if (o.toSymbol !== undefined && o.toSymbol !== null && String(o.toSymbol).trim() !== '') {
    if (!isValidSymbolCode(o.toSymbol)) return false;
    if (String(o.toSymbol).trim().toUpperCase() !== String(symbol || '').trim().toUpperCase()) {
      if (o.toQty === undefined || o.toQty === null || String(o.toQty).trim() === '') return false;
      if (typeof o.toQty !== 'number' && typeof o.toQty !== 'string') return false;
      var tq = Number(o.toQty);
      if (!isFinite(tq) || tq <= 0) return false;
    }
  } else if (o.toQty !== undefined && o.toQty !== null && String(o.toQty).trim() !== '') {
    if (typeof o.toQty !== 'number' && typeof o.toQty !== 'string') return false;
    var tq2 = Number(o.toQty);
    if (!isFinite(tq2) || tq2 <= 0) return false;
  }
  return true;
}

function isValidImportTrade(t, accountIds) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  if (TRADE_TYPES.indexOf(t.type) === -1) return false;
  if (!isValidSymbolCode(t.symbol)) return false;
  if (!isValidDateStr(t.date)) return false;
  if (isFutureDateStr(t.date)) return false;
  // fee (fiat) is always optional >= 0 when present
  var feeChk = numGte0(t.fee, true);
  if (feeChk === false) return false;
  if (t.feeCurrency !== undefined && t.feeCurrency !== null && String(t.feeCurrency).trim() !== '') {
    if (!isValidCurrencyCode(t.feeCurrency)) return false;
  }
  // txid is optional metadata; when present it must look like a tx hash
  if (!isValidTxid(t.txid)) return false;
  // attachment (invoice/receipt) is optional metadata; plain trades without
  // it must keep validating — when present it must be well-formed
  if (t.attachment !== undefined && t.attachment !== null && !isValidAttachment(t.attachment)) return false;
  // ledger code + label are optional bookkeeping metadata (cash records);
  // when present they must be well-formed, on every trade type
  if (!isValidLedgerCode(t.ledger)) return false;
  if (!isValidLedgerLabel(t.ledgerLabel)) return false;
  // networkFee: on-chain fee denominated in the transferred asset itself
  if (t.networkFee !== undefined && t.networkFee !== null && String(t.networkFee).trim() !== '') {
    if (typeof t.networkFee !== 'number' && typeof t.networkFee !== 'string') return false;
    var nf = Number(t.networkFee);
    if (!isFinite(nf) || nf < 0) return false;
  }
  if (t.type === 'transfer') {
    if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return false;
    var tq = Number(t.qty);
    if (!isFinite(tq) || tq <= 0) return false;
    var tnf = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
    if (!isFinite(tnf) || tnf < 0 || tnf >= tq) return false; // net received must stay > 0
    if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
      var tt = Number(t.total);
      if (!isFinite(tt) || tt < 0) return false;
    }
    if (t.currency !== undefined && t.currency !== null && String(t.currency).trim() !== '') {
      if (!isValidCurrencyCode(t.currency)) return false;
    }
    // Recipients: either the legacy single destination below, or `outputs`
    // (one entry per recipient of the same tx). Both at once are rejected
    // so stored records always have a single source of truth. Without either
    // the transfer is an on-chain move inside the same account (e.g.
    // sweeping to a fresh address), where only the network fee is lost.
    var hasOutputs = Array.isArray(t.outputs) && t.outputs.length > 0;
    if (hasOutputs) {
      if (t.outputs.length > TRANSFER_MAX_OUTPUTS) return false;
      var hasToBoth = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
      if (hasToBoth) return false;
      if (t.toQty !== undefined && t.toQty !== null && String(t.toQty).trim() !== '') return false;
      if (t.toSymbol !== undefined && t.toSymbol !== null && String(t.toSymbol).trim() !== '') return false;
      for (var oi = 0; oi < t.outputs.length; oi++) {
        if (!isValidTransferOutput(t.outputs[oi], t.symbol, t.accountId, accountIds)) return false;
      }
      var sums = transferOutputsSum(t.outputs);
      if (Math.abs(sums.qty + tnf - tq) > 1e-8) return false; // sent must equal recipients + fee
      if (sums.fee - tnf > 1e-12) return false; // attributed row fees ride inside the tx fee
    } else {
    // Cross-fiat cash moves carry the received amount (toQty) plus the
    // destination fiat (toSymbol); same-fiat moves derive it from the fee.
    if (t.toQty !== undefined && t.toQty !== null && String(t.toQty).trim() !== '') {
      if (typeof t.toQty !== 'number' && typeof t.toQty !== 'string') return false;
      var tto = Number(t.toQty);
      if (!isFinite(tto) || tto <= 0) return false;
    }
    if (t.toSymbol !== undefined && t.toSymbol !== null && String(t.toSymbol).trim() !== '') {
      if (!isValidSymbolCode(t.toSymbol)) return false;
    }
    // A cross-fiat arrival names its destination fiat: the converted amount
    // is then required (a missing toQty would credit zero silently).
    var hasToSym = t.toSymbol !== undefined && t.toSymbol !== null && String(t.toSymbol).trim() !== '';
    if (hasToSym && String(t.toSymbol).trim().toUpperCase() !== String(t.symbol).trim().toUpperCase()) {
      if (t.toQty === undefined || t.toQty === null || String(t.toQty).trim() === '') return false;
    }
    var hasTo = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
    if (accountIds !== undefined) {
      if (!Array.isArray(accountIds)) return false;
      if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
      if (hasTo && typeof t.toAccountId !== 'string') return false;
      if (accountIds.indexOf(t.accountId) === -1) return false;
      if (hasTo) {
        if (t.accountId === t.toAccountId) return false;
        if (accountIds.indexOf(t.toAccountId) === -1) return false;
      }
    } else {
      if (typeof t.accountId !== 'string' || !t.accountId) return false;
      if (hasTo && typeof t.toAccountId !== 'string') return false;
      if (hasTo && t.accountId === t.toAccountId) return false;
    }
    }
    return true;
  }
  if (t.type === 'income') {
    if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return false;
    var iq = Number(t.qty);
    if (!isFinite(iq) || iq <= 0) return false;
    if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
      if (typeof t.total !== 'number' && typeof t.total !== 'string') return false;
      var it = Number(t.total);
      if (!isFinite(it) || it < 0) return false;
    }
    if (t.currency !== undefined && t.currency !== null && String(t.currency).trim() !== '') {
      if (!isValidCurrencyCode(t.currency)) return false;
    } else if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '' && Number(t.total) > 0) {
      return false; // value without currency is ambiguous
    }
    if (accountIds !== undefined) {
      if (!Array.isArray(accountIds)) return false;
      if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
      if (accountIds.indexOf(t.accountId) === -1) return false;
    }
    return true;
  }
  if (t.type === 'expense') {
    var hasQty = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
    var hasTotal = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
    if (!hasQty && !hasTotal) return false;
    if (hasQty) {
      if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return false;
      var eq = Number(t.qty);
      if (!isFinite(eq) || eq <= 0) return false;
    }
    if (hasTotal) {
      if (typeof t.total !== 'number' && typeof t.total !== 'string') return false;
      var et = Number(t.total);
      if (!isFinite(et) || et < 0) return false;
      if (et === 0 && !hasQty) return false;
    }
    if (typeof t.currency !== 'string' || !isValidCurrencyCode(t.currency)) {
      // crypto-only expense may omit currency; fiat expense must name it
      if (hasTotal) return false;
    }
    if (accountIds !== undefined) {
      if (!Array.isArray(accountIds)) return false;
      if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
      if (accountIds.indexOf(t.accountId) === -1) return false;
    }
    return true;
  }
  // buy / sell (legacy strict path, preserved for tests)
  if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return false;
  var qty = Number(t.qty);
  if (!isFinite(qty) || qty <= 0) return false;
  if (t.total === undefined || t.total === null) return false;
  if (typeof t.total !== 'number' && typeof t.total !== 'string') return false;
  if (String(t.total).trim() === '') return false;
  var total = Number(t.total);
  if (!isFinite(total) || total < 0) return false;
  if (typeof t.currency !== 'string' || !isValidCurrencyCode(t.currency)) return false;
  // Strict v2 membership: when the account roster is supplied, the trade
  // must name one of its accounts. Legacy v1 callers omit it (their trades
  // gain accountIds during grouping instead).
  if (accountIds !== undefined) {
    if (!Array.isArray(accountIds)) return false;
    if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
    if (accountIds.indexOf(t.accountId) === -1) return false;
  }
  return true;
}

function normalizeTradeForStore(t) {
  var c = {};
  for (var k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) c[k] = t[k]; }
  if (typeof c.symbol === 'string') c.symbol = c.symbol.trim().toUpperCase();
  if (typeof c.ledger === 'string' && c.ledger.trim() !== '') c.ledger = c.ledger.trim();
  if (typeof c.ledgerLabel === 'string' && c.ledgerLabel.trim() !== '') c.ledgerLabel = c.ledgerLabel.trim();
  if (typeof c.toSymbol === 'string' && c.toSymbol.trim() !== '') c.toSymbol = c.toSymbol.trim().toUpperCase();
  if (typeof c.currency === 'string' && c.currency.trim() !== '') c.currency = c.currency.trim().toUpperCase();
  if (typeof c.feeCurrency === 'string' && c.feeCurrency.trim() !== '') c.feeCurrency = c.feeCurrency.trim().toUpperCase();
  if (typeof c.txid === 'string' && c.txid.trim() !== '') c.txid = c.txid.trim();
  // Multi-recipient transfers: normalize rows (trim labels, uppercase the
  // arrival fiat); an empty list degrades to the legacy shape. Legacy
  // single-dest fields never coexist with outputs (single source of truth).
  if (c.outputs !== undefined && c.outputs !== null) {
    if (Array.isArray(c.outputs)) {
      var __outs = [];
      c.outputs.forEach(function (o) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) return;
        var n = {};
        if (typeof o.toAccountId === 'string' && o.toAccountId.trim() !== '') n.toAccountId = o.toAccountId.trim();
        if (typeof o.label === 'string' && o.label.trim() !== '') n.label = o.label.trim().slice(0, TRANSFER_LABEL_MAX);
        n.qty = o.qty;
        if (o.fee !== undefined && o.fee !== null && String(o.fee).trim() !== '') n.fee = o.fee;
        if (o.spend === false) n.spend = false;
        if (typeof o.toSymbol === 'string' && o.toSymbol.trim() !== '') n.toSymbol = o.toSymbol.trim().toUpperCase();
        if (o.toQty !== undefined && o.toQty !== null && String(o.toQty).trim() !== '') n.toQty = o.toQty;
        __outs.push(n);
      });
      if (__outs.length) {
        c.outputs = __outs;
        try { delete c.toAccountId; } catch (e) { c.toAccountId = undefined; }
        try { delete c.toQty; } catch (e) { c.toQty = undefined; }
        try { delete c.toSymbol; } catch (e) { c.toSymbol = undefined; }
      } else {
        try { delete c.outputs; } catch (e) { c.outputs = undefined; }
      }
    } else {
      try { delete c.outputs; } catch (e) { c.outputs = undefined; }
    }
  }
  if (c.attachment !== undefined && c.attachment !== null && isValidAttachment(c.attachment)) {
    c.attachment = { name: String(c.attachment.name).trim(), mime: String(c.attachment.mime), size: Number(c.attachment.size), hash: String(c.attachment.hash).toLowerCase() };
  } else if (c.attachment !== undefined && (c.attachment === null || !isValidAttachment(c.attachment))) {
    try { delete c.attachment; } catch (e) { c.attachment = undefined; }
  }
  return c;
}

function isValidOverrideValue(v) {
  if (typeof v === 'number') return isFinite(v) && v > 0;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    // Fiat-tagged form {price, vs}: the fiat the manual price was entered in.
    return typeof v.price === 'number' && isFinite(v.price) && v.price > 0 &&
      typeof v.vs === 'string' && /^[A-Z]{2,10}$/.test(v.vs.trim().toUpperCase());
  }
  return false;
}

function isValidPriceOverrides(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  var keys = Object.keys(v);
  for (var i = 0; i < keys.length; i++) {
    if (!isValidOverrideValue(v[keys[i]])) return false;
  }
  return true;
}

function exportState(s) {
  var st = s || {};
  var accounts = Array.isArray(st.accounts)
    ? st.accounts.filter(isValidAccount).map(normalizeAccount)
    : [];
  var accountIds = accounts.map(function (a) { return a.id; });
  var trades = Array.isArray(st.trades)
    ? st.trades.filter(function (t) { return isValidImportTrade(t, accountIds); }).map(normalizeTradeForStore)
    : [];
  var priceOverrides = {};
  if (st.priceOverrides && typeof st.priceOverrides === 'object' && !Array.isArray(st.priceOverrides) && isValidPriceOverrides(st.priceOverrides)) {
    priceOverrides = st.priceOverrides;
  }
  var envelope = {
    app: APP_ID,
    version: STORE_VERSION,
    exportedAt: new Date().toISOString(),
    settings: normalizeSettings(st.settings, defaultState().settings),
    accounts: accounts,
    trades: trades,
    priceOverrides: priceOverrides
  };
  return JSON.stringify(envelope);
}

function importState(json) {
  var data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error('import failed: invalid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('import failed: top-level object expected');
  }
  if (data.app !== APP_ID) {
    throw new Error('import failed: unknown app');
  }
  if (data.version === 1) {
    return importStateV1(data);
  }
  if (data.version !== STORE_VERSION) {
    throw new Error('import failed: unsupported version');
  }
  if (!isValidSettings(data.settings)) {
    throw new Error('import failed: invalid settings');
  }
  if (!Array.isArray(data.accounts)) {
    throw new Error('import failed: accounts must be an array');
  }
  for (var ai = 0; ai < data.accounts.length; ai++) {
    if (!isValidAccount(data.accounts[ai])) {
      throw new Error('import failed: invalid account at index ' + ai);
    }
  }
  var accountIds = data.accounts.map(function (a) { return a.id; });
  var seenIds = {};
  for (var di = 0; di < accountIds.length; di++) {
    if (Object.prototype.hasOwnProperty.call(seenIds, accountIds[di])) {
      throw new Error('import failed: duplicate account id ' + accountIds[di]);
    }
    seenIds[accountIds[di]] = true;
  }
  if (!Array.isArray(data.trades)) {
    throw new Error('import failed: trades must be an array');
  }
  for (var ti = 0; ti < data.trades.length; ti++) {
    if (!isValidImportTrade(data.trades[ti], accountIds)) {
      throw new Error('import failed: invalid trade at index ' + ti);
    }
  }
  var seenTradeIds = {};
  for (var tdi = 0; tdi < data.trades.length; tdi++) {
    var tid = data.trades[tdi] && data.trades[tdi].id;
    if (typeof tid === 'string' && tid.length > 0) {
      if (Object.prototype.hasOwnProperty.call(seenTradeIds, tid)) {
        throw new Error('import failed: duplicate trade id ' + tid);
      }
      seenTradeIds[tid] = true;
    }
  }
  var priceOverrides = {};
  if (data.priceOverrides !== undefined) {
    if (!isValidPriceOverrides(data.priceOverrides)) {
      throw new Error('import failed: invalid priceOverrides');
    }
    priceOverrides = data.priceOverrides;
  }
  // All validation passed — only now replace stored state (never partial).
  // Note: legacy files may carry settings.defaultAccountId; it is ignored.
  var normalizedSettings = normalizeSettings(data.settings, defaultState().settings);
  var mappedTrades = data.trades.map(normalizeTradeForStore);
  // Drop quotes baked in the wrong fiat by the pre-fix freezer (exact live
  // override copies) so imports never reintroduce the nominal lie.
  try { dropBakedExecLocks(mappedTrades, priceOverrides); } catch (e) { /* repair never breaks import */ }
  try { repairCashTradeAmounts(mappedTrades, data.accounts); } catch (e) { /* repair never breaks import */ }
  var next = {
    settings: normalizedSettings,
    accounts: sanitizeGroups(data.accounts.map(normalizeAccount)),
    trades: mappedTrades,
    priceOverrides: priceOverrides
  };
  saveState(next);
  return next;
}

// Legacy v1 file import: group v1 trades (account-less) into auto-created
// per-symbol accounts. No legacy runtime paths — v1 is never read from
// localStorage, only accepted here.
function importStateV1(data) {
  if (!isValidSettings(data.settings)) {
    throw new Error('import failed: invalid settings');
  }
  if (!Array.isArray(data.trades)) {
    throw new Error('import failed: trades must be an array');
  }
  for (var ti = 0; ti < data.trades.length; ti++) {
    if (!isValidImportTrade(data.trades[ti])) {
      throw new Error('import failed: invalid trade at index ' + ti);
    }
  }
  var priceOverrides = {};
  if (data.priceOverrides !== undefined) {
    if (!isValidPriceOverrides(data.priceOverrides)) {
      throw new Error('import failed: invalid priceOverrides');
    }
    priceOverrides = data.priceOverrides;
  }
  var accounts = [];
  var bySymbol = {};
  var trades = data.trades.map(function (t) {
    var sym = String(t.symbol).trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(bySymbol, sym)) {
      var acc = { id: uid(), name: sym, ticker: sym, kind: 'crypto', createdAt: new Date().toISOString() };
      bySymbol[sym] = acc;
      accounts.push(acc);
    }
    var copy = {};
    for (var k in t) {
      if (Object.prototype.hasOwnProperty.call(t, k)) copy[k] = t[k];
    }
    copy.symbol = sym;
    copy.accountId = bySymbol[sym].id;
    return normalizeTradeForStore(copy);
  });
  // Membership holds by construction; re-check via the extended validator
  // so a grouping bug can never silently persist a dangling trade.
  var accountIds = accounts.map(function (a) { return a.id; });
  for (var vi = 0; vi < trades.length; vi++) {
    if (!isValidImportTrade(trades[vi], accountIds)) {
      throw new Error('import failed: invalid trade at index ' + vi);
    }
  }
  var next = {
    settings: {
      mainCurrency: data.settings.mainCurrency,
      costMethod: data.settings.costMethod
    },
    accounts: accounts,
    trades: trades,
    priceOverrides: priceOverrides
  };
  saveState(next);
  return next;
}

function accountById(st, id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  var list = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

// Expose pure functions for tests.html via window.Inoculens.
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.loadState = loadState;
  window.Inoculens.saveState = saveState;
  window.Inoculens.exportState = exportState;
  window.Inoculens.importState = importState;
  window.Inoculens.defaultState = defaultState;
  window.Inoculens.accountById = accountById;
  window.Inoculens.isValidAttachment = isValidAttachment;
  window.Inoculens.syncBlobFilename = syncBlobFilename;
  window.Inoculens.syncBlobNameHash = syncBlobNameHash;
}

// === Fx ===
// ECB historical FX via the Frankfurter proxy (https://api.frankfurter.dev).
// NOTE: the legacy api.frankfurter.app host 301-redirects cross-origin and
// browsers refuse the fetch, so always use the canonical host below.
// fetchEcbRate(date, from, to) locks the rate at trade date with forward-fill:
// a weekend/holiday gap walks back up to FX_MAX_LOOKBACK_DAYS and returns
// interpolated:true with source:'ECB-'+actualFixingDate. Stablecoins
// (USDC/USDT/DAI) are treated as 1:1 USD, then converted via ECB USD->main.
// Each HTTP attempt is retried once on network failure; if the rate still
// cannot be locked, fetchEcbRate throws Error('fx-unavailable') so the UI
// can ask for a manual rate.

var FX_STABLES = ['USDC', 'USDT', 'DAI'];
var FX_MAX_LOOKBACK_DAYS = 5;
var FX_BASE_URL = 'https://api.frankfurter.dev/v1';

function stableToUsd(ccy) {
  if (typeof ccy !== 'string') return false;
  return FX_STABLES.indexOf(ccy.toUpperCase()) !== -1;
}

function normalizeToMain(total, fee, rate) {
  return (Number(total) + Number(fee)) * Number(rate);
}

function fxShiftDate(dateStr, deltaDays) {
  if (!isValidDateStr(dateStr)) return null;
  var parts = String(dateStr).slice(0, 10).split('-');
  var t = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (!isFinite(t)) return null;
  t += deltaDays * 86400000;
  var d = new Date(t);
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// Pure forward-fill helper: newest fixing at or before `date` within the
// lookback window, or null when no fixing is available (caller throws
// Error('fx-unavailable') in that case).
function pickRate(ratesByDate, date) {
  for (var back = 0; back <= FX_MAX_LOOKBACK_DAYS; back++) {
    var d = fxShiftDate(date, -back);
    if (ratesByDate && Object.prototype.hasOwnProperty.call(ratesByDate, d)) {
      var rate = Number(ratesByDate[d]);
      if (isFinite(rate)) {
        return { rate: rate, interpolated: back > 0, date: d, source: 'ECB-' + d };
      }
    }
  }
  return null;
}

function fxFetchOnce(url, fetchImpl) {
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.reject(new Error('fx-unavailable'));
  var timeoutMs = 10000;
  var timer = null;
  var raced = false;
  function cleanup() { if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } timer = null; } }
  var attempt;
  try {
    attempt = f(url);
  } catch (e) {
    return Promise.reject(new Error('fx-unavailable'));
  }
  if (!attempt || typeof attempt.then !== 'function') return Promise.reject(new Error('fx-unavailable'));
  var timeoutP = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      if (!raced) { raced = true; reject(new Error('fx-unavailable')); }
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') { try { timer.unref(); } catch (e) { /* ignore */ } }
  });
  return Promise.race([attempt, timeoutP]).then(function (res) {
    if (raced) throw new Error('fx-unavailable');
    raced = true;
    cleanup();
    if (!res || !res.ok) {
      var err = new Error('fx-http-' + (res && res.status));
      err.fxStatus = res && res.status;
      throw err;
    }
    return res.json();
  }, function (e) {
    cleanup();
    if (e && (e.message === 'fx-unavailable' || e.fxStatus)) throw e;
    var err2 = new Error('fx-unavailable');
    throw err2;
  });
}

function fxFetchWithRetry(url, fetchImpl) {
  return fxFetchOnce(url, fetchImpl).catch(function (e) {
    if (e && e.fxStatus === 404) throw e; // missing fixing: no point retrying the same date
    return fxFetchOnce(url, fetchImpl); // retry once; a second failure propagates to the caller
  });
}

function fetchEcbRate(date, from, to) {
  if (!isValidDateStr(date)) return Promise.reject(new Error('fx-unavailable'));
  if (isFutureDateStr(date)) return Promise.reject(new Error('fx-unavailable'));
  var f = (typeof from === 'string') ? from.trim().toUpperCase() : from;
  var t = (typeof to === 'string') ? to.trim().toUpperCase() : to;
  if (!/^[A-Z]{2,10}$/.test(f || '') || !/^[A-Z]{2,10}$/.test(t || '')) {
    return Promise.reject(new Error('fx-unavailable'));
  }
  var effFrom = stableToUsd(f) ? 'USD' : f; // USDC->USD 1.0, then ECB USD->main
  var effTo = stableToUsd(t) ? 'USD' : t;
  if (effFrom === effTo) {
    return Promise.resolve({ rate: 1, interpolated: false, source: '1:1' });
  }
  // Hermetic async: capture window.fetch once per operation so concurrent
  // tests.html stubs (or later restores) cannot clobber retry/walkBack fetches.
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  function attempt(d, back) {
    if (!d || !isValidDateStr(d)) return Promise.reject(new Error('fx-unavailable'));
    var url = FX_BASE_URL + '/' + d +
      '?from=' + encodeURIComponent(effFrom) + '&to=' + encodeURIComponent(effTo);
    function walkBack() {
      if (back >= FX_MAX_LOOKBACK_DAYS) throw new Error('fx-unavailable');
      var prev = fxShiftDate(d, -1);
      if (!prev) throw new Error('fx-unavailable');
      return attempt(prev, back + 1);
    }
    return fxFetchWithRetry(url, capturedFetch).then(
      function (data) {
        var rate = data && data.rates && data.rates[effTo];
        if (typeof rate === 'number' && isFinite(rate) && rate > 0) {
          // Frankfurter answers with the latest available fixing, which may
          // predate the requested date: pin provenance to its actual date.
          // Guard lookahead: never accept a fixing after the requested date.
          var dd = (data && typeof data.date === 'string' && isValidDateStr(data.date)) ? data.date.slice(0, 10) : d;
          if (dd > d) return walkBack();
          return { rate: rate, interpolated: back > 0 || dd !== d, source: 'ECB-' + dd };
        }
        return walkBack(); // 200 but no fixing for this date: previous close
      },
      function (e) {
        if (e && e.fxStatus === 404) return walkBack(); // ECB holiday/weekend gap
        throw new Error('fx-unavailable'); // network failure after retry
      }
    );
  }
  return attempt(date.slice(0, 10), 0);
}

// --- Display conversion (main-currency switching) ---
// Trades are stored native (total + currency never change). The fxLock is
// the entry-time record. For DISPLAY, every trade is converted into the
// CURRENT main currency at its HISTORICAL ECB rate (trade date), via a
// persisted cache (ECB history never changes, so entries stay valid
// forever). Live prices (current valuation) always come from refreshPrices
// in the current main. P&L = live value − historical cost, as specified.
// Fallback: if a pair is missing (offline, pre-ECB dates), the trade keeps
// its stored fxLock so the page still paints; numbers then match the old
// main and get corrected on the next online render.

var FXCACHE_KEY = 'inoculens.fxcache.v1';
var FXCACHE_MAX = 1000;
var fxCacheStore = null; // key "date|FROM|TO" -> {rate, source}; lazy-loaded

function fxCacheKey(date, from, to) {
  return String(date) + '|' + String(from).toUpperCase() + '|' + String(to).toUpperCase();
}

function loadFxCache(reload) {
  if (fxCacheStore !== null && !reload) return fxCacheStore;
  fxCacheStore = {};
  try {
    var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(FXCACHE_KEY) : null;
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') fxCacheStore = parsed;
    }
  } catch (e) { fxCacheStore = {}; }
  return fxCacheStore;
}

function saveFxCache() {
  try {
    if (typeof localStorage === 'undefined') return;
    var keys = Object.keys(fxCacheStore || {});
    var store = fxCacheStore;
    if (keys.length > FXCACHE_MAX) {
      // Plain objects keep insertion order for string keys: keep newest.
      store = {};
      keys.slice(keys.length - 800).forEach(function (k) { store[k] = fxCacheStore[k]; });
      fxCacheStore = store;
    }
    localStorage.setItem(FXCACHE_KEY, JSON.stringify(store));
  } catch (e) { /* private mode / quota: memory cache still works */ }
}

function clearFxCache() {
  fxCacheStore = {};
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(FXCACHE_KEY);
  } catch (e) { /* ignore */ }
}

function getCachedRate(date, from, to) {
  var f = String(from || '').toUpperCase();
  var t = String(to || '').toUpperCase();
  if (!f || !t) return null;
  if (f === t || (stableToUsd(f) && stableToUsd(t))) return { rate: 1, source: '1:1' };
  var cache = loadFxCache();
  var hit = cache[fxCacheKey(date, f, t)];
  if (hit && isFinite(Number(hit.rate)) && Number(hit.rate) > 0 && typeof hit.source === 'string') {
    // Self-heal: a cached exactly-1 for two distinct, non-stable fiats is a
    // stale artifact, never a real ECB fixing — a 1:1 would pose as a rate
    // forever (fills skip cached pairs). Treat as missing so it refetches.
    if (Number(hit.rate) === 1) return null;
    return { rate: Number(hit.rate), source: hit.source };
  }
  return null;
}

function cacheRate(date, from, to, rate, source) {
  var f = String(from || '').toUpperCase();
  var t = String(to || '').toUpperCase();
  if (!f || !t || f === t || !isFinite(Number(rate)) || Number(rate) <= 0) return;
  loadFxCache()[fxCacheKey(date, f, t)] = { rate: Number(rate), source: String(source || '') };
}

// Distinct (date, currency) pairs across trades that still need a rate
// into `main`. Same-currency needs nothing (rate 1, no network). One fiat
// per trade: only the trade currency (plus frozen exec / tagged override
// fiats, which ride the same pair when they match) ever needs converting.
// Optional kinds ({accountId: kind}) additionally prefetches today's rate
// for open cash income — holdings float, so the current fixing is needed
// alongside the frozen trade-date locks.
function displayPairs(trades, main, kinds) {
  var m = String(main || '').toUpperCase();
  var seen = {};
  var out = [];
  function need(date, from) {
    var f = String(from || '').toUpperCase();
    if (!f || !date || f === m) return;
    var k = date + '|' + f;
    if (seen[k] || getCachedRate(date, f, m)) return;
    seen[k] = true;
    out.push({ date: date, from: f });
  }
  function needToday(fiat) {
    var f = String(fiat || '').toUpperCase();
    if (!f || f === m) return;
    var dk = '';
    try { dk = todayStr(); } catch (e) { return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return;
    var k = dk + '|' + f;
    if (seen[k] || getCachedRate(dk, f, m)) return;
    seen[k] = true;
    out.push({ date: dk, from: f });
  }
  (trades || []).forEach(function (t) {
    if (!t) return;
    var c = (typeof t.currency === 'string') ? t.currency.toUpperCase() : '';
    var d = (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) ? t.date.slice(0, 10) : '';
    if (!c || !d) return;
    need(d, c);
    if (kinds && t.type === 'income' && c !== m) {
      var kd = '';
      try { kd = kinds[t.accountId] || ''; } catch (e) { kd = ''; }
      if (isCashKind(kd)) needToday(c);
    }
    // Frozen exec quote in another fiat needs its own historical rate to
    // render in the current main (deduped by `seen` when it matches a leg).
    // Same for a fiat-tagged manual override (Exec falls back to it).
    if (t.type === 'buy' || t.type === 'sell') {
      var fr = null;
      try { fr = frozenExecOf(t); } catch (e) { fr = null; }
      if (fr && fr.vs && fr.vs !== m) need(d, fr.vs);
      var oe = null;
      try { oe = priceOverrideEntry(t.symbol); } catch (e) { oe = null; }
      if (oe && oe.vs && oe.vs !== m) need(d, oe.vs);
    }
  });
  return out;
}

// Fill the cache for every pair the current paint needs. Never rejects:
// a failed pair keeps its stored fxLock (degraded display, corrected later).
// Failures are recorded (fxFailedList) so the render can say so honestly
// instead of printing fallback figures as if they were fresh.
var fxFailedList = [];
var fxWarnedSession = false;
function ensureDisplayRates(trades, main, kinds) {
  var m = String(main || '').toUpperCase();
  var pairs = displayPairs(trades, m, kinds);
  if (!pairs.length) return Promise.resolve(false);
  return Promise.all(pairs.map(function (p) {
    return fetchEcbRate(p.date, p.from, m).then(function (r) {
      cacheRate(p.date, p.from, m, r.rate, r.source);
      return true;
    }, function () {
      try {
        var dup = fxFailedList.some(function (x) { return x && x.date === p.date && x.from === p.from && x.to === m; });
        if (!dup) fxFailedList.push({ date: p.date, from: p.from, to: m });
      } catch (e) { /* ignore */ }
      return false;
    });
  })).then(function (flags) {
    var changed = false;
    flags.forEach(function (f) { if (f) changed = true; });
    if (changed) saveFxCache();
    return changed;
  });
}

// One calm banner for unrefreshable conversions (session-once): lists the
// pairs so a confident-looking fallback is never mistaken for fresh math.
function fxFailedMessage(pairs) {
  var lines = (pairs || []).slice(0, 4).map(function (p) {
    return p.from + ' → ' + p.to + ' · ' + p.date;
  });
  if ((pairs || []).length > 4) lines.push('…');
  return {
    msg: 'Some conversions couldn\'t refresh — affected figures show entry-time values.',
    title: 'FX rates unavailable',
    lines: lines
  };
}

// Copy of a trade with fxLock rewritten into `main` at the historical rate.
// Native total/currency/fee untouched (fixed in stone); the fee always rides
// the trade lock (one fiat per trade). Falls back to the stored lock when no
// rate is cached yet (first paint before fetch lands, or offline) — see
// module comment.
function convertTrade(t, main) {
  var m = String(main || '').toUpperCase();
  if (!t || typeof t !== 'object') return t;
  var c = (typeof t.currency === 'string') ? t.currency.toUpperCase() : '';
  var d = (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) ? t.date.slice(0, 10) : '';
  if (!c || !d) return t;
  var out = null;
  function clone() {
    if (out) return out;
    out = {};
    for (var k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) out[k] = t[k]; }
    return out;
  }
  function lockFor(from) {
    var f = String(from || '').toUpperCase();
    if (!f) return null;
    if (f === m) return { pair: f + '/' + m, rate: 1, source: '1:1', interpolated: false };
    var hit = getCachedRate(d, f, m);
    if (!hit) return null;
    var fixDay = (/^ECB-(\d{4}-\d{2}-\d{2})$/.exec(hit.source) || [])[1] || d;
    return { pair: f + '/' + m, rate: hit.rate, source: 'ECB-' + fixDay, interpolated: fixDay !== d };
  }
  // Total leg.
  if (c === m) {
    clone().fxLock = { pair: c + '/' + m, rate: 1, source: '1:1', interpolated: false };
  } else {
    var tl = lockFor(c);
    if (tl) clone().fxLock = tl;
    // No cached rate yet: keep the stored lock (corrected on re-render).
  }
  // One fiat per trade: a stale separate fee lock would convert the fee at
  // the wrong rate, so it is always dropped from display copies.
  if (t.feeFxLock !== undefined) {
    clone();
    try { delete out.feeFxLock; } catch (e) { out.feeFxLock = undefined; }
  }
  return out || t;
}

function convertTrades(trades, main) {
  return (trades || []).map(function (t) { return convertTrade(t, main); });
}

// Expose Fx on window.Inoculens for tests.html, Ledger (Task 4), Ui (Task 6).
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.fetchEcbRate = fetchEcbRate;
  window.Inoculens.stableToUsd = stableToUsd;
  window.Inoculens.normalizeToMain = normalizeToMain;
  window.Inoculens.pickRate = pickRate;
  window.Inoculens.convertTrade = convertTrade;
  window.Inoculens.convertTrades = convertTrades;
  window.Inoculens.displayPairs = displayPairs;
  window.Inoculens.ensureDisplayRates = ensureDisplayRates;
  window.Inoculens.fxFailedPairs = function () { return fxFailedList.slice(); };
  window.Inoculens.fxFailedMessage = fxFailedMessage;
  window.Inoculens.getCachedRate = getCachedRate;
  window.Inoculens.cacheRate = cacheRate;
  window.Inoculens.clearFxCache = clearFxCache;
  window.Inoculens.reloadFxCache = function () { loadFxCache(true); };
}

// === Ledger ===
// Pure cost-basis engine: normalizeTrade + average-cost + FIFO + positions +
// validation. No DOM, no network, no storage. All main-currency conversion
// uses the trade's frozen fxLock.rate (Task 3). Read by Ui (Task 6) via
// computePositions / validateTrade.
//
// Fee economics (all-in model): one fiat per trade — the fee is always
// denominated in the trade currency, so cost counts the FULL total (50 EUR
// in, 0.00058193 BTC out => entry 50/qty, e.g. 85920.99 — the fee simply
// lifts the calculated price, never a separate loss). Fees ride along as
// display-only info (feesFiat/fees sums + "Total fees paid" line); they never
// touch Realized, Unrealized or Total P&L. fee:0 behaves exactly as before.
// Sells book gross proceeds (total, no fee subtraction) for the same reason.

function ledgerFxRate(lock) {
  var r = lock ? Number(lock.rate) : NaN;
  return (isFinite(r) && r > 0) ? r : 1;
}

// Open cash income converts at the latest fixing, not the receipt lock:
// holdings float, closed flows stay frozen. Falls back to the frozen lock
// (same as every other figure) when no current rate is cached yet.
function cashIncomeRate(t, main) {
  try {
    var m = String(main || '').toUpperCase();
    var f = String((t && t.symbol) || (t && t.currency) || '').toUpperCase();
    if (!f || f === m) return ledgerFxRate(t && t.fxLock);
    var dk = todayStr();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return ledgerFxRate(t && t.fxLock);
    var hit = getCachedRate(dk, f, m);
    if (hit && isFinite(Number(hit.rate)) && Number(hit.rate) > 0) return Number(hit.rate);
  } catch (e) { /* fall through to frozen */ }
  return ledgerFxRate(t && t.fxLock);
}

// --- Cash realization (display attribution, IAS 21 style) ---
// Holdings float, spending realizes: a cash income's DISPLAY value is
// remainder_qty * today_rate + sum(consumed_qty_i * spend_rate_i), where
// each spend_rate_i is the consuming expense's frozen display rate
// (trade-date fixing into the current main). Consumption is FIFO, oldest
// income first, same account + same fiat, expenses only. Transfers are
// moves, never spends. Qty-less (fiat-only) expenses consume nothing and
// book straight through. Asset incomes stay frozen (never in the map).
// Record lines, linkage, cost basis, invested/spent and native balances
// are untouched — only the converted view numbers use this.
function cashFiatOf(t) {
  return String((t && t.symbol) || '').trim().toUpperCase();
}

function cashQtyOf(t) {
  var q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
  return (isFinite(q) && q > 0) ? q : 0;
}

// Map cash-income trade object -> realized display value (signed +, main
// fiat). allTrades are display-converted (fxLock into main). isCash(id)
// gates which accounts realize; null/false means none. Expenses never
// appear in the map (their frozen value is used directly).
function buildCashRealization(allTrades, main, isCash) {
  var map = new Map();
  try {
    if (!allTrades || !allTrades.length) return map;
    var byKey = {};
    (allTrades || []).forEach(function (t) {
      if (!t) return;
      try {
        if (!isCash || !isCash(t.accountId)) return;
      } catch (e) { return; }
      if (t.type !== 'income' && t.type !== 'expense') return;
      var fiat = cashFiatOf(t);
      if (!fiat) return;
      var q = cashQtyOf(t);
      if (!(q > 0)) return;
      var key = String(t.accountId) + '|' + fiat;
      if (!byKey[key]) byKey[key] = { incomes: [], expenses: [] };
      if (t.type === 'income') byKey[key].incomes.push(t);
      else byKey[key].expenses.push(t);
    });
    function dOf(t) { return (t && typeof t.date === 'string') ? t.date : ''; }
    function byDate(a, b) {
      var da = dOf(a), db = dOf(b);
      if (da < db) return -1;
      if (da > db) return 1;
      return 0;
    }
    Object.keys(byKey).forEach(function (key) {
      var g = byKey[key];
      var incomes = g.incomes.slice().sort(byDate);
      var expenses = g.expenses.slice().sort(byDate);
      var lots = incomes.map(function (t) { return { t: t, left: cashQtyOf(t), consumedMain: 0 }; });
      var li = 0;
      expenses.forEach(function (e) {
        var need = cashQtyOf(e);
        if (!(need > 0)) return;
        var spendRate = ledgerFxRate(e.fxLock);
        while (need > LEDGER_EPS && li < lots.length) {
          var lot = lots[li];
          if (!lot || lot.left <= LEDGER_EPS) { li++; continue; }
          var take = Math.min(lot.left, need);
          lot.consumedMain += take * spendRate;
          lot.left -= take;
          need -= take;
          if (lot.left <= LEDGER_EPS) { lot.left = 0; li++; }
        }
        // Overspend beyond held income consumes nothing further: the excess
        // stays as a frozen expense (negative balances allowed).
      });
      lots.forEach(function (lot) {
        var rem = lot.left;
        if (Math.abs(rem) < LEDGER_EPS) rem = 0;
        var todayRate = null;
        try { todayRate = cashIncomeRate(lot.t, main); } catch (e2) { todayRate = null; }
        if (!(isFinite(Number(todayRate)) && Number(todayRate) > 0)) {
          try { todayRate = ledgerFxRate(lot.t.fxLock); } catch (e3) { todayRate = 1; }
        }
        map.set(lot.t, lot.consumedMain + rem * Number(todayRate));
      });
    });
  } catch (e) { /* realization never breaks display; callers fall back frozen */ }
  return map;
}

function normalizeTrade(t) {
  t = t || {};
  var rate = ledgerFxRate(t.fxLock);
  var totalRaw = (t.total === '' || t.total === null || t.total === undefined) ? 0 : Number(t.total);
  var feeRaw = (t.fee === '' || t.fee === null || t.fee === undefined) ? 0 : Number(t.fee);
  var totalMain = (isFinite(totalRaw) && totalRaw >= 0 ? totalRaw : 0) * rate;
  var fee = (isFinite(feeRaw) && feeRaw >= 0 ? feeRaw : 0);
  var out = { totalMain: totalMain, feeMain: fee * rate };
  // All-in cost: the stated total already includes the fee (one fiat per
  // trade), so cost IS the full total. feeLossMain stays 0 — kept only so
  // old stored shapes keep working.
  out.netMain = totalMain;
  out.feeLossMain = 0;
  return out;
}

function ledgerSortByDate(trades) {
  return (trades || []).slice().sort(function (a, b) {
    var da = (a && typeof a.date === 'string') ? a.date : '';
    var db = (b && typeof b.date === 'string') ? b.date : '';
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
  });
}

function ledgerHoldingDays(openDate, closeDate) {
  function toUtc(d) {
    if (!isValidDateStr(d)) return null;
    var p = d.slice(0, 10).split('-');
    var t = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return isFinite(t) ? t : null;
  }
  var a = toUtc(openDate);
  var b = toUtc(closeDate);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / 86400000);
}

var LEDGER_EPS = 1e-9;

function ledgerSym(t) {
  return String((t && t.symbol) || '').trim().toUpperCase();
}

// Stable linkage key for FIFO lot tracing (per-record Sold / Closed-from
// lines). Null when a legacy trade carries no id — such lots keep their
// math but opt out of per-record linkage.
function ledgerTradeId(t) {
  return (t && typeof t.id === 'string' && t.id !== '') ? t.id : null;
}

function computeAverage(trades) {
  var bySym = new Map();
  var list = ledgerSortByDate(trades);
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var sym = ledgerSym(t);
    if (!sym) continue;
    var n = normalizeTrade(t);
    if (t.type === 'buy' || t.type === 'income') {
      var qbi = Number(t.qty);
      if (!isFinite(qbi) || qbi <= 0) continue;
      if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
      var ebi = bySym.get(sym);
      ebi.qty += qbi;
      ebi.cost += n.netMain; // all-in cost (fee already inside the price)
      ebi.fees = (ebi.fees || 0) + n.feeMain; // display-only info
    } else if (t.type === 'sell') {
      var qs = Number(t.qty);
      if (!isFinite(qs) || qs <= 0) continue;
      if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
      var e = bySym.get(sym);
      if (e.qty <= LEDGER_EPS) continue; // no inventory: ignore, never negative
      var sellQty = Math.min(qs, e.qty);
      var avg = e.qty > 0 ? e.cost / e.qty : 0;
      // Gross proceeds: fees are already baked into the buy price, so sells
      // book the full total (display-only fee line, zero P&L drag).
      var proceeds = n.totalMain;
      e.fees = (e.fees || 0) + n.feeMain;
      if (qs > e.qty && qs > 0) proceeds = proceeds * (sellQty / qs);
      e.realized += proceeds - avg * sellQty;
      e.cost -= avg * sellQty;
      e.qty -= sellQty;
      if (Math.abs(e.qty) < LEDGER_EPS) { e.qty = 0; e.cost = 0; } // kill float dust
    } else if (t.type === 'expense') {
      var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
      var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
      var qe = hasQ ? Number(t.qty) : 0;
      if (hasQ && (!isFinite(qe) || qe <= 0)) continue;
      if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
      var ee = bySym.get(sym);
      if (hasQ) {
        if (ee.qty > LEDGER_EPS) {
          var rq = Math.min(qe, ee.qty);
          var aqe = ee.qty > 0 ? ee.cost / ee.qty : 0;
          var cRem = aqe * rq;
          ee.realized -= cRem; // crypto lost: proceeds 0 minus cost
          ee.cost -= cRem;
          ee.qty -= rq;
          if (Math.abs(ee.qty) < LEDGER_EPS) { ee.qty = 0; ee.cost = 0; }
        }
      }
      if (hasT || (n.feeMain > 0)) {
        ee.realized -= n.netMain; // all-in cash lost (fee already in the price)
        ee.fees = (ee.fees || 0) + n.feeMain;
      }
    } else if (t.type === 'transfer') {
      var qt = Number(t.qty);
      if (!isFinite(qt) || qt <= 0) continue;
      var nft = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (!isFinite(nft) || nft < 0 || nft >= qt) continue;
      if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
      var et = bySym.get(sym);
      var fiatT = n.netMain; // all-in fiat cost (display-only fee, no drag)
      et.fees = (et.fees || 0) + n.feeMain;
      var outsA = transferOutputsOf(t);
      if (!outsA.length) {
      if (et.qty <= LEDGER_EPS) {
        // no inventory: cannot move, but fiat fee still lost
        if (fiatT > 0) et.realized -= fiatT;
        continue;
      }
      var tQty = Math.min(qt, et.qty);
      var scaleT = qt > 0 ? tQty / qt : 0;
      var feeQtyT = nft * scaleT;
      var avgT = et.qty > 0 ? et.cost / et.qty : 0;
      var feeCostT = avgT * feeQtyT;
      et.qty -= feeQtyT; // net movement is -fee (out+in cancel except fee)
      et.cost -= feeCostT;
      et.realized -= feeCostT + fiatT; // on-chain loss + fiat fee are real losses
      if (Math.abs(et.qty) < LEDGER_EPS) { et.qty = 0; et.cost = 0; }
      } else {
        // Multi-recipient: internal same-symbol moves cancel globally (only
        // the fee matters); external and cross-fiat rows leave the pool.
        if (et.qty <= LEDGER_EPS) {
          if (fiatT > 0) et.realized -= fiatT;
          continue;
        }
        var tQtyA = Math.min(qt, et.qty);
        var scA = qt > 0 ? tQtyA / qt : 0;
        var feeQtyA = nft * scA;
        var avgA = et.qty > 0 ? et.cost / et.qty : 0;
        var leaveQ = feeQtyA;
        var leaveSpendC = 0;
        outsA.forEach(function (o) {
          var rq = Number(o.qty) * scA;
          if (!isFinite(rq) || rq <= 0) return;
          if (isTransferOutputInternal(o)) {
            var dS = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
              ? sym : String(o.toSymbol).trim().toUpperCase();
            if (dS === sym) return; // cancels globally
            return; // cross-fiat internal: leaves the pool silently
          }
          leaveQ += rq;
          if (o.spend !== false) leaveSpendC += avgA * rq; // external spend books its cost
        });
        var feeCostA = avgA * feeQtyA;
        et.qty -= leaveQ;
        et.cost -= avgA * leaveQ;
        et.realized -= feeCostA + fiatT + leaveSpendC;
        if (Math.abs(et.qty) < LEDGER_EPS) { et.qty = 0; et.cost = 0; }
      }
    }
  }
  bySym.forEach(function (e) {
    e.avgEntry = e.qty > LEDGER_EPS ? e.cost / e.qty : 0;
    if (Math.abs(e.qty) < LEDGER_EPS) { e.qty = 0; e.cost = 0; }
  });
  return bySym;
}

function computeFifo(trades) {
  var queues = new Map(); // sym -> [{qty, unitCost, date}]
  var acc = new Map(); // sym -> {realized, lots}
  var list = ledgerSortByDate(trades);
  function state(sym) {
    if (!acc.has(sym)) acc.set(sym, { realized: 0, lots: [], fees: 0, feeDrag: 0 });
    if (!queues.has(sym)) queues.set(sym, []);
    return acc.get(sym);
  }
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var sym = ledgerSym(t);
    if (!sym) continue;
    var n = normalizeTrade(t);
    var st = state(sym);
    var q = queues.get(sym);
    if (t.type === 'buy' || t.type === 'income') {
      var qb = Number(t.qty);
      if (!isFinite(qb) || qb <= 0) continue;
      q.push({ qty: qb, unitCost: qb > 0 ? n.netMain / qb : 0, date: t.date, buyId: ledgerTradeId(t) }); // all-in unit cost
      st.fees = (st.fees || 0) + n.feeMain; // display-only
    } else if (t.type === 'sell') {
      var qty = Number(t.qty);
      if (!isFinite(qty) || qty <= 0) continue;
      var heldFifo = q.reduce(function (s, l) { return s + l.qty; }, 0);
      if (heldFifo <= LEDGER_EPS) continue; // no inventory: ignore, never negative
      // Gross proceeds — fees live inside the buy price, never as sell drag.
      var proceedsTotal = n.totalMain;
      st.fees = (st.fees || 0) + n.feeMain;
      var unitProceeds = qty > 0 ? proceedsTotal / qty : 0;
      var sellQty = Math.min(qty, heldFifo);
      // Scale proceeds when the sell is clamped (oversell ignored, no negative).
      if (qty > sellQty && qty > 0) unitProceeds = (proceedsTotal * (sellQty / qty)) / (sellQty || 1);
      var left = sellQty;
      while (left > LEDGER_EPS && q.length > 0) {
        var lot = q[0];
        var take = Math.min(lot.qty, left);
        var proceeds = take * unitProceeds;
        var cost = take * lot.unitCost;
        st.lots.push({
          openDate: lot.date,
          closeDate: t.date,
          qty: take,
          proceeds: proceeds,
          cost: cost,
          gain: proceeds - cost,
          holdingDays: ledgerHoldingDays(lot.date, t.date),
          buyId: lot.buyId || null,
          sellId: ledgerTradeId(t),
          kind: 'sell'
        });
        st.realized += proceeds - cost;
        lot.qty -= take;
        left -= take;
        if (lot.qty <= LEDGER_EPS) q.shift();
      }
    } else if (t.type === 'expense') {
      var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
      var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
      if (hasQ) {
        var qe = Number(t.qty);
        if (!isFinite(qe) || qe <= 0) continue;
        var heldE = q.reduce(function (s, l) { return s + l.qty; }, 0);
        if (heldE > LEDGER_EPS) {
          var rq = Math.min(qe, heldE);
          var leftE = rq;
          while (leftE > LEDGER_EPS && q.length > 0) {
            var lote = q[0];
            var takeE = Math.min(lote.qty, leftE);
            var costE = takeE * lote.unitCost;
            st.lots.push({
              openDate: lote.date,
              closeDate: t.date,
              qty: takeE,
              proceeds: 0,
              cost: costE,
              gain: -costE,
              holdingDays: ledgerHoldingDays(lote.date, t.date),
              buyId: lote.buyId || null,
              sellId: ledgerTradeId(t),
              kind: 'expense'
            });
            st.realized -= costE;
            lote.qty -= takeE;
            leftE -= takeE;
            if (lote.qty <= LEDGER_EPS) q.shift();
          }
        }
      }
      if (hasT || n.feeMain > 0) {
        st.realized -= n.netMain; // all-in cash lost
        st.fees = (st.fees || 0) + n.feeMain;
      }
    } else if (t.type === 'transfer') {
      var qt = Number(t.qty);
      if (!isFinite(qt) || qt <= 0) continue;
      var nft = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (!isFinite(nft) || nft < 0 || nft >= qt) continue;
      var fiatT = n.netMain; // all-in fiat cost
      st.fees = (st.fees || 0) + n.feeMain;
      var heldT = q.reduce(function (s, l) { return s + l.qty; }, 0);
      if (heldT <= LEDGER_EPS) {
        if (fiatT > 0) st.realized -= fiatT;
        continue;
      }
      var tQty = Math.min(qt, heldT);
      var scaleT = qt > 0 ? tQty / qt : 0;
      var feeQtyT = nft * scaleT;
      // Remove gross qty oldest-first, then treat fee slice as expense.
      var removed = [];
      var leftT = tQty;
      while (leftT > LEDGER_EPS && q.length > 0) {
        var lotT = q[0];
        var takeT = Math.min(lotT.qty, leftT);
        removed.push({ qty: takeT, unitCost: lotT.unitCost, openDate: lotT.date, buyId: lotT.buyId || null });
        lotT.qty -= takeT;
        leftT -= takeT;
        if (lotT.qty <= LEDGER_EPS) q.shift();
      }
      var costOutT = removed.reduce(function (s, l) { return s + l.qty * l.unitCost; }, 0);
      var feeCostT = tQty > 0 ? costOutT * (feeQtyT / tQty) : 0;
      // Record the on-chain fee slice as loss lots (proportional across removed lots).
      if (feeQtyT > LEDGER_EPS && tQty > 0) {
        for (var ri = 0; ri < removed.length; ri++) {
          var rl = removed[ri];
          var ft = rl.qty * (feeQtyT / tQty);
          if (ft <= LEDGER_EPS) continue;
          var fc = ft * rl.unitCost;
          st.lots.push({
            openDate: rl.openDate,
            closeDate: t.date,
            qty: ft,
            proceeds: 0,
            cost: fc,
            gain: -fc,
            holdingDays: ledgerHoldingDays(rl.openDate, t.date),
            buyId: rl.buyId || null,
            sellId: ledgerTradeId(t),
            kind: 'network-fee'
          });
        }
      }
      st.realized -= feeCostT + fiatT;
      // qty/cost net: gross removed, nothing re-added globally (in+out cancel except fee already accounted via qty reduction below).
      // Re-add net? No: globally out+in cancel, leaving -feeQty. Queues already removed gross; re-add net portion with original lots scaled.
      var outsG = transferOutputsOf(t);
      var keepQtyT = tQty - feeQtyT;
      if (outsG.length) {
        // Multi-recipient: internal same-symbol slices stay in the pool;
        // external spend slices close as expense lots; cross-fiat and
        // neutral slices simply leave.
        keepQtyT = 0;
        var spendCostT = 0;
        outsG.forEach(function (o) {
          var rq = Number(o.qty) * scaleT;
          if (!isFinite(rq) || rq <= LEDGER_EPS) return;
          if (isTransferOutputInternal(o)) {
            var dS = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
              ? sym : String(o.toSymbol).trim().toUpperCase();
            if (dS === sym) keepQtyT += rq;
            return;
          }
          if (o.spend === false) return;
          for (var si = 0; si < removed.length; si++) {
            var srl = removed[si];
            var sft = (tQty > 0) ? srl.qty * (rq / tQty) : 0;
            if (sft <= LEDGER_EPS) continue;
            var sfc = sft * srl.unitCost;
            spendCostT += sfc;
            st.lots.push({
              openDate: srl.openDate,
              closeDate: t.date,
              qty: sft,
              proceeds: 0,
              cost: sfc,
              gain: -sfc,
              holdingDays: ledgerHoldingDays(srl.openDate, t.date),
              buyId: srl.buyId || null,
              sellId: ledgerTradeId(t),
              kind: 'expense'
            });
          }
        });
        st.realized -= spendCostT;
      }
      var netQtyT = keepQtyT;
      if (netQtyT > LEDGER_EPS && tQty > 0) {
        for (var ni = 0; ni < removed.length; ni++) {
          var ol = removed[ni];
          var keep = ol.qty * (netQtyT / tQty);
          if (keep > LEDGER_EPS) q.push({ qty: keep, unitCost: ol.unitCost, date: ol.openDate, buyId: ol.buyId || null });
        }
        // Keep FIFO order stable: moved lots go to back (they are still oldest economically, but queue order preserved by re-append; sort by date to keep oldest-first).
        q.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0; });
      }
      // Fix double-count: we removed gross then re-added net, net qty change = -feeQty, net cost change = -feeCost. Queues now reflect that (removed gross, added net). Realized already includes -feeCost-fiat. Good.
      // Recompute: queues currently = old - gross + net = old - fee. Correct.
    }
  }
  var out = new Map();
  acc.forEach(function (st, sym) {
    var q = queues.get(sym) || [];
    var qty = 0;
    var cost = 0;
    for (var k = 0; k < q.length; k++) { qty += q[k].qty; cost += q[k].qty * q[k].unitCost; }
    out.set(sym, {
      qty: qty,
      avgEntry: qty > 0 ? cost / qty : 0, // all-in Real price
      realized: st.realized,
      lots: st.lots,
      fees: st.fees || 0, // display-only info
      feeDrag: 0
    });
  });
  // Symbols with buys only are in queues but maybe not acc; ensure presence.
  queues.forEach(function (q, sym) {
    if (out.has(sym)) return;
    var qty = 0;
    var cost = 0;
    for (var k = 0; k < q.length; k++) { qty += q[k].qty; cost += q[k].qty * q[k].unitCost; }
    out.set(sym, { qty: qty, avgEntry: qty > 0 ? cost / qty : 0, realized: 0, lots: [], fees: 0, feeDrag: 0 });
  });
  return out;
}

function computePositions(trades, live, method) {
  var engine = method === 'fifo' ? computeFifo(trades) : computeAverage(trades);
  var buyCost = {}; // sym -> lifetime all-in buy+income cost (denominator for returnPct)
  var hasBuy = {};
  (trades || []).forEach(function (t) {
    if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
    var sym = ledgerSym(t);
    if (!sym) return;
    var qty = Number(t.qty);
    if (!isFinite(qty) || qty <= 0) return;
    var n = normalizeTrade(t);
    buyCost[sym] = (buyCost[sym] || 0) + n.netMain; // all-in (fee already inside)
    hasBuy[sym] = true;
  });
  var rows = [];
  engine.forEach(function (v, sym) {
    if (!hasBuy[sym] && !(v.qty > LEDGER_EPS) && !(Math.abs(v.realized || 0) > LEDGER_EPS)) return; // skip phantom sell-only rows
    // Unknown live price stays unknown (null) — never coerced to 0, which
    // fabricated a full loss (value 0, unrealized -cost, return -100%).
    var lookup = String(sym).toUpperCase();
    var raw = live ? (live[sym] !== undefined ? live[sym] : live[lookup]) : undefined;
    var num = Number(raw);
    var known = isFinite(num) && num > 0;
    var livePrice = known ? num : null;
    var qtyHeld = v.qty || 0;
    if (Math.abs(qtyHeld) < LEDGER_EPS) qtyHeld = 0;
    var avgEntry = v.avgEntry || 0;
    var marketValue = known ? qtyHeld * num : (qtyHeld === 0 ? 0 : null);
    var unrealized = marketValue === null ? null : marketValue - avgEntry * qtyHeld;
    var realized = v.realized || 0;
    var totalPL = unrealized === null ? realized : unrealized + realized; // fees display-only, zero drag
    var denom = buyCost[sym] || 0;
    var returnPct = denom > LEDGER_EPS
      ? (unrealized === null ? (qtyHeld === 0 ? (realized / denom) * 100 : null) : (totalPL / denom) * 100)
      : null;
    rows.push({
      symbol: sym,
      qtyHeld: qtyHeld,
      avgEntry: avgEntry,
      livePrice: livePrice,
      marketValue: marketValue,
      unrealized: unrealized,
      realized: realized,
      fees: v.fees || 0, // display-only info ("Total fees paid" line)
      feeDrag: 0,
      totalPL: totalPL,
      returnPct: returnPct
    });
  });
  rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
  return rows;
}

// --- Joint per-account portfolio engine (transfers move basis between accounts) ---
// Processes ALL trades once in date order, keeping separate cost queues per
// (accountId, symbol). Transfers move cost/lots from source to dest at the
// source's basis (no P&L except network + fiat fees, which are real losses).
// Returns { byAccount: {accId: Map(sym->pos)}, analytics, lots }.
// Positions use the same live-price unknown rules as computePositions.
function computePortfolio(allTrades, live, method) {
  var isFifo = method === 'fifo';
  var sorted = ledgerSortByDate(allTrades || []);
  var acctState = {}; // accId -> sym -> {qty,cost,realized,income,fees,fiatFees,queue,lots}
  function stFor(accId, sym) {
    var a = acctState[accId];
    if (!a) { a = {}; acctState[accId] = a; }
    var s = a[sym];
    if (!s) {
      s = { qty: 0, cost: 0, realized: 0, income: 0, fees: 0, feeDrag: 0, lots: [], queue: [], touched: false };
      a[sym] = s;
    }
    return s;
  }
  var totals = { invested: 0, withdrawn: 0, income: 0, incomeQty: 0, feesFiat: 0, feesCryptoQty: 0, feesCryptoMain: 0, expensesFiat: 0, realized: 0, feeDrag: 0 };
  function avgOf(s) { return s.qty > LEDGER_EPS ? s.cost / s.qty : 0; }
  sorted.forEach(function (t) {
    if (!t) return;
    var sym = ledgerSym(t);
    if (!sym) return;
    var n = normalizeTrade(t);
    if (t.type === 'buy') {
      var qb = Number(t.qty);
      if (!isFinite(qb) || qb <= 0) return;
      var sb = stFor(t.accountId, sym);
      sb.touched = true;
      sb.qty += qb;
      var cb = n.netMain; // all-in (fee already inside the price)
      sb.cost += cb;
      sb.fees += n.feeMain; // display-only
      totals.invested += n.netMain;
      totals.feesFiat += n.feeMain;
      if (isFifo) sb.queue.push({ qty: qb, unitCost: qb > 0 ? cb / qb : 0, date: t.date, buyId: ledgerTradeId(t) });
    } else if (t.type === 'income') {
      var qi = Number(t.qty);
      if (!isFinite(qi) || qi <= 0) return;
      var si = stFor(t.accountId, sym);
      si.touched = true;
      si.qty += qi;
      var ci = n.netMain; // all-in
      si.cost += ci;
      si.income += n.totalMain;
      si.fees += n.feeMain; // display-only
      totals.income += n.totalMain;
      totals.incomeQty += qi;
      totals.feesFiat += n.feeMain;
      if (isFifo) si.queue.push({ qty: qi, unitCost: qi > 0 ? ci / qi : 0, date: t.date, buyId: ledgerTradeId(t) });
    } else if (t.type === 'sell') {
      var qs = Number(t.qty);
      if (!isFinite(qs) || qs <= 0) return;
      var ss = stFor(t.accountId, sym);
      if (ss.qty <= LEDGER_EPS && (!isFifo || ss.queue.reduce(function (s, l) { return s + l.qty; }, 0) <= LEDGER_EPS)) return;
      ss.touched = true;
      // Gross proceeds (fees live inside the buy price, never as sell drag).
      var proceeds = n.totalMain;
      if (isFifo) {
        var heldF = ss.queue.reduce(function (s, l) { return s + l.qty; }, 0);
        var sQty = Math.min(qs, heldF);
        if (qs > heldF && qs > 0) proceeds = proceeds * (sQty / qs);
        var unitP = sQty > 0 ? proceeds / sQty : 0;
        // also mirror qty/cost for avg view consistency
        var left = sQty;
        while (left > LEDGER_EPS && ss.queue.length) {
          var lot = ss.queue[0];
          var take = Math.min(lot.qty, left);
          var pc = take * unitP;
          var cc = take * lot.unitCost;
          ss.lots.push({ openDate: lot.date, closeDate: t.date, qty: take, proceeds: pc, cost: cc, gain: pc - cc, holdingDays: ledgerHoldingDays(lot.date, t.date), accountId: t.accountId, symbol: sym, buyId: lot.buyId || null, sellId: ledgerTradeId(t), kind: 'sell' });
          ss.realized += pc - cc;
          totals.realized += pc - cc;
          lot.qty -= take;
          left -= take;
          if (lot.qty <= LEDGER_EPS) ss.queue.shift();
        }
        ss.qty -= sQty;
        // cost derived from queue; recompute for avg field
        var rc = 0, rq = 0;
        ss.queue.forEach(function (l) { rq += l.qty; rc += l.qty * l.unitCost; });
        ss.cost = rc;
        if (Math.abs(ss.qty) < LEDGER_EPS && Math.abs(rq) < LEDGER_EPS) { ss.qty = 0; ss.cost = 0; }
        else ss.qty = rq;
        totals.withdrawn += proceeds;
        totals.feesFiat += n.feeMain;
        ss.fees += n.feeMain;
      } else {
        var sQty2 = Math.min(qs, ss.qty);
        if (qs > ss.qty && qs > 0) proceeds = proceeds * (sQty2 / qs);
        var a2 = avgOf(ss);
        ss.realized += proceeds - a2 * sQty2;
        totals.realized += proceeds - a2 * sQty2;
        ss.cost -= a2 * sQty2;
        ss.qty -= sQty2;
        if (Math.abs(ss.qty) < LEDGER_EPS) { ss.qty = 0; ss.cost = 0; }
        totals.withdrawn += proceeds;
        totals.feesFiat += n.feeMain;
        ss.fees += n.feeMain;
      }
    } else if (t.type === 'expense') {
      var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
      var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
      if (!hasQ && !hasT) return;
      var se = stFor(t.accountId, sym);
      se.touched = true;
      if (hasQ) {
        var qe = Number(t.qty);
        if (isFinite(qe) && qe > 0) {
          if (isFifo) {
            var heldE = se.queue.reduce(function (s, l) { return s + l.qty; }, 0);
            var rqE = Math.min(qe, heldE);
            var lE = rqE;
            while (lE > LEDGER_EPS && se.queue.length) {
              var le2 = se.queue[0];
              var tk = Math.min(le2.qty, lE);
              var ce2 = tk * le2.unitCost;
              se.lots.push({ openDate: le2.date, closeDate: t.date, qty: tk, proceeds: 0, cost: ce2, gain: -ce2, holdingDays: ledgerHoldingDays(le2.date, t.date), accountId: t.accountId, symbol: sym, kind: 'expense', buyId: le2.buyId || null, sellId: ledgerTradeId(t) });
              se.realized -= ce2;
              totals.realized -= ce2;
              totals.feesCryptoMain += ce2;
              totals.feesCryptoQty += tk;
              le2.qty -= tk;
              lE -= tk;
              if (le2.qty <= LEDGER_EPS) se.queue.shift();
            }
            var rq2 = 0, rc2 = 0;
            se.queue.forEach(function (l) { rq2 += l.qty; rc2 += l.qty * l.unitCost; });
            se.qty = rq2; se.cost = rc2;
          } else if (se.qty > LEDGER_EPS) {
            var rqe = Math.min(qe, se.qty);
            var ae = avgOf(se);
            var cre = ae * rqe;
            se.realized -= cre;
            totals.realized -= cre;
            totals.feesCryptoMain += cre;
            totals.feesCryptoQty += rqe;
            se.cost -= cre;
            se.qty -= rqe;
            if (Math.abs(se.qty) < LEDGER_EPS) { se.qty = 0; se.cost = 0; }
          }
        }
      }
      if (hasT || n.feeMain > 0) {
        var fl = n.netMain; // all-in cash lost
        se.realized -= n.netMain;
        totals.realized -= n.netMain;
        totals.expensesFiat += fl;
        totals.feesFiat += n.feeMain;
        se.fees += n.feeMain;
      }
    } else if (t.type === 'transfer') {
      var qt = Number(t.qty);
      if (!isFinite(qt) || qt <= 0) return;
      var nft = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (!isFinite(nft) || nft < 0 || nft >= qt) return;
      var from = stFor(t.accountId, sym);
      // No destination: on-chain move inside the same account (fresh address,
      // same owner) — out and in cancel, only the network fee is lost.
      // With recipients each internal row is credited at the source basis;
      // external spend rows book their cost as a loss.
      var outsP = transferOutputsOf(t);
      var to = (!outsP.length && t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '')
        ? stFor(String(t.toAccountId).trim(), sym)
        : from;
      from.touched = true;
      to.touched = true;
      // Legacy parity: a named destination counts as active even when the
      // source holds nothing (the run below returns early on empty source).
      if (outsP.length === 1 && isTransferOutputInternal(outsP[0])) {
        try { stFor(String(outsP[0].toAccountId).trim(), sym).touched = true; } catch (e) { /* ignore */ }
      }
      var fiatT = n.netMain; // all-in fiat cost (fee display-only)
      if (isFifo) {
        var heldT = from.queue.reduce(function (s, l) { return s + l.qty; }, 0);
        if (heldT <= LEDGER_EPS) {
          if (fiatT > 0) { from.realized -= fiatT; totals.realized -= fiatT; totals.expensesFiat += fiatT; totals.feesFiat += n.feeMain; }
          return;
        }
        var tQty = Math.min(qt, heldT);
        var sc = qt > 0 ? tQty / qt : 0;
        var feeQ = nft * sc;
        var removed = [];
        var lt = tQty;
        while (lt > LEDGER_EPS && from.queue.length) {
          var ltf = from.queue[0];
          var tkf = Math.min(ltf.qty, lt);
          removed.push({ qty: tkf, unitCost: ltf.unitCost, openDate: ltf.date, buyId: ltf.buyId || null });
          ltf.qty -= tkf;
          lt -= tkf;
          if (ltf.qty <= LEDGER_EPS) from.queue.shift();
        }
        var costOut = removed.reduce(function (s, l) { return s + l.qty * l.unitCost; }, 0);
        var feeC = tQty > 0 ? costOut * (feeQ / tQty) : 0;
        if (feeQ > LEDGER_EPS && tQty > 0) {
          removed.forEach(function (rl) {
            var fsh = rl.qty * (feeQ / tQty);
            if (fsh <= LEDGER_EPS) return;
            var fco = fsh * rl.unitCost;
            from.lots.push({ openDate: rl.openDate, closeDate: t.date, qty: fsh, proceeds: 0, cost: fco, gain: -fco, holdingDays: ledgerHoldingDays(rl.openDate, t.date), accountId: t.accountId, symbol: sym, kind: 'network-fee', buyId: rl.buyId || null, sellId: ledgerTradeId(t) });
          });
        }
        from.realized -= feeC + fiatT;
        totals.realized -= feeC + fiatT;
        totals.feesCryptoMain += feeC;
        totals.feesCryptoQty += feeQ;
        totals.expensesFiat += fiatT;
        totals.feesFiat += n.feeMain;
        from.fees += n.feeMain;
        var frq = 0, frc = 0;
        from.queue.forEach(function (l) { frq += l.qty; frc += l.qty * l.unitCost; });
        from.qty = frq; from.cost = frc;
        if (!outsP.length) {
        var netQ = tQty - feeQ;
        if (netQ > LEDGER_EPS && tQty > 0) {
          removed.forEach(function (rl) {
            var keep = rl.qty * (netQ / tQty);
            if (keep > LEDGER_EPS) to.queue.push({ qty: keep, unitCost: rl.unitCost, date: rl.openDate, buyId: rl.buyId || null });
          });
          to.queue.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0; });
          var trq = 0, trc = 0;
          to.queue.forEach(function (l) { trq += l.qty; trc += l.qty * l.unitCost; });
          to.qty = trq; to.cost = trc;
        }
        } else if (tQty > 0) {
          var destSeen = {};
          outsP.forEach(function (o) {
            var share = Number(o.qty) * sc;
            if (!isFinite(share) || share <= LEDGER_EPS) return;
            if (isTransferOutputInternal(o)) {
              var dSym = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
                ? sym : String(o.toSymbol).trim().toUpperCase();
              var arr = (dSym !== sym && o.toQty !== undefined && o.toQty !== null && String(o.toQty).trim() !== '')
                ? Number(o.toQty) * sc : share;
              if (!isFinite(arr) || arr <= 0) return;
              var dst = stFor(String(o.toAccountId).trim(), dSym);
              dst.touched = true;
              removed.forEach(function (rl) {
                var keep = rl.qty * (share / tQty);
                if (keep > LEDGER_EPS) dst.queue.push({ qty: keep, unitCost: rl.unitCost, date: rl.openDate, buyId: rl.buyId || null });
              });
              var did = String(o.toAccountId).trim() + '|' + dSym;
              destSeen[did] = dst;
            } else if (o.spend !== false) {
              removed.forEach(function (rl) {
                var xsh = rl.qty * (share / tQty);
                if (xsh <= LEDGER_EPS) return;
                var xco = xsh * rl.unitCost;
                from.lots.push({ openDate: rl.openDate, closeDate: t.date, qty: xsh, proceeds: 0, cost: xco, gain: -xco, holdingDays: ledgerHoldingDays(rl.openDate, t.date), accountId: t.accountId, symbol: sym, kind: 'expense', buyId: rl.buyId || null, sellId: ledgerTradeId(t) });
                from.realized -= xco;
                totals.realized -= xco;
                totals.feesCryptoMain += xco;
                totals.feesCryptoQty += xsh;
              });
            }
          });
          Object.keys(destSeen).forEach(function (k) {
            var dst2 = destSeen[k];
            dst2.queue.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0; });
            var rq2 = 0, rc2 = 0;
            dst2.queue.forEach(function (l) { rq2 += l.qty; rc2 += l.qty * l.unitCost; });
            dst2.qty = rq2; dst2.cost = rc2;
          });
        }
      } else {
        if (from.qty <= LEDGER_EPS) {
          if (fiatT > 0) { from.realized -= fiatT; totals.realized -= fiatT; totals.expensesFiat += fiatT; totals.feesFiat += n.feeMain; }
          return;
        }
        var tQ2 = Math.min(qt, from.qty);
        var sc2 = qt > 0 ? tQ2 / qt : 0;
        var feeQ2 = nft * sc2;
        var aF = avgOf(from);
        var costO = aF * tQ2;
        var feeC2 = aF * feeQ2;
        from.qty -= tQ2;
        from.cost -= costO;
        if (Math.abs(from.qty) < LEDGER_EPS) { from.qty = 0; from.cost = 0; }
        from.realized -= feeC2 + fiatT;
        totals.realized -= feeC2 + fiatT;
        totals.feesCryptoMain += feeC2;
        totals.feesCryptoQty += feeQ2;
        totals.expensesFiat += fiatT;
        totals.feesFiat += n.feeMain;
        from.fees += n.feeMain;
        if (!outsP.length) {
        var moved = costO - feeC2;
        var netQ2 = tQ2 - feeQ2;
        to.qty += netQ2;
        to.cost += moved;
        } else {
          outsP.forEach(function (o) {
            var share = Number(o.qty) * sc2;
            if (!isFinite(share) || share <= LEDGER_EPS) return;
            var shareCost = aF * share;
            if (isTransferOutputInternal(o)) {
              var dSym = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
                ? sym : String(o.toSymbol).trim().toUpperCase();
              var arr = (dSym !== sym && o.toQty !== undefined && o.toQty !== null && String(o.toQty).trim() !== '')
                ? Number(o.toQty) * sc2 : share;
              if (!isFinite(arr) || arr <= 0) return;
              var dst = stFor(String(o.toAccountId).trim(), dSym);
              dst.touched = true;
              dst.qty += arr;
              dst.cost += shareCost;
            } else if (o.spend !== false) {
              from.realized -= shareCost;
              totals.realized -= shareCost;
              totals.feesCryptoMain += shareCost;
              totals.feesCryptoQty += share;
            }
          });
        }
      }
    }
  });
  // Build per-account position maps with live prices.
  var byAccount = {};
  Object.keys(acctState).forEach(function (accId) {
    var m = new Map();
    var syms = acctState[accId];
    Object.keys(syms).forEach(function (sym) {
      var s = syms[sym];
      if (!s.touched) return; // never active: drop phantom (e.g. sell-only with no inventory)
      var lookup = String(sym).toUpperCase();
      var raw = live ? (live[sym] !== undefined ? live[sym] : live[lookup]) : undefined;
      var num = Number(raw);
      var known = isFinite(num) && num > 0;
      var qtyHeld = Math.abs(s.qty) < LEDGER_EPS ? 0 : s.qty;
      var avgEntry = qtyHeld > 0 ? s.cost / qtyHeld : 0;
      var mv = known ? qtyHeld * num : (qtyHeld === 0 ? 0 : null);
      var un = mv === null ? null : mv - avgEntry * qtyHeld;
      m.set(sym, {
        symbol: sym, qtyHeld: qtyHeld, avgEntry: avgEntry,
        livePrice: known ? num : null, marketValue: mv, unrealized: un,
        realized: s.realized, totalPL: un === null ? s.realized : un + s.realized, // fees display-only
        income: s.income, fees: s.fees, lots: s.lots
      });
    });
    byAccount[accId] = m;
  });
  return { byAccount: byAccount, totals: totals, states: acctState };
}

function computeAnalytics(allTrades, live, method) {
  var pf = computePortfolio(allTrades, live, method);
  var mv = 0, un = 0, rz = pf.totals.realized, mvKnown = false, unKnown = false;
  var accIds = Object.keys(pf.byAccount);
  accIds.forEach(function (id) {
    pf.byAccount[id].forEach(function (p) {
      if (p.marketValue !== null) { mv += p.marketValue; mvKnown = true; }
      if (p.unrealized !== null) { un += p.unrealized; unKnown = true; }
    });
  });
  var feesTotal = (pf.totals.feesFiat || 0) + (pf.totals.feesCryptoMain || 0) + (pf.totals.expensesFiat || 0);
  var baseTpl = (unKnown || Math.abs(rz) > LEDGER_EPS) ? (unKnown ? un + rz : rz) : rz;
  return {
    marketValue: mvKnown ? mv : null,
    unrealized: unKnown ? un : null,
    realized: rz,
    totalPL: baseTpl, // fees display-only ("Total fees paid" line), zero drag
    feeDrag: 0,
    invested: pf.totals.invested,
    withdrawn: pf.totals.withdrawn,
    income: pf.totals.income,
    feesFiat: pf.totals.feesFiat,
    feesCryptoQty: pf.totals.feesCryptoQty,
    feesCryptoMain: pf.totals.feesCryptoMain,
    expensesFiat: pf.totals.expensesFiat,
    feesTotal: feesTotal,
    byAccount: pf.byAccount,
    totals: pf.totals
  };
}

function heldForAccount(allTrades, accountId, symbol) {
  var sym = String(symbol || '').toUpperCase();
  var pf = computePortfolio(allTrades || [], {}, 'average');
  var m = pf.byAccount[accountId];
  if (!m) return 0;
  var p = m.get(sym) || m.get(symbol);
  if (!p) {
    // fallback: try case-insensitive scan
    var found = 0;
    m.forEach(function (v, k) { if (String(k).toUpperCase() === sym) found = v.qtyHeld; });
    return found;
  }
  return p.qtyHeld;
}

// --- Cash bookkeeping engine (pure, no DOM) ---
// Cash accounts are balance ledgers, not positions: balance = signed flows
// in the account fiat, converted per-flow at the frozen fxLock rate.
// income/buy credit, expense/sell debit; transfers debit the source and
// credit the destination (same-fiat: sent − fee; cross-fiat: stored toQty).
function cashReceivedOf(t, accountId) {
  // Per-destination form cashReceivedOf(t, accountId) credits one internal
  // recipient of a (possibly multi-output) transfer, 0 otherwise.
  if (accountId !== undefined && accountId !== null) return transferArrivalFor(t, accountId);
  if (!t || t.type !== 'transfer') return 0;
  var dest = (t.toSymbol === undefined || t.toSymbol === null || String(t.toSymbol).trim() === '')
    ? String(t.symbol || '').toUpperCase()
    : String(t.toSymbol).trim().toUpperCase();
  if (dest !== String(t.symbol || '').toUpperCase()) {
    var cross = (t.toQty === undefined || t.toQty === null || String(t.toQty).trim() === '') ? NaN : Number(t.toQty);
    return (isFinite(cross) && cross > 0) ? cross : 0;
  }
  var sent = Number(t.qty);
  var nfRaw = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
  var nf = (isFinite(nfRaw) && nfRaw >= 0) ? nfRaw : 0;
  if (!isFinite(sent) || sent <= 0) return 0;
  var recv = sent - nf;
  return (isFinite(recv) && recv > 0) ? recv : 0;
}

function cashSignedNative(t, accountId) {
  if (!t || t.accountId !== accountId) {
    return transferArrivalFor(t, accountId);
  }
  var q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
  if (t.type === 'income' || t.type === 'buy') return (isFinite(q) && q > 0) ? q : 0;
  if (t.type === 'expense') {
    if (isFinite(q) && q > 0) return -q;
    // Legacy qty-less expense: only the same-fiat total is a balance move.
    var tot = Number(t.total);
    if (isFinite(tot) && tot > 0 && String(t.currency || '').toUpperCase() === String(t.symbol || '').toUpperCase()) return -tot;
    return 0;
  }
  if (t.type === 'sell') return (isFinite(q) && q > 0) ? -q : 0;
  if (t.type === 'transfer') return (isFinite(q) && q > 0) ? -q : 0;
  return 0;
}

function cashBalance(allTrades, accountId, main, floatIncome) {
  var doFloat = floatIncome !== false;
  var native = 0;
  var inMain = 0;
  var ticker = '';
  var mainU = String(main || '').toUpperCase();
  // Realization map: consumed income locks at spend rates, remainder floats.
  // Built once per balance so the total is remainder x current by construction.
  var realMap = null;
  if (doFloat) {
    try {
      realMap = buildCashRealization(allTrades, main, function (id) { return id === accountId; });
    } catch (e) { realMap = null; }
  }
  function legRate(t, isDest) {
    if (isDest) {
      // Destination leg is denominated in the arrival fiat: its own lock
      // wins; a main-fiat arrival is 1 by definition.
      var toSym = (t.toSymbol === undefined || t.toSymbol === null || String(t.toSymbol).trim() === '')
        ? String(t.symbol || '').toUpperCase()
        : String(t.toSymbol).trim().toUpperCase();
      if (toSym === mainU) return 1;
      if (t.toFxLock) return ledgerFxRate(t.toFxLock);
    } else if (t.fromFxLock) {
      // Source leg of a cash transfer: transfers zero their own currency,
      // so the frozen source-fiat rate rides separately (else a non-main
      // source would convert 1:1 by mistake).
      return ledgerFxRate(t.fromFxLock);
    }
    return ledgerFxRate(t.fxLock);
  }
  (allTrades || []).forEach(function (t) {
    if (!t) return;
    var isSrc = (t.accountId === accountId);
    var isDest = (!isSrc && transferArrivalFor(t, accountId) > 0);
    if (!isSrc && !isDest) return;
    if (isSrc && !ticker && t.symbol) ticker = String(t.symbol).toUpperCase();
    var signed = isDest ? cashReceivedOf(t, accountId) : cashSignedNative(t, accountId);
    if (!isFinite(signed) || signed === 0) return;
    native += signed;
    // Realization: holdings float, spending locks. A consumed income's value
    // is remainder x today + consumed x spend-day (already in realMap), so a
    // fully spent account nets to exactly zero. Every other leg — expenses,
    // transfers, sells — stays on its frozen lock.
    if (doFloat && !isDest && t.type === 'income' && realMap && realMap.has(t)) {
      var rv = realMap.get(t);
      if (isFinite(Number(rv))) { inMain += Number(rv); return; }
    }
    var leg = legRate(t, isDest);
    if (doFloat && !isDest && t.type === 'income' && !(realMap && realMap.has(t))) {
      try { leg = cashIncomeRate(t, main); } catch (e) { /* keep frozen leg */ }
    }
    inMain += signed * leg;
  });
  // Tidy binary dust; keep the sign of tiny remainders at exactly 0.
  function tidy(v) { return (Math.abs(v) < 1e-9) ? 0 : Math.round(v * 100) / 100; }
  return { native: tidy(native), main: tidy(inMain), ticker: ticker };
}

// Ledger tree: income/expense (and legacy ledger-carrying buy/sell) trades
// aggregate by code (signed main amounts), then roll up into parents. Parent = longest
// other known code that is a strict leading prefix, or — for numeric
// Twinfield-style schemes — the digit-level parent (1110 → 1100 → 1000).
// Trades without a code land in the unassigned bucket. Labels resolve
// trade label first, then the chart map, then the bare code.
function ledgerParentOf(code, known) {
  var c = String(code);
  var set = {};
  (known || []).forEach(function (k) { set[String(k)] = true; });
  delete set[c];
  var best = null;
  function consider(k) {
    if (!set[k] || k === '') return;
    if (best === null || k.length > best.length) best = k;
  }
  Object.keys(set).forEach(function (k) {
    if (c.indexOf(k) === 0) consider(k);
  });
  if (/^[0-9]+$/.test(c)) {
    var core = c.replace(/0+$/, '');
    while (core.length > 1) {
      core = core.slice(0, -1);
      consider(core + new Array(c.length - core.length + 1).join('0'));
    }
  }
  return best;
}

// Every code nested under `target` via the same parent rules as the tree
// (prefix + numeric Twinfield parents). Used by ledger delete so removing a
// top ledger cascades to the whole subtree, including posted-only codes.
function ledgerDescendantsOf(target, allCodes) {
  var t = (target === undefined || target === null) ? '' : String(target).trim();
  if (!t) return [];
  var keys = [];
  (allCodes || []).forEach(function (k) {
    var ck = String(k);
    if (ck !== t && keys.indexOf(ck) === -1) keys.push(ck);
  });
  var full = keys.concat([t]);
  var out = [];
  keys.forEach(function (c) {
    var cur = c;
    var seen = {};
    while (cur && !seen[cur]) {
      seen[cur] = true;
      var p = ledgerParentOf(cur, full);
      if (!p) break;
      if (p === t) { out.push(c); break; }
      cur = p;
    }
  });
  return out;
}

// Full ledger scope for an account: itself, or the whole group (main
// first) when grouped. Ledger reads/writes across the scope share the
// main's chart; records keep their own account.
function ledgerScopeOf(st, accountId) {
  if (!st || !accountId) return [accountId];
  var mainOf = groupMainOf(st, accountId);
  var mainId = mainOf ? mainOf.id : accountId;
  var ids = [mainId];
  groupMembers(st, mainId).forEach(function (a) { ids.push(a.id); });
  return ids;
}

// Extra display fiats beyond the header main: every group currency in play,
// so their historical pairs get prefetched exactly like header pairs.
// Without this, group figures in a foreign fiat sit on fallback locks.
function groupFillFiats(st) {
  var out = [];
  var seen = {};
  var m = '';
  try { m = String(st.settings.mainCurrency || '').toUpperCase(); } catch (e) { m = ''; }
  ((st && st.accounts) || []).forEach(function (a) {
    if (!a || !a.id) return;
    var isMain = false;
    try { isMain = isGroupMain(st, a.id); } catch (e) { isMain = false; }
    if (!isMain) return;
    var g = '';
    try { g = groupLedgerCurrency(st, a); } catch (e) { g = ''; }
    if (!g || g === m || seen[g]) return;
    seen[g] = true;
    out.push(g);
  });
  return out;
}

// Every ledger code known to an account: chart keys plus codes posted on
// its records (posted-only codes nest like charted ones).
function ledgerAccountCodes(st, accountId) {
  var set = {};
  try {
    var eff = ledgerChartFor(st, accountId);
    Object.keys(eff).forEach(function (k) { var ck = String(k).trim(); if (ck) set[ck] = true; });
  } catch (e) { /* ignore */ }
  ((st && st.trades) || []).forEach(function (t) {
    if (!t || t.accountId !== accountId) return;
    var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (c) set[c] = true;
  });
  return Object.keys(set);
}

function ledgerPostedOn(st, accountId, code, excludeId, excludeCode) {
  var n = 0;
  ((st && st.trades) || []).forEach(function (t) {
    if (!t || t.accountId !== accountId) return;
    if (excludeId && t.id === excludeId) return;
    var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (excludeCode && c === excludeCode) return;
    if (c === code) n++;
  });
  return n;
}

// Parent-overview rule: a ledger with sub-ledgers is a pure roll-up and
// can't hold its own records. Returns null when posting `code` is clean,
// else {kind:'parent',code,kids} (code already has children) or
// {kind:'orphans',code,parents} (posting here would strand records on a
// new parent). excludeId skips one record (trade edits), excludeCode skips
// records carrying that code (ledger renames move them away). scopeIds
// widens charts + postings to the whole group (main first); omitted means
// the single account.
function ledgerRecordConflict(st, accountId, code, excludeId, excludeCode, scopeIds) {
  code = (code === undefined || code === null) ? '' : String(code).trim();
  if (!code) return null;
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [accountId];
  var chartAcc = scope[0];
  var set = {};
  try {
    var eff = ledgerChartFor(st, chartAcc);
    Object.keys(eff).forEach(function (k) { var ck = String(k).trim(); if (ck) set[ck] = true; });
  } catch (e) { /* ignore */ }
  scope.forEach(function (sid) {
    ((st && st.trades) || []).forEach(function (t) {
      if (!t || t.accountId !== sid) return;
      var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
      if (c) set[c] = true;
    });
  });
  var all = Object.keys(set);
  if (all.indexOf(code) === -1) all.push(code);
  function postedInScope(cd) {
    var n = 0;
    scope.forEach(function (sid) { n += ledgerPostedOn(st, sid, cd, excludeId, excludeCode); });
    return n;
  }
  var kids = ledgerDescendantsOf(code, all);
  if (kids.length) return { kind: 'parent', code: code, kids: kids.slice().sort() };
  var parents = [];
  var cur = code;
  var seen = {};
  while (cur && !seen[cur]) {
    seen[cur] = true;
    var p = ledgerParentOf(cur, all);
    if (!p) break;
    if (postedInScope(p) > 0 && parents.indexOf(p) === -1) parents.push(p);
    cur = p;
  }
  if (parents.length) return { kind: 'orphans', code: code, parents: parents };
  return null;
}

// Existing rule-breakers for the cleanup hint: ledgers that hold records
// AND sub-ledgers. Sorted for stable messages.
function ledgerViolations(st, accountId) {
  var all = [];
  try { all = ledgerAccountCodes(st, accountId); } catch (e) { all = []; }
  var out = [];
  all.forEach(function (c) {
    try {
      if (ledgerPostedOn(st, accountId, c, null, null) > 0 && ledgerDescendantsOf(c, all).length > 0) out.push(c);
    } catch (e) { /* ignore */ }
  });
  return out.sort();
}

function ledgerConflictMessage(conf) {
  if (!conf) return '';
  function short(list) {
    var a = (list || []).slice().sort();
    return a.slice(0, 4).join(', ') + (a.length > 4 ? ', …' : '');
  }
  if (conf.kind === 'parent') {
    return '"' + conf.code + '" is an overview ledger — it holds sub-ledgers (' + short(conf.kids) + ') and can\'t take records. Post to a child ledger instead.';
  }
  return '"' + conf.code + '" would turn "' + conf.parents[0] + '" into an overview that still holds records. Move the "' + conf.parents[0] + '" record(s) to a child ledger, keep "' + conf.parents[0] + '" as an empty overview (add it with + Ledger), then post here.';
}

// Repair pass for cash bookkeeping records saved before the cash form
// locked amounts to the account fiat: a cash income/expense with a real
// quantity but a blank/zero total gains total=qty (exactly what the form
// saves today). Positive totals are never touched. Idempotent.
function repairCashTradeAmounts(trades, accounts) {
  try {
    var kinds = {};
    ((accounts) || []).forEach(function (a) {
      if (a && a.id) kinds[a.id] = (typeof a.kind === 'string') ? a.kind.trim().toLowerCase() : '';
    });
    (trades || []).forEach(function (t) {
      if (!t || (t.type !== 'income' && t.type !== 'expense')) return;
      if (kinds[t.accountId] !== 'cash') return;
      var symU = String(t.symbol || '').toUpperCase();
      // Blank currency rejoins the books under the account fiat: without it
      // the record is unfetchable (no pair) and values at zero.
      if (String(t.currency || '').trim() === '' && symU !== '' && isValidCurrencyCode(symU)) {
        t.currency = symU;
      }
      if (String(t.currency || '').toUpperCase() !== symU || symU === '') return;
      var q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
      if (!isFinite(q) || q <= 0) return;
      var tot = (t.total === undefined || t.total === null || String(t.total).trim() === '') ? NaN : Number(t.total);
      if (isFinite(tot) && tot > 0) return;
      t.total = q;
    });
  } catch (e) { /* repair never breaks load/import */ }
}
// Ledger row value: the signed main-fiat movement. Cash-pattern
// income/expense (amount in the account fiat) values by quantity at the
// frozen rate — the optional market-value total may be blank ("free").
// Everything else values by the booked total, as before.
function ledgerSignedMain(t, cashHint, main) {
  var isIn = (t.type === 'income' || t.type === 'buy');
  if (!isIn && t.type !== 'expense' && t.type !== 'sell') return 0;
  var dir = isIn ? 1 : -1;
  var symU = String(t.symbol || '').toUpperCase();
  var ccyU = String(t.currency || '').toUpperCase();
  // Cash bookkeeping values the amount in the account fiat by quantity.
  // cashHint (cash-scope accounts) covers records whose currency field is
  // blank or mismatched: the quantity is still account-fiat money, so it
  // converts at the frozen rate instead of booking a zero. Open cash income
  // floats at the latest fixing (main display fiat); everything else —
  // expenses, transfers, buys/sells, cost basis — stays frozen. When a
  // realization map is supplied (ledger tree / balances), consumed income
  // locks at spend-day rates and only the remainder floats.
  if ((t.type === 'income' || t.type === 'expense') && (cashHint || (ccyU !== '' && ccyU === symU))) {
    var q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
    if (isFinite(q) && q > 0) {
      if (t.type === 'income' && cashHint) {
        var live = null;
        try { live = cashIncomeRate(t, main); } catch (e) { live = null; }
        if (live !== null && live !== undefined && isFinite(Number(live))) return dir * q * Number(live);
      }
      return dir * q * ledgerFxRate(t.fxLock);
    }
    var q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
    if (isFinite(q) && q > 0) return dir * q * ledgerFxRate(t.fxLock);
    if (t.type === 'expense') {
      var et = Number(t.total);
      if (isFinite(et) && et > 0) return -et * ledgerFxRate(t.fxLock);
    }
    return 0;
  }
  var n = normalizeTrade(t);
  return dir * (isFinite(n.netMain) ? n.netMain : 0);
}

// Realization-aware row value: cash incomes in realMap use their attributed
// value (locked consumed + floated remainder); everything else keeps the
// frozen ledgerSignedMain behavior. realMap may be null (single-trade callers).
function ledgerSignedMainRealized(t, cashHint, main, realMap) {
  try {
    if (t && t.type === 'income' && cashHint && realMap && realMap.has(t)) {
      var v = realMap.get(t);
      if (isFinite(Number(v))) return Number(v);
    }
  } catch (e) { /* fall through frozen */ }
  return ledgerSignedMain(t, cashHint, main);
}

function ledgerTree(allTrades, accountId, main, labelMap) {
  return ledgerTreeMulti(allTrades, [accountId], main, labelMap, null);
}

// Multi-account tree for group mains (and asset views): the same roll-up
// over every id in scope. kinds maps id -> account kind; null means all
// cash (the legacy single-account behavior). Asset income/expense without
// a code pool into Unlabeled assets; buy/sell without a code and codeless
// transfers stay out of the tree entirely, on every kind. A labeled transfer
// posts -sent on the source and +received on the arrival under one code.
function ledgerTreeMulti(allTrades, ids, main, labelMap, kinds) {
  var labels = labelMap || {};
  var inScope = {};
  (ids || []).forEach(function (id) { if (typeof id === 'string' && id !== '') inScope[id] = true; });
  function cashScope(id) {
    if (!kinds || typeof kinds[id] !== 'string') return true;
    return isCashKind(kinds[id]);
  }
  var own = {}; // code -> {code, amount}
  var unassignedIncome = 0;
  var unassignedIncomeCount = 0;
  var unassignedExpense = 0;
  var unassignedExpenseCount = 0;
  var unassignedAssets = 0;
  var unassignedAssetsCount = 0;
  // Signed zero is still zero: -0 would print as "-€0.00".
  function z(v) { return (v === 0) ? 0 : Math.round(v * 100) / 100; }
  // Realization (one attribution over the whole scope): consumed cash income
  // locks at spend-day rates, remainder floats. Same FIFO as balances, so
  // tree totals and account Values agree and closed accounts net to zero.
  var realMap = null;
  try {
    realMap = buildCashRealization(allTrades, main, function (id) { return !!inScope[id] && cashScope(id); });
  } catch (e) { realMap = null; }
  (allTrades || []).forEach(function (t) {
    if (!t || !inScope[t.accountId]) return;
    if (t.type !== 'income' && t.type !== 'expense' && t.type !== 'buy' && t.type !== 'sell' && t.type !== 'transfer') return;
    var code = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (t.type === 'transfer') {
      // Codeless transfers stay out of every bucket; a labeled move posts
      // -sent on the source leg and +received on the arrival leg under the
      // same code, so a group scope nets to the fee. Rates mirror the
      // balance legs (frozen source/arrival locks, main-fiat arrival at 1).
      if (!code) return;
      var sent = Number(t.qty);
      if (!isFinite(sent) || sent <= 0) return;
      var mainU = String(main || '').toUpperCase();
      var srcRate = t.fromFxLock ? ledgerFxRate(t.fromFxLock) : ledgerFxRate(t.fxLock);
      var toSym = (t.toSymbol === undefined || t.toSymbol === null || String(t.toSymbol).trim() === '')
        ? String(t.symbol || '').toUpperCase()
        : String(t.toSymbol).trim().toUpperCase();
      var dstRate = (toSym === mainU) ? 1 : (t.toFxLock ? ledgerFxRate(t.toFxLock) : ledgerFxRate(t.fxLock));
      var recv = cashReceivedOf(t);
      if (!isFinite(recv) || recv < 0) recv = 0;
      var destIds = transferDestIds(t);
      if (!own[code]) own[code] = { code: code, amount: 0, count: 0 };
      own[code].amount = z(own[code].amount - sent * srcRate);
      own[code].count++;
      if (!destIds.length) {
        if (inScope[t.accountId]) {
          own[code].amount = z(own[code].amount + recv * dstRate);
          own[code].count++;
        }
      } else {
        destIds.forEach(function (destId) {
          if (destId !== t.accountId && inScope[destId]) {
            var arr = transferArrivalFor(t, destId);
            if (isFinite(arr) && arr > 0) {
              own[code].amount = z(own[code].amount + arr * dstRate);
              own[code].count++;
            }
          }
        });
      }
      return;
    }
    var signed = z(ledgerSignedMainRealized(t, cashScope(t.accountId), main, realMap));
    if (!code) {
      // Only bookkeeping types can be uncategorized; plain asset
      // buy/sell records without a code stay out of the tree entirely.
      // Unlabeled records (e.g. freed by a ledger delete) surface under two
      // virtual defaults so totals never lose money: income vs expenses on
      // cash, one Unlabeled assets pool everywhere else.
      if (t.type === 'income' || t.type === 'expense') {
        if (cashScope(t.accountId)) {
          if (t.type === 'income') { unassignedIncome = z(unassignedIncome + signed); unassignedIncomeCount++; }
          else { unassignedExpense = z(unassignedExpense + signed); unassignedExpenseCount++; }
        } else {
          unassignedAssets = z(unassignedAssets + signed); unassignedAssetsCount++;
        }
      }
      return;
    }
    if (!own[code]) own[code] = { code: code, amount: 0, count: 0 };
    own[code].amount = z(own[code].amount + signed);
    own[code].count++;
  });
  var codes = Object.keys(own);
  // Chart codes without records are structural parents (e.g. 1000 holding
  // only subledger postings): they render with zero of their own so the
  // tree shows the full chart, not just posted codes.
  Object.keys(labels || {}).forEach(function (k) {
    k = String(k).trim();
    if (k === '') return;
    if (!Object.prototype.hasOwnProperty.call(own, k)) {
      own[k] = { code: k, amount: 0, count: 0 };
      codes.push(k);
    }
  });
  var nodes = {};
  codes.forEach(function (c) {
    var tradeLabel = '';
    (allTrades || []).forEach(function (t) {
      if (tradeLabel) return;
      if (t && inScope[t.accountId] && String(t.ledger || '').trim() === c && t.ledgerLabel && String(t.ledgerLabel).trim() !== '') {
        tradeLabel = String(t.ledgerLabel).trim();
      }
    });
    nodes[c] = {
      code: c,
      label: tradeLabel || (labels[c] ? String(labels[c]) : c),
      own: z(own[c].amount),
      count: own[c].count,
      total: 0,
      kids: []
    };
  });
  var roots = [];
  codes.forEach(function (c) {
    var p = ledgerParentOf(c, codes);
    if (p && nodes[p]) nodes[p].kids.push(nodes[c]);
    else roots.push(nodes[c]);
  });
  function roll(n) {
    var t = n.own;
    n.kids.forEach(function (k) { t += roll(k); });
    n.total = z(t);
    n.kids.sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; });
    return n.total;
  }
  roots.forEach(roll);
  roots.sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; });
  var unassigned = z(unassignedIncome + unassignedExpense);
  var unassignedCount = unassignedIncomeCount + unassignedExpenseCount;
  return { roots: roots, unassigned: unassigned, unassignedCount: unassignedCount, unassignedIncome: z(unassignedIncome), unassignedIncomeCount: unassignedIncomeCount, unassignedExpense: z(unassignedExpense), unassignedExpenseCount: unassignedExpenseCount, unassignedAssets: z(unassignedAssets), unassignedAssetsCount: unassignedAssetsCount };
}

function validateTrade(t, heldQty) {
  t = t || {};
  var type = t.type;
  if (type !== undefined && TRADE_TYPES.indexOf(type) === -1) {
    return 'type must be buy, sell, transfer, income or expense';
  }
  var effType = type || 'buy';
  if (effType === 'expense') {
    var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
    var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
    if (!hasQ && !hasT) return 'expense needs qty or total';
    if (hasQ) {
      var qex = Number(t.qty);
      if (!isFinite(qex) || qex <= 0) return 'qty must be > 0';
      if (typeof heldQty === 'number' && isFinite(heldQty)) {
        if (qex > heldQty + LEDGER_EPS) return 'oversell: max sellable is ' + heldQty;
      }
    }
    if (hasT) {
      var tex = Number(t.total);
      if (!isFinite(tex) || tex < 0) return 'total must be >= 0';
      if (!hasQ && tex <= 0) return 'total must be > 0';
    }
  } else {
    if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return 'qty must be > 0';
    if (typeof t.qty === 'string' && t.qty.trim() === '') return 'qty must be > 0';
    var qty = Number(t.qty);
    if (!isFinite(qty) || qty <= 0) return 'qty must be > 0';
    if ((effType === 'sell' || effType === 'transfer') && typeof heldQty === 'number' && isFinite(heldQty)) {
      if (qty > heldQty + LEDGER_EPS) return 'oversell: max sellable is ' + heldQty;
    }
  }
  if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
    if (typeof t.total !== 'number' && typeof t.total !== 'string') return 'total must be >= 0';
    var total = Number(t.total);
    if (!isFinite(total) || total < 0) return 'total must be >= 0';
  }
  if (t.fee !== undefined && t.fee !== null && String(t.fee).trim() !== '') {
    if (typeof t.fee !== 'number' && typeof t.fee !== 'string') return 'fee must be >= 0';
    var fee = Number(t.fee);
    if (!isFinite(fee) || fee < 0) return 'fee must be >= 0';
  }
  // One fiat per trade: the stated total already includes the fee, so the fee
  // cannot exceed an explicitly stated positive total (standalone fees with
  // no total stay allowed).
  if (t.fee !== undefined && t.fee !== null && String(t.fee).trim() !== '' &&
      t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
    var vFee = Number(t.fee);
    var vTot = Number(t.total);
    if (isFinite(vTot) && vTot > 0 && isFinite(vFee) && vFee > vTot) {
      return 'fee cannot exceed total';
    }
  }
  if (t.networkFee !== undefined && t.networkFee !== null && String(t.networkFee).trim() !== '') {
    if (typeof t.networkFee !== 'number' && typeof t.networkFee !== 'string') return 'network fee must be >= 0';
    var nf = Number(t.networkFee);
    if (!isFinite(nf) || nf < 0) return 'network fee must be >= 0';
    if (typeof t.qty === 'number' || typeof t.qty === 'string') {
      var qq = Number(t.qty);
      if (isFinite(qq) && qq > 0 && nf >= qq) return 'network fee must be < qty';
    }
  }
  if (t.feeCurrency !== undefined && t.feeCurrency !== null && String(t.feeCurrency).trim() !== '') {
    if (!isValidCurrencyCode(t.feeCurrency)) return 'fee currency invalid';
  }
  if (!isValidTxid(t.txid)) return 'transaction ID looks invalid — paste the full tx hash';
  if (t.attachment !== undefined && t.attachment !== null && !isValidAttachment(t.attachment)) return 'attachment is invalid — re-attach the file';
  if (t.currency !== undefined && t.currency !== null && String(t.currency).trim() !== '') {
    if (!isValidCurrencyCode(t.currency)) return 'currency invalid';
  }
  if (effType === 'transfer') {
    var hasToV = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
    var outsV = (t.outputs !== undefined && t.outputs !== null && Array.isArray(t.outputs) && t.outputs.length) ? t.outputs : null;
    if (outsV) {
      if (outsV.length > TRANSFER_MAX_OUTPUTS) return 'too many recipients (max 20)';
      if (hasToV) return 'transfer has both a destination and recipients';
      var sumQV = 0, sumFV = 0;
      for (var vi = 0; vi < outsV.length; vi++) {
        if (!isValidTransferOutput(outsV[vi], t.symbol, t.accountId)) return 'recipient ' + (vi + 1) + ' is invalid';
        sumQV += Number(outsV[vi].qty);
        if (outsV[vi].fee !== undefined && outsV[vi].fee !== null && String(outsV[vi].fee).trim() !== '') sumFV += Number(outsV[vi].fee);
      }
      var qVV = Number(t.qty);
      var nfVV = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (isFinite(qVV) && qVV > 0 && isFinite(nfVV) && nfVV >= 0) {
        if (Math.abs(sumQV + nfVV - qVV) > 1e-8) return 'recipients + fee must equal sent';
        if (sumFV - nfVV > 1e-12) return 'recipient fees exceed the transfer fee';
      }
    } else if (hasToV && t.accountId && t.toAccountId && t.accountId === t.toAccountId) return 'transfer needs two different accounts';
  }
  if (typeof t.date === 'string' && t.date.length > 0) {
    if (!isValidDateStr(t.date)) return 'date must be dd/mm/yyyy';
    if (isFutureDateStr(t.date)) return 'date cannot be in the future';
  }
  return null;
}

// Expose Ledger on window.Inoculens for tests.html and Ui (Task 6).
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.normalizeTrade = normalizeTrade;
  window.Inoculens.computeAverage = computeAverage;
  window.Inoculens.computeFifo = computeFifo;
  window.Inoculens.computePositions = computePositions;
  window.Inoculens.validateTrade = validateTrade;
  window.Inoculens.computePortfolio = computePortfolio;
  window.Inoculens.computeAnalytics = computeAnalytics;
  window.Inoculens.heldForAccount = heldForAccount;
  window.Inoculens.isValidLedgerCode = isValidLedgerCode;
  window.Inoculens.isValidLedgerLabel = isValidLedgerLabel;
  window.Inoculens.isValidLedgerLabels = isValidLedgerLabels;
  window.Inoculens.normalizeLedgerLabels = normalizeLedgerLabels;
  window.Inoculens.isCashKind = isCashKind;
  window.Inoculens.isCashAccount = isCashAccount;
  window.Inoculens.cashAccountIds = cashAccountIds;
  window.Inoculens.cashReceivedOf = cashReceivedOf;
  window.Inoculens.cashSignedNative = cashSignedNative;
  window.Inoculens.cashBalance = cashBalance;
  window.Inoculens.transferOutputsOf = transferOutputsOf;
  window.Inoculens.transferDestIds = transferDestIds;
  window.Inoculens.transferArrivalFor = transferArrivalFor;
  window.Inoculens.transferInvolvesAccount = transferInvolvesAccount;
  window.Inoculens.transferRowArrival = transferRowArrival;
  window.Inoculens.isValidTransferOutput = isValidTransferOutput;
  window.Inoculens.ledgerParentOf = ledgerParentOf;
  window.Inoculens.ledgerDescendantsOf = ledgerDescendantsOf;
  window.Inoculens.ledgerAccountCodes = ledgerAccountCodes;
  window.Inoculens.ledgerRecordConflict = ledgerRecordConflict;
  window.Inoculens.ledgerViolations = ledgerViolations;
  window.Inoculens.ledgerConflictMessage = ledgerConflictMessage;
  window.Inoculens.ledgerTree = ledgerTree;
  window.Inoculens.ledgerTreeMulti = ledgerTreeMulti;
  window.Inoculens.ledgerScopeOf = ledgerScopeOf;
  window.Inoculens.groupFillFiats = groupFillFiats;
  window.Inoculens.ledgerChartFor = ledgerChartFor;
  window.Inoculens.ensureAccountChart = ensureAccountChart;
  window.Inoculens.groupMembers = groupMembers;
  window.Inoculens.groupMainOf = groupMainOf;
  window.Inoculens.isGroupMain = isGroupMain;
  window.Inoculens.defaultGroupCurrency = defaultGroupCurrency;
  window.Inoculens.ensureGroupCurrency = ensureGroupCurrency;
  window.Inoculens.assignGroup = assignGroup;
  window.Inoculens.ungroupAll = ungroupAll;
  window.Inoculens.sanitizeGroups = sanitizeGroups;
  window.Inoculens.expandDeleteIds = expandDeleteIds;
  window.Inoculens.uniqueSubName = uniqueSubName;
  window.Inoculens.assetLedgersOn = assetLedgersOn;
  window.Inoculens.openLedgerDialog = openLedgerDialog;
  window.Inoculens.openGroupDialog = openGroupDialog;
  window.Inoculens.createSubAccount = createSubAccount;
  window.Inoculens.renameAccountLedger = renameAccountLedger;
  window.Inoculens.deleteAccountLedger = deleteAccountLedger;
  window.Inoculens.ledgerSignedMain = ledgerSignedMain;
  window.Inoculens.ledgerSignedMainRealized = ledgerSignedMainRealized;
  window.Inoculens.buildCashRealization = buildCashRealization;
  window.Inoculens.cashFiatOf = cashFiatOf;
  window.Inoculens.cashQtyOf = cashQtyOf;
  window.Inoculens.learnLedgerLabel = learnLedgerLabel;
  window.Inoculens.findLedgerLabel = findLedgerLabel;
  window.Inoculens.refreshLedgerList = refreshLedgerList;
  window.Inoculens.TRADE_TYPES = TRADE_TYPES;
}

// === Prices ===
// Live crypto prices via CoinGecko simple/price with manual fallback.
// Resolution order per symbol: (1) manual override from live
// loadState().priceOverrides (wins, no network), (2) CoinGecko
// simple/price for mapped symbols with a 60s in-memory cache,
// (3) null for unknown tickers or failed fetches (last cached price
// is returned when available). Never throws to the UI — failures
// resolve to cached-or-null. Read by Ui (Task 6) via refreshAllPrices.

var SYMBOL_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  XLM: 'stellar',
  ATOM: 'cosmos',
  UNI: 'uniswap',
  TRX: 'tron',
  NEAR: 'near',
  ARB: 'arbitrum',
  OP: 'optimism',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  MATIC: 'matic-network',
  POL: 'polygon-ecosystem-token',
  APT: 'aptos',
  INJ: 'injective-protocol',
  SUI: 'sui',
  SEI: 'sei-network',
  TIA: 'celestia',
  PEPE: 'pepe',
  SHIB: 'shiba-inu',
  TON: 'toncoin',
  ICP: 'internet-computer',
  FIL: 'filecoin',
  ETC: 'ethereum-classic',
  HBAR: 'hedera-hashgraph',
  VET: 'vechain',
  RENDER: 'render-token',
  FET: 'fetch-ai',
  KAS: 'kaspa',
  MNT: 'mantle',
  STX: 'stacks',
  MKR: 'maker',
  AAVE: 'aave',
  CRV: 'curve-dao-token',
  LDO: 'lido-dao',
  AR: 'arweave',
  SAND: 'the-sandbox',
  MANA: 'decentraland',
  AXS: 'axie-infinity',
  CHZ: 'chiliz',
  ENJ: 'enjincoin',
  BAT: 'basic-attention-token',
  ZEC: 'zcash',
  DASH: 'dash',
  XTZ: 'tezos',
  EOS: 'eos',
  KSM: 'kusama',
  ALGO: 'algorand',
  THETA: 'theta-network',
  FTM: 'fantom',
  CELO: 'celo',
  KAVA: 'kava',
  RUNE: 'thorchain',
  WBTC: 'wrapped-bitcoin',
  WSTETH: 'wrapped-steth',
  RPL: 'rocket-pool',
  SNX: 'havven',
  COMP: 'compound-governance-token',
  YFI: 'yearn-finance',
  SUSHI: 'sushi',
  ASTR: 'astar',
  JUP: 'jupiter-exchange-solana',
  PYTH: 'pyth-network',
  ONDO: 'ondo-finance',
  TAO: 'bittensor',
  XMR: 'monero',
  CRO: 'crypto-com-chain',
  GRT: 'the-graph',
  IMX: 'immutable-x',
  ENS: 'ethereum-name-service',
  LRC: 'loopring',
  QNT: 'quant-network',
  CAKE: 'pancakeswap-token',
  EGLD: 'elrond-erd-2',
  FLOW: 'flow',
  GALA: 'gala',
  APE: 'apecoin',
  JASMY: 'jasmycoin',
  HNT: 'helium',
  WIF: 'dogwifcoin',
  BONK: 'bonk',
  FLOKI: 'floki',
  RAY: 'raydium',
  PENDLE: 'pendle',
  ENA: 'ethena',
  STRK: 'starknet',
  ZK: 'zksync',
  W: 'wormhole',
  BLUR: 'blur',
  ORCA: 'orca'
};

// Commodities / precious metals / energy, quoted in USD on Stooq (spot for
// metals, front-month futures for energy/materials). Keys are the account
// tickers users type; values are Stooq codes (lowercase). Tickers containing
// a dot (e.g. GC.F) bypass the map and are used as Stooq codes directly so
// new instruments work without a code change. Units: metals per troy ounce,
// oil per barrel — converted into the display main via ECB like stocks.
var COMMODITY_MAP = {
  XAU: 'xauusd',
  XAG: 'xagusd',
  XPT: 'xptusd',
  XPD: 'xpdusd',
  WTI: 'cl.f',
  USOIL: 'cl.f',
  OIL: 'cl.f',
  BRENT: 'cb.f',
  UKOIL: 'cb.f',
  BRENTOIL: 'cb.f',
  NG: 'ng.f',
  NATGAS: 'ng.f',
  COPPER: 'hg.f',
  HG: 'hg.f',
  GC: 'gc.f',
  SI: 'si.f',
  PL: 'pl.f',
  PA: 'pa.f'
};

function isStooqKind(kd) {
  var k = (typeof kd === 'string') ? kd.trim().toLowerCase() : '';
  return k === 'stock' || k === 'commodity';
}

function stooqCommoditySymbol(sym) {
  var s = String(sym || '').trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,12}$/.test(s)) return null;
  if (Object.prototype.hasOwnProperty.call(COMMODITY_MAP, s)) return COMMODITY_MAP[s];
  if (s.indexOf('.') !== -1) return s.toLowerCase();
  return null;
}

function histKindFor(kd) {
  var k = (typeof kd === 'string') ? kd.trim().toLowerCase() : '';
  if (k === 'stock') return 'stock';
  if (k === 'commodity') return 'commodity';
  return 'crypto';
}

// Live metals via gold-api.com (free, no key, CORS-open): XAU/XAG/XPT/XPD
// spot per troy ounce + HG copper, quoted in USD. COPPER is an alias for
// HG. Energy (WTI/BRENT/NG) rides Yahoo front-month futures via
// YAHOO_COMMODITY_MAP below, with Stooq as the last resort.
var GOLD_API_METALS = ['XAU', 'XAG', 'XPT', 'XPD', 'HG'];
function goldApiSymbol(sym) {
  var s = String(sym || '').trim().toUpperCase();
  if (s === 'COPPER') return 'HG';
  if (GOLD_API_METALS.indexOf(s) !== -1) return s;
  return null;
}

// USD spot from gold-api.com. Resolves a positive number or null — never
// throws, never caches (the caller bridges + caches into the display fiat).
function fetchGoldApiUsd(sym, fetchImpl) {
  var s = goldApiSymbol(sym);
  if (!s) return Promise.resolve(null);
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  var url = 'https://api.gold-api.com/price/' + encodeURIComponent(s);
  try {
    return f(url).then(function (res) {
      if (!res || !res.ok) throw new Error('goldapi-http-' + (res && res.status));
      return res.json();
    }).then(function (data) {
      var p = data ? Number(data.price) : NaN;
      if (isFinite(p) && p > 0) return p;
      return null;
    }).then(null, function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

// Energy futures via Yahoo (same proxy chain as stocks): WTI/Brent/gas
// have no key-free spot API; front-month futures track them closely.
// Units stay native (USD per barrel), converted via ECB like everything else.
var YAHOO_COMMODITY_MAP = {
  WTI: 'CL=F',
  USOIL: 'CL=F',
  OIL: 'CL=F',
  BRENT: 'BZ=F',
  UKOIL: 'BZ=F',
  BRENTOIL: 'BZ=F',
  NG: 'NG=F',
  NATGAS: 'NG=F'
};

// Yahoo daily history for any Yahoo code (stocks, futures): one 12-day
// window ending the day after wantDay; the newest candle at or before
// wantDay wins (walked back = interpolated). Resolves
// {price, interpolated, day} or rejects — the caller picks the fallback.
function fetchYahooHistory(yahooSym, wantDay, cur, fetchImpl) {
  var endSec = Math.floor(Date.UTC(Number(wantDay.slice(0, 4)), Number(wantDay.slice(5, 7)) - 1, Number(wantDay.slice(8, 10))) / 1000) + 86400;
  if (!isFinite(endSec) || endSec <= 0) return Promise.reject(new Error('no-window'));
  var startSec = endSec - 12 * 86400;
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.reject(new Error('no-fetch'));
  return fetchFirstJson(yahooProxyUrls(yahooSym, 'period1=' + startSec + '&period2=' + endSec + '&interval=1d'), f).then(function (data) {
    var r = data && data.chart && data.chart.result && data.chart.result[0];
    if (!r) throw new Error('no-quotes');
    var nat = String((r.meta && r.meta.currency) || 'USD').toUpperCase();
    var candles = parseYahooDaily(data).filter(function (c) { return c.day <= wantDay; });
    if (!candles.length) throw new Error('no-fixing');
    var pick = candles[candles.length - 1];
    var back = (pick.day !== wantDay);
    if (nat === cur) return { price: pick.close, interpolated: back, day: pick.day };
    return fetchEcbRate(pick.day, nat, cur).then(function (fx) {
      var v = pick.close * Number(fx.rate);
      if (!isFinite(v) || v <= 0) throw new Error('fx-bridge');
      return { price: v, interpolated: back || !!fx.interpolated, day: pick.day };
    });
  });
}

var PRICE_CACHE_TTL_MS = 60000;
var priceCache = {}; // key "SYM:VS" (uppercased) -> {price, at}

function priceCacheKey(symbol, vs) {
  return String(symbol).toUpperCase() + ':' + String(vs).toUpperCase();
}

function priceOverrideFor(symbol) {
  var e = null;
  try { e = priceOverrideEntry(symbol); } catch (err) { e = null; }
  return e ? e.price : null;
}

// Raw override entry with its fiat: {price, vs} where vs is null for legacy
// bare numbers (fiat unknown — treated as the requested fiat, exactly the
// old behavior). New saves always tag the fiat they were entered in.
function priceOverrideEntry(symbol) {
  var sym = String(symbol).trim().toUpperCase();
  var ov = null;
  try {
    var st = loadState();
    ov = st ? st.priceOverrides : null;
  } catch (e) {
    ov = null;
  }
  if (!ov || typeof ov !== 'object') return null;
  var raw = null;
  if (Object.prototype.hasOwnProperty.call(ov, sym)) {
    raw = ov[sym];
  } else {
    // Tolerate differently-cased keys without touching stored data.
    var keys = Object.keys(ov);
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i]).toUpperCase() === sym) { raw = ov[keys[i]]; break; }
    }
  }
  if (typeof raw === 'number') {
    return (isFinite(raw) && raw > 0) ? { price: raw, vs: null } : null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    var p = Number(raw.price);
    var vs = (typeof raw.vs === 'string') ? raw.vs.trim().toUpperCase() : '';
    if (isFinite(p) && p > 0 && /^[A-Z]{2,10}$/.test(vs)) return { price: p, vs: vs };
  }
  return null;
}

function priceDefaultVs(vs) {
  if (typeof vs === 'string' && vs.length > 0) return vs;
  try {
    var st = loadState();
    if (st && st.settings && typeof st.settings.mainCurrency === 'string' && st.settings.mainCurrency.length > 0) {
      return st.settings.mainCurrency;
    }
  } catch (e) { /* fall through */ }
  return 'EUR';
}

function stooqSymbol(sym) {
  var s = String(sym || '').trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,12}$/.test(s)) return null;
  return s.toLowerCase() + '.us';
}

function parseStooqClose(csv) {
  try {
    var lines = String(csv || '').trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    var header = lines[0].split(',');
    var row = lines[1].split(',');
    var ci = header.indexOf('Close');
    if (ci === -1) ci = 6;
    var v = Number(row[ci]);
    if (!isFinite(v) || v <= 0) return null;
    return v;
  } catch (e) { return null; }
}

// Stocks via Yahoo Finance chart API, fetched through the allorigins proxy
// (Yahoo blocks browser CORS directly; the proxy is a dumb pipe for public
// quotes — no user data ever leaves the browser). Stooq's q/l quote
// endpoint currently answers 404, so Yahoo is primary and Stooq is kept as
// the fallback below.
function yahooSymbol(sym) {
  var s = String(sym || '').trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(s)) return null;
  if (/^(XAU|XAG|XPT|XPD)$/.test(s)) return null; // metals belong to gold-api
  return s;
}

function yahooChartUrl(sym, query) {
  return 'https://api.allorigins.win/raw?url=' +
    encodeURIComponent('https://query1.finance.yahoo.com/v8/finance/chart/' +
      encodeURIComponent(sym) + '?' + query);
}

// Both CORS proxies for the Yahoo chart URL, in order: allorigins first,
// codetabs second (some networks/adblockers kill one but not the other).
function yahooProxyUrls(sym, query) {
  var base = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?' + query;
  return ['https://api.allorigins.win/raw?url=' + encodeURIComponent(base),
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(base)];
}

// Crypto live fallbacks when CoinGecko is rate-limited: Kraken then
// Coinbase (both free, no key, CORS-open — the same hosts the history path
// already uses). USD spot only; the caller bridges into the display fiat.
// Never throw: null on any miss, and non-listed majors cost zero network.
function fetchKrakenLiveUsd(sym, fetchImpl) {
  var s = String(sym || '').trim().toUpperCase();
  if (KRAKEN_SYMBOLS.indexOf(s) === -1) return Promise.resolve(null);
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  var url = 'https://api.kraken.com/0/public/Ticker?pair=' + encodeURIComponent(s + 'USD');
  try {
    return f(url).then(function (res) {
      if (!res || !res.ok) throw new Error('kraken-http-' + (res && res.status));
      return res.json();
    }).then(function (data) {
      var result = data && data.result;
      if (!result || typeof result !== 'object') return null;
      var keys = Object.keys(result);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === 'last') continue;
        var c = result[keys[i]] && result[keys[i]].c;
        var p = (c && c.length) ? Number(c[0]) : NaN;
        if (isFinite(p) && p > 0) return p;
      }
      return null;
    }).then(null, function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

function fetchCoinbaseLiveUsd(sym, fetchImpl) {
  var s = String(sym || '').trim().toUpperCase();
  if (COINBASE_SYMBOLS.indexOf(s) === -1) return Promise.resolve(null);
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  var url = 'https://api.exchange.coinbase.com/products/' + encodeURIComponent(s + '-USD') + '/ticker';
  try {
    return f(url).then(function (res) {
      if (!res || !res.ok) throw new Error('coinbase-http-' + (res && res.status));
      return res.json();
    }).then(function (data) {
      var p = data ? Number(data.price) : NaN;
      if (isFinite(p) && p > 0) return p;
      return null;
    }).then(null, function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

function fetchCryptoFallbackUsd(sym, fetchImpl) {
  return fetchKrakenLiveUsd(sym, fetchImpl).then(function (p) {
    if (isFinite(Number(p)) && Number(p) > 0) return Number(p);
    return fetchCoinbaseLiveUsd(sym, fetchImpl);
  }, function () { return fetchCoinbaseLiveUsd(sym, fetchImpl); });
}

// First URL that answers ok + parses as JSON; rejects when all fail.
// Each attempt fails fast (12s race) so one hanging proxy cannot stick the
// UI on "loading" for minutes. Never throws synchronously.
function fetchWithTimeout(fetchImpl, url, ms) {
  var timeoutMs = (isFinite(Number(ms)) && Number(ms) > 0) ? Number(ms) : 12000;
  var timer = null;
  var timeoutP = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('proxy-timeout')); }, timeoutMs);
    if (timer && typeof timer.unref === 'function') { try { timer.unref(); } catch (e) { /* ignore */ } }
  });
  var attempt;
  try {
    attempt = fetchImpl(url);
  } catch (e) {
    if (timer) { try { clearTimeout(timer); } catch (e2) { /* ignore */ } }
    return Promise.reject(e);
  }
  if (!attempt || typeof attempt.then !== 'function') {
    if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } }
    return Promise.reject(new Error('no-promise'));
  }
  return Promise.race([attempt, timeoutP]).then(function (res) {
    if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } }
    return res;
  }, function (e) {
    if (timer) { try { clearTimeout(timer); } catch (e2) { /* ignore */ } }
    throw e;
  });
}

function fetchFirstJson(urls, fetchImpl) {
  function next(i) {
    if (i >= urls.length) return Promise.reject(new Error('no-source'));
    return fetchWithTimeout(fetchImpl, urls[i]).then(function (res) {
      if (!res || !res.ok) throw new Error('proxy-http-' + (res && res.status));
      return res.json();
    }).then(null, function () { return next(i + 1); });
  }
  return next(0);
}

// Latest quote from a Yahoo chart payload: regularMarketPrice first, else
// the newest non-null daily close. Returns {price, currency} or null.
function parseYahooQuote(data) {
  try {
    var r = data && data.chart && data.chart.result && data.chart.result[0];
    if (!r) return null;
    var cur = String((r.meta && r.meta.currency) || 'USD').toUpperCase();
    var px = r.meta ? Number(r.meta.regularMarketPrice) : NaN;
    if (isFinite(px) && px > 0) return { price: px, currency: cur };
    var q = r.indicators && r.indicators.quote && r.indicators.quote[0];
    var cl = (q && q.close) || [];
    for (var i = cl.length - 1; i >= 0; i--) {
      var c = Number(cl[i]);
      if (isFinite(c) && c > 0) return { price: c, currency: cur };
    }
  } catch (e) { /* fall through */ }
  return null;
}

// Daily closes from a Yahoo chart payload: [{day:'YYYY-MM-DD', close}]
// in UTC date (US session hours never cross UTC midnight, so the trading
// date and UTC date coincide for .us listings).
function parseYahooDaily(data) {
  var out = [];
  try {
    var r = data && data.chart && data.chart.result && data.chart.result[0];
    if (!r) return out;
    var ts = r.timestamp || [];
    var q = r.indicators && r.indicators.quote && r.indicators.quote[0];
    var cl = (q && q.close) || [];
    for (var i = 0; i < ts.length; i++) {
      var c = Number(cl[i]);
      if (!isFinite(c) || c <= 0) continue;
      var d = new Date(Number(ts[i]) * 1000);
      if (!isFinite(d.getTime())) continue;
      out.push({ day: d.toISOString().slice(0, 10), close: c });
    }
  } catch (e) { /* fall through */ }
  return out;
}

// Stocks via CNBC (direct, CORS `*`, no proxy): one batched quote call for
// any number of tickers. Each code-0 quote yields {price, currency} keyed
// by uppercased symbol. Never rejects: misses are simply absent.
var CNBC_QUOTE_URL = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
function parseCnbcQuotes(data) {
  var map = {};
  try {
    var list = data && data.FormattedQuoteResult && data.FormattedQuoteResult.FormattedQuote;
    if (!Array.isArray(list)) return map;
    list.forEach(function (q) {
      if (!q || Number(q.code) !== 0) return;
      var s = String(q.symbol || '').toUpperCase();
      var p = Number(q.last);
      if (!s || !isFinite(p) || p <= 0) return;
      map[s] = { price: p, currency: String(q.currencyCode || 'USD').toUpperCase() };
    });
  } catch (e) { /* fall through */ }
  return map;
}

function fetchBatchCnbc(syms, fetchImpl) {
  var list = [];
  (syms || []).forEach(function (s) {
    var t = String(s || '').trim().toUpperCase();
    if (t && /^[A-Z0-9.-]{1,12}$/.test(t) && list.indexOf(t) === -1) list.push(t);
  });
  if (!list.length) return Promise.resolve({});
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve({});
  var url = CNBC_QUOTE_URL + '?symbols=' +
    list.map(function (t) { return encodeURIComponent(t); }).join('|') +
    '&requestMethod=quick&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
  try {
    return f(url).then(function (res) {
      if (!res || !res.ok) throw new Error('cnbc-http-' + (res && res.status));
      return res.json();
    }).then(function (data) {
      return parseCnbcQuotes(data);
    }).then(null, function () { return {}; });
  } catch (e) { return Promise.resolve({}); }
}

// Native-currency stock quote into the display fiat (1:1 when equal),
// cached under STOCK:sym:cur. Stale cache wins over null on any failure.
function convertStockQuote(sym, price, native, cur) {
  var s = String(sym || '').trim().toUpperCase();
  var c = String(cur || 'EUR').toUpperCase();
  var key = priceCacheKey('STOCK:' + s, c);
  var cached = null;
  try { cached = priceCache[key] || null; } catch (e) { cached = null; }
  function cachedOrNull() {
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
    return null;
  }
  var p = Number(price);
  var nat = String(native || 'USD').toUpperCase();
  if (!isFinite(p) || p <= 0) return Promise.resolve(cachedOrNull());
  if (nat === c) {
    priceCache[key] = { price: p, at: Date.now() };
    return Promise.resolve(p);
  }
  return fetchEcbRate(todayStr(), nat, c).then(function (r) {
    var v = p * Number(r.rate);
    if (!isFinite(v) || v <= 0) return cachedOrNull();
    priceCache[key] = { price: v, at: Date.now() };
    return v;
  }, function () { return cachedOrNull(); });
}

function fetchStockCnbc(sym, cur, fetchImpl) {
  return fetchBatchCnbc([sym], fetchImpl).then(function (map) {
    var q = map && map[String(sym || '').toUpperCase()];
    if (!q) return null;
    return convertStockQuote(sym, q.price, q.currency, cur);
  });
}

function fetchStockYahoo(sym, cur, fetchImpl) {
  // Yahoo chart via proxies, Stooq below. Resolves cached-or-null (never
  // rejects) when every source misses.
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  function stooq() {
    var sq = stooqSymbol(sym);
    if (!sq || !f) return Promise.resolve(null);
    var url = 'https://stooq.com/q/l/?s=' + encodeURIComponent(sq) + '&f=sd2t2ohlcv&h&e=csv';
    return f(url).then(function (res) {
      if (!res || !res.ok) throw new Error('price-http-' + (res && res.status));
      return res.text();
    }).then(function (csv) {
      return convertStockQuote(sym, parseStooqClose(csv), 'USD', cur);
    }).then(null, function () { return null; });
  }
  if (!f) return Promise.resolve(null);
  var yq = yahooSymbol(sym);
  if (!yq) return stooq();
  return fetchFirstJson(yahooProxyUrls(yq, 'interval=1d&range=5d'), f).then(function (data) {
    var q = parseYahooQuote(data);
    if (!q) throw new Error('no-quote');
    return convertStockQuote(sym, q.price, q.currency, cur);
  }).then(null, function () { return stooq(); });
}

function fetchStockPrice(symbol, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = priceDefaultVs(vs);
  cur = String(cur).trim().toUpperCase();
  if (MAIN_CURRENCIES.indexOf(cur) === -1) cur = 'EUR';
  var key = priceCacheKey('STOCK:' + sym, cur);
  var now = Date.now();
  var cached = priceCache[key];
  if (cached && (now - cached.at) < PRICE_CACHE_TTL_MS && isFinite(Number(cached.price)) && Number(cached.price) > 0) {
    return Promise.resolve(Number(cached.price));
  }
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) {
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Promise.resolve(Number(cached.price));
    return Promise.resolve(null);
  }
  // CNBC direct first (no proxy lottery), then Yahoo proxies, then Stooq.
  return fetchStockCnbc(sym, cur, capturedFetch).then(function (p) {
    if (isFinite(Number(p)) && Number(p) > 0) return Number(p);
    return fetchStockYahoo(sym, cur, capturedFetch);
  }, function () { return fetchStockYahoo(sym, cur, capturedFetch); });
}

function fetchCommodityPrice(symbol, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = priceDefaultVs(vs);
  cur = String(cur).trim().toUpperCase();
  if (MAIN_CURRENCIES.indexOf(cur) === -1) cur = 'EUR';
  var key = priceCacheKey('COMMODITY:' + sym, cur);
  var now = Date.now();
  var cached = priceCache[key];
  if (cached && (now - cached.at) < PRICE_CACHE_TTL_MS && isFinite(Number(cached.price)) && Number(cached.price) > 0) {
    return Promise.resolve(Number(cached.price));
  }
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) {
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Promise.resolve(Number(cached.price));
    return Promise.resolve(null);
  }
  function cachedOrNull() {
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
    return null;
  }
  // Shared native->display-fiat bridge (same ECB source the stock path uses).
  function bridged(amount, native) {
    var p = Number(amount);
    var nat = String(native || 'USD').toUpperCase();
    if (!isFinite(p) || p <= 0) return Promise.resolve(cachedOrNull());
    if (nat === cur) {
      priceCache[key] = { price: p, at: Date.now() };
      return Promise.resolve(p);
    }
    return fetchEcbRate(todayStr(), nat, cur).then(function (r) {
      var v = p * Number(r.rate);
      if (!isFinite(v) || v <= 0) return cachedOrNull();
      priceCache[key] = { price: v, at: Date.now() };
      return v;
    }, function () { return cachedOrNull(); });
  }
  // Legacy Stooq quote (kept as the last resort — the q/l endpoint
  // currently answers 404, so a miss here resolves null and the row keeps
  // its honest "feed unreachable" error + override fallback).
  function viaStooq() {
    var sq = stooqCommoditySymbol(sym);
    if (!sq) return Promise.resolve(cachedOrNull());
    var url = 'https://stooq.com/q/l/?s=' + encodeURIComponent(sq) + '&f=sd2t2ohlcv&h&e=csv';
    return capturedFetch(url).then(function (res) {
      if (!res.ok) throw new Error('price-http-' + res.status);
      return res.text();
    }).then(function (csv) {
      return bridged(parseStooqClose(csv), 'USD');
    }).then(null, function () { return cachedOrNull(); });
  }
  // Energy futures via Yahoo (same proxy chain as stocks).
  function viaEnergy(ySym) {
    return fetchFirstJson(yahooProxyUrls(ySym, 'interval=1d&range=5d'), capturedFetch).then(function (data) {
      var q = parseYahooQuote(data);
      if (!q) throw new Error('no-quote');
      return bridged(q.price, q.currency);
    }).then(null, function () { return viaStooq(); });
  }
  // Metals first: gold-api.com is free, key-free and CORS-open.
  if (goldApiSymbol(sym)) {
    return fetchGoldApiUsd(sym, capturedFetch).then(function (usd) {
      if (isFinite(Number(usd)) && Number(usd) > 0) return bridged(usd, 'USD');
      return viaStooq();
    }, function () { return viaStooq(); });
  }
  if (Object.prototype.hasOwnProperty.call(YAHOO_COMMODITY_MAP, sym)) return viaEnergy(YAHOO_COMMODITY_MAP[sym]);
  return viaStooq();
}

var lastPriceErrors = {}; // sym -> short reason for the latest refreshAllPrices run (feeds the error-details popup)

function cachedFreshPrice(sym, cur) {
  var key = priceCacheKey(sym, cur);
  var c = priceCache[key];
  if (c && (Date.now() - c.at) < PRICE_CACHE_TTL_MS && isFinite(Number(c.price)) && Number(c.price) > 0) {
    return Number(c.price);
  }
  return null;
}

// One CoinGecko request for many symbols (ids=csv, vs=main[,usd]). Per-coin
// requests tripped the free-tier rate limit and caused the intermittent
// "unreachable" errors; a single batched call plus one outer retry is far
// more reliable. Resolves {prices, errors}; rejects only on total failure.
function fetchBatchPrices(syms, vs) {
  var cur = String(vs || '').toUpperCase();
  var curLow = cur.toLowerCase();
  var ids = syms.map(function (s) { return SYMBOL_MAP[String(s).toUpperCase()]; });
  var seenIds = {};
  var uniqIds = [];
  ids.forEach(function (id) { if (id && !seenIds[id]) { seenIds[id] = true; uniqIds.push(id); } });
  var needUsd = curLow !== 'usd'; // bridge for mains CoinGecko doesn't quote (e.g. RON)
  var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
    uniqIds.map(function (id) { return encodeURIComponent(id); }).join(',') +
    '&vs_currencies=' + encodeURIComponent(curLow) + (needUsd ? ',usd' : '');
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  var done = function (prices, errors) { return { prices: prices, errors: errors }; };
  if (!capturedFetch) {
    var off = {}, offE = {};
    syms.forEach(function (s) {
      var c = priceCache[priceCacheKey(s, cur)];
      if (c && isFinite(Number(c.price)) && Number(c.price) > 0) off[s] = Number(c.price);
      else { off[s] = null; offE[s] = 'offline — no cached price'; }
    });
    return Promise.resolve(done(off, offE));
  }
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.json();
  }).then(function (data) {
    var prices = {}, errors = {};
    var usdToCur = null;
    var usdToCurJobs = [];
    syms.forEach(function (s) {
      var id = SYMBOL_MAP[String(s).toUpperCase()];
      var p = data && data[id] && data[id][curLow];
      p = Number(p);
      if (isFinite(p) && p > 0) {
        prices[s] = p;
        priceCache[priceCacheKey(s, cur)] = { price: p, at: Date.now() };
        return;
      }
      if (needUsd) {
        var pu = data && data[id] && data[id].usd;
        pu = Number(pu);
        if (isFinite(pu) && pu > 0) {
          usdToCurJobs.push({ sym: s, usd: pu });
          return;
        }
      }
      prices[s] = null;
      errors[s] = 'no quote returned — try a manual override in Settings';
    });
    if (!usdToCurJobs.length) return done(prices, errors);
    return fetchEcbRate(todayStr(), 'USD', cur).then(function (r) {
      usdToCur = Number(r.rate);
      usdToCurJobs.forEach(function (j) {
        var v = j.usd * usdToCur;
        if (isFinite(v) && v > 0) {
          prices[j.sym] = v;
          priceCache[priceCacheKey(j.sym, cur)] = { price: v, at: Date.now() };
        } else {
          prices[j.sym] = null;
          errors[j.sym] = 'currency bridge failed — try a manual override in Settings';
        }
      });
      return done(prices, errors);
    }, function () {
      usdToCurJobs.forEach(function (j) {
        prices[j.sym] = null;
        errors[j.sym] = 'currency bridge unreachable (ECB) — try a manual override in Settings';
      });
      return done(prices, errors);
    });
  });
}

function fetchLivePrice(symbol, vs, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = priceDefaultVs(vs);
  cur = String(cur).trim().toUpperCase();
  if (MAIN_CURRENCIES.indexOf(cur) === -1 && ['USDC', 'USDT', 'DAI'].indexOf(cur) === -1) cur = 'EUR';
  var curLow = String(cur).toLowerCase();
  // (2) Fresh cache (60s) avoids network.
  var key = priceCacheKey(sym, cur);
  var now = Date.now();
  var cached = priceCache[key];
  // (1) Manual override wins — no market network. A legacy bare number is
  // denominated in the requested fiat (old behavior); a fiat-tagged override
  // converts at the CURRENT rate (it stands in for the live price), and
  // resolves unknown — never mislabeled — when conversion fails.
  var ovEntry = null;
  try { ovEntry = priceOverrideEntry(sym); } catch (e) { ovEntry = null; }
  if (ovEntry !== null) {
    if (!ovEntry.vs || ovEntry.vs === cur) return Promise.resolve(ovEntry.price);
    var ovCached = priceCache[key];
    return fetchEcbRate(todayStr(), ovEntry.vs, cur).then(function (r) {
      var v = ovEntry.price * Number(r.rate);
      if (!isFinite(v) || v <= 0) {
        if (ovCached && isFinite(Number(ovCached.price)) && Number(ovCached.price) > 0) return Number(ovCached.price);
        return null;
      }
      priceCache[key] = { price: v, at: Date.now() };
      return v;
    }, function () {
      if (ovCached && isFinite(Number(ovCached.price)) && Number(ovCached.price) > 0) return Number(ovCached.price);
      return null;
    });
  }
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  if (kd === 'stock') return fetchStockPrice(sym, cur);
  if (kd === 'commodity') return fetchCommodityPrice(sym, cur);
  // Cash in the display fiat is worth 1 by definition — no network, no
  // override needed (a manual override above still wins when set).
  if (kd === 'cash' && sym === cur) {
    priceCache[key] = { price: 1, at: Date.now() };
    return Promise.resolve(1);
  }
  if (kd === 'custom' || kd === 'cash') return Promise.resolve(null);
  // (3a) Unknown ticker: null immediately, never throws, no network.
  var id = SYMBOL_MAP[sym];
  if (!id) return Promise.resolve(null);
  var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
    encodeURIComponent(id) + '&vs_currencies=' + encodeURIComponent(curLow);
  // Hermetic async: capture fetch at call time so a later stub restore
  // cannot clobber this operation's continuation.
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) {
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Promise.resolve(Number(cached.price));
    return Promise.resolve(null);
  }
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.json();
  }).then(function (data) {
    var p = data && data[id] && data[id][curLow];
    p = Number(p);
    if (isFinite(p) && p > 0) {
      priceCache[key] = { price: p, at: Date.now() };
      return p;
    }
    // Unsupported vs_currency (e.g. RON is absent from CoinGecko's list):
    // bridge via the USD pivot — USD price times live USD->main FX.
    // Cached-or-null fallback preserved below on any failure.
    if (curLow !== 'usd') {
      return fetchLivePrice(sym, 'USD').then(function (pu) {
        pu = Number(pu);
        if (!isFinite(pu) || pu <= 0) {
          if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
          return null;
        }
        return fetchEcbRate(todayStr(), 'USD', cur).then(function (r) {
          var bridged = pu * Number(r.rate);
          if (!isFinite(bridged) || bridged <= 0) {
            if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
            return null;
          }
          priceCache[key] = { price: bridged, at: Date.now() };
          return bridged;
        }, function () {
          if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
          return null;
        });
      });
    }
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
    return null;
  }).then(null, function () {
    // CoinGecko error / 429 / bad payload: exchange fallbacks for majors
    // (Kraken, then Coinbase), then last cached or null. Never throws.
    return fetchCryptoFallbackUsd(sym, capturedFetch).then(function (fu) {
      fu = Number(fu);
      if (!isFinite(fu) || fu <= 0) {
        if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
        return null;
      }
      if (curLow === 'usd') {
        priceCache[key] = { price: fu, at: Date.now() };
        return fu;
      }
      return fetchEcbRate(todayStr(), 'USD', cur).then(function (r) {
        var v = fu * Number(r.rate);
        if (!isFinite(v) || v <= 0) {
          if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
          return null;
        }
        priceCache[key] = { price: v, at: Date.now() };
        return v;
      }, function () {
        if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
        return null;
      });
    });
  });
}

function refreshAllPrices(symbols, vs, kinds) {
  var cur = priceDefaultVs(vs);
  var seen = {};
  var uniq = [];
  (symbols || []).forEach(function (s) {
    var sym = String(s || '').toUpperCase();
    if (!sym || seen[sym]) return;
    seen[sym] = true;
    uniq.push(sym);
  });
  function kindFor(sym) {
    if (!kinds) return undefined;
    if (typeof kinds === 'function') { try { return kinds(sym); } catch (e) { return undefined; } }
    if (typeof kinds === 'object') {
      if (Object.prototype.hasOwnProperty.call(kinds, sym)) return kinds[sym];
      var up = String(sym).toUpperCase();
      var ks = Object.keys(kinds);
      for (var i = 0; i < ks.length; i++) if (String(ks[i]).toUpperCase() === up) return kinds[ks[i]];
    }
    return undefined;
  }
  var out = {};
  var errors = {};
  var crypto = [];
  var stocks = [];
  var commodities = [];
  var ovConvJobs = [];
  uniq.forEach(function (sym) {
    // Manual override wins — no market network. Legacy bare numbers are
    // denominated in the requested fiat; fiat-tagged overrides convert at the
    // current rate (or resolve unknown when conversion fails — never
    // mislabeled).
    var ovE = null;
    try { ovE = priceOverrideEntry(sym); } catch (e) { ovE = null; }
    if (ovE !== null) {
      if (!ovE.vs || ovE.vs === cur) { out[sym] = ovE.price; return; }
      ovConvJobs.push({ sym: sym, price: ovE.price, vs: ovE.vs });
      return;
    }
    var kd = (typeof kindFor(sym) === 'string') ? kindFor(sym).trim().toLowerCase() : '';
    if (kd === 'stock') { stocks.push(sym); return; }
    if (kd === 'commodity') {
      if (!hasCommoditySource(sym)) {
        out[sym] = null;
        errors[sym] = 'no live source mapped — add a manual override in Settings';
        return;
      }
      commodities.push(sym);
      return;
    }
    // Cash in the display fiat is worth 1 by definition — no network, no
    // override needed (an override above already won when set).
    if (kd === 'cash' && sym === String(cur).toUpperCase()) { out[sym] = 1; return; }
    if (kd === 'custom' || kd === 'cash') {
      out[sym] = null;
      errors[sym] = 'manual price only — add an override in Settings';
      return;
    }
    if (!SYMBOL_MAP[sym]) {
      out[sym] = null;
      errors[sym] = 'no live source mapped — add a manual override in Settings';
      return;
    }
    var fresh = cachedFreshPrice(sym, cur);
    if (fresh !== null) { out[sym] = fresh; return; }
    crypto.push(sym);
  });
  var jobs = [];
  if (ovConvJobs.length) {
    jobs.push(Promise.all(ovConvJobs.map(function (j) {
      return fetchEcbRate(todayStr(), j.vs, cur).then(function (r) {
        var v = j.price * Number(r.rate);
        if (isFinite(v) && v > 0) {
          out[j.sym] = v;
          priceCache[priceCacheKey(j.sym, cur)] = { price: v, at: Date.now() };
        } else {
          out[j.sym] = null;
          errors[j.sym] = 'manual override could not convert to ' + cur + ' — try a manual override in ' + cur + ' under Settings';
        }
        return true;
      }, function () {
        var c = priceCache[priceCacheKey(j.sym, cur)];
        if (c && isFinite(Number(c.price)) && Number(c.price) > 0) out[j.sym] = Number(c.price);
        else {
          out[j.sym] = null;
          errors[j.sym] = 'manual override unreachable in ' + cur + ' (ECB) — try a manual override in ' + cur + ' under Settings';
        }
        return false;
      });
    })).then(function () { /* mapped into out/errors above */ }));
  }
  if (crypto.length) {
    jobs.push(fetchBatchPrices(crypto, cur).then(function (res) {
      Object.keys(res.prices).forEach(function (k) { out[k] = res.prices[k]; });
      Object.keys(res.errors).forEach(function (k) { errors[k] = res.errors[k]; });
    }, function () {
      crypto.forEach(function (sym) {
        var c = priceCache[priceCacheKey(sym, cur)];
        if (c && isFinite(Number(c.price)) && Number(c.price) > 0) out[sym] = Number(c.price);
        else { out[sym] = null; errors[sym] = 'CoinGecko request failed (network or rate limit)'; }
      });
    }));
  }
  if (stocks.length) {
    // One batched CNBC call for every stock (direct, no proxy), then the
    // Yahoo-proxy chain per symbol that missed. Same out/errors contract.
    var stockFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
    jobs.push(fetchBatchCnbc(stocks, stockFetch).then(function (map) {
      var per = stocks.map(function (sym) {
        var q = map && map[sym];
        if (q) {
          return convertStockQuote(sym, q.price, q.currency, cur).then(function (p) {
            if (isFinite(Number(p)) && Number(p) > 0) out[sym] = Number(p);
            else { out[sym] = null; errors[sym] = 'stock feed unreachable — try a manual override in Settings'; }
          });
        }
        return fetchStockYahoo(sym, cur, stockFetch).then(function (p) {
          if (isFinite(Number(p)) && Number(p) > 0) out[sym] = Number(p);
          else { out[sym] = null; errors[sym] = 'stock feed unreachable — try a manual override in Settings'; }
        });
      });
      return Promise.all(per).then(function () { /* mapped into out/errors above */ });
    }));
  }
  commodities.forEach(function (sym) {
    jobs.push(fetchLivePrice(sym, cur, 'commodity').then(function (p) {
      if (isFinite(Number(p)) && Number(p) > 0) out[sym] = Number(p);
      else { out[sym] = null; errors[sym] = 'commodity feed unreachable — try a manual override in Settings'; }
    }));
  });
  return Promise.all(jobs).then(function () { lastPriceErrors = errors; return out; });
}

// --- Historical execution prices (per-trade market reference) ---
// Exec. price resolution order per trade: (1) manual override from
// loadState().priceOverrides (wins, no network), (2) the trade's frozen
// execLock (stamped once at save time, converted to the display main at the
// historical ECB rate — never refetched), (3) cached historical price for
// (symbol, trade date, main), (4) network history — CoinGecko /history
// (DD-MM-YYYY) for mapped crypto, Stooq daily closes for stock and
// commodity accounts with
// up to 5-day walk-back for weekends/holidays — converted into the display
// main at the HISTORICAL ECB rate of the fixing date (never today's rate),
// (5) null when unknown (row shows "—", never 0). Never throws to the UI.
// Real price stays purely calculated (all-in converted total / qty); Exec is
// the reference-only market quote it is compared against.

var HISTCACHE_KEY = 'inoculens.histcache.v1';
var HISTCACHE_MAX = 1000;
var histPriceCache = null; // key "SYM|DATE|VS|kind" -> {price, source, interpolated, at}; lazy-loaded

function histCacheKey(symbol, date, vs, kind) {
  return String(symbol).toUpperCase() + '|' + String(date).slice(0, 10) + '|' +
    String(vs).toUpperCase() + '|' + String(kind || '').toLowerCase();
}

function loadHistCache(reload) {
  if (histPriceCache !== null && !reload) return histPriceCache;
  histPriceCache = {};
  try {
    var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(HISTCACHE_KEY) : null;
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') histPriceCache = parsed;
    }
  } catch (e) { histPriceCache = {}; }
  return histPriceCache;
}

function saveHistCache() {
  try {
    if (typeof localStorage === 'undefined') return;
    var keys = Object.keys(histPriceCache || {});
    var store = histPriceCache;
    if (keys.length > HISTCACHE_MAX) {
      store = {};
      keys.slice(keys.length - 800).forEach(function (k) { store[k] = histPriceCache[k]; });
      histPriceCache = store;
    }
    localStorage.setItem(HISTCACHE_KEY, JSON.stringify(store));
  } catch (e) { /* private mode / quota: memory cache still works */ }
}

// Keys that failed recently (network/429/dead source): later passes skip
// them until a short cooldown lapses, so one outage doesn't hammer the price
// APIs on every render (which also starves the live-price quota) — but unlike
// a session pin, a later render or a timed retry still heals the row.
var histFailKeys = {}; // key -> {fails, at}
var HIST_FAIL_MAX = 5;
function histCooldownMs(fails) {
  return Math.min(60000 * Math.pow(2, Math.max(0, (fails || 1) - 1)), 300000);
}
function histBlocked(key) {
  var f = histFailKeys[key];
  if (!f) return false;
  if ((f.fails || 0) >= HIST_FAIL_MAX) return true;
  return (Date.now() - (f.at || 0)) < histCooldownMs(f.fails);
}
function histNoteFail(key) {
  var f = histFailKeys[key] || { fails: 0, at: 0 };
  f.fails = (f.fails || 0) + 1;
  f.at = Date.now();
  histFailKeys[key] = f;
  histRetryLater(key);
}
// Timed retry so an open page heals without waiting for the next render.
// Bounded by HIST_FAIL_MAX; each attempt re-caches and repaints on success.
function histRetryLater(key) {
  var f = histFailKeys[key];
  if (!f || (f.fails || 0) >= HIST_FAIL_MAX) return;
  var delay = histCooldownMs(f.fails);
  setTimeout(function () {
    try {
      var parts = String(key).split('|');
      if (parts.length !== 4) return;
      if (histInflight[key] || histBlocked(key)) return;
      var hit = null;
      try { hit = getHistCached(parts[0], parts[1], parts[2], parts[3]); } catch (e) { hit = null; }
      if (hit) { try { delete histFailKeys[key]; } catch (e) { /* ignore */ } return; }
      histInflight[key] = true;
      fetchHistoricalPrice(parts[0], parts[1], parts[2], (parts[3] === 'stock' || parts[3] === 'commodity') ? parts[3] : undefined).then(function (r) {
        delete histInflight[key];
        var price = (r && typeof r === 'object') ? r.price : r;
        if (isFinite(Number(price)) && Number(price) > 0) {
          try {
            setHistCached(parts[0], parts[1], parts[2], parts[3], Number(price),
              (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history',
              (r && typeof r === 'object') ? !!r.interpolated : false);
            saveHistCache();
          } catch (e) { /* ignore */ }
          try { delete histFailKeys[key]; } catch (e) { /* ignore */ }
          try { render(); } catch (e) { /* ignore */ }
        } else { histNoteFail(key); }
      }, function () { delete histInflight[key]; histNoteFail(key); });
    } catch (e) { /* ignore */ }
  }, delay);
}

// History fetches currently in flight, by the same key: shared by
// freezeExecLock + ensureHistoricalExec so a save and its first repaint never
// fire duplicate CoinGecko calls for the same quote (duplicate bursts are
// what trip the free-tier rate limit, leaving both with nothing and the row
// on "—"). Entries are removed on settle; also reset with the cache.
var histInflight = {};

function clearHistCache() {
  histPriceCache = {};
  histFailKeys = {};
  histInflight = {};
  try { feeRateErr = {}; } catch (e) { /* ignore */ }
  try { histDiag = {}; } catch (e) { /* ignore */ }
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(HISTCACHE_KEY);
  } catch (e) { /* ignore */ }
}

// One-time repair for quotes baked in the wrong fiat: an earlier build
// stamped the live global override raw under the display main when freezing.
// A non-manual frozen quote that exactly equals a current global override is
// such a stamped copy (a genuine market quote never equals a hand-entered
// number to the cent) — dropping it lets the row fall back to the override
// itself (still shown while set) or a genuine history refetch. Manual quotes
// are the user's own words and are never touched. Pure: mutates the passed
// array, returns true when anything was dropped. Never throws.
function dropBakedExecLocks(trades, overrides) {
  var changed = false;
  try {
    var ov = (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) ? overrides : {};
    var keys = Object.keys(ov);
    (trades || []).forEach(function (t) {
      if (!t || typeof t !== 'object' || (t.type !== 'buy' && t.type !== 'sell')) return;
      var fr = null;
      try { fr = frozenExecOf(t); } catch (e) { fr = null; }
      if (!fr || String(fr.source).toLowerCase() === 'manual') return;
      var sym = String((t && t.symbol) || '').toUpperCase();
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i]).toUpperCase() !== sym) continue;
        var raw = ov[keys[i]];
        var op = (typeof raw === 'number') ? raw
          : ((raw && typeof raw === 'object' && !Array.isArray(raw)) ? Number(raw.price) : NaN);
        if (isFinite(op) && op > 0 && op === fr.price) {
          try { delete t.execLock; } catch (e) { t.execLock = undefined; }
          changed = true;
        }
        break;
      }
    });
  } catch (e) { /* repair never breaks the run */ }
  return changed;
}

// Frozen reference quote stamped on the trade at save time:
// {price, vs, source}. Extra trade key, ignored by validation/ledger/export
// shape checks (isValidImportTrade only asserts known fields).
function frozenExecOf(t) {
  if (!t || typeof t !== 'object') return null;
  var e = t.execLock;
  if (!e || typeof e !== 'object') return null;
  var p = Number(e.price);
  var vs = (typeof e.vs === 'string') ? e.vs.trim().toUpperCase() : '';
  if (!isFinite(p) || p <= 0 || !/^[A-Z]{2,10}$/.test(vs)) return null;
  return { price: p, vs: vs, source: String(e.source || '') };
}

// Fetch-once patch for trades saved without a frozen quote (history fetch
// failed at save, or a pre-freeze legacy trade being edited). Never blocks
// saving and never throws: on failure the legacy async display path keeps
// serving the row (override → frozen → hist cache → network → "—").
// A fiat-tagged manual override freezes verbatim (no fetch, no conversion).
function freezeExecLock(tradeId, symbol, date, mainU, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var day = (typeof date === 'string') ? date.slice(0, 10) : '';
  var m = String(mainU || '').trim().toUpperCase();
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  if (!tradeId || !sym || !isValidDateStr(day)) return;
  if (kd === 'custom' || kd === 'cash') return;
  if (kd === 'commodity') { if (!hasCommoditySource(sym)) return; }
  else if (kd !== 'stock' && !SYMBOL_MAP[sym]) return;
  function patch(price, vs, source) {
    if (!(isFinite(Number(price)) && Number(price) > 0)) return;
    if (!/^[A-Z]{2,10}$/.test(String(vs || ''))) return;
    var st = null;
    try { st = loadState(); } catch (e) { return; }
    var found = false;
    (st.trades || []).forEach(function (t) {
      if (t && t.id === tradeId && !frozenExecOf(t)) {
        t.execLock = { price: Number(price), vs: String(vs).toUpperCase(), source: String(source || '') };
        found = true;
      }
    });
    if (!found) return;
    try { saveStateGuarded(st); } catch (e) { return; }
    try { render(); } catch (e) { /* paint stays, next render picks it up */ }
  }
  // A live global override already serves this trade's Exec row: never stamp
  // a live price as a historical quote.
  try { if (priceOverrideEntry(sym) !== null) return; } catch (e) { /* fall through */ }
  var kk = histKindFor(kd);
  var ckey = sym + '|' + day + '|' + m + '|' + kk;
  // Already known (e.g. the first paint filled it while saving): freeze with
  // zero network.
  var hit = null;
  try { hit = getHistCached(sym, day, m, kk); } catch (e) { hit = null; }
  if (hit) {
    patch(hit.price, m, hit.source || 'history');
    return;
  }
  // Another fetch for this exact quote is already running (e.g. the repaint
  // triggered by this very save): share it instead of doubling the burst.
  if (histInflight[ckey]) return;
  histInflight[ckey] = true;
  fetchHistoricalPrice(sym, day, m, kd).then(function (r) {
    delete histInflight[ckey];
    var price = (r && typeof r === 'object') ? r.price : r;
    // Write through to the history cache too, so the legacy display path and
    // later fiat switches reuse this quote without refetching.
    if (isFinite(Number(price)) && Number(price) > 0) {
      try {
        setHistCached(sym, day, m, kk, Number(price),
          (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history',
          (r && typeof r === 'object') ? !!r.interpolated : false);
        saveHistCache();
      } catch (e) { /* memory cache still works */ }
    }
    patch(price, m, (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history');
  }, function () { delete histInflight[ckey]; /* legacy async display path covers the row */ });
}

// Last per-quote history failure, in plain words (session-only): attached
// to the fee-rate tooltip so a failed lookup names its cause.
var histDiag = {}; // key(sym|day|vs|crypto) -> text
function histDiagNote(sym, day, vs, text) {
  try {
    var k = String(sym || '').toUpperCase() + '|' + String(day || '').slice(0, 10) + '|' + String(vs || '').toUpperCase() + '|crypto';
    var prev = histDiag[k];
    histDiag[k] = prev ? (prev + '; ' + text) : String(text);
  } catch (e) { /* ignore */ }
}
function histDiagClear(sym, day, vs) {
  try { delete histDiag[String(sym || '').toUpperCase() + '|' + String(day || '').slice(0, 10) + '|' + String(vs || '').toUpperCase() + '|crypto']; } catch (e) { /* ignore */ }
}
function getHistCached(symbol, date, vs, kind) {
  var c = loadHistCache()[histCacheKey(symbol, date, vs, kind)];
  if (c && isFinite(Number(c.price)) && Number(c.price) > 0) {
    return { price: Number(c.price), source: String(c.source || ''), interpolated: !!c.interpolated };
  }
  return null;
}

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
    var el = document.querySelector('[data-trade="' + id + '"] [data-label="Fee in fiat rate"]');
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

function setHistCached(symbol, date, vs, kind, price, source, interpolated) {
  if (!isFinite(Number(price)) || Number(price) <= 0) return;
  loadHistCache()[histCacheKey(symbol, date, vs, kind)] = {
    price: Number(price), source: String(source || ''), interpolated: !!interpolated, at: Date.now()
  };
}

function toCoingeckoDate(dateStr) {
  if (!isValidDateStr(dateStr)) return null;
  var p = String(dateStr).slice(0, 10).split('-');
  return p[2] + '-' + p[1] + '-' + p[0]; // DD-MM-YYYY
}

function toStooqDay(dateStr) {
  if (!isValidDateStr(dateStr)) return null;
  return String(dateStr).slice(0, 10).replace(/-/g, '');
}

// Parse a Stooq daily CSV (Date,Open,High,Low,Close,Volume) and return the
// Close for `wantDay` (YYYYMMDD), or null when the market was shut.
function parseStooqDaily(csv, wantDay) {
  try {
    var lines = String(csv || '').trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    for (var i = 1; i < lines.length; i++) {
      var row = lines[i].split(',');
      if (!row.length) continue;
      var day = String(row[0] || '').replace(/-/g, '');
      if (day !== wantDay) continue;
      var v = Number(row[4]);
      if (isFinite(v) && v > 0) return v;
      return null;
    }
    return null;
  } catch (e) { return null; }
}

function fetchHistoricalCryptoPrice(symbol, dateStr, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  var curLow = cur.toLowerCase();
  var id = SYMBOL_MAP[sym];
  if (!id || !isValidDateStr(dateStr)) return Promise.resolve(null);
  var gd = toCoingeckoDate(dateStr);
  var url = 'https://api.coingecko.com/api/v3/coins/' + encodeURIComponent(id) +
    '/history?date=' + encodeURIComponent(gd);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  function krakenFallback() { return fetchKrakenHistory(sym, dateStr, cur); }
  function deepFallback() {
    return krakenFallback().then(function (kp) {
      if (isFinite(kp) && kp > 0) { histDiagClear(sym, dateStr.slice(0, 10), cur); return kp; }
      return fetchStooqCryptoHistory(sym, dateStr, cur).then(function (sp) {
        if (isFinite(sp) && sp > 0) return sp;
        return fetchCoinbaseHistory(sym, dateStr, cur);
      });
    });
  }
  var day10 = dateStr.slice(0, 10);
  function coingeckoAndBeyond() {
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.json();
  }, function () { throw new Error('price-unreachable'); }).then(function (data) {
    var cp = data && data.market_data && data.market_data.current_price;
    var p = cp ? Number(cp[curLow]) : NaN;
    if (isFinite(p) && p > 0) { histDiagClear(sym, day10, cur); return p; }
    // Bridge unsupported vs via the USD pivot + HISTORICAL ECB USD->main.
    if (curLow !== 'usd') {
      var pu = cp ? Number(cp.usd) : NaN;
      if (isFinite(pu) && pu > 0) {
        return fetchEcbRate(dateStr.slice(0, 10), 'USD', cur).then(function (r) {
          var v = pu * Number(r.rate);
          if (isFinite(v) && v > 0) { histDiagClear(sym, day10, cur); return v; }
          return null;
        }, function () { return null; });
      }
    }
    return null;
  }).then(function (p) {
    if (isFinite(p) && p > 0) return p;
    return deepFallback();
  }, function (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('price-http-') === 0) histDiagNote(sym, day10, cur, 'CoinGecko HTTP ' + msg.slice(11));
    else histDiagNote(sym, day10, cur, 'CoinGecko unreachable');
    return deepFallback();
  });
  }
  // Most reliable source first: Coinbase public candles (no key, generous
  // limits, deep history, CORS-open). The rest of the chain follows on a miss.
  return fetchCoinbaseHistory(sym, dateStr, cur).then(function (cb) {
    if (isFinite(cb) && cb > 0) return cb;
    return coingeckoAndBeyond();
  });
}

// Third source for crypto history when the first two fail or omit the fiat:
// Kraken public OHLC, daily close (no key, CORS-enabled). Majors only;
// USD/EUR direct, other fiats via the USD pivot + historical ECB.
var KRAKEN_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH'];
function fetchKrakenHistory(sym, dateStr, vs) {
  var s = String(sym || '').trim().toUpperCase();
  var c = String(vs || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  if (KRAKEN_SYMBOLS.indexOf(s) === -1 || !isValidDateStr(day) || isFutureDateStr(day)) {
    if (KRAKEN_SYMBOLS.indexOf(s) === -1) histDiagNote(s, day, c, 'Kraken: asset not covered');
    return Promise.resolve(null);
  }
  var fiat = (c === 'EUR') ? 'EUR' : 'USD';
  var start = Math.floor(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 1000);
  if (!isFinite(start) || start <= 0) return Promise.resolve(null);
  var url = 'https://api.kraken.com/0/public/OHLC?pair=' + encodeURIComponent(s + fiat) +
    '&interval=1440&since=' + Math.max(0, start - 172800);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('kraken-http-' + res.status);
    return res.json();
  }).then(function (data) {
    var err = data && data.error;
    if (err && err.length) throw new Error('kraken-' + err.join(','));
    var result = data && data.result;
    var candles = null;
    if (result && typeof result === 'object') {
      var keys = Object.keys(result);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === 'last') continue;
        if (Array.isArray(result[keys[i]])) { candles = result[keys[i]]; break; }
      }
    }
    if (!candles) return null;
    for (var k = 0; k < candles.length; k++) {
      var cd = candles[k];
      if (!cd || !isFinite(Number(cd[0])) || !isFinite(Number(cd[4]))) continue;
      var tt = Number(cd[0]);
      if (tt >= start && tt < start + 86400 && Number(cd[4]) > 0) {
        var close = Number(cd[4]);
        if (fiat === c) { histDiagClear(s, day, c); return close; }
        return fetchEcbRate(day, 'USD', c).then(function (r) {
          var v = close * Number(r.rate);
          if (isFinite(v) && v > 0) { histDiagClear(s, day, c); return v; }
          return null;
        }, function () { return null; });
      }
    }
    histDiagNote(s, day, c, 'Kraken: no candle for date');
    return null;
  }).then(null, function (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('kraken-http-') === 0) histDiagNote(s, day, c, 'Kraken HTTP ' + msg.slice(12));
    else histDiagNote(s, day, c, 'Kraken unreachable');
    return null;
  });
}

// Deep-history fallback for dates the other sources can't reach (CoinGecko
// free stops at 365 days, Kraken daily keeps ~720 candles): Stooq daily
// close, BTC/ETH only, always via USD + historical ECB. Same host and
// parser the stock path already uses.
var STOOQ_CRYPTO = { BTC: 'btcusd', ETH: 'ethusd' };
function fetchStooqCryptoHistory(sym, dateStr, vs) {
  var s = String(sym || '').trim().toUpperCase();
  var c = String(vs || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  var sq = STOOQ_CRYPTO[s];
  if (!sq || !isValidDateStr(day) || isFutureDateStr(day)) {
    if (!sq) histDiagNote(s, day, c, 'Stooq: asset not covered');
    return Promise.resolve(null);
  }
  var compact = toStooqDay(day);
  var url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sq) +
    '&d1=' + encodeURIComponent(compact) + '&d2=' + encodeURIComponent(compact) + '&i=d';
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('stooq-http-' + res.status);
    return res.text();
  }).then(function (csv) {
    var usd = parseStooqDaily(csv, compact);
    if (!isFinite(usd) || usd <= 0) { histDiagNote(s, day, c, 'Stooq: no quote for date'); return null; }
    if (c === 'USD') { histDiagClear(s, day, c); return usd; }
    return fetchEcbRate(day, 'USD', c).then(function (r) {
      var v = usd * Number(r.rate);
      if (isFinite(v) && v > 0) { histDiagClear(s, day, c); return v; }
      return null;
    }, function () { return null; });
  }).then(null, function (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('stooq-http-') === 0) histDiagNote(s, day, c, 'Stooq HTTP ' + msg.slice(11));
    else histDiagNote(s, day, c, 'Stooq unreachable');
    return null;
  });
}

// Coinbase Exchange public candles, daily granularity (no key, CORS-enabled).
// Primary history source (tried first): majors with USD/EUR/GBP books;
// other fiats via USD + historical ECB. Majors with USD/EUR/GBP
// books; other fiats via USD + historical ECB.
var COINBASE_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH'];
function fetchCoinbaseHistory(sym, dateStr, vs) {
  var s = String(sym || '').trim().toUpperCase();
  var c = String(vs || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  if (COINBASE_SYMBOLS.indexOf(s) === -1 || !isValidDateStr(day) || isFutureDateStr(day)) {
    if (COINBASE_SYMBOLS.indexOf(s) === -1) histDiagNote(s, day, c, 'Coinbase: asset not covered');
    return Promise.resolve(null);
  }
  var fiat = (c === 'EUR' || c === 'GBP') ? c : 'USD';
  var start = Math.floor(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 1000);
  if (!isFinite(start) || start <= 0) return Promise.resolve(null);
  var url = 'https://api.exchange.coinbase.com/products/' + encodeURIComponent(s + '-' + fiat) +
    '/candles?start=' + encodeURIComponent(day + 'T00:00:00Z') +
    '&end=' + encodeURIComponent(day + 'T23:59:59Z') + '&granularity=86400';
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('coinbase-http-' + res.status);
    return res.json();
  }).then(function (data) {
    // Candle: [time, low, high, open, close, volume].
    var candles = Array.isArray(data) ? data : null;
    if (!candles) return null;
    for (var k = 0; k < candles.length; k++) {
      var cd = candles[k];
      if (!cd || !isFinite(Number(cd[0])) || !isFinite(Number(cd[4]))) continue;
      var tt = Number(cd[0]);
      if (tt >= start && tt < start + 86400 && Number(cd[4]) > 0) {
        var close = Number(cd[4]);
        if (fiat === c) { histDiagClear(s, day, c); return close; }
        return fetchEcbRate(day, 'USD', c).then(function (r) {
          var v = close * Number(r.rate);
          if (isFinite(v) && v > 0) { histDiagClear(s, day, c); return v; }
          return null;
        }, function () { return null; });
      }
    }
    histDiagNote(s, day, c, 'Coinbase: no candle for date');
    return null;
  }).then(null, function (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('coinbase-http-') === 0) histDiagNote(s, day, c, 'Coinbase HTTP ' + msg.slice(14));
    else histDiagNote(s, day, c, 'Coinbase unreachable');
    return null;
  });
}

function fetchHistoricalStockPrice(symbol, dateStr, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  if (!isValidDateStr(dateStr)) return Promise.resolve(null);
  var wantDay = dateStr.slice(0, 10);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  function stooqFallback() { return fetchHistoricalStockStooq(sym, wantDay, cur); }
  var yq = yahooSymbol(sym);
  if (!yq) return stooqFallback();
  return fetchYahooHistory(yq, wantDay, cur, capturedFetch).then(function (r) { return r; }, function () { return stooqFallback(); });
}

// Legacy Stooq daily closes with up to 5-day walk-back (kept as the stock
// history fallback; Stooq daily currently sits behind a bot challenge that
// programmatic fetches may not pass).
function fetchHistoricalStockStooq(sym, wantDay, cur) {
  var sq = stooqSymbol(sym);
  if (!sq || !isValidDateStr(wantDay)) return Promise.resolve(null);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  // Walk back up to 5 days for weekends/holidays (same window as FX).
  function attempt(day, back) {
    var compact = toStooqDay(day);
    var url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sq) +
      '&d1=' + encodeURIComponent(compact) + '&d2=' + encodeURIComponent(compact) + '&i=d';
    return capturedFetch(url).then(function (res) {
      if (!res.ok) throw new Error('price-http-' + res.status);
      return res.text();
    }).then(function (csv) {
      var usd = parseStooqDaily(csv, compact);
      if (isFinite(usd) && usd > 0) {
        if (cur === 'USD') return { price: usd, interpolated: back > 0, day: day };
        return fetchEcbRate(day, 'USD', cur).then(function (r) {
          var v = usd * Number(r.rate);
          if (!isFinite(v) || v <= 0) throw new Error('fx-bridge');
          return { price: v, interpolated: back > 0 || !!r.interpolated, day: day };
        });
      }
      if (back >= 5) throw new Error('no-fixing');
      var prev = fxShiftDate(day, -1);
      if (!prev) throw new Error('no-fixing');
      return attempt(prev, back + 1);
    });
  }
  return attempt(wantDay, 0).then(function (r) { return r; }, function () { return null; });
}

function fetchHistoricalCommodityPrice(symbol, dateStr, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  if (!isValidDateStr(dateStr)) return Promise.resolve(null);
  var wantDay = dateStr.slice(0, 10);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  var sq = stooqCommoditySymbol(sym);
  function stooqFallback() {
    if (!sq) return Promise.resolve(null);
    return attempt(wantDay, 0).then(function (r) { return r; }, function () { return null; });
  }
  // Energy futures share the Yahoo history window with stocks.
  if (Object.prototype.hasOwnProperty.call(YAHOO_COMMODITY_MAP, sym)) {
    return fetchYahooHistory(YAHOO_COMMODITY_MAP[sym], wantDay, cur, capturedFetch).then(function (r) { return r; }, function () { return stooqFallback(); });
  }
  if (!sq) return Promise.resolve(null);
  // Walk back up to 5 days for weekends/holidays (same window as stocks/FX).
  function attempt(day, back) {
    var compact = toStooqDay(day);
    var url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sq) +
      '&d1=' + encodeURIComponent(compact) + '&d2=' + encodeURIComponent(compact) + '&i=d';
    return capturedFetch(url).then(function (res) {
      if (!res.ok) throw new Error('price-http-' + res.status);
      return res.text();
    }).then(function (csv) {
      var usd = parseStooqDaily(csv, compact);
      if (isFinite(usd) && usd > 0) {
        if (cur === 'USD') return { price: usd, interpolated: back > 0, day: day };
        return fetchEcbRate(day, 'USD', cur).then(function (r) {
          var v = usd * Number(r.rate);
          if (!isFinite(v) || v <= 0) throw new Error('fx-bridge');
          return { price: v, interpolated: back > 0 || !!r.interpolated, day: day };
        });
      }
      if (back >= 5) throw new Error('no-fixing');
      var prev = fxShiftDate(day, -1);
      if (!prev) throw new Error('no-fixing');
      return attempt(prev, back + 1);
    });
  }
  return attempt(wantDay, 0).then(function (r) { return r; }, function () { return null; });
}

function fetchHistoricalPrice(symbol, dateStr, vs, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  if (!sym || !isValidDateStr(day) || isFutureDateStr(day)) return Promise.resolve(null);
  // (1) Manual override wins — no market network. Legacy bare numbers are
  // denominated in the requested fiat; fiat-tagged overrides convert at the
  // HISTORICAL rate of the trade date (null when unconvertible — never a
  // nominal value in the wrong fiat).
  var ovE = null;
  try { ovE = priceOverrideEntry(sym); } catch (e) { ovE = null; }
  if (ovE !== null) {
    if (!ovE.vs || ovE.vs === cur) return Promise.resolve(ovE.price);
    return fetchEcbRate(day, ovE.vs, cur).then(function (r) {
      var v = ovE.price * Number(r.rate);
      return (isFinite(v) && v > 0) ? v : null;
    }, function () { return null; });
  }
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  if (kd === 'custom' || kd === 'cash') return Promise.resolve(null);
  if (kd === 'stock') return fetchHistoricalStockPrice(sym, day, cur);
  if (kd === 'commodity') return fetchHistoricalCommodityPrice(sym, day, cur);
  if (!SYMBOL_MAP[sym]) return Promise.resolve(null);
  return fetchHistoricalCryptoPrice(sym, day, cur);
}

// Sync read for paint: override, else cache, else null (async fill follows).
function getHistoricalExec(symbol, dateStr, vs, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  if (!sym || !isValidDateStr(day)) return null;
  var ov = null;
  try { ov = priceOverrideFor(sym); } catch (e) { ov = null; }
  if (ov !== null) return { price: ov, source: 'manual', interpolated: false };
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  var hit = getHistCached(sym, day, cur, histKindFor(kd));
  if (hit) return hit;
  return null;
}

// Fill the cache for every (symbol, date) the current paint needs. Never
// rejects: unknown tickers resolve to null and keep the "—" placeholder.
function ensureHistoricalExec(trades, main, kinds) {
  var m = String(main || priceDefaultVs()).toUpperCase();
  function kindFor(sym) {
    if (!kinds) return undefined;
    if (typeof kinds === 'function') { try { return kinds(sym); } catch (e) { return undefined; } }
    if (typeof kinds === 'object') {
      if (Object.prototype.hasOwnProperty.call(kinds, sym)) return kinds[sym];
      var up = String(sym).toUpperCase();
      var ks = Object.keys(kinds);
      for (var i = 0; i < ks.length; i++) if (String(ks[i]).toUpperCase() === up) return kinds[ks[i]];
    }
    return undefined;
  }
  var seen = {};
  var jobs = [];
  var idsByKey = {}; // quote key -> trade ids waiting on it (for failure tooltips)
  (trades || []).forEach(function (t) {
    if (!t || (t.type !== 'buy' && t.type !== 'sell' && t.type !== 'transfer')) return;
    var sym = String((t && t.symbol) || '').toUpperCase();
    var day = (t && typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) ? t.date.slice(0, 10) : '';
    if (!sym || !isValidDateStr(day) || isFutureDateStr(day)) return;
    var kd = (typeof kindFor(sym) === 'string') ? kindFor(sym).trim().toLowerCase() : '';
    if (kd === 'custom' || kd === 'cash') return;
    if (kd === 'commodity') { if (!hasCommoditySource(sym)) return; }
    else if (kd !== 'stock' && !SYMBOL_MAP[sym]) return;
    var kk = histKindFor(kd);
    var key = sym + '|' + day + '|' + m + '|' + kk;
    if (t.id) { (idsByKey[key] = idsByKey[key] || []).push(t.id); }
    if (seen[key]) return;
    seen[key] = true;
    try { if (priceOverrideFor(sym) !== null) return; } catch (e) { /* fall through */ }
    if (frozenExecOf(t)) return; // frozen quote on the trade: no network needed
    if (getHistCached(sym, day, m, kk)) return;
    if (histBlocked(key)) return; // failed recently: retry after cooldown, not every render
    if (histInflight[key]) return; // already fetching (e.g. save just froze it)
    histInflight[key] = true;
    jobs.push(fetchHistoricalPrice(sym, day, m, kd).then(function (r) {
      delete histInflight[key];
      var price = (r && typeof r === 'object') ? r.price : r;
      var interp = (r && typeof r === 'object') ? !!r.interpolated : false;
      var src = (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history';
      if (isFinite(Number(price)) && Number(price) > 0) {
        setHistCached(sym, day, m, kk, Number(price), src, interp);
        return true;
      }
      histNoteFail(key);
      (idsByKey[key] || []).forEach(function (id) { try { feeFailMsg(id, key); } catch (e) { /* ignore */ } });
      return false;
    }, function () { delete histInflight[key]; histNoteFail(key); (idsByKey[key] || []).forEach(function (id) { try { feeFailMsg(id, key); } catch (e) { /* ignore */ } }); return false; }));
  });
  if (!jobs.length) return Promise.resolve(false);
  return Promise.all(jobs).then(function (flags) {
    var changed = false;
    flags.forEach(function (f) { if (f) changed = true; });
    if (changed) { try { saveHistCache(); } catch (e) { /* ignore */ } }
    return changed;
  });
}

// Expose Prices on window.Inoculens for tests.html and Ui (Task 6).
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.SYMBOL_MAP = SYMBOL_MAP;
  window.Inoculens.COMMODITY_MAP = COMMODITY_MAP;
  window.Inoculens.stooqCommoditySymbol = stooqCommoditySymbol;
  window.Inoculens.goldApiSymbol = goldApiSymbol;
  window.Inoculens.fetchGoldApiUsd = fetchGoldApiUsd;
  window.Inoculens.YAHOO_COMMODITY_MAP = YAHOO_COMMODITY_MAP;
  window.Inoculens.fetchYahooHistory = fetchYahooHistory;
  window.Inoculens.hasCommoditySource = hasCommoditySource;
  window.Inoculens.fetchKrakenLiveUsd = fetchKrakenLiveUsd;
  window.Inoculens.fetchCoinbaseLiveUsd = fetchCoinbaseLiveUsd;
  window.Inoculens.fetchCommodityPrice = fetchCommodityPrice;
  window.Inoculens.fetchHistoricalCommodityPrice = fetchHistoricalCommodityPrice;
  window.Inoculens.PRICE_CACHE_TTL_MS = PRICE_CACHE_TTL_MS;
  window.Inoculens.priceCache = priceCache;
  window.Inoculens.fetchLivePrice = fetchLivePrice;
  window.Inoculens.refreshAllPrices = refreshAllPrices;
  window.Inoculens.fetchHistoricalPrice = fetchHistoricalPrice;
  window.Inoculens.getHistoricalExec = getHistoricalExec;
  window.Inoculens.ensureHistoricalExec = ensureHistoricalExec;
  window.Inoculens.getHistCached = getHistCached;
  window.Inoculens.setHistCached = setHistCached;
  window.Inoculens.clearHistCache = clearHistCache;
  window.Inoculens.reloadHistCache = function () { loadHistCache(true); };
  window.Inoculens.parseStooqDaily = parseStooqDaily;
  window.Inoculens.yahooSymbol = yahooSymbol;
  window.Inoculens.parseYahooQuote = parseYahooQuote;
  window.Inoculens.parseYahooDaily = parseYahooDaily;
  window.Inoculens.parseCnbcQuotes = parseCnbcQuotes;
  window.Inoculens.fetchBatchCnbc = fetchBatchCnbc;
  window.Inoculens.toCoingeckoDate = toCoingeckoDate;
  window.Inoculens.roundHalfUp2 = roundHalfUp2;
  window.Inoculens.frozenExecOf = frozenExecOf;
  window.Inoculens.freezeExecLock = freezeExecLock;
  window.Inoculens.retryFeeRate = retryFeeRate;
  window.Inoculens.priceOverrideEntry = priceOverrideEntry;
  window.Inoculens.priceOverrideFor = priceOverrideFor;
  window.Inoculens.resolveExecPrice = resolveExecPrice;
  window.Inoculens.dropBakedExecLocks = dropBakedExecLocks;
}

// === Ui ===
// DOM boot + render loop (Task 6; top-bar + dialogs redesign). Binds the
// sticky top bar, positions/trades tables, trade + settings dialogs,
// import/export and banner to Store/Fx/Ledger/Prices. Render loop: every
// mutation does saveState -> recompute (computePositions) -> render(). A
// main-currency switch re-fetches live prices only; frozen trade fxLocks
// are never rewritten. Money is formatted with Intl.NumberFormat in the
// current mainCurrency. Every positions/trades <td> carries a data-label
// so the mobile card layout (styles.css) can label rows. init() boots on
// DOMContentLoaded; render()/refreshPrices() are the recompute+render
// entry points (also used by tests.html).

// === Version contract (for any AI or human editing this app) ===
// Full rules live in AGENTS.md at the repo root — coding agents load it
// automatically, no prompt needed. Summary:
// The footer version is the commit id + commit count, e.g. "c03f772 (#110)".
// That id only exists AFTER committing, so nobody hand-writes it: the deploy
// build (stamp-version.sh, wired in netlify.toml) stamps the exact values
// into APP_VERSION below on every deploy. Keep a sane fallback value here
// for local/file:// use, and keep bumping the ?v= cache-busters in
// index.html on every change so deployed users load fresh assets. Users only
// ever see the footer version string, never this note.
// === End version contract ===

var APP_VERSION = '35056ef (#140)';

var uiBooted = false;
var livePrices = {}; // SYM (uppercased) -> number|null, latest known live price
var priceLoading = {}; // SYM -> true while the current refresh generation is still fetching it
var PRICE_LOADING_TEXT = '…';
var PRICE_LOADING_TITLE = 'Fetching live price — no error yet';

// A symbol whose price comes from a live source (a set manual override
// counts): only these can be "loading" or "unreachable". Cash/custom kinds
// and sourceless tickers are manual-by-design and show the plain unknown
// placeholder instead — never a spinner, never a banner.
function hasCommoditySource(sym) {
  try { if (stooqCommoditySymbol(sym)) return true; } catch (e) { /* fall through */ }
  try { if (goldApiSymbol(sym)) return true; } catch (e) { /* fall through */ }
  return false;
}

function isActionablePriceSymbol(s, kinds) {
  var up = String(s || '').toUpperCase();
  try { if (priceOverrideEntry(up) !== null) return true; } catch (e) { /* fall through */ }
  var kd = null;
  try {
    if (kinds && Object.prototype.hasOwnProperty.call(kinds, up)) kd = kinds[up];
    else if (kinds) {
      var ks = Object.keys(kinds);
      for (var i = 0; i < ks.length; i++) {
        if (String(ks[i]).toUpperCase() === up) { kd = kinds[ks[i]]; break; }
      }
    }
  } catch (e) { kd = null; }
  var kdl = (typeof kd === 'string') ? kd.trim().toLowerCase() : '';
  if (kdl === 'cash' || kdl === 'custom') return false;
  if (kdl === 'stock') return true;
  if (kdl === 'commodity') return hasCommoditySource(up);
  try { if (SYMBOL_MAP && SYMBOL_MAP[up]) return true; } catch (e) { /* fall through */ }
  return false;
}

function isPriceLoading(sym) {
  try { return !!priceLoading[String(sym || '').toUpperCase()]; } catch (e) { return false; }
}

function anyPriceLoading() {
  try { return Object.keys(priceLoading).length > 0; } catch (e) { return false; }
}

// Paint a value element into/out of the loading state. Same box, same
// layout — only the text, a pulse class and an honest tooltip change.
function paintLoading(el, on, label) {
  try {
    if (!el || !el.classList) return;
    if (on) {
      el.classList.add('is-loading');
      el.setAttribute('aria-label', String(label || 'Price') + ' is loading');
      el.title = PRICE_LOADING_TITLE;
    } else {
      el.classList.remove('is-loading');
      el.removeAttribute('aria-label');
      el.removeAttribute('title');
    }
  } catch (e) { /* decorative only */ }
}
var moneyFmtCache = {};

function todayStr() {
  // Local calendar date (user-facing default + date max), matching the
  // local-based download filename. Pure FX calendar math (fxShiftDate,
  // ledgerHoldingDays) intentionally stays on UTC date arithmetic.
  var n = new Date();
  var m = n.getMonth() + 1;
  var d = n.getDate();
  return n.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

// All user-visible dates are dd/mm/yyyy, built manually from parts — never
// via toLocaleDateString / Intl (device locale must not change the format).
// Storage stays ISO YYYY-MM-DD; these helpers only format for display and
// parse user input back to ISO.
function fmtDateDmy(d) {
  if (d === undefined || d === null) return '';
  var s = String(d).trim();
  if (!s) return '';
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[3] + '/' + m[2] + '/' + m[1];
  var m2 = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m2) {
    var dd = m2[1].length < 2 ? '0' + m2[1] : m2[1];
    var mm = m2[2].length < 2 ? '0' + m2[2] : m2[2];
    return dd + '/' + mm + '/' + m2[3];
  }
  return s;
}

function parseDateInput(s) {
  if (typeof s !== 'string') return null;
  var v = s.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return isValidDateStr(v) ? v : null;
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) {
    var dd = m[1].length < 2 ? '0' + m[1] : m[1];
    var mm = m[2].length < 2 ? '0' + m[2] : m[2];
    var iso = m[3] + '-' + mm + '-' + dd;
    return isValidDateStr(iso) ? iso : null;
  }
  return null;
}

function todayDmy() {
  return fmtDateDmy(todayStr());
}

function fmtDateTimeDmy(iso) {
  try {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return String(iso);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() +
      ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC';
  } catch (e) { return String(iso); }
}

function fmtEcbInText(s) {
  if (typeof s !== 'string') return s;
  var out = s.replace(/ECB-(\d{4})-(\d{2})-(\d{2})/g, function (_, y, m, d) { return 'ECB-' + d + '/' + m + '/' + y; });
  out = out.replace(/Stooq-(\d{4})(\d{2})(\d{2})/g, function (_, y, m, d) { return 'Stooq-' + d + '/' + m + '/' + y; });
  return out;
}

// Short human record code, derived deterministically from the stored trade
// id (djb2 pair, hex, first 6) — stable across reloads and synced devices,
// no migration, no renumbering on delete. Legacy trades without an id fall
// back to stable content so they still get a (shared-looking) code.
function tradeDisplayId(t) {
  var id = (typeof t === 'string') ? t : (t && t.id);
  var src;
  if (typeof id === 'string' && id.length > 0) {
    src = id;
  } else {
    src = [t && t.date, t && t.type, t && t.symbol, t && t.qty, t && t.total, t && t.accountId].join('|');
  }
  var h = '';
  try {
    h = syncStateHash(src).replace(/-/g, '').toUpperCase();
  } catch (e) { h = ''; }
  while (h.length < 6) h += '0';
  return '#' + h.slice(0, 6);
}

function uid() {
  return 't' + Date.now().toString(36) + Math.floor(Math.random() * 0xffffff).toString(36);
}

function uiVal(id, fb) {
  var el = document.getElementById(id);
  return el ? el.value : fb;
}

function uiSetVal(id, v) {
  var el = document.getElementById(id);
  if (el) el.value = v;
}

function moneyFmt(currency) {
  var code = String(currency || 'EUR').toUpperCase();
  if (!moneyFmtCache[code]) {
    try {
      moneyFmtCache[code] = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
    } catch (e) {
      moneyFmtCache[code] = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' });
    }
  }
  return moneyFmtCache[code];
}

function fmtMoney(n, currency) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  try {
    return moneyFmt(currency).format(v);
  } catch (e) {
    return String(Math.round(v * 100) / 100);
  }
}

// Round half-up to 2 decimals (3rd decimal >= 5 rounds up, <= 4 rounds down),
// e.g. 85920.98706029935 -> 85920.99. Display helper: ledger math always
// keeps full precision; only the shown price is rounded.
function roundHalfUp2(n) {
  var v = Number(n);
  if (!isFinite(v)) return NaN;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

var btcQtyFmt = null;

function fmtQty(n, symbol) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  // BTC always shows all 8 decimals (satoshis): 0.1 -> 0.10000000,
  // 1 -> 1.00000000. Other assets keep trimmed display.
  if (String(symbol || '').trim().toUpperCase() === 'BTC') {
    try {
      if (!btcQtyFmt) btcQtyFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 8, maximumFractionDigits: 8 });
      return btcQtyFmt.format(v);
    } catch (e) {
      return v.toFixed(8);
    }
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(v);
}

function fmtPct(n) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  return (Math.round(v * 100) / 100) + '%';
}

function showBanner(msg, kind, details) {
  var b = document.getElementById('banner');
  if (!b) return;
  var hasDetails = !!(details && ((details.lines && details.lines.length) || details.message));
  if (hasDetails) {
    lastErrorDetails = {
      title: details.title || 'Details',
      message: details.message || String(msg),
      lines: (details.lines || []).slice(0, 200)
    };
  } else {
    lastErrorDetails = null;
  }
  // Settings sits above the page: while it is open the message lives ONLY
  // in the dialog mirror. Errors born here die with the dialog; a message
  // moved in from a pre-existing page banner moves back on close.
  if (!suppressMirror && settingsDialogOpen()) {
    lastMirror = { msg: String(msg), kind: kind, details: details || null, fromPage: false };
    try {
      mirrorBannerToSettings(String(msg), kind === 'info' ? 'info' : 'error', hasDetails);
    } catch (e) { /* never let the mirror break the banner */ }
    return;
  }
  var t = document.getElementById('banner-text');
  if (t) t.textContent = String(msg);
  else b.textContent = String(msg);
  b.classList.remove('error', 'info');
  b.classList.add(kind === 'info' ? 'info' : 'error');
  try { b.dataset.kind = kind === 'info' ? 'info' : 'error'; } catch (e) { /* ignore */ }
  var old = document.getElementById('banner-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  // Optional drill-down: every error with something more to say gets a
  // "More details" button opening the fixed-size error popup. The banner
  // itself stays one calm general line no matter how many tickers fail.
  if (hasDetails) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'banner-details';
    btn.className = 'quiet';
    btn.textContent = 'More details';
    btn.setAttribute('aria-label', 'Show error details');
    btn.addEventListener('click', function () { openErrorDialog(); });
    b.appendChild(btn);
  }
  b.hidden = false;
}

function clearBanner() {
  var b = document.getElementById('banner');
  if (!b) return;
  var t = document.getElementById('banner-text');
  if (t) t.textContent = '';
  else b.textContent = '';
  b.classList.remove('error', 'info');
  try { delete b.dataset.kind; } catch (e) { /* ignore */ }
  var old = document.getElementById('banner-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  lastErrorDetails = null;
  lastMirror = null;
  b.hidden = true;
  try { hideSettingsAlert(); } catch (e) { /* ignore */ }
}

var lastErrorDetails = null; // {title, message, lines[]} for the error-details popup

// While Settings is open the message lives ONLY in the dialog mirror;
// suppressMirror + lastMirror carry it back to the page banner on close.
var suppressMirror = false;
var lastMirror = null; // {msg, kind, details} or null

// Settings-dialog mirror of the page banner: modal dialogs paint above the
// page, so without this an error fired from the Sync tab hides behind the
// dialog until it is closed. The mirror shows the same line (+ its own
// More details button, which stacks above) and hides with clearBanner.
function settingsDialogOpen() {
  try {
    var d = (typeof document !== 'undefined') ? document.getElementById('settings-dialog') : null;
    return !!(d && (d.open || (d.hasAttribute && d.hasAttribute('open'))));
  } catch (e) {
    return false;
  }
}

function settingsAlertEl() {
  var dlg = document.getElementById('settings-dialog');
  var host = document.getElementById('settings-dialog-body');
  if (!dlg || !host) return null;
  var el = document.getElementById('settings-alert');
  if (!el) {
    el = document.createElement('div');
    el.id = 'settings-alert';
    el.className = 'dlg-note';
    el.hidden = true;
    var sp = document.createElement('span');
    sp.id = 'settings-alert-text';
    el.appendChild(sp);
    // Child of the dialog itself (above the body), NOT of the grid body:
    // the body is a single-row grid and a second child would break it.
    dlg.insertBefore(el, host);
  }
  // Once per dialog: when Settings closes, a mirrored message moves back to
  // the page banner so it is not silently lost. Native Esc closes fire
  // 'close' too, so this catches every path (not just closeDialog).
  if (!dlg.getAttribute('data-alert-wired')) {
    dlg.setAttribute('data-alert-wired', '1');
    dlg.addEventListener('close', function () {
      try { flushSettingsAlertToBanner(); } catch (e) { /* ignore */ }
      try { updateModalLock(); } catch (e2) { /* ignore */ }
    });
  }
  return el;
}

function mirrorBannerToSettings(msg, kind, hasDetails) {
  if (typeof document === 'undefined') return;
  if (!settingsDialogOpen()) return;
  var el = settingsAlertEl();
  if (!el) return;
  el.classList.remove('error', 'info');
  el.classList.add(kind === 'info' ? 'info' : 'error');
  var sp = document.getElementById('settings-alert-text');
  if (sp) sp.textContent = String(msg);
  else el.textContent = String(msg);
  var old = document.getElementById('settings-alert-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  if (hasDetails) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'settings-alert-details';
    btn.textContent = 'More details';
    btn.setAttribute('aria-label', 'Show error details');
    btn.addEventListener('click', function () { openErrorDialog(); });
    el.appendChild(btn);
  }
  // Every error gets a way out: dismissing here clears the message
  // everywhere (mirror and page banner are one message).
  var x = document.getElementById('settings-alert-close');
  if (!x) {
    x = document.createElement('button');
    x.type = 'button';
    x.id = 'settings-alert-close';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Dismiss this message');
    x.addEventListener('click', function () {
      try { clearBanner(); } catch (e) { /* ignore */ }
    });
  }
  el.appendChild(x); // last: after any details button
  el.hidden = false;
}

function hideSettingsAlert() {
  if (typeof document === 'undefined') return;
  var el = document.getElementById('settings-alert');
  if (el) el.hidden = true;
}

function refreshSettingsAlert() {
  // Settings opened while a page banner shows: move the message into the
  // dialog (it moves back on close), so it lives in exactly one place.
  try {
    var s = pageBannerState();
    if (!s) return;
    hidePageBannerOnly();
    lastMirror = { msg: s.msg, kind: s.kind, details: lastErrorDetails, fromPage: true };
    mirrorBannerToSettings(s.msg, s.kind === 'info' ? 'info' : 'error', s.hasDetails);
  } catch (e) { /* ignore */ }
}

function pageBannerState() {
  try {
    var b = document.getElementById('banner');
    if (!b || b.hidden) return null;
    var t = document.getElementById('banner-text');
    var kind = 'error';
    try { kind = (b.dataset && b.dataset.kind === 'info') ? 'info' : 'error'; } catch (e) { /* ignore */ }
    return { msg: t ? t.textContent : b.textContent, kind: kind, hasDetails: !!document.getElementById('banner-details') };
  } catch (e) {
    return null;
  }
}

function hidePageBannerOnly() {
  // Hides the page banner but keeps lastErrorDetails, for the move into/out
  // of the settings mirror. Prefer clearBanner() when the message is done.
  var b = document.getElementById('banner');
  if (!b) return;
  var t = document.getElementById('banner-text');
  if (t) t.textContent = '';
  else b.textContent = '';
  b.classList.remove('error', 'info');
  try { delete b.dataset.kind; } catch (e) { /* ignore */ }
  var old = document.getElementById('banner-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  b.hidden = true;
}

function flushSettingsAlertToBanner() {
  var m = lastMirror;
  lastMirror = null;
  try { hideSettingsAlert(); } catch (e) { /* ignore */ }
  if (!m || !m.fromPage) return;
  suppressMirror = true;
  try {
    showBanner(m.msg, m.kind, m.details);
  } finally {
    suppressMirror = false;
  }
}

function openErrorDialog() {
  var d = lastErrorDetails || { title: 'Details', message: '', lines: [] };
  var t = document.getElementById('error-dialog-title');
  if (t) t.textContent = d.title || 'Details';
  var m = document.getElementById('error-dialog-message');
  if (m) {
    m.textContent = d.message || '';
    m.hidden = !d.message;
  }
  var ul = document.getElementById('error-dialog-list');
  if (ul) {
    ul.innerHTML = '';
    (d.lines || []).forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = String(line);
      ul.appendChild(li);
    });
    ul.hidden = !(d.lines && d.lines.length);
  }
  wireDialog('error-dialog');
  openDialog('error-dialog');
}

// Price notices are informational and transient: only clear the banner
// when it shows a price notice, so FX/storage errors are never wiped.
function clearPriceBanner() {
  // A mirrored info notice lives in the dialog while the page banner hides
  // (see showBanner): clear that copy too — but never an error mirror.
  try {
    if (lastMirror && lastMirror.kind === 'info') {
      lastMirror = null;
      hideSettingsAlert();
    }
  } catch (e) { /* ignore */ }
  var b = document.getElementById('banner');
  if (!b || b.hidden) return;
  var kind = null;
  try { kind = b.dataset.kind; } catch (e) { kind = null; }
  if (kind === 'info') clearBanner();
}

// Guarded persistence for UI mutations: saveState throws
// Error('storage-unavailable') on private-mode/quota failure. Every UI
// mutation must go through here so no storage failure bricks the UI
// uncaught — the failure surfaces via the existing banner path.
function saveStateGuarded(s) {
  try {
    saveState(s);
    return true;
  } catch (e) {
    if (e && e.message === 'storage-unavailable') {
      showBanner('Storage unavailable — change was not saved.', 'error', {
        title: 'Storage error',
        lines: [
          'What failed: saving your latest change to this browser.',
          'Common causes: private window, or storage full / quota exceeded.',
          'Your change was NOT saved — free space or leave private mode, then retry.'
        ]
      });
      return false;
    }
    throw e;
  }
}

function heldQtyFor(trades, symbol) {
  var sym = String(symbol || '').toUpperCase();
  var held = 0;
  (trades || []).forEach(function (t) {
    if (!t || String(t.symbol || '').toUpperCase() !== sym) return;
    if (t.type === 'buy' || t.type === 'income') {
      var qb = Number(t.qty);
      if (!isFinite(qb) || qb <= 0) return;
      held += qb;
    } else if (t.type === 'sell') {
      var qs = Number(t.qty);
      if (!isFinite(qs) || qs <= 0) return;
      held -= qs;
    } else if (t.type === 'expense') {
      if (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') return;
      var qe = Number(t.qty);
      if (!isFinite(qe) || qe <= 0) return;
      held -= qe;
    } else if (t.type === 'transfer') {
      var qt = Number(t.qty);
      if (!isFinite(qt) || qt <= 0) return;
      var nft = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (!isFinite(nft) || nft < 0) nft = 0;
      held -= nft; // global net: out+in cancel except on-chain fee
    }
  });
  return held < 0 ? 0 : held;
}

function uniqueSymbols(trades) {
  var seen = {};
  var out = [];
  (trades || []).forEach(function (t) {
    var s = String((t && t.symbol) || '').toUpperCase();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out;
}


// gain/loss tint for P&L figures (Revolut-style): '' for zero/unknown.
function plClass(n) {
  var v = Number(n);
  if (!isFinite(v) || v === 0) return '';
  return v > 0 ? 'gain' : 'loss';
}

function statCard(label, text, raw, loading) {
  var d = document.createElement('div');
  d.className = 'card';
  d.setAttribute('data-label', label);
  var l = document.createElement('span');
  l.className = 'card-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'card-value num';
  v.textContent = text;
  if (raw !== null && raw !== undefined && isFinite(Number(raw))) {
    d.setAttribute('data-value', String(Number(raw)));
    v.setAttribute('data-value', String(Number(raw)));
  }
  if (loading) paintLoading(v, true, label);
  d.appendChild(l);
  d.appendChild(v);
  return d;
}

// Auto-fit hero digits: fixed box, fluid numbers. The digits live in an
// inner span sized here; the outer line keeps its CSS size, so the strut —
// and therefore the box — never moves. Starts from the CSS clamp size and
// steps down until the amount fits one line (floor ~1.4rem); ellipsis
// remains as the last resort. Re-run on render + resize.
function fitHeroValue() {
  try {
    var el = null;
    try { el = document.getElementById('hero-value-num'); } catch (e0) { el = null; }
    if (!el) el = document.getElementById('hero-value');
    if (!el || !el.style) return;
    el.style.fontSize = '';
    if (typeof getComputedStyle !== 'function') return;
    var size = parseFloat(getComputedStyle(el).fontSize);
    if (!isFinite(size) || size <= 0) return;
    var floor = 22;
    var guard = 0;
    while (guard < 30 && size > floor && el.scrollWidth > el.clientWidth + 1) {
      size -= 2;
      el.style.fontSize = size + 'px';
      guard++;
    }
  } catch (e) { /* ignore */ }
}

function renderSummaryCards(st, rows, dtradesOpt, nAcctsOpt) {
  var main = st.settings.mainCurrency;
  var mv = 0;
  var un = 0;
  var rz = 0;
  var pl = 0;
  var mvKnown = false;
  var unKnown = false;
  var hasRealized = false;
  // Cash ledgers: balances count toward total Value only — never toward
  // Unrealized/Realized/Return/Invested/Spent. Same asset filter as cards.
  var cashIdsS = {};
  try { cashIdsS = cashAccountIds(st); } catch (e) { cashIdsS = {}; }
  var cashTickers = {};
  try {
    ((st && st.accounts) || []).forEach(function (a) {
      if (a && a.id && cashIdsS[a.id] && a.ticker) cashTickers[a.id] = String(a.ticker).toUpperCase();
    });
  } catch (e) { cashTickers = {}; }
  var cashFilter = null;
  try { cashFilter = selectedTickers(st); } catch (e) { cashFilter = null; }
  function cashVisible(aid) {
    if (!cashIdsS[aid]) return false;
    if (cashFilter === null) return true;
    return cashFilter.indexOf(cashTickers[aid] || '') !== -1;
  }
  var dtrCash = null;
  try { dtrCash = dtradesOpt || convertTrades(st.trades, main); } catch (e) { dtrCash = []; }
  var cashTrades = 0;
  (dtrCash || []).forEach(function (t) {
    if (!t) return;
    if ((t.accountId && cashVisible(t.accountId)) || transferDestIds(t).some(function (id) { return cashVisible(id); })) cashTrades++;
  });
  var cashBalTotal = 0;
  var cashBalKnown = false;
  Object.keys(cashIdsS).forEach(function (aid) {
    if (!cashVisible(aid)) return;
    var hasAny = (dtrCash || []).some(function (t) { return transferInvolvesAccount(t, aid); });
    if (!hasAny) return;
    var b = cashBalance(dtrCash, aid, main);
    if (isFinite(b.main)) { cashBalTotal += b.main; cashBalKnown = true; }
  });
  if (cashBalKnown) { mv += cashBalTotal; mvKnown = true; }
  var anyContent = rows.length > 0 || cashTrades > 0;
  rows.forEach(function (p) {
    rz += p.realized;
    if (Math.abs(p.realized || 0) > 1e-9) hasRealized = true;
    if (p.unrealized === null && Math.abs(p.realized || 0) <= 1e-9) {
      if (p.marketValue !== null) { mv += p.marketValue; mvKnown = true; }
      return; // unknown open position: value may count, P&L stays unknown
    }
    pl += p.totalPL;
    if (p.marketValue !== null) { mv += p.marketValue; mvKnown = true; }
    if (p.unrealized !== null) { un += p.unrealized; unKnown = true; }
  });
  // Lifetime cost denominator (consistent with computePositions returnPct):
  // sum of buy+income cost for symbols with known P&L. Falls back to
  // remaining-cost when trade history is unavailable (tests/native).
  var lifetime = 0;
  try {
    var dtr = dtradesOpt || convertTrades(st.trades, main);
    var buyBySym = {};
    dtr.forEach(function (t) {
      if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
      if (t.accountId && cashIdsS[t.accountId]) return; // cash is balance-only
      var s = String(t.symbol || '').toUpperCase();
      if (!s) return;
      var q = Number(t.qty);
      if (!isFinite(q) || q <= 0) return;
      var nn = normalizeTrade(t);
      buyBySym[s] = (buyBySym[s] || 0) + nn.netMain + nn.feeLossMain;
    });
    var knownSyms = {};
    rows.forEach(function (p) {
      if (p.unrealized !== null || Math.abs(p.realized || 0) > 1e-9) knownSyms[p.symbol] = true;
    });
    Object.keys(buyBySym).forEach(function (s) { if (knownSyms[s]) lifetime += buyBySym[s]; });
  } catch (e) { lifetime = 0; }
  if (!(lifetime > 0)) {
    // Fallback: remaining cost (old behaviour) so empty/new portfolios still paint.
    rows.forEach(function (p) {
      if (p.marketValue !== null && p.unrealized !== null) lifetime += p.marketValue - p.unrealized;
    });
    // If fallback yields 0 but we have realized (e.g. closed, price unknown), use it as denominator guard below.
    if (!(lifetime > 0)) lifetime = 0;
  }
  var plKnown = unKnown || hasRealized;
  var tb = document.getElementById('tb-totals');
  if (tb) {
    var nAccts = (typeof nAcctsOpt === 'number' && isFinite(nAcctsOpt)) ? nAcctsOpt : (st.accounts || []).length;
    tb.textContent = anyContent
      ? (nAccts + (nAccts === 1 ? ' account' : ' accounts') + ' · ' +
        (st.settings.costMethod === 'fifo' ? 'FIFO' : 'Average cost') + ' · in ' + main)
      : '';
  }
  var host = document.getElementById('summary-cards');
  if (!host) return;
  host.innerHTML = '';
  if (!anyContent) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No trades yet — add your first trade.';
    host.appendChild(p);
    return;
  }
  var ret = lifetime > 0 ? ((un + rz) / lifetime) * 100 : null;
  // Unknown aggregates show the loading placeholder while a live fetch is
  // still in flight (never an error); manual-by-design unknowns keep '—'.
  var loadAny = anyPriceLoading();
  [['Value', mvKnown ? fmtMoney(mv, main) : (loadAny ? PRICE_LOADING_TEXT : '—'), mvKnown ? mv : null, (!mvKnown && loadAny)],
   ['Unrealized', unKnown ? fmtMoney(un, main) : (loadAny ? PRICE_LOADING_TEXT : '—'), unKnown ? un : null, (!unKnown && loadAny)],
   ['Realized', fmtMoney(rz, main), rz, false],
   ['Return', ret !== null ? fmtPct(ret) : (loadAny ? PRICE_LOADING_TEXT : '—'), ret, (ret === null && loadAny)]].forEach(function (c) {
    var cardEl = statCard(c[0], c[1], c[2], c[3]);
    if (c[0] !== 'Value') {
      var sc = plClass(c[2]);
      if (sc) cardEl.querySelector('.card-value').classList.add(sc);
    }
    host.appendChild(cardEl);
  });
  var hv = document.getElementById('hero-value');
  var hvn = null;
  try { hvn = document.getElementById('hero-value-num'); } catch (e0) { hvn = null; }
  var hvTarget = hvn || hv;
  if (hvTarget) {
    var heroLoading = !!(anyContent && !mvKnown && anyPriceLoading());
    hvTarget.textContent = anyContent ? (mvKnown ? fmtMoney(mv, main) : (heroLoading ? PRICE_LOADING_TEXT : '—')) : '—';
    paintLoading(hvTarget, heroLoading, 'Total balance');
  }
  if (hv && (!hvTarget || !hvTarget.classList.contains('is-loading'))) hv.title = hvTarget ? hvTarget.textContent : '';
  fitHeroValue();
  // Invested amount: lifetime gross in (every buy + valued income at its
  // locked historical rate) — never reduced by sells, fees or transfers.
  // Sits between value and pill on one small line; truncates, never resizes
  // the box.
  var hi = document.getElementById('hero-invested');
  if (hi) {
    if (!anyContent) {
      hi.textContent = '';
      hi.hidden = true;
    } else {
      var inv = 0;
      try {
        var dtrInv = dtradesOpt || convertTrades(st.trades, main);
        dtrInv.forEach(function (t) {
          if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
          if (t.accountId && cashIdsS[t.accountId]) return; // cash is balance-only
          var q = Number(t.qty);
          if (!isFinite(q) || q <= 0) return;
          var nn = normalizeTrade(t);
          if (isFinite(nn.netMain) && nn.netMain > 0) inv += nn.netMain;
        });
      } catch (e) { inv = 0; }
      hi.hidden = false;
      hi.textContent = 'INVESTED AMOUNT: ' + fmtMoney(inv, main);
    }
  }
  // Spent amount: lifetime gross fiat out — sell proceeds, the cash legs of
  // expense and transfer records, plus crypto fees and crypto expenses
  // valued at the frozen tx-date rate (the same ≈ the cards show; 0 while
  // the rate is unknown, never a guess). Each leg uses its locked
  // historical rate. Never reduced by anything; appreciation can push it
  // above invested. feeMain is never added: the all-in totals include it.
  var hs = document.getElementById('hero-spent');
  if (hs) {
    if (!anyContent) {
      hs.textContent = '';
      hs.hidden = true;
    } else {
      var spent = 0;
      try {
        var dtrSpent = dtradesOpt || convertTrades(st.trades, main);
        var kindsSpent = {};
        try {
          (st.accounts || []).forEach(function (a) {
            if (a && a.ticker) kindsSpent[String(a.ticker).toUpperCase()] = a.kind;
          });
        } catch (e) { kindsSpent = {}; }
        dtrSpent.forEach(function (t) {
          if (!t) return;
          if (t.accountId && cashIdsS[t.accountId]) return; // cash is balance-only
          var sn = normalizeTrade(t);
          if (t.type === 'sell') {
            if (isFinite(sn.totalMain) && sn.totalMain > 0) spent += sn.totalMain;
          } else if (t.type === 'expense' || t.type === 'transfer') {
            if (isFinite(sn.netMain) && sn.netMain > 0) spent += sn.netMain;
            var cq = (t.type === 'transfer')
              ? ((t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee))
              : ((t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? 0 : Number(t.qty));
            if (isFinite(cq) && cq > 0) {
              var sym = String(t.symbol || '').toUpperCase();
              var kd = kindsSpent[sym];
              var kr = null;
              try { kr = resolveExecPrice(t, main, (typeof kd === 'string') ? kd : undefined); } catch (e) { kr = null; }
              if (kr !== null && isFinite(Number(kr.price)) && Number(kr.price) > 0) {
                spent += cq * Number(kr.price);
              }
            }
          }
        });
      } catch (e) { spent = 0; }
      hs.hidden = false;
      hs.textContent = 'SPENT AMOUNT: ' + fmtMoney(spent, main);
    }
  }
  var hp = document.getElementById('hero-pl');
  if (hp) {
    if (!anyContent || !plKnown) {
      hp.textContent = '';
      hp.className = 'hero-pl';
    } else {
      // Arrow carries the direction; show magnitude so signs never glue (▼-€0.14).
      hp.textContent = fmtMoney(Math.abs(pl), main);
      hp.className = 'hero-pl pill ' + plClass(pl);
    }
  }
}

var accountFilterOpen = false;
var accountFilterFocus = null;
var accountFilterOutsideWired = false;
var selectionMode = false;
var selectedAccounts = {}; // id -> true; survives page flips and re-renders (in-memory working set)
var accountActionOpen = false;

// View filter: null = show every asset, otherwise exactly these tickers.
// Persisted in settings (backup/restore carry it); absent key means all.
function selectedTickers(st) {
  var f = st && st.settings ? st.settings.accountFilter : null;
  if (f === undefined || f === null) return null;
  return normalizeAccountFilter(f);
}

function accountTickers(accounts) {
  var seen = {};
  var out = [];
  (accounts || []).forEach(function (a) {
    var t = String((a && a.ticker) || '').toUpperCase();
    if (!t || seen[t]) return;
    seen[t] = true;
    out.push(t);
  });
  return out.sort();
}

function setAccountFilter(next, focusTicker) {
  var st = loadState();
  st.settings = st.settings || { mainCurrency: 'EUR', costMethod: 'average' };
  if (next === null) {
    try {
      delete st.settings.accountFilter;
    } catch (e) {
      st.settings.accountFilter = null;
    }
  } else {
    st.settings.accountFilter = next;
  }
  accountFilterFocus = focusTicker || null;
  if (!saveStateGuarded(st)) return;
  render();
}

function closeAccountFilter(moveFocus) {
  if (!accountFilterOpen) return;
  accountFilterOpen = false;
  accountFilterFocus = null;
  var host = document.getElementById('accounts');
  var panel = host && host.querySelector ? host.querySelector('[data-filter-panel]') : null;
  var btn = host && host.querySelector ? host.querySelector('[data-filter-btn]') : null;
  if (panel) panel.hidden = true;
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    if (moveFocus && btn.focus) {
      try { btn.focus(); } catch (e) { /* ignore */ }
    }
  }
}

function restoreAccountFilterFocus() {
  if (!accountFilterOpen || !accountFilterFocus) {
    accountFilterFocus = null;
    return;
  }
  try {
    var host = document.getElementById('accounts');
    var el = host && host.querySelector ? host.querySelector('[data-ticker="' + accountFilterFocus + '"]') : null;
    if (el && el.focus) el.focus();
  } catch (e) { /* ignore */ }
  accountFilterFocus = null;
}

function selectedCount() {
  return Object.keys(selectedAccounts).length;
}

function cancelSelection() {
  selectionMode = false;
  selectedAccounts = {};
  accountActionOpen = false;
  render();
}

function toggleAccountSelect(id) {
  if (!id) return;
  if (selectedAccounts[id]) delete selectedAccounts[id];
  else selectedAccounts[id] = true;
  syncSelectionUI();
}

// Paint-only sync (no re-render): every rendered card, count and Action
// follow the set — home list and group sub-lists alike — so rapid
// multi-select keeps focus and panels stay open.
function syncSelectionUI() {
  var n = selectedCount();
  try {
    Array.prototype.forEach.call(document.querySelectorAll('.account-card'), function (card) {
      var id = card.getAttribute ? card.getAttribute('data-account') : null;
      var on = !!id && !!selectedAccounts[id];
      if (card.classList) card.classList.toggle('selected', on);
      var cb = card.querySelector ? card.querySelector('[data-select-check]') : null;
      if (cb) cb.checked = on;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-select-count]'), function (count) {
      count.textContent = n + ' selected';
      count.hidden = !(selectionMode && n > 0);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-action-wrap]'), function (awrap) {
      awrap.hidden = !(selectionMode && n > 0);
    });
  } catch (e) { /* ignore */ }
}

function closeAccountAction() {
  if (!accountActionOpen) return;
  accountActionOpen = false;
  try {
    Array.prototype.forEach.call(document.querySelectorAll('[data-action-panel]'), function (panel) {
      panel.hidden = true;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-action-btn]'), function (btn) {
      btn.setAttribute('aria-expanded', 'false');
    });
  } catch (e) { /* ignore */ }
}

function applyColorToSelection(hex) {
  var st = loadState();
  var ids = Object.keys(selectedAccounts).filter(function (id) { return !!accountById(st, id); });
  if (!ids.length) return;
  if (hex !== null) {
    if (!isValidHexColor(hex)) {
      showBanner('Pick a valid color, e.g. #F7931A.');
      return;
    }
    hex = String(hex).trim().toUpperCase();
  }
  ids.forEach(function (id) {
    var a = accountById(st, id);
    if (!a) return;
    if (hex === null) {
      try {
        delete a.color;
      } catch (e) {
        a.color = undefined;
      }
    } else {
      a.color = hex;
    }
  });
  if (!saveStateGuarded(st)) return;
  clearBanner();
  closeDialog('color-dialog');
  render(); // stay in selection mode with the set intact
}

function buildAccountAction() {
  var wrap = document.createElement('div');
  wrap.className = 'filter-wrap';
  wrap.setAttribute('data-action-wrap', '1');
  var n = selectedCount();
  wrap.hidden = !(selectionMode && n > 0);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('data-action-btn', '1');
  btn.textContent = 'Action';
  btn.setAttribute('aria-label', 'Bulk actions for selected accounts');
  btn.setAttribute('aria-expanded', accountActionOpen ? 'true' : 'false');
  btn.addEventListener('click', function () {
    accountActionOpen = !accountActionOpen;
    render();
  });
  wrap.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'filter-panel';
  panel.setAttribute('data-action-panel', '1');
  panel.hidden = !accountActionOpen;
  var col = document.createElement('button');
  col.type = 'button';
  col.className = 'action-opt';
  col.textContent = 'Change color';
  col.setAttribute('aria-label', 'Change color of selected accounts');
  col.addEventListener('click', function () {
    accountActionOpen = false;
    panel.hidden = true;
    var host = document.getElementById('accounts');
    var tgl = host && host.querySelector ? host.querySelector('[data-action-btn]') : null;
    if (tgl) tgl.setAttribute('aria-expanded', 'false');
    openDialog('color-dialog');
  });
  panel.appendChild(col);
  // Group… is offered only for grouping-clean selections: mains regroup
  // through Ungroup, and sub-accounts have no regroup option at all — the
  // button simply isn't there when one is selected.
  var grpBlocked = false;
  try {
    var stG = loadState();
    grpBlocked = Object.keys(selectedAccounts).some(function (id) {
      return !!accountById(stG, id) && (isGroupMain(stG, id) || groupMainOf(stG, id));
    });
  } catch (e) { grpBlocked = false; }
  if (!grpBlocked) {
  var grp = document.createElement('button');
  grp.type = 'button';
  grp.className = 'action-opt';
  grp.textContent = 'Group…';
  grp.setAttribute('aria-label', 'Group selected accounts under one main');
  grp.addEventListener('click', function () {
    accountActionOpen = false;
    panel.hidden = true;
    var host = document.getElementById('accounts');
    var tgl = host && host.querySelector ? host.querySelector('[data-action-btn]') : null;
    if (tgl) tgl.setAttribute('aria-expanded', 'false');
    var st = loadState();
    var ids = Object.keys(selectedAccounts).filter(function (id) { return !!accountById(st, id); });
    if (!ids.length) return;
    for (var i = 0; i < ids.length; i++) {
      if (isGroupMain(st, ids[i])) { showBanner('"' + accountById(st, ids[i]).name + '" is already a main account — ungroup it first.'); return; }
      if (groupMainOf(st, ids[i])) { showBanner('"' + accountById(st, ids[i]).name + '" is a sub-account and cannot be grouped.'); return; }
    }
    openGroupDialog(ids);
  });
  panel.appendChild(grp);
  }
  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'action-del';
  del.textContent = 'Delete';
  del.setAttribute('aria-label', 'Delete selected accounts and their trades');
  del.addEventListener('click', function () {
    accountActionOpen = false;
    var s0 = loadState();
    var picked = Object.keys(selectedAccounts).filter(function (id) { return !!accountById(s0, id); });
    var full = expandDeleteIds(s0, picked);
    var extra = full.length - picked.length;
    confirmAction('Delete accounts', 'Delete ' + full.length + (full.length === 1 ? ' account' : ' accounts') +
      (extra > 0 ? ' (including ' + extra + ' sub-account' + (extra === 1 ? '' : 's') + ')' : '') +
      ' and all their trades? This cannot be undone.', 'Delete', true).then(function (ok) {
      if (!ok) return;
      var s2 = loadState();
      var inSet = {};
      expandDeleteIds(s2, Object.keys(selectedAccounts)).forEach(function (id) { inSet[id] = true; });
      if (!Object.keys(inSet).length) {
        selectedAccounts = {};
        selectionMode = false;
        render();
        return;
      }
      // Owned trades go; transfers pointing into the set go too — otherwise
      // the next load would silently drop the survivors' half of the move.
      s2.trades = (s2.trades || []).filter(function (t) {
        return !t || (!inSet[t.accountId] && !transferDestIds(t).some(function (id) { return !!inSet[id]; }));
      });
      s2.accounts = (s2.accounts || []).filter(function (a) { return !a || !inSet[a.id]; });
      selectedAccounts = {};
      selectionMode = false;
      if (!saveStateGuarded(s2)) return;
      try { Object.keys(inSet).forEach(function (id) { delete tradePageByAccount[id]; clearTradeTypeFilterState(id); }); } catch (e) { /* ignore */ }
      clearBanner();
      render();
    });
  });
  panel.appendChild(del);
  wrap.appendChild(panel);
  return wrap;
}

function buildAccountFilter(st, tickers, effective) {
  var wrap = document.createElement('div');
  wrap.className = 'filter-wrap';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('data-filter-btn', '1');
  var f = selectedTickers(st);
  btn.textContent = (f === null) ? 'Filter' : ('Filter · ' + f.length);
  btn.setAttribute('aria-label', 'Filter accounts by asset');
  btn.setAttribute('aria-expanded', accountFilterOpen ? 'true' : 'false');
  btn.addEventListener('click', function () {
    accountFilterOpen = !accountFilterOpen;
    accountFilterFocus = null;
    render();
  });
  wrap.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'filter-panel';
  panel.setAttribute('data-filter-panel', '1');
  panel.hidden = !accountFilterOpen;
  var title = document.createElement('p');
  title.className = 'filter-title';
  title.textContent = 'Show assets';
  panel.appendChild(title);
  function optRow(labelText, checked, ticker) {
    var lab = document.createElement('label');
    lab.className = 'filter-opt';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    if (ticker === null) cb.setAttribute('data-filter-all', '1');
    else cb.setAttribute('data-ticker', ticker);
    var sp = document.createElement('span');
    sp.textContent = labelText;
    lab.appendChild(cb);
    lab.appendChild(sp);
    cb.addEventListener('change', function () {
      if (ticker === null) {
        setAccountFilter(cb.checked ? null : [], null);
        return;
      }
      var cur = effective.slice();
      var ix = cur.indexOf(ticker);
      if (cb.checked && ix === -1) cur.push(ticker);
      if (!cb.checked && ix !== -1) cur.splice(ix, 1);
      var coversAll = tickers.length > 0 && tickers.every(function (t) { return cur.indexOf(t) !== -1; });
      setAccountFilter(coversAll ? null : cur.sort(), ticker);
    });
    return lab;
  }
  var counts = {};
  (st.accounts || []).forEach(function (a) {
    var t = String((a && a.ticker) || '').toUpperCase();
    if (t) counts[t] = (counts[t] || 0) + 1;
  });
  panel.appendChild(optRow('All', effective.length === tickers.length && tickers.length > 0, null));
  tickers.forEach(function (t) {
    var n = counts[t] || 0;
    panel.appendChild(optRow(t + (n ? ' · ' + n : ''), effective.indexOf(t) !== -1, t));
  });
  wrap.appendChild(panel);
  return wrap;
}

function tradeTypeLabel(t) {
  if (t === 'sell') return 'Sell';
  if (t === 'transfer') return 'Transfer';
  if (t === 'income') return 'Income';
  if (t === 'expense') return 'Expense';
  return 'Buy';
}

// Record-type filter button for the account detail Trades header. Same look
// and checkbox language as the home asset filter (ghost button, Filter · N
// count, All + per-type rows with counts); only the dimension differs.
function buildTradeTypeFilter(acc, atrades) {
  var id = (acc && acc.id) || '';
  var wrap = document.createElement('div');
  wrap.className = 'filter-wrap';
  var cur = tradeTypeFilterFor(id); // null = all
  var open = !!tradeTypeFilterOpenByAccount[id];
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('data-filter-btn', '1');
  btn.textContent = (cur === null) ? 'Filter' : ('Filter · ' + cur.length);
  btn.setAttribute('aria-label', 'Filter records by type');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.addEventListener('click', function () {
    tradeTypeFilterOpenByAccount[id] = !tradeTypeFilterOpenByAccount[id];
    tradeTypeFilterFocus = null;
    render();
  });
  wrap.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'filter-panel';
  panel.setAttribute('data-filter-panel', '1');
  panel.hidden = !open;
  var title = document.createElement('p');
  title.className = 'filter-title';
  title.textContent = 'Show records';
  panel.appendChild(title);
  var counts = {};
  (atrades || []).forEach(function (t) {
    var k = String((t && t.type) || '').toLowerCase();
    if (TRADE_TYPES.indexOf(k) !== -1) counts[k] = (counts[k] || 0) + 1;
  });
  function optRow(labelText, checked, type) {
    var lab = document.createElement('label');
    lab.className = 'filter-opt';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    if (type === null) cb.setAttribute('data-ttfilter-all', '1');
    else cb.setAttribute('data-ttype', type);
    var sp = document.createElement('span');
    sp.textContent = labelText;
    lab.appendChild(cb);
    lab.appendChild(sp);
    cb.addEventListener('change', function () {
      if (type === null) {
        setTradeTypeFilter(id, cb.checked ? null : [], null);
        return;
      }
      var base = tradeTypeFilterFor(id);
      var list = (base === null) ? TRADE_TYPES.slice() : base.slice();
      var ix = list.indexOf(type);
      if (cb.checked && ix === -1) list.push(type);
      if (!cb.checked && ix !== -1) list.splice(ix, 1);
      var coversAll = TRADE_TYPES.every(function (x) { return list.indexOf(x) !== -1; });
      setTradeTypeFilter(id, coversAll ? null : list.sort(), type);
    });
    return lab;
  }
  panel.appendChild(optRow('All', cur === null, null));
  TRADE_TYPES.forEach(function (x) {
    var n = counts[x] || 0;
    panel.appendChild(optRow(tradeTypeLabel(x) + (n ? ' · ' + n : ''), cur === null || cur.indexOf(x) !== -1, x));
  });
  wrap.appendChild(panel);
  return wrap;
}

// Home-style account card, shared by the home list and group mains.
// rows come from the joint engine run (same data as the totals). scopeIds
// widens the figures to the whole group (main first); omitted means the
// single account. Standalone rendering is unchanged by construction.
function accountCardEl(st, acc, rows, dtrades, main, withSelect, scopeIds) {
  rows = rows || [];
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [acc.id];
  var scopeSet = {};
  scope.forEach(function (sid) { if (typeof sid === 'string' && sid !== '') scopeSet[sid] = true; });
  var card = document.createElement('article');
  card.className = 'account-card';
  card.setAttribute('data-account', acc.id);
  card.setAttribute('data-account-nav', acc.id);
  card.setAttribute('tabindex', '0');
  card.setAttribute('role', 'link');
  card.setAttribute('aria-label', 'Open ' + acc.name + ', ' + String(acc.ticker).toUpperCase());
  var grip = document.createElement('span');
  grip.className = 'drag-handle';
  grip.title = 'Drag to reorder';
  grip.setAttribute('aria-hidden', 'true');
  card.appendChild(grip);
  var avatar = document.createElement('span');
  avatar.className = 'acct-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = String(acc.ticker || '?').substring(0, 4).toUpperCase();
  if (acc.color && isValidHexColor(acc.color)) {
    card.setAttribute('data-colored', '1');
    try {
      card.style.setProperty('--acct-color', String(acc.color).trim().toUpperCase());
      avatar.style.color = contrastText(acc.color);
    } catch (e) { /* ignore */ }
  }
  card.appendChild(avatar);
  var mid = document.createElement('span');
  mid.className = 'acct-mid';
  var nameEl = document.createElement('span');
  nameEl.className = 'account-name';
  nameEl.textContent = acc.name;
  mid.appendChild(nameEl);
  var tickEl = document.createElement('span');
  tickEl.className = 'account-ticker';
  tickEl.textContent = String(acc.ticker).toUpperCase();
  mid.appendChild(tickEl);
  card.appendChild(mid);
  // Scope figures: asset rows arrive pre-folded; cash balances sum across
  // scope cash accounts (native only when every balance shares one fiat).
  var scopeTrades = 0;
  var cashMain = 0;
  var cashKnown = false;
  var cashNative = 0;
  var cashTickers = {};
  var cashContrib = 0;
  var seenTrade = {};
  (dtrades || []).forEach(function (t) {
    if (!t) return;
    if (!scopeSet[t.accountId] && !transferDestIds(t).some(function (id) { return !!scopeSet[id]; })) return;
    if (t.id) {
      if (seenTrade[t.id]) return;
      seenTrade[t.id] = true;
    }
    scopeTrades++;
  });
  scope.forEach(function (sid) {
    var sa = null;
    try { sa = accountById(st, sid); } catch (e) { sa = null; }
    if (!sa || !isCashKind(sa.kind)) return;
    var at = accountTrades({ trades: dtrades }, sid);
    if (!at.length) return;
    cashContrib++;
    var b = cashBalance(dtrades, sid, main);
    if (isFinite(Number(b.main))) { cashMain += Number(b.main); cashKnown = true; }
    cashNative += Number(b.native) || 0;
    cashTickers[String(sa.ticker || '').toUpperCase()] = true;
  });
  var pl = 0;
  var mv = 0;
  var mvKnown = false;
  rows.forEach(function (r) {
    pl += r.totalPL;
    if (r.marketValue !== null) { mv += r.marketValue; mvKnown = true; }
  });
  var valKnown = mvKnown || cashKnown;
  var valNum = (mvKnown ? mv : 0) + (cashKnown ? cashMain : 0);
  var figs = document.createElement('span');
  figs.className = 'acct-figs';
  var valv = document.createElement('span');
  valv.className = 'acct-value';
  var plv = document.createElement('span');
  var accTick = String(acc.ticker || '').toUpperCase();
  var accLoading = !!scopeTrades && !valKnown && isPriceLoading(accTick);
  valv.textContent = valKnown ? fmtMoney(valNum, main) : (scopeTrades ? (accLoading ? PRICE_LOADING_TEXT : '—') : 'New');
  paintLoading(valv, accLoading, acc.name + ' value');
  if (cashKnown && isFinite(Number(valNum))) valv.setAttribute('data-value', String(Number(valNum)));
  var hasKnownPl = rows.some(function (r) { return r.unrealized !== null || Math.abs(r.realized || 0) > 1e-9; });
  if (hasKnownPl) {
    plv.className = 'acct-pl ' + plClass(pl);
    plv.textContent = fmtMoney(pl, main);
    if (isFinite(Number(pl))) plv.setAttribute('data-value', String(Number(pl)));
  } else if (cashKnown) {
    plv.className = 'acct-pl';
    var tickList = Object.keys(cashTickers);
    if (tickList.length === 1 && scope.length === 1) {
      var only = null;
      try { only = accountById(st, scope[0]); } catch (e) { only = null; }
      var cb0 = cashBalance(dtrades, scope[0], main);
      plv.textContent = fmtQty(cb0.native, cb0.ticker || (only && only.ticker) || '') + ' ' + String(cb0.ticker || (only && only.ticker) || '').toUpperCase();
    } else if (tickList.length === 1) {
      plv.textContent = fmtQty(cashNative, tickList[0]) + ' ' + tickList[0];
    } else {
      plv.textContent = cashContrib + (cashContrib === 1 ? ' account' : ' accounts');
    }
  } else {
    plv.className = 'acct-pl';
    var plLoading = !!scopeTrades && isPriceLoading(accTick);
    plv.textContent = scopeTrades ? (plLoading ? PRICE_LOADING_TEXT : '—') : 'New';
    paintLoading(plv, plLoading, acc.name + ' profit');
  }
  figs.appendChild(valv);
  figs.appendChild(plv);
  card.appendChild(figs);
  if (withSelect && selectionMode) {
    var cbx = document.createElement('input');
    cbx.type = 'checkbox';
    cbx.className = 'card-check';
    cbx.setAttribute('data-select-check', acc.id);
    cbx.checked = !!selectedAccounts[acc.id];
    cbx.setAttribute('aria-label', 'Select ' + acc.name);
    cbx.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); });
    cbx.addEventListener('change', function () { toggleAccountSelect(acc.id); });
    if (cbx.checked) card.classList.add('selected');
    card.appendChild(cbx);
  }
  // Cards open on click (see nav wiring); the per-card buttons stay in the
  // DOM hidden for programmatic/test use so they never clutter the card.
  var tradeBtn = document.createElement('button');
  tradeBtn.type = 'button';
  tradeBtn.className = 'quiet';
  tradeBtn.textContent = '+ Record';
  tradeBtn.setAttribute('data-account-trade', acc.id);
  tradeBtn.setAttribute('aria-label', 'Add record to ' + acc.name);
  tradeBtn.hidden = true;
  card.appendChild(tradeBtn);
  var openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'quiet acct-open';
  openBtn.textContent = 'Open ›';
  openBtn.setAttribute('data-account-open', acc.id);
  openBtn.setAttribute('aria-label', 'Open ' + acc.name);
  openBtn.hidden = true;
  card.appendChild(openBtn);
  return card;
}

function renderAccounts(st) {
  var host = document.getElementById('accounts');
  if (!host) return;
  var method = st.settings.costMethod;
  var main = st.settings.mainCurrency;
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  // View filter: only the selected assets render (cards + totals).
  // Grouped sub-accounts never render on home: their figures and rows fold
  // into the main, so every trade counts exactly once in cards and totals.
  var filter = selectedTickers(st);
  var visibleAccounts = (filter === null
    ? accounts
    : accounts.filter(function (a) { return filter.indexOf(String(a.ticker).toUpperCase()) !== -1; }))
    .filter(function (a) { return !groupMainOf(st, a.id); });
  // Display conversion: native amounts stay in stone; everything shown is
  // converted into the CURRENT main at historical ECB rates (cached).
  var dtrades = convertTrades(st.trades, main);
  // Cash accounts are balance ledgers, never positions: the joint run below
  // stays whole (so cross-account transfer basis never shifts), but cash
  // rows are dropped at aggregation — cards and the hero add cash balances
  // explicitly instead.
  var cashIds = cashAccountIds(st);
  // Joint portfolio engine: one date-ordered pass keeps per-account cost
  // queues separate (so AGGREGATE-BEATS-GLOBAL holds for buy/sell), while
  // transfers move basis from source to dest at the source's basis — the
  // on-chain network fee + any fiat fee land as real losses. Each account's
  // rows are read from the joint run and reused for its card below, so
  // cards and grand totals agree by construction.
  var pf = null;
  try { pf = computePortfolio(dtrades, livePrices, method); } catch (e) { pf = null; }
  function engineRowsFor(accId) {
    if (cashIds[accId]) return []; // cash ledgers skip the engine
    if (pf && pf.byAccount) {
      var m = pf.byAccount[accId];
      if (!m) return [];
      var arr = [];
      m.forEach(function (r) { arr.push(r); });
      arr.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
      return arr;
    }
    // Fallback: independent per-account run (no transfers in legacy data).
    var acc = null;
    try { acc = accountById(st, accId); } catch (e) { acc = null; }
    if (acc && isCashKind(acc.kind)) return [];
    return computePositions(accountTrades({ trades: dtrades }, accId), livePrices, method);
  }
  var scopeRows = {};
  accounts.forEach(function (acc) { scopeRows[acc.id] = engineRowsFor(acc.id); });
  // Mains fold their members' rows in: cards and grand totals agree, and no
  // member trade is ever counted twice.
  var perAcctRows = visibleAccounts.map(function (acc) {
    var rows = (scopeRows[acc.id] || []).slice();
    groupMembers(st, acc.id).forEach(function (m) {
      (scopeRows[m.id] || []).forEach(function (r) { rows.push(r); });
    });
    return rows;
  });
  var grandRows = [];
  perAcctRows.forEach(function (rows) {
    rows.forEach(function (r) { grandRows.push(r); });
  });
  renderSummaryCards(st, grandRows, dtrades, visibleAccounts.length);
  // Paged cards, global totals: only the current page renders, while hero,
  // summary and counts always cover every visible account.
  var rowsById = {};
  visibleAccounts.forEach(function (acc, vi) { rowsById[acc.id] = perAcctRows[vi]; });
  var pageCount = Math.max(1, Math.ceil(visibleAccounts.length / ACCOUNT_PAGE_SIZE));
  if (accountPage > pageCount - 1) accountPage = pageCount - 1;
  if (accountPage < 0) accountPage = 0;
  var pageAccounts = visibleAccounts.slice(accountPage * ACCOUNT_PAGE_SIZE, accountPage * ACCOUNT_PAGE_SIZE + ACCOUNT_PAGE_SIZE);
  host.innerHTML = '';
  var landing = document.getElementById('landing');
  var hero = document.getElementById('hero');
  var overview = document.getElementById('overview');
  var fab = document.getElementById('fab-trade');
  var emptyState = !accounts.length;
  var noTrades = !emptyState && !(st.trades || []).length;
  if (landing) landing.hidden = !emptyState;
  var landingTicker = document.getElementById('landing-ticker-wrap');
  if (landingTicker) landingTicker.hidden = !emptyState;
  if (hero) hero.hidden = emptyState || noTrades;
  if (overview) overview.hidden = emptyState || noTrades;
  if (fab) fab.hidden = emptyState || noTrades;
  document.body.classList.toggle('is-empty', emptyState);
  document.body.classList.toggle('has-no-trades', noTrades);
  if (emptyState) {
    wireLanding();
    return;
  }
  if (noTrades) {
    host.appendChild(buildGuidePanel());
  }
  var headRow = document.createElement('div');
  headRow.className = 'section-head';
  var h2 = document.createElement('h2');
  h2.textContent = 'Accounts';
  h2.className = 'section-title';
  headRow.appendChild(h2);
  var actions = document.createElement('div');
  actions.className = 'section-actions';
  var tickers = accountTickers(accounts);
  var effective = filter === null ? tickers : filter;
  var nSel = selectedCount();
  if (selectionMode) {
    var countEl = document.createElement('span');
    countEl.className = 'muted select-count';
    countEl.setAttribute('data-select-count', '1');
    countEl.textContent = nSel + ' selected';
    countEl.hidden = nSel === 0;
    actions.appendChild(countEl);
    actions.appendChild(buildAccountAction());
  }
  var selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'ghost' + (selectionMode ? ' select-on' : '');
  selectBtn.setAttribute('data-select-btn', '1');
  selectBtn.textContent = 'Select';
  selectBtn.setAttribute('aria-label', 'Select accounts');
  selectBtn.setAttribute('aria-pressed', selectionMode ? 'true' : 'false');
  selectBtn.addEventListener('click', function () {
    if (selectionMode) cancelSelection();
    else { selectionMode = true; render(); }
  });
  actions.appendChild(selectBtn);
  actions.appendChild(buildAccountFilter(st, tickers, effective));
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ghost';
  addBtn.textContent = '+ Account';
  addBtn.setAttribute('aria-label', 'Create account');
  addBtn.addEventListener('click', function () { openAccountDialog(); });
  actions.appendChild(addBtn);
  headRow.appendChild(actions);
  host.appendChild(headRow);
  if (!visibleAccounts.length) {
    if (hero) hero.hidden = true;
    if (overview) overview.hidden = true;
    if (fab) fab.hidden = true;
    var noneNote = document.createElement('p');
    noneNote.className = 'muted';
    noneNote.textContent = 'No accounts match this filter — pick assets in Filter above.';
    host.appendChild(noneNote);
    restoreAccountFilterFocus();
    return;
  }
  pageAccounts.forEach(function (acc) {
    host.appendChild(accountCardEl(st, acc, rowsById[acc.id] || [], dtrades, main, true, [acc.id].concat(groupMembers(st, acc.id).map(function (m) { return m.id; }))));
  });
  if (pageCount > 1) host.appendChild(buildAccountPager(pageCount));
  restoreAccountFilterFocus();
}

function buildAccountPager(pageCount) {
  var pager = document.createElement('div');
  pager.className = 'pager';
  pager.setAttribute('role', 'navigation');
  pager.setAttribute('aria-label', 'Account pages');
  function pgBtn(label, attrs, disabled, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost page-btn';
    b.textContent = label;
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) b.setAttribute(k, attrs[k]);
    }
    if (disabled) b.disabled = true;
    b.addEventListener('click', fn);
    return b;
  }
  pager.appendChild(pgBtn('‹ Prev', { 'data-page-prev': '1', 'aria-label': 'Previous account page' }, accountPage <= 0, function () {
    if (accountPage > 0) { accountPage--; render(); }
  }));
  // Sliding window: at most 6 page numbers at once (1–6, then 2–7, …).
  var PAGER_WINDOW = 6;
  var winStart = 0;
  if (pageCount > PAGER_WINDOW) {
    winStart = accountPage - 4;
    if (winStart < 0) winStart = 0;
    if (winStart > pageCount - PAGER_WINDOW) winStart = pageCount - PAGER_WINDOW;
  }
  for (var i = winStart; i < Math.min(winStart + PAGER_WINDOW, pageCount); i++) {
    (function (p) {
      var nb = pgBtn(String(p + 1), { 'data-page-goto': String(p), 'aria-label': 'Go to account page ' + (p + 1) }, false, function () {
        if (accountPage !== p) { accountPage = p; render(); }
      });
      if (p === accountPage) nb.setAttribute('aria-current', 'page');
      pager.appendChild(nb);
    })(i);
  }
  pager.appendChild(pgBtn('Next ›', { 'data-page-next': '1', 'aria-label': 'Next account page' }, accountPage >= pageCount - 1, function () {
    if (accountPage < pageCount - 1) { accountPage++; render(); }
  }));
  return pager;
}

function buildTradePager(accountId, total, pageCount, page) {
  var pager = document.createElement('div');
  pager.className = 'pager trade-pager';
  pager.setAttribute('role', 'navigation');
  pager.setAttribute('aria-label', 'Trade pages');
  function pgBtn(label, attrs, disabled, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost page-btn';
    b.textContent = label;
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) b.setAttribute(k, attrs[k]);
    }
    if (disabled) b.disabled = true;
    b.addEventListener('click', fn);
    return b;
  }
  function go(p) {
    tradePageSetFor(accountId, p, total);
    render();
    try {
      var bar = document.querySelector('#account-detail .trade-bottom-bar');
      if (bar && bar.scrollIntoView) bar.scrollIntoView({ block: 'nearest' });
    } catch (e) { /* ignore */ }
  }
  pager.appendChild(pgBtn('‹ Prev', { 'data-tpage-prev': '1', 'aria-label': 'Previous trade page' }, page <= 0, function () {
    if (page > 0) go(page - 1);
  }));
  // Sliding window like the account pager: at most 6 numbers at once.
  var PAGER_WINDOW = 6;
  var winStart = 0;
  if (pageCount > PAGER_WINDOW) {
    winStart = page - 4;
    if (winStart < 0) winStart = 0;
    if (winStart > pageCount - PAGER_WINDOW) winStart = pageCount - PAGER_WINDOW;
  }
  for (var i = winStart; i < Math.min(winStart + PAGER_WINDOW, pageCount); i++) {
    (function (p) {
      var nb = pgBtn(String(p + 1), { 'data-tpage-goto': String(p), 'aria-label': 'Go to trade page ' + (p + 1) }, false, function () {
        if (tradePageGet(accountId, total) !== p) go(p);
      });
      if (p === page) nb.setAttribute('aria-current', 'page');
      pager.appendChild(nb);
    })(i);
  }
  pager.appendChild(pgBtn('Next ›', { 'data-tpage-next': '1', 'aria-label': 'Next trade page' }, page >= pageCount - 1, function () {
    if (page < pageCount - 1) go(page + 1);
  }));
  return pager;
}

function startInlineRename(accId, headEl, nameEl) {
  var st = loadState();
  var acc = accountById(st, accId);
  if (!acc || !headEl || !nameEl) return;
  if (headEl.querySelector('[data-rename-input]')) return;
  var input = document.createElement('input');
  input.setAttribute('data-rename-input', '1');
  input.value = acc.name;
  input.setAttribute('aria-label', 'New name for ' + acc.name);
  headEl.insertBefore(input, nameEl);
  headEl.removeChild(nameEl);
  try { input.focus(); input.select(); } catch (e) { /* ignore */ }
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    renameAccount(accId, input.value);
  }
  function cancel() {
    if (done) return;
    done = true;
    render();
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

function startInlineLabelEdit(accId) {
  var st = loadState();
  var acc = accountById(st, accId);
  if (!acc) return;
  var host = document.getElementById('account-detail');
  if (!host || !host.querySelector) return;
  var block = host.querySelector('.detail-meta-block');
  var headEl = host.querySelector('.detail-head');
  if (!block && headEl) {
    block = document.createElement('div');
    block.className = 'detail-meta-block';
    headEl.appendChild(block);
  }
  if (!block || block.querySelector('[data-label-input]')) return;
  block.innerHTML = '';
  var input = document.createElement('textarea');
  input.setAttribute('data-label-input', '1');
  input.value = acc.address || '';
  input.setAttribute('aria-label', 'Label for ' + acc.name);
  input.setAttribute('maxlength', '128');
  input.setAttribute('rows', '3');
  input.setAttribute('placeholder', accountKindExample(acc.kind, 'label'));
  input.setAttribute('autocomplete', 'off');
  var row = document.createElement('div');
  row.className = 'label-edit-row';
  var save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Save';
  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  row.appendChild(save);
  row.appendChild(cancelBtn);
  block.appendChild(input);
  block.appendChild(row);
  try { input.focus(); input.select(); } catch (e) { /* ignore */ }
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    var s2 = loadState();
    var a2 = accountById(s2, accId);
    if (!a2) return;
    var v = String(input.value === undefined || input.value === null ? '' : input.value).trim().slice(0, 128);
    if (v) a2.address = v;
    else {
      try {
        delete a2.address;
      } catch (e) {
        a2.address = undefined;
      }
    }
    if (!saveStateGuarded(s2)) { done = false; return; }
    clearBanner();
    render();
  }
  function cancelFn() {
    if (done) return;
    done = true;
    render();
  }
  save.addEventListener('click', commit);
  // Mousedown first: keep focus so blur-commit doesn't fire before Cancel.
  cancelBtn.addEventListener('mousedown', function (e) { if (e && e.preventDefault) e.preventDefault(); });
  cancelBtn.addEventListener('click', cancelFn);
  input.addEventListener('keydown', function (e) {
    // Plain Enter inserts a newline (multi-line label); Ctrl/Cmd+Enter saves.
    if ((e.key === 'Enter') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') cancelFn();
  });
  input.addEventListener('blur', commit);
}

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
function currentRouteId() {
  try {
    var p = String((typeof location !== 'undefined' && location.pathname) || '');
    var m = /^\/account\/([^\/?#]+)/.exec(p);
    if (m) return decodeURIComponent(m[1]);
  } catch (e) { /* fall through to hash */ }
  return accountDetailIdHash();
}

function accountDetailIdHash() {
  var h = String((typeof location !== 'undefined' && location.hash) || '');
  var hm = /^#\/account\/([^\/?#]+)/.exec(h);
  return hm ? decodeURIComponent(hm[1]) : null;
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

// --- Stacked facts (minimalist detail layout) ---
// One fact per row: muted label left, tabular value right. Values carry
// data-label (stable test hook) and data-value when known; P&L figures
// tint gain/loss. The FX conversion always gets its own line so amounts
// never run into their provenance.

function statRow(label, text, raw, tint) {  var d = document.createElement('div');
  d.className = 'stat-row';
  d.setAttribute('data-label', label);
  var l = document.createElement('span');
  l.className = 'stat-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'stat-val num';
  v.textContent = text;
  if (raw !== null && raw !== undefined && isFinite(Number(raw))) {
    d.setAttribute('data-value', String(Number(raw)));
    if (tint) {
      var sc = plClass(raw);
      if (sc) v.classList.add(sc);
    }
  }
  d.appendChild(l);
  d.appendChild(v);
  return d;
}

function sectionTitle(text) {
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = text;
  return h;
}

function fmtFeeAmount(t) {
  var f = Number(t.fee);
  if (!(isFinite(f) && f > 0)) return '—';
  // One fiat per trade: the fee is always denominated in the trade currency.
  var code = String(t.currency || '').toUpperCase();
  var fiatCodes = ['EUR', 'USD', 'GBP', 'CHF', 'RON', 'USDC', 'USDT', 'DAI', 'JPY', 'CAD', 'AUD'];
  if (fiatCodes.indexOf(code) !== -1 || /^[A-Z]{3}$/.test(code)) {
    // fiat-like: money; crypto-like fee (BTC/ETH) would be caught below? Keep money for 3-letter fiat, qty otherwise.
    if (['EUR', 'USD', 'GBP', 'CHF', 'RON', 'JPY', 'CAD', 'AUD'].indexOf(code) !== -1) {
      try { return moneyFmt(code).format(f); } catch (e) { return fmtQty(f, code) + ' ' + code; }
    }
  }
  return fmtQty(f, code) + ' ' + code;
}

function tradeTypeMeta(type) {
  if (type === 'sell') return { label: 'Sell', cls: 'side-sell' };
  if (type === 'transfer') return { label: 'Transfer', cls: 'side-transfer' };
  if (type === 'income') return { label: 'Income', cls: 'side-income' };
  if (type === 'expense') return { label: 'Expense', cls: 'side-expense' };
  return { label: 'Buy', cls: 'side-buy' };
}

// "Now worth" fun-fact pill (display-only): what this record's qty would be
// worth today at the live price in the current main fiat. Pure math, never
// stored, never read by the ledger — P&L/tax cannot see it. Unknown live
// prices stay null (never 0: that would fabricate a -100% loss).
function tradeNowValue(qty, livePrice) {
  var q = Number(qty);
  var p = Number(livePrice);
  if (!isFinite(q) || q <= 0 || !isFinite(p) || p <= 0) return null;
  return q * p;
}

// Standard P&L percent: (now - then) / then * 100. Null when there is no
// cost basis to compare against (then <= 0) — the pill then shows money only.
function tradeNowPct(thenMain, nowMain) {
  var a = Number(thenMain);
  var b = Number(nowMain);
  if (!isFinite(a) || a <= 0 || !isFinite(b) || b < 0) return null;
  return ((b - a) / a) * 100;
}

// Resolve the pill model for one buy/sell record, or null when no pill
// should render (other types, bad qty, unknown live price). `t` is the
// display (converted) trade so `then` already sits in the current main.
function tradeNowMeta(t, main, livePrice) {
  if (!t || (t.type !== 'buy' && t.type !== 'sell')) return null;
  var q = Number(t.qty);
  if (!isFinite(q) || q <= 0) return null;
  var now = tradeNowValue(q, livePrice);
  if (now === null) return null;
  var then = null;
  try { then = normalizeTrade(t).netMain; } catch (e) { then = null; }
  then = Number(then);
  if (!isFinite(then) || then < 0) return null;
  var pct = tradeNowPct(then, now);
  var cls = 'trade-now-flat';
  // Cent-level epsilon: sub-cent drift (FX rounding) reads as flat.
  if (then <= 0) {
    cls = now > 0 ? 'trade-now-gain' : 'trade-now-flat';
  } else if (now - then > 0.005) {
    cls = 'trade-now-gain';
  } else if (then - now > 0.005) {
    cls = 'trade-now-loss';
  }
  return { now: now, then: then, pct: pct, cls: cls };
}

// Pill text: the signed change first (delta vs the record's own cost),
// then the labelled current value with its percent, e.g.
// "+€5.49 | Current €7.49 +200%". The sign carries the direction, so no
// increase/decrease word, and the current value meets the percent with a
// plain space (no · in this pill). The ▲/▼ arrow rides CSS ::before (like
// .pill.gain/.pill.loss), so the text carries no arrow.
// Flat or basis-free records read "Current €N" only.
function tradeNowText(now, main, pct, then) {
  var cur = 'Current ' + fmtMoney(now, main);
  var p = Number(pct);
  if (pct === null || pct === undefined || !isFinite(p)) return cur;
  if (Math.abs(p) < 0.005) return cur;
  var delta = Number(now) - Number(then);
  var signedDelta = (delta > 0 ? '+' : '') + fmtMoney(delta, main);
  var signedPct = (p > 0 ? '+' : '') + fmtPct(p);
  return signedDelta + ' | ' + cur + ' ' + signedPct;
}

function openNoteDialog(text, title) {
  var p = document.getElementById('note-dialog-text');
  if (p) p.textContent = String(text === undefined || text === null ? '' : text);
  var h = document.getElementById('note-dialog-title');
  if (h) h.textContent = title || 'Note';
  openDialog('note-dialog');
}

// Invoice / receipt preview: inline for images + PDFs, with a download
// button. Builds its dialog once. When the blob is missing locally and
// sync holds a passphrase, it lazy-fetches the encrypted copy first;
// otherwise it says plainly where the file lives instead of doing nothing.
function openAttachmentPreview(meta) {
  if (!meta || !isValidAttachment(meta)) return;
  var dlg = document.getElementById('attach-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'attach-dialog';
    dlg.setAttribute('aria-labelledby', 'attach-dialog-title');
    dlg.innerHTML =
      '<div class="dialog-head"><h2 id="attach-dialog-title">Invoice / Receipt</h2>' +
      '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
      '<p id="attach-dialog-name" class="muted"></p>' +
      '<div id="attach-dialog-view"></div>' +
      '<p id="attach-dialog-msg" class="muted" hidden></p>' +
      '<div class="dialog-actions"><button type="button" id="attach-dialog-dl" class="primary" hidden>Download</button> ' +
      '<button type="button" data-close>Close</button></div>';
    document.body.appendChild(dlg);
    // Same wiring as every other dialog: backdrop clicks close via
    // [data-close], Esc restores focus and recomputes the background
    // freeze — without this the page scrolls under the preview (and the
    // lock could stick the other way if Esc bypassed the recount).
    try { wireDialog('attach-dialog'); } catch (e) { /* ignore */ }
    dlg.addEventListener('close', function () {
      try {
        var old = dlg.getAttribute('data-objurl');
        if (old) { (window.URL || window.webkitURL).revokeObjectURL(old); dlg.removeAttribute('data-objurl'); }
        var v = document.getElementById('attach-dialog-view'); if (v) v.innerHTML = '';
      } catch (e) { /* ignore */ }
    });
  }
  var nameEl = document.getElementById('attach-dialog-name');
  var viewEl = document.getElementById('attach-dialog-view');
  var msgEl = document.getElementById('attach-dialog-msg');
  var dlEl = document.getElementById('attach-dialog-dl');
  if (nameEl) nameEl.textContent = meta.name;
  if (msgEl) { msgEl.hidden = true; msgEl.textContent = ''; }
  if (viewEl) viewEl.innerHTML = '';
  if (dlEl) { dlEl.hidden = true; dlEl.onclick = null; }
  function showBlob(blob, label) {
    try {
      var urls = window.URL || window.webkitURL;
      var url = urls.createObjectURL(blob);
      dlg.setAttribute('data-objurl', url);
      var fname = (label && label.name) || meta.name;
      if (dlEl) {
        dlEl.hidden = false;
        dlEl.onclick = function () {
          try {
            var a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click();
            if (a.parentNode) a.parentNode.removeChild(a);
          } catch (e) { /* ignore */ }
        };
      }
      if (viewEl) {
        var mime = (label && label.mime) || meta.mime;
        if (String(mime).indexOf('image/') === 0) {
          var img = document.createElement('img');
          img.src = url; img.alt = meta.name;
          img.style.cssText = 'max-width:100%;border-radius:10px;border:1px solid var(--border)';
          viewEl.appendChild(img);
        } else {
          var emb = document.createElement('embed');
          emb.src = url; emb.type = 'application/pdf';
          emb.style.cssText = 'width:100%;height:60vh;border-radius:10px;border:1px solid var(--border)';
          viewEl.appendChild(emb);
        }
      }
    } catch (e) {
      if (msgEl) { msgEl.hidden = false; msgEl.textContent = 'Could not display the file on this device.'; }
    }
    openDialog('attach-dialog');
  }
  function showMissing(note) {
    if (msgEl) { msgEl.hidden = false; msgEl.textContent = note; }
    openDialog('attach-dialog');
  }
  attGet(meta.hash).then(function (rec) {
    if (rec && rec.blob) { showBlob(rec.blob, rec); return; }
    var cfg = null, pass = '';
    try {
      cfg = syncLoadConfig();
      pass = (cfg && cfg.passphrase) ? cfg.passphrase : '';
      if (!pass) {
        try {
          var pv = document.getElementById('sy-pass');
          if (pv && pv.value) pass = pv.value;
        } catch (e) { /* settings closed */ }
      }
    } catch (e) { cfg = null; }
    if (!cfg || !pass) { showMissing('File is not on this device — it was attached elsewhere. Open the original device, or enter the sync passphrase in Settings → Sync to fetch it.'); return; }
    if (msgEl) { msgEl.hidden = false; msgEl.textContent = 'Fetching encrypted copy…'; }
    openDialog('attach-dialog');
    syncPullAttachment(cfg, pass, meta).then(function (got) {
      if (msgEl) { msgEl.hidden = true; msgEl.textContent = ''; }
      showBlob(got.blob, got.meta);
    }, function () {
      showMissing('File is not on this device yet — sync has no copy either. Open the original device with sync on so it can upload, then retry here.');
    });
  });
}

// Resolve the reference Exec quote for a trade row: {price, ccy} or null.
// Precedence is deliberate: a fiat-tagged global override is explicit live
// intent and always convertible; a frozen per-trade quote carries its own
// known fiat and beats a legacy bare-number override (whose fiat is unknown
// — showing it raw in a foreign main would be a nominal lie); the legacy
// number still serves when nothing better exists; then async history.
// Cross-fiat values convert at the trade-date historical rate; when the rate
// is unavailable the value shows in its OWN fiat, never nominal in the
// display fiat. Never throws; P&L never reads this (display-only).
function resolveExecPrice(t, main, kind) {
  var m = String(main || '').toUpperCase();
  if (!t || typeof t !== 'object' || !m) return null;
  function converted(price, vs) {
    var p = Number(price);
    var from = String(vs || '').trim().toUpperCase();
    if (!isFinite(p) || p <= 0 || !/^[A-Z]{2,10}$/.test(from)) return null;
    if (from === m) return { price: p, ccy: m };
    var hr = null;
    try { hr = getCachedRate(t.date, from, m); } catch (e) { hr = null; }
    if (hr && isFinite(Number(hr.rate)) && Number(hr.rate) > 0) {
      return { price: p * Number(hr.rate), ccy: m };
    }
    return { price: p, ccy: from };
  }
  var oe = null;
  try { oe = priceOverrideEntry(t.symbol); } catch (e) { oe = null; }
  if (oe !== null && oe.vs) return converted(oe.price, oe.vs);
  var fr = null;
  try { fr = frozenExecOf(t); } catch (e) { fr = null; }
  if (fr) return converted(fr.price, fr.vs);
  if (oe !== null) {
    var lp = Number(oe.price);
    if (isFinite(lp) && lp > 0) return { price: lp, ccy: m }; // legacy bare: old nominal behavior
    return null;
  }
  var hi = null;
  try { hi = getHistoricalExec(t.symbol, t.date, main, kind); } catch (e) { hi = null; }
  if (hi && isFinite(Number(hi.price)) && Number(hi.price) > 0) return { price: Number(hi.price), ccy: m };
  return null;
}

// Ledger inputs ride records that can carry a code: cash income/expense
// always (required at submit); transfers on every kind (a move posts -sent
// on the source and +received on the arrival under the same code, so groups
// net to the fee); every other asset type while the global switch is on
// (optional). Swaps move value through generated sell/buy legs — label the
// legs afterwards via record edit instead.
function tradeLedgerAllowed(isCashAcc, side) {
  if (side === 'swap') return false;
  if (side === 'transfer') {
    if (isCashAcc) return true;
    try { return assetLedgersOn(loadState()); } catch (e) { return true; }
  }
  if (isCashAcc) return side === 'income' || side === 'expense';
  try { return assetLedgersOn(loadState()); } catch (e) { return true; }
}

// Plain-language fee economics for transfer cards: what the fee was worth
// at move time vs what the books record (original cost). Numbers come from
// the record itself; nothing here touches P&L.
function openFeeExplainer(t, main, feeQty, rate) {
  var sym = String((t && t.symbol) || '').toUpperCase();
  var fq = Number(feeQty);
  var worth = (rate !== null && isFinite(fq) && fq > 0)
    ? fmtMoney(fq * rate.price, rate.ccy) : null;
  var rateTxt = (rate !== null)
    ? fmtMoney(rate.price, rate.ccy) + ' / ' + sym : null;
  var entry = 0;
  try {
    var st = loadState();
    var dtr = convertTrades(st.trades || [], main);
    var eng = computeAverage(dtr);
    var pos = eng.get(sym) || eng.get(String((t && t.symbol) || ''));
    if (pos && isFinite(Number(pos.avgEntry)) && Number(pos.avgEntry) > 0) entry = Number(pos.avgEntry);
  } catch (e) { entry = 0; }
  var lines = [];
  if (worth !== null && rateTxt !== null) {
    lines.push('Worth ' + worth + ' at the transfer-day price (' + rateTxt + ').');
  } else {
    lines.push('No rate known yet for this move — tap Fee in fiat rate to retry the lookup.');
  }
  if (worth !== null && entry > 0) {
    lines.push('Books record its ' + fmtMoney(fq * entry, main) + ' cost (your ' + fmtMoney(entry, main) + ' average entry) as the realized loss.');
    lines.push('The difference is the market move while you held — not an error.');
  } else if (worth !== null) {
    lines.push('Books record what those coins cost you when bought — not this market value.');
  }
  openNoteDialog(lines.join('\n'), 'Transfer fees');
}

// Discoverability for tap-for-info rows: an ⓘ badge on the label that
// opens the same popup as the value. Pass the value element when the popup
// only exists on overflow — syncInfoDots then hides decorative dots whose
// value fits. Omit it when the tap always opens something (Transfer fees).
function infoDot(labelEl, openFn, valueEl) {
  if (!labelEl || typeof openFn !== 'function') return;
  var dot = document.createElement('span');
  // Overflow-gated dots (a measured value was passed) start hidden and only
  // ever appear via the sync pass — any rebuild path that skips the sync
  // then defaults to no dot instead of flashing one. Always-on dots (no
  // value: the tap always opens something) keep the plain class.
  dot.className = valueEl ? 'info-dot info-dot-gated' : 'info-dot';
  dot.textContent = 'ⓘ';
  dot.setAttribute('aria-hidden', 'true');
  labelEl.appendChild(dot);
  try { labelEl.style.cursor = 'pointer'; } catch (e) { /* ignore */ }
  labelEl.addEventListener('click', function () { try { openFn(); } catch (e) { /* ignore */ } });
  if (valueEl) {
    try { valueEl.setAttribute('data-info-cond', '1'); } catch (e) { /* ignore */ }
  }
}

// Overflow-gated dots mean something only when the value is actually
// truncated: hide the decorative ones after layout settles. The pointer
// follows the same truth — text cursor for fitting text, hand only where
// a tap does something. Runs on every paint and on resize (truncation
// follows width). The 2px floor swallows subpixel rounding so near-fitting
// labels never flap their dot across paints, refreshes or resizes.
function syncInfoDots() {
  try {
    var vals = document.querySelectorAll('.stat-val[data-info-cond], .detail-meta-val[data-info-cond], .ledger-label-text[data-info-cond]');
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      var box = null;
      try { box = v.closest ? v.closest('.stat-row, .detail-meta') : null; } catch (e) { box = null; }
      if (!box) continue;
      var dot = box.querySelector('.info-dot');
      var lab = null;
      try { lab = box.querySelector('.stat-label, .detail-meta-label'); } catch (e) { lab = null; }
      var overflowing = false;
      try { overflowing = v.scrollWidth > v.clientWidth + 2; } catch (e) { overflowing = false; }
      if (dot) dot.style.display = overflowing ? 'inline' : 'none';
      try { v.style.cursor = overflowing ? 'pointer' : ''; } catch (e) { /* ignore */ }
      if (lab) {
        try { lab.style.cursor = overflowing ? 'pointer' : ''; } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
}

function rateRow(label, text) {
  var rate = document.createElement('div');
  rate.className = 'stat-row rate-line';
  rate.setAttribute('data-label', label);
  var rl = document.createElement('span');
  rl.className = 'stat-label';
  rl.textContent = label;
  var rv = document.createElement('span');
  rv.className = 'stat-val muted';
  rv.textContent = text;
  // The ⓘ badge (and the "show full" affordance) exists only when a popup
  // is possible at all: a '—' placeholder can never overflow, so wiring it
  // would leave a badge that opens nothing. Real values stay runtime-gated
  // (badge shows only while the text is actually truncated).
  var hasContent = String(text === undefined || text === null ? '' : text).trim() !== '' &&
    String(text).trim() !== '—';
  function openRate() {
    // Popup only when the text actually overflows the row.
    if (rv.scrollWidth <= rv.clientWidth + 2) return;
    openNoteDialog(text, label);
  }
  if (hasContent) {
    rv.setAttribute('role', 'button');
    rv.setAttribute('tabindex', '0');
    rv.setAttribute('aria-label', 'Show full rate');
    rv.addEventListener('click', openRate);
    rv.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openRate();
      }
    });
    infoDot(rl, openRate, rv);
  }
  rate.appendChild(rl);
  rate.appendChild(rv);
  return rate;
}

// ————— Phone-collapsed record cards —————
// Phones (≤720px) show every record as pills + actions + the two key numbers
// (the .is-primary rows); the stylesheet hides the rest until a tap drops
// them down. Expanded ids live here so a re-render — live prices landing, FX
// fills, paging, filtering — never slams an open card shut under the reader.
// Keyed by trade id; legacy id-less records simply opt out.
var openTradeCards = {};

// Flip one card between collapsed (phone default) and expanded. Runs at any
// width; the stylesheet only hides rows inside the phone breakpoint, so a
// desktop toggle stays invisible. Re-gates the ⓘ dots too: rows that were
// display:none just became measurable (and vice versa).
function setTradeCardOpen(box, open) {
  if (!box) return;
  var id = '';
  try { id = String(box.getAttribute('data-trade') || ''); } catch (e) { id = ''; }
  if (open) {
    try { box.classList.add('is-open'); } catch (e) { /* ignore */ }
    if (id) openTradeCards[id] = true;
  } else {
    try { box.classList.remove('is-open'); } catch (e) { /* ignore */ }
    if (id) delete openTradeCards[id];
  }
  var btn = null;
  try { btn = box.querySelector('.trade-more'); } catch (e) { btn = null; }
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Hide record details' : 'Show all record details');
    btn.title = open ? 'Hide details' : 'Show all details';
  }
  try { syncInfoDots(); } catch (e) { /* the ⓘ gate never breaks a tap */ }
}

function tradeBlock(t, main, accountNameById, kind, fifoCtx) {
  var n = normalizeTrade(t);
  // The two key numbers per type stay visible on a collapsed phone card
  // (buy/sell: Paid + Amount; transfer: Moved + Received; income: Received +
  // Value; expense: Lost + Fiat lost). Everything else drops down on a tap.
  function primary(row) {
    try { row.classList.add('is-primary'); } catch (e) { /* ignore */ }
    return row;
  }
  // The Converted row only earns its place when there is something to
  // convert: same-fiat views would just print the native number twice.
  var tCcy = String(t.currency || '').toUpperCase();
  var showConverted = tCcy === '' || tCcy !== String(main || '').toUpperCase();
  var box = document.createElement('article');
  box.className = 'trade-block';
  box.setAttribute('data-trade', t.id || '');
  var head = document.createElement('div');
  head.className = 'trade-head';
  var meta = tradeTypeMeta(t.type);
  var side = document.createElement('span');
  side.className = 'side ' + meta.cls;
  side.textContent = meta.label;
  var when = document.createElement('span');
  when.className = 'trade-when muted';
  when.textContent = fmtDateDmy(t.date || '');
  head.appendChild(when);
  // Record ids matter for FIFO lot linkage, so the pill only shows in FIFO
  // mode — Average cards stay clean.
  if (fifoCtx) {
    var rid = document.createElement('span');
    rid.className = 'trade-id';
    rid.textContent = tradeDisplayId(t);
    rid.title = 'Record ' + tradeDisplayId(t);
    head.appendChild(rid);
  }
  head.appendChild(side);
  // "Now worth" fun-fact pill: qty × live price in the current main, with the
  // P&L percent vs the record's own historic cost. Buys and sells only;
  // display-only (never stored, never booked). Hidden while the live price
  // is unknown instead of printing a fictitious loss.
  if (t.type === 'buy' || t.type === 'sell') {
    var nowMeta = null;
    try {
      var nwSym = String(t.symbol || '').toUpperCase();
      var lvRaw = (typeof livePrices !== 'undefined' && livePrices) ? livePrices[nwSym] : null;
      nowMeta = tradeNowMeta(t, main, lvRaw);
    } catch (e) { nowMeta = null; }
    if (nowMeta) {
      var nowPill = document.createElement('span');
      nowPill.className = 'trade-now ' + nowMeta.cls;
      var nowTxt = '';
      try { nowTxt = tradeNowText(nowMeta.now, main, nowMeta.pct, nowMeta.then); } catch (e) { nowTxt = ''; }
      nowPill.textContent = nowTxt;
      nowPill.title = nowTxt;
      nowPill.setAttribute('aria-label', nowTxt);
      head.appendChild(nowPill);
    }
  }
  var whatTxt = '';
  if (t.type === 'transfer' && accountNameById) {
    try {
      var fn = accountNameById(t.accountId);
      var outsH = transferOutputsOf(t);
      if (outsH.length === 1 && isTransferOutputInternal(outsH[0])) {
        var tn = accountNameById(String(outsH[0].toAccountId).trim());
        if (fn || tn) whatTxt = (fn || '') + ' → ' + (tn || '');
      } else if (outsH.length === 1) {
        var lab0 = String(outsH[0].label || '').trim();
        if (fn || lab0) whatTxt = (fn || '') + ' → ' + lab0;
      } else if (outsH.length > 1) {
        if (fn) whatTxt = fn + ' → ' + outsH.length + ' recipients';
      } else if (t.toAccountId) {
        var tn2 = accountNameById(t.toAccountId);
        if (fn || tn2) whatTxt = (fn || '') + ' → ' + (tn2 || '');
      }
    } catch (e) { /* ignore */ }
  }
  if (t.swapId) whatTxt += (whatTxt ? ' · ' : '') + 'swap';
  if (whatTxt) {
    var what = document.createElement('span');
    what.className = 'trade-what';
    what.textContent = whatTxt;
    head.appendChild(what);
  }
  // Phone action cluster (▾ ✎ 🗑): the wrapper keeps the three together when
  // they wrap to the next line, so the ▾ can sit immediately left of ✎ without
  // ever leaving a lone trash behind. Desktop ignores the wrapper box
  // (display:contents) and hides the ▾, so its head layout is untouched.
  var actions = document.createElement('span');
  actions.className = 'trade-actions';
  var more = document.createElement('button');
  more.type = 'button';
  more.className = 'quiet trade-more';
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', 'Show all record details');
  more.title = 'Show all details';
  var caret = document.createElement('span');
  caret.className = 'trade-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';
  more.appendChild(caret);
  more.addEventListener('click', function () {
    if (!isMobileView()) return;
    setTradeCardOpen(box, !(box.classList && box.classList.contains('is-open')));
  });
  actions.appendChild(more);
  var edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'quiet trade-edit';
  edit.textContent = '✎';
  edit.setAttribute('data-edit', t.id || '');
  edit.setAttribute('aria-label', 'Edit record ' + String(t.symbol || '') + ' ' + fmtDateDmy(t.date || ''));
  edit.addEventListener('click', function () { openEditTrade(edit.getAttribute('data-edit')); });
  actions.appendChild(edit);
  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'quiet danger trade-del';
  del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  del.setAttribute('data-del', t.id || '');
  del.setAttribute('aria-label', 'Delete trade ' + String(t.symbol || '') + ' ' + fmtDateDmy(t.date || ''));
  del.addEventListener('click', function () { deleteTrade(del.getAttribute('data-del')); });
  actions.appendChild(del);
  head.appendChild(actions);
  box.appendChild(head);
  // Phone tap rules for the whole card surface: a collapsed card is one big
  // "show details" button — the first tap always drops the rows down, and the
  // capture phase suppresses an inner popup just for that tap, so expanding is
  // never a coin toss. Once expanded, every value/ⓘ/link keeps its normal
  // behavior and a tap on the head collapses again. ✎/🗑/links work in both
  // states: real controls are never swallowed.
  box.addEventListener('click', function (ev) {
    try {
      if (!isMobileView()) return;
      var tgt = ev ? ev.target : null;
      if (!tgt || !tgt.closest) return;
      if (tgt.closest('button, a, input, select, textarea, label, summary')) return;
      if (box.classList.contains('is-open')) {
        if (tgt.closest('.trade-facts, .lot-links')) return;
        setTradeCardOpen(box, false);
        return;
      }
      if (tgt.closest('.stat-row')) {
        ev.stopPropagation();
        if (ev.preventDefault) ev.preventDefault();
      }
      setTradeCardOpen(box, true);
    } catch (e) { /* a failed tap must never break the list */ }
  }, true);
  var isXfer = t.type === 'transfer';
  // Transfer fee valuation: the network fee in fiat at the frozen tx-date
  // rate. Resolved once here and reused by the Transfer fees (≈) and Fee Fiat
  // Rate rows; null (→ '—') when nothing is known, never a guess.
  var xferFee = 0;
  var xferRate = null;
  if (isXfer) {
    var nfRawX = (t.networkFee === undefined || t.networkFee === null) ? '' : String(t.networkFee).trim();
    xferFee = (nfRawX === '') ? 0 : Number(t.networkFee);
    if (!isFinite(xferFee) || xferFee < 0) xferFee = 0;
    try { xferRate = resolveExecPrice(t, main, kind); } catch (e) { xferRate = null; }
  }
  if (t.type === 'transfer') {
    var tSym = String(t.symbol || '').toUpperCase();
    var outsC = transferOutputsOf(t);
    box.appendChild(primary(statRow('Moved', fmtQty(t.qty, tSym) + ' ' + tSym, t.qty, false)));
    if (xferFee > 0) {
      var feeTxtT = fmtQty(t.networkFee, tSym) + ' ' + tSym;
      if (xferRate !== null) feeTxtT += ' (≈ ' + fmtMoney(xferFee * xferRate.price, xferRate.ccy) + ')';
      var feeRowT = statRow('Transfer fees', feeTxtT, t.networkFee, false);
      // Tap explains the two numbers in plain language (market worth vs
      // booked cost) — the card stays clean, the math stays one tap away.
      var feeValT = feeRowT.querySelector('.stat-val');
      var feeLabT = feeRowT.querySelector('.stat-label');
      if (feeValT) {
        feeValT.setAttribute('role', 'button');
        feeValT.setAttribute('tabindex', '0');
        feeValT.setAttribute('aria-label', 'Explain the transfer fee');
        feeValT.title = 'Tap to explain this fee';
        (function (tr, mn, fq, rt) {
          function open() { try { openFeeExplainer(tr, mn, fq, rt); } catch (e) { /* ignore */ } }
          feeValT.addEventListener('click', open);
          feeValT.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
          });
          infoDot(feeLabT, open);
        })(t, main, xferFee, xferRate);
      }
      box.appendChild(feeRowT);
      // Fee in fiat rate sits right after Transfer fees — it is the rate behind
      // the (≈) above, frozen at the tx date. Unknown: tap retries the
      // lookup on demand instead of waiting for the backoff.
      var feeRateTxt = (xferRate !== null)
        ? fmtMoney(xferRate.price, xferRate.ccy) + ' / ' + tSym
        : '—';
      var feeRateEl = rateRow('Fee in fiat rate', feeRateTxt);
      if (xferRate === null) {
        feeRateEl.title = feeRateWhy(t, kind);
        (function (el, id) {
          el.addEventListener('click', function () {
            try { retryFeeRate(id); } catch (e) { /* ignore */ }
          });
        })(feeRateEl, t.id);
      }
      box.appendChild(feeRateEl);
    }
    // One Received row for every arrival: the inline line trims with …
    // (capped like Note/Rate so a long recipient list can never push the
    // strip — or the card — off-screen) and the ⓘ/tap opens the full list.
    var recLines = [];
    var recTotal = 0;
    if (!outsC.length) {
      var netQ = Number(t.qty) - xferFee;
      recLines.push(fmtQty(netQ, tSym) + ' ' + tSym);
      recTotal = (isFinite(netQ) && netQ > 0) ? netQ : 0;
    } else {
      outsC.forEach(function (o) {
        if (isTransferOutputInternal(o)) {
          var nm = String(o.toAccountId).trim();
          try { if (accountNameById) nm = accountNameById(String(o.toAccountId).trim()) || nm; } catch (e) { /* ignore */ }
          var arr = transferRowArrival(o, t.symbol);
          var txt = fmtQty(arr, tSym) + ' ' + tSym + ' → ' + nm;
          var oFee = (o.fee !== undefined && o.fee !== null && String(o.fee).trim() !== '') ? Number(o.fee) : 0;
          if (isFinite(oFee) && oFee > 0) txt += ' · fee ' + fmtQty(o.fee, tSym);
          recLines.push(txt);
          if (isFinite(arr) && arr > 0) recTotal += arr;
        } else {
          var arr2 = Number(o.qty);
          var lab = String(o.label || '').trim();
          recLines.push(fmtQty(arr2, tSym) + ' ' + tSym + ' → ' + lab + ' (external)');
          if (isFinite(arr2) && arr2 > 0) recTotal += arr2;
        }
      });
    }
    var recRow = primary(statRow('Received', recLines.join(', '), recTotal, false));
    (function (row, lines) {
      var recVal = row.querySelector('.stat-val');
      var recLab = row.querySelector('.stat-label');
      function openRecips() {
        // Popup only when the text actually overflows the row.
        if (!recVal || recVal.scrollWidth <= recVal.clientWidth + 2) return;
        openNoteDialog(lines.join('\n'), 'Received');
      }
      if (recVal) {
        recVal.setAttribute('role', 'button');
        recVal.setAttribute('tabindex', '0');
        recVal.setAttribute('aria-label', 'Show all recipients');
        recVal.addEventListener('click', openRecips);
        recVal.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openRecips();
          }
        });
      }
      if (recLab) infoDot(recLab, openRecips, recVal);
    })(recRow, recLines);
    box.appendChild(recRow);
    if ((Number(t.total) > 0 || Number(t.fee) > 0)) {
      box.appendChild(statRow('Fiat cost', fmtMoney(n.netMain, main), n.netMain, false));
    }
  } else if (t.type === 'income') {
    box.appendChild(primary(statRow('Received', fmtQty(t.qty, t.symbol) + ' ' + String(t.symbol || '').toUpperCase(), t.qty, false)));
    if (Number(t.total) > 0) {
      box.appendChild(primary(statRow('Value', fmtMoney(t.total, String(t.currency || '').toUpperCase()), t.total, false)));
      if (showConverted) box.appendChild(statRow('Converted', fmtMoney(n.netMain, main), n.netMain, false));
    } else {
      box.appendChild(primary(statRow('Value', '— (free)', null, false)));
    }
  } else if (t.type === 'expense') {
    if (t.qty !== undefined && t.qty !== null && String(t.qty).trim() !== '') {
      box.appendChild(primary(statRow('Lost', fmtQty(t.qty, t.symbol) + ' ' + String(t.symbol || '').toUpperCase(), t.qty, false)));
    }
    if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '' && Number(t.total) > 0) {
      box.appendChild(primary(statRow('Fiat lost', fmtMoney(t.total, String(t.currency || '').toUpperCase()), t.total, false)));
      if (showConverted) box.appendChild(statRow('Converted', fmtMoney(n.netMain, main), n.netMain, false));
    }
  } else {
    box.appendChild(primary(statRow('Paid', fmtMoney(t.total, String(t.currency || '').toUpperCase()), t.total, false)));
    if (showConverted) box.appendChild(statRow('Converted', fmtMoney(n.netMain, main), n.netMain, false));
    // Real price is calculated, never quoted: the FULL all-in total converted
    // at the historical FX rate (or manual rate), divided by qty received —
    // e.g. 50 EUR / 0.00058193 BTC = 85920.99. Shown rounded half-up to 2
    // decimals; the books run on this exact value (== Average entry). Exec is
    // the reference-only market quote resolved by resolveExecPrice(); it never
    // touches P&L; "—" only when nothing is known (never 0, never a guess).
    var pq = Number(t.qty);
    if (isFinite(pq) && pq > 0 && n.netMain > 0) {
      var symU = String(t.symbol || '').toUpperCase();
      var realP = n.netMain / pq;
      var ex = null;
      try { ex = resolveExecPrice(t, main, kind); } catch (e) { ex = null; }
      if (ex !== null) {
        box.appendChild(statRow('Exec. price', fmtMoney(ex.price, ex.ccy) + ' / ' + symU, ex.price, false));
      } else {
        box.appendChild(statRow('Exec. price', '—', null, false));
      }
      box.appendChild(statRow('Real price', fmtMoney(realP, main) + ' / ' + symU, realP, false));
    }
  }
  // Same-asset moves have no FX: the meaningless '1:1 @ 1' Rate is gone for
  // transfers (Fee in fiat rate lives next to Transfer fees instead), and the
  // fiat Fee row is gone too — the network fee IS the fee.
  if (!isXfer) {
    box.appendChild(rateRow('Rate', fxBadgeText(t)));
  }
  if (!isXfer) {
  var feeRow = statRow('Fee', fmtFeeAmount(t), t.fee, false);
  box.appendChild(feeRow);
  }
  if (t.note) {
    var noteRow = statRow('Note', String(t.note), null, false);
    var noteVal = noteRow.querySelector('.stat-val');
    if (noteVal) {
      noteVal.classList.add('note-clamp');
      noteVal.setAttribute('role', 'button');
      noteVal.setAttribute('tabindex', '0');
      noteVal.setAttribute('aria-label', 'Show full note');
      noteVal.title = String(t.note);
      (function (val, txt) {
        function open() {
          // Popup only when the text actually overflows the row.
          if (val.scrollWidth <= val.clientWidth + 2) return;
          openNoteDialog(txt);
        }
        val.addEventListener('click', open);
        val.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        });
        infoDot(noteRow.querySelector('.stat-label'), open, val);
      })(noteVal, t.note);
    }
    box.appendChild(noteRow);
  }
  if (t.ledger && String(t.ledger).trim() !== '') {
    var ledTxt = String(t.ledger).trim();
    if (t.ledgerLabel && String(t.ledgerLabel).trim() !== '') ledTxt += ' · ' + String(t.ledgerLabel).trim();
    box.appendChild(statRow('Ledger', ledTxt, null, false));
  }
  if (t.txid && isValidTxid(t.txid)) {
    var txFull = String(t.txid).trim();
    var txRow = document.createElement('div');
    txRow.className = 'stat-row';
    txRow.setAttribute('data-label', 'Tx');
    var txL = document.createElement('span');
    txL.className = 'stat-label';
    txL.textContent = 'Tx';
    var txV = document.createElement('span');
    txV.className = 'stat-val num';
    var txA = document.createElement('a');
    txA.className = 'tx-link';
    txA.href = txExplorerUrl(txFull);
    txA.target = '_blank';
    txA.rel = 'noopener';
    txA.textContent = shortTxid(txFull);
    txA.title = txFull;
    txV.appendChild(txA);
    txRow.appendChild(txL);
    txRow.appendChild(txV);
    box.appendChild(txRow);
  }
  if (t.attachment && isValidAttachment(t.attachment)) {
    (function (meta) {
      var atRow = document.createElement('div');
      atRow.className = 'stat-row';
      atRow.setAttribute('data-label', 'Invoice / Receipt');
      var atL = document.createElement('span');
      atL.className = 'stat-label';
      atL.textContent = 'Invoice / Receipt';
      var atV = document.createElement('span');
      atV.className = 'stat-val num';
      var atA = document.createElement('a');
      atA.className = 'tx-link';
      atA.href = '#';
      atA.textContent = String(meta.name).length > 24 ? String(meta.name).slice(0, 23) + '…' : String(meta.name);
      atA.title = String(meta.name) + ' (' + String(meta.mime) + ') — click to preview';
      atA.addEventListener('click', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        try { openAttachmentPreview(meta); } catch (e) { showBanner('Could not open the file on this device.'); }
      });
      atV.appendChild(atA);
      atRow.appendChild(atL);
      atRow.appendChild(atV);
      box.appendChild(atRow);
    })(t.attachment);
  }
  if (t.type === 'buy' || t.type === 'sell') {
    box.appendChild(primary(statRow('Amount', fmtQty(t.qty, t.symbol) + ' ' + String(t.symbol || '').toUpperCase(), t.qty, false)));
  }
  // One true facts line: gather every fact row into a non-wrapping strip so
  // nothing ever spills to a second row — long values trim with … instead
  // (Rate/Note are capped; the popup still opens the full text on click).
  var facts = document.createElement('div');
  facts.className = 'trade-facts';
  Array.prototype.forEach.call(box.querySelectorAll(':scope > .stat-row'), function (r) { facts.appendChild(r); });
  box.appendChild(facts);
  // A card opened before a re-render opens again in the fresh DOM (after the
  // strip exists, so the caret and the ⓘ gate pick up the open state).
  if (t.id && openTradeCards[String(t.id)]) setTradeCardOpen(box, true);
  // FIFO lot linkage: slices of this record closed elsewhere (buys/income)
  // or slices closed by this record (sells). Average pools cost, so there is
  // nothing truthful to link — fifoCtx is null outside FIFO mode.
  if (fifoCtx && t && typeof t.id === 'string' && t.id !== '') {
    if (t.type === 'buy' || t.type === 'income') {
      var buySlices = (fifoCtx.links.byBuy[t.id] || []);
      if (buySlices.length) box.appendChild(soldBlock(t, buySlices, fifoCtx));
    } else if (t.type === 'sell') {
      var closeSlices = (fifoCtx.links.byClose[t.id] || []);
      if (closeSlices.length) box.appendChild(closedBlock(t, closeSlices, fifoCtx));
    }
  }
  return box;
}

// Group closed FIFO lots by opening / closing trade id. Lots without an id
// on the relevant side (legacy id-less trades) keep their math but opt out
// of per-record linkage.
function fifoLinksFor(lots) {
  var byBuy = {};
  var byClose = {};
  (lots || []).forEach(function (l) {
    if (!l) return;
    if (l.buyId) (byBuy[l.buyId] = byBuy[l.buyId] || []).push(l);
    if (l.sellId) (byClose[l.sellId] = byClose[l.sellId] || []).push(l);
  });
  return { byBuy: byBuy, byClose: byClose };
}

function lotKindOf(l) {
  if (l && l.kind === 'expense') return 'expense';
  if (l && l.kind === 'network-fee') return 'network-fee';
  return 'sell';
}

// Human reference to a linked record: code + date + type. Falls back to the
// lot's own dates when the trade itself is out of view (another page) or
// gone — the code still identifies it.
function lotRefText(other, otherId, fallbackDate) {
  var code = tradeDisplayId(other && other.id ? other : otherId);
  var date = (other && other.date) || fallbackDate || '';
  var type = (other && other.type) ? String(other.type).toLowerCase() : 'record';
  return code + ' · ' + fmtDateDmy(date) + ' ' + type;
}

function lotLink(l, targetId, fallbackDate, ctx, sym, verb) {
  var ref = (targetId && ctx.byId[targetId]) || null;
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'lot-link';
  if (targetId) b.setAttribute('data-goto', targetId);
  var code = tradeDisplayId(ref && ref.id ? ref : targetId);
  b.setAttribute('aria-label', 'Show linked record ' + code);
  b.title = 'Show linked record ' + code;
  // Ellipsis lives on an inner block span: text-overflow directly on a
  // <button> paints the ellipsis over the text (sliced/duplicated glyphs)
  // instead of clipping it in some browsers.
  var span = document.createElement('span');
  span.className = 'lot-link-text';
  span.textContent = fmtQty(l.qty, sym) + ' ' + sym + ' ' + verb + ' ' + lotRefText(ref, targetId, fallbackDate) +
    ' (' + fmtMoney(l.gain, ctx.main) + ')';
  b.appendChild(span);
  b.addEventListener('click', function () { ctx.go(targetId); });
  return b;
}

// Buy/income card: which later records consumed this buy, and whether it is
// fully closed. Fee/expense slices get their own verbs so partial states
// always reconcile with the engine.
function soldBlock(t, slices, ctx) {
  var sym = String(t.symbol || '').toUpperCase();
  var bought = Number(t.qty);
  var closed = 0;
  var hasSell = false;
  var i;
  for (i = 0; i < slices.length; i++) {
    closed += Number(slices[i].qty) || 0;
    if (lotKindOf(slices[i]) === 'sell') hasSell = true;
  }
  var full = isFinite(bought) && bought > 0 && closed >= bought - 1e-9;
  var scope = (isFinite(bought) && bought > 0)
    ? fmtQty(closed, sym) + ' of ' + fmtQty(bought, sym) + ' ' + sym
    : fmtQty(closed, sym) + ' ' + sym;
  var wrap = document.createElement('div');
  wrap.className = 'lot-links';
  wrap.setAttribute('data-lot-links', 'sold');
  var head = document.createElement('div');
  head.className = 'lot-links-head';
  head.textContent = hasSell
    ? (full ? 'Sold · in full' : 'Sold · partially (' + scope + ')')
    : (full ? 'Consumed · in full' : 'Consumed · partially (' + scope + ')');
  wrap.appendChild(head);
  // More than five lines scroll inside the list: plain block layout, whole
  // pixels and an isolated layer keep text rasterization stable where fancier
  // containers tore glyphs.
  var list = document.createElement('div');
  list.className = 'lot-link-list';
  wrap.appendChild(list);
  slices.forEach(function (l) {
    var kind = lotKindOf(l);
    var verb = kind === 'sell' ? 'sold in' : (kind === 'expense' ? 'lost to expense in' : 'fee in');
    list.appendChild(lotLink(l, l.sellId, l.closeDate, ctx, sym, verb));
  });
  return wrap;
}

// Sell card: which earlier buys this sale ate, oldest first.
function closedBlock(t, slices, ctx) {
  var sym = String(t.symbol || '').toUpperCase();
  var wrap = document.createElement('div');
  wrap.className = 'lot-links';
  wrap.setAttribute('data-lot-links', 'closed');
  var head = document.createElement('div');
  head.className = 'lot-links-head';
  head.textContent = 'Closed from';
  wrap.appendChild(head);
  // Same five-line cap as the Sold block (see soldBlock).
  var list = document.createElement('div');
  list.className = 'lot-link-list';
  wrap.appendChild(list);
  slices.forEach(function (l) {
    var ref = (l.buyId && ctx.byId[l.buyId]) || null;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'lot-link';
    if (l.buyId) b.setAttribute('data-goto', l.buyId);
    var code = tradeDisplayId(ref && ref.id ? ref : l.buyId);
    b.setAttribute('aria-label', 'Show linked record ' + code);
    b.title = 'Show linked record ' + code;
    // Inner span carries the ellipsis (see lotLink).
    var span = document.createElement('span');
    span.className = 'lot-link-text';
    span.textContent = fmtQty(l.qty, sym) + ' ' + sym + ' ← ' + lotRefText(ref, l.buyId, l.openDate) +
      ' (' + fmtMoney(l.gain, ctx.main) + ')';
    b.appendChild(span);
    (function (id) {
      b.addEventListener('click', function () { ctx.go(id); });
    })(l.buyId);
    list.appendChild(b);
  });
  return wrap;
}

function detailMetaRow(label, text, title) {
  var d = document.createElement('div');
  d.className = 'detail-meta';
  d.setAttribute('data-label', label);
  // Account labels stack: caption on top, wrapped text underneath.
  if (String(label) === 'Label') d.classList.add('detail-meta-stacked');
  var l = document.createElement('span');
  l.className = 'detail-meta-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'detail-meta-val';
  // Account labels are multi-line by design: wrap them fully instead of
  // trimming to one line. Notes keep the trim + popup treatment.
  if (String(label) === 'Label') v.classList.add('detail-meta-multiline');
  v.textContent = String(text);
  v.title = String(text);
  v.setAttribute('role', 'button');
  v.setAttribute('tabindex', '0');
  v.setAttribute('aria-label', 'Show full ' + String(title).toLowerCase());
  function open() {
    if (v.scrollWidth <= v.clientWidth + 2) return;
    openNoteDialog(text, title);
  }
  v.addEventListener('click', open);
  v.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  // Wrapped rows (multi-line labels) show everything: no hidden info, no dot.
  if (!v.classList.contains('detail-meta-multiline')) infoDot(l, open, v);
  d.appendChild(l);
  d.appendChild(v);
  return d;
}

function ledgerRowEl(code, label, total, main, depth, opts) {
  var o = opts || {};
  var unlabeled = (code === '—');
  var d = document.createElement('div');
  d.className = 'stat-row ledger-row' + (o.isParent ? ' is-parent' : '') + (unlabeled ? ' is-unlabeled' : '');
  d.setAttribute('data-label', 'ledger');
  d.setAttribute('data-ledger', code);
  if (isFinite(Number(total))) d.setAttribute('data-value', String(Number(total)));
  try { d.style.paddingLeft = 'calc(0.6rem + ' + (depth * 1.9) + 'rem)'; } catch (e) { /* ignore */ }
  // Parents collapse to the top ledger only: the arrow hides the whole subtree.
  // Every row reserves the arrow slot (spacer when childless) so labels sit
  // on one x per depth and never jump when a ledger gains children later.
  // Virtual Unlabeled rows can never have children: no slot, label starts
  // at the very beginning of the row.
  if (o.hasKids) {
    var tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'quiet ledger-toggle';
    tog.textContent = o.collapsed ? '▸' : '▾';
    tog.setAttribute('data-ledger-toggle', code);
    tog.setAttribute('aria-expanded', o.collapsed ? 'false' : 'true');
    tog.setAttribute('aria-label', (o.collapsed ? 'Expand ledger ' : 'Collapse ledger ') + code);
    d.appendChild(tog);
  } else if (!unlabeled) {
    var sp = document.createElement('span');
    sp.className = 'ledger-toggle-sp';
    sp.setAttribute('aria-hidden', 'true');
    d.appendChild(sp);
  }
  // Fixed slots keep every amount at the same x: long names truncate with
  // ellipsis and an ⓘ popup (same pattern as record notes), never pushing.
  // Virtual Unlabeled rows join code and name with a plain space (no dot).
  var full = unlabeled ? (code + (label ? ' ' + label : '')) : (code + ((label && label !== code) ? ' · ' + label : ''));
  var l = document.createElement('span');
  l.className = 'stat-label ledger-label';
  var lt = document.createElement('span');
  lt.className = 'ledger-label-text';
  lt.textContent = full;
  l.appendChild(lt);
  function openFull() {
    if (lt.scrollWidth <= lt.clientWidth + 2) return;
    openNoteDialog(full, 'Ledger ' + code);
  }
  lt.setAttribute('role', 'button');
  lt.setAttribute('tabindex', '0');
  lt.setAttribute('aria-label', 'Show full ledger name');
  lt.addEventListener('click', openFull);
  lt.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFull(); }
  });
  infoDot(l, openFull, lt);
  d.appendChild(l);
  var side = document.createElement('span');
  side.className = 'ledger-side';
  var v = document.createElement('span');
  // Parent overviews carry a boxed total: income-tinted when the rolled sum
  // is positive, expense-tinted when negative (pill colors, not a pill).
  var boxCls = '';
  if (o.isParent) {
    var tv = Number(total);
    if (isFinite(tv) && tv > 0) boxCls = ' ledger-box-inc';
    else if (isFinite(tv) && tv < 0) boxCls = ' ledger-box-exp';
  }
  v.className = 'stat-val num ledger-amount' + boxCls + ' ' + (plClass(total) || '');
  v.textContent = fmtMoney(total, main);
  side.appendChild(v);
  // Structural rows can be removed from this account's chart (materializes
  // the account's own chart when it still follows the default).
  if (code !== '—') {
    var ed = document.createElement('button');
    ed.type = 'button';
    ed.className = 'quiet';
    ed.textContent = 'Edit';
    ed.setAttribute('data-ledger-edit', code);
    ed.setAttribute('aria-label', 'Edit ledger ' + code + ' in this account');
    side.appendChild(ed);
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'quiet';
    del.textContent = 'Delete';
    del.setAttribute('data-ledger-del', code);
    del.setAttribute('aria-label', 'Delete ledger ' + code + ' from this account');
    side.appendChild(del);
  } else {
    // Unlabeled rows carry no actions, but they must stand exactly as tall:
    // invisible same-box placeholders reserve the Edit/Delete height.
    ['Edit', 'Delete'].forEach(function (t) {
      var ph = document.createElement('button');
      ph.type = 'button';
      ph.className = 'quiet ledger-act-sp';
      ph.textContent = t;
      ph.disabled = true;
      ph.tabIndex = -1;
      ph.setAttribute('aria-hidden', 'true');
      side.appendChild(ph);
    });
  }
  d.appendChild(side);
  return d;
}

// One-line cleanup hint for overview-rule breakers. Never throws.
function appendLedgerWarn(host, viol) {
  try {
    if (!viol || !viol.length) return;
    var shown = viol.slice(0, 3).map(function (c) { return '"' + c + '"'; }).join(', ');
    var wn = document.createElement('p');
    wn.className = 'muted ledger-warn';
    wn.textContent = 'Heads-up: ' + shown + (viol.length > 3 ? ', …' : '') +
      (viol.length === 1 ? ' holds' : ' hold') + ' records and sub-ledgers — move ' +
      (viol.length === 1 ? 'its' : 'their') + ' records to a child so ' +
      (viol.length === 1 ? 'it stays' : 'they stay') + ' a pure total.';
    host.appendChild(wn);
  } catch (e) { /* hint never breaks render */ }
}

// Shared ledger list: tree rows (collapse per key) plus the Unlabeled
// buckets that exist. Edit/delete run on chartId across the whole scope
// (the main's chart for groups); toggles are view-only collapse state.
function appendLedgerList(host, tree, ccy, opts) {
  var o = opts || {};
  var key = o.key;
  var chartId = o.chartId;
  var scope = (o.scope && o.scope.length) ? o.scope : [chartId];
  var list = document.createElement('div');
  list.className = 'ledger-list';
  list.setAttribute('data-ledger-account', chartId);
  var collapsed = (key && ledgerCollapsed[key]) || {};
  (function walk(nodes, depth) {
    nodes.forEach(function (n) {
      var kids = (n.kids && n.kids.length) ? n.kids : [];
      var isCol = !!collapsed[n.code];
      list.appendChild(ledgerRowEl(n.code, n.label, n.total, ccy, depth, { hasKids: kids.length > 0, collapsed: isCol, isParent: kids.length > 0 }));
      if (kids.length && !isCol) walk(kids, depth + 1);
    });
  })(tree.roots, 0);
  if (tree.unassignedIncomeCount) list.appendChild(ledgerRowEl('—', 'Unlabeled income', tree.unassignedIncome, ccy, 0));
  if (tree.unassignedExpenseCount) list.appendChild(ledgerRowEl('—', 'Unlabeled expenses', tree.unassignedExpense, ccy, 0));
  if (tree.unassignedAssetsCount) list.appendChild(ledgerRowEl('—', 'Unlabeled assets', tree.unassignedAssets, ccy, 0));
  list.addEventListener('click', function (e) {
    if (!e || !e.target || !e.target.closest) return;
    var tog = e.target.closest('[data-ledger-toggle]');
    if (tog) {
      var tc = tog.getAttribute('data-ledger-toggle');
      var set = (key && ledgerCollapsed[key]) || (ledgerCollapsed[key] = {});
      if (set[tc]) delete set[tc]; else set[tc] = true;
      render();
      return;
    }
    var be = e.target.closest('[data-ledger-edit]');
    if (be) { openLedgerDialog(chartId, be.getAttribute('data-ledger-edit'), scope); return; }
    var btn = e.target.closest('[data-ledger-del]');
    if (!btn) return;
    deleteAccountLedger(chartId, btn.getAttribute('data-ledger-del'), scope);
  });
  host.appendChild(list);
  return list;
}

// Cash account detail: balance cards plus the bookkeeping ledger tree
// (prefix roll-up). No cost-basis cards, no spent/fees lines — the flows
// below plus the tree are the accounting view. opts.skipLedgers hides the
// Ledgers section (grouped members show it on their main instead).
function buildCashDetailStats(st, acc, dtrades, main, stats, host, opts) {
  stats.innerHTML = ''; // drop the cost-basis grid (built for assets above)
  var bal = cashBalance(dtrades, acc.id, main);
  stats.appendChild(statCard('Balance', fmtQty(bal.native, bal.ticker || acc.ticker) + ' ' + String(bal.ticker || acc.ticker || '').toUpperCase(), bal.native));
  stats.appendChild(statCard('Value', fmtMoney(bal.main, main), bal.main));
  // Two cards in a four-track box: center the pair (see cards-duo).
  stats.classList.add('cards-duo');
  host.appendChild(stats);
  if (opts && opts.skipLedgers) return;
  var labels = ledgerChartFor(st, acc.id);
  var tree = ledgerTree(dtrades, acc.id, main, labels);
  var sec = document.createElement('div');
  sec.className = 'section-head ledgers-head';
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = 'Ledgers';
  sec.appendChild(h);
  var ladd = document.createElement('button');
  ladd.type = 'button';
  ladd.className = 'ghost';
  ladd.textContent = '+ Ledger';
  ladd.setAttribute('aria-label', 'Add ledger to ' + acc.name);
  ladd.addEventListener('click', function () { openLedgerDialog(acc.id); });
  sec.appendChild(ladd);
  host.appendChild(sec);
  // Empty or not, a created chart always shows: tree.roots carries chart
  // codes with zero of their own, so an empty 1000 still renders its row.
  // Unlabeled buckets never render alone — without roots there is no table,
  // only the note below (never an Unlabeled-only table for no reason).
  if (!tree.roots.length) {
    var noneNote = document.createElement('p');
    noneNote.className = 'muted';
    noneNote.textContent = 'No ledgers yet — add a parent code like 1000, then post to subledgers.';
    host.appendChild(noneNote);
    return;
  }
  appendLedgerList(host, tree, main, { key: acc.id, chartId: acc.id, scope: [acc.id] });
  // Legacy cleanup hint: a parent that still holds records breaks the
  // overview rule — point at it once so it can be moved to a child.
  try { appendLedgerWarn(host, ledgerViolations(st, acc.id)); } catch (e) { /* ignore */ }
}

// Group mains: merged ledgers across the main + members, then home-style
// sub-account cards instead of the trade history.
function groupLedgerCurrency(st, mainAcc) {
  var g = mainAcc && typeof mainAcc.groupCurrency === 'string' ? mainAcc.groupCurrency.trim().toUpperCase() : '';
  if (MAIN_CURRENCIES.indexOf(g) !== -1) return g;
  return defaultGroupCurrency(st, mainAcc);
}

// Visibility gate: the Ledgers panel shows when there is something to
// show — a chart code or at least one in-scope record carrying a ledger
// code (income/expense/buy/sell plus labeled transfers, which also post
// tree rows). Unlabeled buckets alone never open the panel.
function groupHasLabels(allTrades, ids) {
  var set = {};
  (ids || []).forEach(function (id) { if (typeof id === 'string' && id !== '') set[id] = true; });
  return (allTrades || []).some(function (t) {
    if (!t || !set[t.accountId]) return false;
    if (t.type !== 'income' && t.type !== 'expense' && t.type !== 'buy' && t.type !== 'sell' && t.type !== 'transfer') return false;
    return String(t.ledger || '').trim() !== '';
  });
}

function buildGroupLedgers(st, mainAcc, members, host, dtrades, headerMain) {
  var ids = [mainAcc.id];
  members.forEach(function (m) { ids.push(m.id); });
  var gCcy = groupLedgerCurrency(st, mainAcc);
  var sec = document.createElement('div');
  sec.className = 'section-head ledgers-head';
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = 'Ledgers';
  sec.appendChild(h);
  var cur = document.createElement('select');
  cur.setAttribute('aria-label', 'Group ledger currency');
  MAIN_CURRENCIES.forEach(function (c) {
    var op = document.createElement('option');
    op.value = c;
    op.textContent = c;
    if (c === gCcy) op.selected = true;
    cur.appendChild(op);
  });
  cur.addEventListener('change', function () {
    var v = String(cur.value || '').toUpperCase();
    if (MAIN_CURRENCIES.indexOf(v) === -1) return;
    var s2 = loadState();
    var m2 = accountById(s2, mainAcc.id);
    if (!m2) return;
    m2.groupCurrency = v;
    if (!saveStateGuarded(s2)) return;
    clearBanner();
    render();
  });
  sec.appendChild(cur);
  var ladd = document.createElement('button');
  ladd.type = 'button';
  ladd.className = 'ghost';
  ladd.textContent = '+ Ledger';
  ladd.setAttribute('aria-label', 'Add ledger to ' + mainAcc.name);
  ladd.addEventListener('click', function () { openLedgerDialog(mainAcc.id, null, ids); });
  sec.appendChild(ladd);
  host.appendChild(sec);
  // The head (currency + first-ledger entry) always renders; rows show as
  // soon as the chart exists (even empty of records, like standalone
  // accounts) or something is actually labeled.
  var groupChart = null;
  try { groupChart = ledgerChartFor(st, mainAcc.id); } catch (e) { groupChart = null; }
  var hasGroupChart = !!(groupChart && Object.keys(groupChart).length);
  if (!hasGroupChart && !groupHasLabels(st.trades, ids)) {
    var gateNote = document.createElement('p');
    gateNote.className = 'muted';
    gateNote.textContent = 'No labeled records yet — post records with ledger codes in the sub-accounts.';
    host.appendChild(gateNote);
    return;
  }
  var gdtrades = (gCcy === headerMain) ? dtrades : convertTrades(st.trades, gCcy);
  var kinds = {};
  ids.forEach(function (id) {
    var a = accountById(st, id);
    kinds[id] = (a && typeof a.kind === 'string') ? a.kind : '';
  });
  var tree = ledgerTreeMulti(gdtrades, ids, gCcy, ledgerChartFor(st, mainAcc.id), kinds);
  // Roots carry chart codes (even empty) plus posted codes: an Unlabeled
  // bucket alone never renders a table.
  if (!tree.roots.length) {
    var noneNote = document.createElement('p');
    noneNote.className = 'muted';
    noneNote.textContent = 'No labeled records yet — post records with ledger codes in the sub-accounts.';
    host.appendChild(noneNote);
    return;
  }
  appendLedgerList(host, tree, gCcy, { key: mainAcc.id, chartId: mainAcc.id, scope: ids });
  try {
    var vset = {};
    ids.forEach(function (sid) {
      ledgerViolations(st, sid).forEach(function (c) { vset[c] = true; });
    });
    appendLedgerWarn(host, Object.keys(vset).sort());
  } catch (e) { /* ignore */ }
}

function buildGroupSubs(st, members, host, dtrades, main, method) {
  var sec = document.createElement('div');
  sec.className = 'section-head';
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = 'Sub-accounts';
  sec.appendChild(h);
  var count = document.createElement('span');
  count.className = 'muted';
  count.textContent = String(members.length);
  sec.appendChild(count);
  var actions = document.createElement('div');
  actions.className = 'section-actions';
  var nSel = 0;
  try { nSel = selectedCount(); } catch (e) { nSel = 0; }
  if (selectionMode) {
    var countEl = document.createElement('span');
    countEl.className = 'muted select-count';
    countEl.setAttribute('data-select-count', '1');
    countEl.textContent = nSel + ' selected';
    countEl.hidden = nSel === 0;
    actions.appendChild(countEl);
    actions.appendChild(buildAccountAction());
  }
  var selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'ghost' + (selectionMode ? ' select-on' : '');
  selectBtn.textContent = 'Select';
  selectBtn.setAttribute('aria-label', 'Select sub-accounts');
  selectBtn.setAttribute('aria-pressed', selectionMode ? 'true' : 'false');
  selectBtn.addEventListener('click', function () {
    if (selectionMode) cancelSelection();
    else { selectionMode = true; render(); }
  });
  actions.appendChild(selectBtn);
  sec.appendChild(actions);
  host.appendChild(sec);
  var wrap = document.createElement('div');
  wrap.className = 'group-subs';
  var cashIds = {};
  try { cashIds = cashAccountIds(st); } catch (e) { cashIds = {}; }
  var perRows = {};
  try {
    var pf = computePortfolio(dtrades, livePrices, method);
    members.forEach(function (m) {
      if (cashIds[m.id]) { perRows[m.id] = []; return; }
      var mm = (pf && pf.byAccount) ? pf.byAccount[m.id] : null;
      var arr = [];
      if (mm) mm.forEach(function (r) { arr.push(r); });
      arr.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
      perRows[m.id] = arr;
    });
  } catch (e) {
    members.forEach(function (m) { perRows[m.id] = []; });
  }
  members.forEach(function (m) {
    wrap.appendChild(accountCardEl(st, m, perRows[m.id] || [], dtrades, main, true, [m.id]));
  });
  wrap.addEventListener('click', function (e) {
    if (!e || !e.target || !e.target.closest) return;
    if (suppressCardClick) { suppressCardClick = false; return; } // just finished a sub drag
    if (selectionMode) {
      var scard = e.target.closest('.account-card');
      if (scard && scard.getAttribute('data-account')) {
        toggleAccountSelect(scard.getAttribute('data-account'));
        return;
      }
    }
    if (e.target.closest('button')) return;
    var nav = e.target.closest('[data-account-nav]');
    if (nav && nav.getAttribute('data-account-nav')) navTo(nav.getAttribute('data-account-nav'));
  });
  wrap.addEventListener('keydown', function (e) {
    if (!e || (e.key !== 'Enter' && e.key !== ' ')) return;
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('button')) return;
    var nav = e.target.closest('[data-account-nav]');
    if (nav && nav.getAttribute('data-account-nav')) {
      e.preventDefault();
      navTo(nav.getAttribute('data-account-nav'));
    }
  });
  host.appendChild(wrap);
  try { wireGroupSubsDnD(wrap); } catch (e) { /* subs render without drag */ }
}

// Standalone asset accounts with the global switch on: their labeled
// income/expense rolls into a Ledgers section (same rows as cash); the
// unlabeled rest pools into Unlabeled assets. The panel shows as soon as
// anything is created — a chart code (even empty, e.g. 1000 with no
// records) or a posted code — and never as an Unlabeled-only table: with
// no roots there is no section at all (the Trades head keeps the
// + Ledger bootstrap instead).
function buildAssetLedgers(st, acc, dtrades, main, host) {
  var ids = [acc.id];
  var kinds = {};
  kinds[acc.id] = (acc && typeof acc.kind === 'string') ? acc.kind : '';
  var tree = ledgerTreeMulti(dtrades, ids, main, ledgerChartFor(st, acc.id), kinds);
  if (!tree.roots.length) return false;
  var sec = document.createElement('div');
  sec.className = 'section-head ledgers-head';
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = 'Ledgers';
  sec.appendChild(h);
  var ladd = document.createElement('button');
  ladd.type = 'button';
  ladd.className = 'ghost';
  ladd.textContent = '+ Ledger';
  ladd.setAttribute('aria-label', 'Add ledger to ' + acc.name);
  ladd.addEventListener('click', function () { openLedgerDialog(acc.id); });
  sec.appendChild(ladd);
  host.appendChild(sec);
  appendLedgerList(host, tree, main, { key: acc.id, chartId: acc.id, scope: ids });
  try { appendLedgerWarn(host, ledgerViolations(st, acc.id)); } catch (e) { /* ignore */ }
  return true;
}

// Per-account ledger management: add/rename writes the account's own
// chart (snapshotting the default first); delete removes the code plus its
// whole subtree from the account's chart and clears those codes off the
// account's records, which then surface under Unlabeled income/expenses.
// Collapse state is per-account and in-session: toggling a parent hides its
// whole subtree until expanded again (render rebuilds from this map).
var ledgerCollapsed = {};
var ledgerDialogAccountId = null;
var ledgerDialogEditingCode = null;
var ledgerDialogScope = null;

function buildLedgerDialog() {
  var host = document.getElementById('ledger-dialog-body');
  if (!host || document.getElementById('ld-save')) return;
  wireDialog('ledger-dialog');
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<label for="ld-code">Code</label>' +
    '<input id="ld-code" autocomplete="off" spellcheck="false" placeholder="e.g. 1100" maxlength="24">' +
    '<label for="ld-label">Label</label>' +
    '<input id="ld-label" autocomplete="off" spellcheck="false" placeholder="e.g. Projects" maxlength="80">' +
    '<p id="ld-error" class="banner-error" role="alert" hidden></p>' +
    '<button id="ld-save" class="primary" type="button">Save ledger</button>';
  host.appendChild(wrap);
  document.getElementById('ld-save').addEventListener('click', function () {
    var err = document.getElementById('ld-error');
    function fail(msg) { if (err) { err.textContent = String(msg); err.hidden = false; } }
    if (err) { err.textContent = ''; err.hidden = true; }
    var accId = ledgerDialogAccountId;
    var editing = ledgerDialogEditingCode;
    var code = uiVal('ld-code', '').trim();
    var label = uiVal('ld-label', '').trim();
    if (!code || !isValidLedgerCode(code) || code === '') { fail('Ledger needs a code (e.g. 1100).'); return; }
    if (!label) { fail('Ledger needs a label (e.g. Projects).'); return; }
    if (!isValidLedgerLabel(label)) { fail('Ledger label is too long — up to 80 characters.'); return; }
    var st = loadState();
    if (!accountById(st, accId)) { fail('Account not found.'); return; }
    if (editing) {
      var rerr = renameAccountLedger(st, accId, editing, code, label, ledgerDialogScope);
      if (rerr) { fail(rerr); return; }
      if (code !== editing && ledgerCollapsed[accId] && ledgerCollapsed[accId][editing]) {
        ledgerCollapsed[accId][code] = true;
        try { delete ledgerCollapsed[accId][editing]; } catch (e) { /* ignore */ }
      }
    } else {
      var map = ensureAccountChart(st, accId);
      if (Object.prototype.hasOwnProperty.call(map, code)) { fail('Ledger code already exists — pick a new code or edit it.'); return; }
      if (Object.keys(map).length >= 500) { fail('This account already holds 500 codes.'); return; }
      map[String(code).trim()] = String(label).trim();
    }
    if (!saveStateGuarded(st)) { fail('Storage unavailable — ledger was not saved.'); return; }
    ledgerDialogEditingCode = null;
    ledgerDialogScope = null;
    uiSetVal('ld-code', '');
    uiSetVal('ld-label', '');
    closeDialog('ledger-dialog');
    clearBanner();
    render();
  });
}

function openLedgerDialog(accountId, editCode, scopeIds) {
  ledgerDialogAccountId = accountId;
  ledgerDialogEditingCode = (editCode === undefined || editCode === null) ? null : String(editCode).trim();
  ledgerDialogScope = (scopeIds && scopeIds.length) ? scopeIds.slice() : null;
  buildLedgerDialog();
  var title = document.getElementById('ledger-dialog-title');
  var save = document.getElementById('ld-save');
  var err = document.getElementById('ld-error');
  if (ledgerDialogEditingCode) {
    var lbl = '';
    try {
      var st = loadState();
      lbl = findLedgerLabel(st, accountId, ledgerDialogEditingCode, ledgerDialogScope) || '';
    } catch (e) { lbl = ''; }
    uiSetVal('ld-code', ledgerDialogEditingCode);
    uiSetVal('ld-label', lbl);
    if (title) title.textContent = 'Edit ledger';
    if (save) save.textContent = 'Save changes';
  } else {
    uiSetVal('ld-code', '');
    uiSetVal('ld-label', '');
    if (title) title.textContent = 'New ledger';
    if (save) save.textContent = 'Save ledger';
  }
  if (err) { err.textContent = ''; err.hidden = true; }
  openDialog('ledger-dialog');
}

// Group dialog: pick the main account for the selected accounts, or create
// a new one (full account creation, grouped on success via pendingGroupIds).
var groupDialogIds = null;
var pendingGroupIds = null;

function buildGroupDialog() {
  var host = document.getElementById('group-dialog-body');
  if (!host || document.getElementById('g-save')) return;
  wireDialog('group-dialog');
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<p class="muted" id="g-count"></p>' +
    '<label for="g-target">Main account</label>' +
    '<select id="g-target"></select>' +
    '<p id="g-error" class="banner-error" role="alert" hidden></p>' +
    '<button id="g-save" class="primary" type="button">Group</button>';
  host.appendChild(wrap);
  document.getElementById('g-save').addEventListener('click', function () {
    var err = document.getElementById('g-error');
    function fail(msg) { if (err) { err.textContent = String(msg); err.hidden = false; } }
    if (err) { err.textContent = ''; err.hidden = true; }
    var target = uiVal('g-target', '');
    if (!target) { fail('Pick a main account.'); return; }
    if (target === '__new') {
      pendingGroupIds = (groupDialogIds || []).slice();
      groupDialogIds = null;
      closeDialog('group-dialog');
      openAccountDialog();
      return;
    }
    var st = loadState();
    var gerr = assignGroup(st, groupDialogIds || [], target);
    if (gerr) { fail(gerr); return; }
    if (!saveStateGuarded(st)) { fail('Storage unavailable — accounts were not grouped.'); return; }
    groupDialogIds = null;
    selectedAccounts = {};
    selectionMode = false;
    closeDialog('group-dialog');
    clearBanner();
    navTo(target);
    render();
  });
}

function openGroupDialog(ids) {
  groupDialogIds = (ids || []).slice();
  buildGroupDialog();
  var st = loadState();
  var inSel = {};
  groupDialogIds.forEach(function (id) { inSel[id] = true; });
  var sel = document.getElementById('g-target');
  if (sel) {
    sel.innerHTML = '';
    (st.accounts || []).forEach(function (a) {
      if (!a || !a.id || inSel[a.id]) return;
      if (groupMainOf(st, a.id)) return; // grouped members can't be mains
      var op = document.createElement('option');
      op.value = a.id;
      op.textContent = a.name + ' (' + String(a.ticker).toUpperCase() + ')';
      sel.appendChild(op);
    });
    var nw = document.createElement('option');
    nw.value = '__new';
    nw.textContent = '＋ Create new main account';
    sel.appendChild(nw);
    sel.value = sel.options.length > 1 ? sel.options[0].value : '__new';
  }
  var count = document.getElementById('g-count');
  if (count) count.textContent = 'Group ' + groupDialogIds.length + ' account' + (groupDialogIds.length === 1 ? '' : 's') + ' under:';
  var gerr = document.getElementById('g-error');
  if (gerr) { gerr.textContent = ''; gerr.hidden = true; }
  openDialog('group-dialog');
}

// Clone just enough state to simulate a ledger rename: account charts +
// record ledgers. The source state is never touched.
function cloneLedgerState(st) {
  function copyObj(o) {
    var n = {};
    if (!o || typeof o !== 'object') return n;
    Object.keys(o).forEach(function (k) { n[k] = o[k]; });
    return n;
  }
  var c = { settings: (st && st.settings) || {}, accounts: [], trades: [], priceOverrides: (st && st.priceOverrides) || {} };
  ((st && st.accounts) || []).forEach(function (a) {
    var n = copyObj(a);
    if (a && a.ledgers && typeof a.ledgers === 'object' && !Array.isArray(a.ledgers)) {
      n.ledgers = copyObj(a.ledgers);
    }
    c.accounts.push(n);
  });
  ((st && st.trades) || []).forEach(function (t) { c.trades.push(copyObj(t)); });
  return c;
}

// Rename (or relabel) one ledger inside an account's own chart: the chart
// entry moves and every record carrying the old code follows it, so the
// tree + totals never lose money. Pure against the passed state (no DOM,
// no save): returns an error string, or null on success. scopeIds widens
// record migration + violation checks to the whole group (main first);
// omitted means the single account.
function renameAccountLedger(st, accountId, oldCode, newCode, newLabel, scopeIds) {
  oldCode = (oldCode === undefined || oldCode === null) ? '' : String(oldCode).trim();
  newCode = (newCode === undefined || newCode === null) ? '' : String(newCode).trim();
  newLabel = (newLabel === undefined || newLabel === null) ? '' : String(newLabel).trim();
  if (!oldCode) return 'Ledger not found.';
  if (!accountById(st, accountId)) return 'Account not found.';
  if (!newCode || !isValidLedgerCode(newCode)) return 'Ledger needs a code (e.g. 1100).';
  if (!newLabel) return 'Ledger needs a label (e.g. Projects).';
  if (!isValidLedgerLabel(newLabel)) return 'Ledger label is too long — up to 80 characters.';
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [accountId];
  function inScope(t) {
    if (!t) return false;
    for (var i = 0; i < scope.length; i++) if (t.accountId === scope[i]) return true;
    return false;
  }
  function violationsUnion(s) {
    var set = {};
    scope.forEach(function (sid) {
      var v = [];
      try { v = ledgerViolations(s, sid); } catch (e) { v = []; }
      v.forEach(function (c) { set[c] = true; });
    });
    return Object.keys(set).sort();
  }
  var map = ensureAccountChart(st, accountId);
  if (newCode !== oldCode) {
    if (Object.prototype.hasOwnProperty.call(map, newCode)) return 'Ledger code already exists — pick a new code or edit it.';
    var posted = false;
    (st.trades || []).forEach(function (t) {
      if (inScope(t) && String(t.ledger || '').trim() === newCode) posted = true;
    });
    if (posted) return 'Ledger code already exists — pick a new code or edit it.';
    if (Object.keys(map).length >= 500) return 'This account already holds 500 codes.';
    // Parent-overview rule, judged on the AFTER state: simulate the rename
    // on a clone and block only when it would newly strand records on a
    // parent (a record-free parent renamed under other codes just works).
    var before = violationsUnion(st);
    var sim = cloneLedgerState(st);
    var smap = ensureAccountChart(sim, accountId);
    if (Object.prototype.hasOwnProperty.call(smap, oldCode)) delete smap[oldCode];
    smap[newCode] = newLabel;
    (sim.trades || []).forEach(function (t) {
      if (!t || !inScope(t)) return;
      if (String(t.ledger || '').trim() === oldCode) { t.ledger = newCode; t.ledgerLabel = newLabel; }
    });
    var added = [];
    try {
      added = violationsUnion(sim).filter(function (c) { return before.indexOf(c) === -1; });
    } catch (e) { added = []; }
    if (added.length) return '"' + added[0] + '" would hold records and sub-ledgers after this change — move its records to a child ledger first, keeping parents record-free.';
    if (Object.prototype.hasOwnProperty.call(map, oldCode)) delete map[oldCode];
    map[newCode] = newLabel;
  } else {
    map[oldCode] = newLabel;
  }
  (st.trades || []).forEach(function (t) {
    if (!inScope(t)) return;
    if (String(t.ledger || '').trim() === oldCode) { t.ledger = newCode; t.ledgerLabel = newLabel; }
  });
  return null;
}

function deleteAccountLedger(accountId, code, scopeIds) {
  if (!accountId || !code) return;
  code = String(code).trim();
  if (!code || code === '—') return;
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [accountId];
  function inScope(t) {
    if (!t) return false;
    for (var i = 0; i < scope.length; i++) if (t.accountId === scope[i]) return true;
    return false;
  }
  var st = loadState();
  var acc = accountById(st, accountId);
  if (!acc) return;
  var effective = ledgerChartFor(st, accountId);
  var allSet = {};
  Object.keys(effective).forEach(function (k) { var ck = String(k).trim(); if (ck) allSet[ck] = true; });
  (st.trades || []).forEach(function (t) {
    if (!inScope(t)) return;
    var kc = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (kc) allSet[kc] = true;
  });
  var subs = ledgerDescendantsOf(code, Object.keys(allSet));
  var doomedSet = {};
  doomedSet[code] = true;
  subs.forEach(function (c) { doomedSet[c] = true; });
  var recCount = 0;
  (st.trades || []).forEach(function (t) {
    if (!inScope(t)) return;
    var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (c && doomedSet[c]) recCount++;
  });
  var label = effective[code] ? code + ' · ' + effective[code] : code;
  var subTxt = subs.length ? ' Also deletes ' + subs.length + ' sub-ledger' + (subs.length === 1 ? '' : 's') + ' underneath (' + subs.slice().sort().join(', ') + ').' : '';
  var unlabeledNoun = scope.length > 1 ? 'the Unlabeled buckets' : 'Unlabeled income/expenses';
  var recTxt = recCount ? ' ' + recCount + ' record' + (recCount === 1 ? '' : 's') + ' lose' + (recCount === 1 ? 's' : '') + ' their ledger and move under ' + unlabeledNoun + ' (totals unchanged).' : ' No records use it.';
  confirmAction('Delete ledger', 'Delete "' + label + '" from ' + acc.name + '?' + subTxt + recTxt, 'Delete', true).then(function (ok) {
    if (!ok) return;
    var s2 = loadState();
    if (!accountById(s2, accountId)) return;
    var map = ensureAccountChart(s2, accountId);
    Object.keys(doomedSet).forEach(function (c) {
      if (Object.prototype.hasOwnProperty.call(map, c)) delete map[c];
    });
    (s2.trades || []).forEach(function (t) {
      if (!inScope(t)) return;
      var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
      if (c && doomedSet[c]) {
        try { delete t.ledger; } catch (e) { t.ledger = undefined; }
        try { delete t.ledgerLabel; } catch (e) { t.ledgerLabel = undefined; }
      }
    });
    if (!saveStateGuarded(s2)) return;
    clearBanner();
    render();
  });
}

function renderAccountDetail(st, id) {
  var host = document.getElementById('account-detail');
  if (!host) return;
  var acc = accountById(st, id);
  if (!acc) {
    navHome();
    return;
  }
  var main = st.settings.mainCurrency;
  var method = st.settings.costMethod;
  var dtrades = convertTrades(st.trades, main);
  var isCashAccD = isCashKind(acc.kind);
  var rows = [];
  try {
    var pfDet = computePortfolio(dtrades, livePrices, method);
    var mDet = pfDet.byAccount[id];
    if (mDet && !isCashAccD) mDet.forEach(function (r) { rows.push(r); });
    rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
  } catch (e) {
    rows = isCashAccD ? [] : computePositions(accountTrades({ trades: dtrades }, acc.id), livePrices, method);
  }
  var atrades = accountTrades({ trades: dtrades }, acc.id);
  // Group role: mains aggregate (merged ledgers + sub cards, no trade
  // history), members show transactions without their Ledgers section.
  var members = groupMembers(st, acc.id);
  var mainOf = groupMainOf(st, acc.id);
  // Mains fold member engine rows into the stat grid, and member trades
  // into lifetime denominators — cards describe the group, never the
  // (often empty) main alone.
  var scopeTrades = atrades;
  if (members.length && !isCashAccD) {
    try {
      if (typeof pfDet !== 'undefined' && pfDet && pfDet.byAccount) {
        members.forEach(function (m) {
          var mm = pfDet.byAccount[m.id];
          if (mm) mm.forEach(function (r) { rows.push(r); });
        });
        rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
      } else {
        members.forEach(function (m) {
          computePositions(accountTrades({ trades: dtrades }, m.id), livePrices, method).forEach(function (r) { rows.push(r); });
        });
      }
    } catch (e) { /* aggregation never breaks the view */ }
  }
  if (members.length) {
    try {
      scopeTrades = [];
      var seenSC = {};
      var scopeIds = [acc.id];
      members.forEach(function (m) { scopeIds.push(m.id); });
      scopeIds.forEach(function (sid) {
        accountTrades({ trades: dtrades }, sid).forEach(function (t) {
          if (!t) return;
          if (t.id) {
            if (seenSC[t.id]) return;
            seenSC[t.id] = true;
          }
          scopeTrades.push(t);
        });
      });
    } catch (e) { scopeTrades = atrades; }
  }
  var assetLedgersShown = false;
  // FIFO lot linkage, resolved once for every visible card: every trade by
  // id (all accounts, so cross-account transfer closes still resolve) and
  // every closed lot grouped by opening / closing trade. Average pools cost
  // and links nothing — fifoCtx stays null there.
  var tradeById = {};
  (dtrades || []).forEach(function (t) {
    if (t && typeof t.id === 'string' && t.id !== '') tradeById[t.id] = t;
  });
  var fifoLinks = { byBuy: {}, byClose: {} };
  if (method === 'fifo' && pfDet && pfDet.byAccount) {
    try {
      var lotsAll = [];
      Object.keys(pfDet.byAccount).forEach(function (aid) {
        var mm = pfDet.byAccount[aid];
        function grab(r) { ((r && r.lots) || []).forEach(function (l) { lotsAll.push(l); }); }
        if (mm && typeof mm.forEach === 'function') {
          if (typeof Map !== 'undefined' && mm instanceof Map) mm.forEach(function (r) { grab(r); });
          else if (Array.isArray(mm)) mm.forEach(function (r) { grab(r); });
        }
      });
      fifoLinks = fifoLinksFor(lotsAll);
    } catch (e) { fifoLinks = { byBuy: {}, byClose: {} }; }
  }
  host.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'account-head detail-head';
  var nameEl = document.createElement('h1');
  nameEl.className = 'account-name detail-name';
  nameEl.textContent = acc.name;
  head.appendChild(nameEl);
  var menu = document.createElement('details');
  menu.className = 'menu';
  var sum = document.createElement('summary');
  sum.textContent = '···';
  sum.setAttribute('aria-label', 'Account options');
  menu.appendChild(sum);
  var mbox = document.createElement('div');
  mbox.className = 'menu-box';
  function menuBtn(text, label, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label + ' ' + acc.name);
    b.addEventListener('click', function () {
      menu.removeAttribute('open');
      fn();
    });
    mbox.appendChild(b);
    return b;
  }
  menuBtn('Rename', 'Rename', function () { startInlineRename(acc.id, head, nameEl); });
  menuBtn('Edit label', 'Edit label for', function () { startInlineLabelEdit(acc.id); });
  // Flat groups: mains and standalone accounts gain subs; members never do.
  if (!mainOf) menuBtn('Create sub-account', 'Create sub-account in', function () { createSubAccount(acc.id); });
  if (members.length) menuBtn('Ungroup', 'Ungroup', function () { ungroupMain(acc.id); });
  menuBtn('Delete', 'Delete', function () { deleteAccount(acc.id); });
  menu.appendChild(mbox);
  head.appendChild(menu);
  host.appendChild(head);
  // Optional free-text label entered at creation (wallet, note, anything) —
  // shown inside the header box with popup-on-overflow like trade notes.
  var metaBlock = null;
  function addMeta(label, text, title) {
    if (!metaBlock) {
      metaBlock = document.createElement('div');
      metaBlock.className = 'detail-meta-block';
      head.appendChild(metaBlock);
    }
    metaBlock.appendChild(detailMetaRow(label, text, title));
  }
  if (acc.address) addMeta('Label', acc.address, 'Label');
  if (acc.note) addMeta('Note', acc.note, 'Account note');
  var stats = document.createElement('div');
  stats.className = 'cards detail-stats';
  var pl = 0;
  var mv = 0;
  var mvKnown = false;
  var un = 0;
  var unKnown = false;
  var rz = 0;
  rows.forEach(function (r) {
    rz += r.realized;
    pl += r.totalPL;
    if (r.marketValue !== null) { mv += r.marketValue; mvKnown = true; }
    if (r.unrealized !== null) { un += r.unrealized; unKnown = true; }
  });
  var cost = mv - un;
  var ret = null;
  // Lifetime return: realized+unrealized vs lifetime buy+income cost (consistent with overview).
  var lifetimeForRet = 0;
  try {
    scopeTrades.forEach(function (t) {
      if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
      var cn = normalizeTrade(t);
      // For transfers-in, cost is already in dest's buy-like inflow? No: transfers carry basis via joint engine, but lifetime here should count original buys+income only (transfers move, not new money).
      // atrades includes transfer-in with no total (total 0) so it adds 0 — safe.
      lifetimeForRet += cn.netMain + cn.feeLossMain;
    });
  } catch (e) { lifetimeForRet = 0; }
  if (lifetimeForRet <= 0) lifetimeForRet = cost; // fallback to remaining (closed edge handled below)
  if (mvKnown && unKnown && lifetimeForRet > 0) ret = ((un + rz) / lifetimeForRet) * 100;
  // Holding first, then worth, market, cost, gains: Quantity, Value,
  // Live price, Average entry, Unrealized, Realized, Total P&L, Return.
  // (Single ticker per account, so rows[0] is the position.)
  // A closed position states facts, not leftovers: average of nothing is
  // unknown, the notice sits above the grid (never inside it), and final
  // return is realized vs lifetime buy cost.
  var pos = rows.length ? rows[0] : null;
  var closed = !!(pos && pos.qtyHeld === 0);
  var lifetimeCost = 0;
  if (closed || true) {
    scopeTrades.forEach(function (t) {
      if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
      var cn = normalizeTrade(t);
      lifetimeCost += cn.netMain + cn.feeLossMain;
    });
    if (closed) {
      var closedFlag = document.createElement('p');
      closedFlag.className = 'muted closed-flag';
      closedFlag.textContent = 'Closed — nothing held.';
      host.appendChild(closedFlag);
    }
  }
  stats.appendChild(statCard('Quantity', pos ? (fmtQty(pos.qtyHeld, pos.symbol) + ' ' + String(pos.symbol || '').toUpperCase()) : '—', pos ? pos.qtyHeld : null));
  // Full grid even with no records yet: unknowns show —, and the live price
  // resolves from the ticker alone so a fresh account already quotes.
  var tickSym = acc && acc.ticker ? String(acc.ticker).toUpperCase() : '';
  var lvRaw = (tickSym && typeof livePrices !== 'undefined' && livePrices) ? livePrices[tickSym] : null;
  var lvNum = Number(lvRaw);
  var liveShow = pos ? pos.livePrice : ((isFinite(lvNum) && lvNum > 0) ? lvNum : null);
  var detLoading = isPriceLoading(tickSym);
  stats.appendChild(statCard('Value', mvKnown ? fmtMoney(mv, main) : (detLoading ? PRICE_LOADING_TEXT : '—'), mvKnown ? mv : null, !mvKnown && detLoading));
  stats.appendChild(statCard('Live price', liveShow !== null ? fmtMoney(liveShow, main) : (detLoading ? PRICE_LOADING_TEXT : '—'), liveShow, liveShow === null && detLoading));
  stats.appendChild(statCard('Average entry', (pos && !closed) ? fmtMoney(pos.avgEntry, main) : '—', (pos && !closed) ? pos.avgEntry : null));
  stats.appendChild(statCard('Unrealized', unKnown ? fmtMoney(un, main) : (detLoading ? PRICE_LOADING_TEXT : '—'), unKnown ? un : null, !unKnown && detLoading));
  stats.appendChild(statCard('Realized', fmtMoney(rz, main), rz));
  if (pos) {
    var tplCard = statCard('Total P&L', fmtMoney(pos.totalPL, main), pos.totalPL);
    var tsc = plClass(pos.totalPL);
    if (tsc) tplCard.querySelector('.card-value').classList.add(tsc);
    stats.appendChild(tplCard);
  } else {
    stats.appendChild(statCard('Total P&L', '—', null));
  }
  if (closed && lifetimeCost > 0) ret = (rz / lifetimeCost) * 100;
  var retCard = statCard('Return', ret !== null ? fmtPct(ret) : '—', ret);
  var rsc = plClass(ret);
  if (rsc) retCard.querySelector('.card-value').classList.add(rsc);
  stats.appendChild(retCard);
  // Fee info lives below the 8-card grid as one line (display-only: the fee
  // is already baked into the calculated Real price, zero P&L drag).
  var feesSum = 0, incomeSum = 0;
  rows.forEach(function (r) { feesSum += Number(r.fees) || 0; incomeSum += Number(r.income) || 0; });
  if (Math.abs(incomeSum) > 1e-9) stats.appendChild(statCard('Income', fmtMoney(incomeSum, main), incomeSum));
  if (isCashAccD) {
    if (members.length) {
      // Main aggregates the group in the header display fiat — like every
      // other card; the Ledgers table below keeps the group currency.
      stats.innerHTML = '';
      var gIds = [acc.id];
      members.forEach(function (m) { gIds.push(m.id); });
      var gNative = 0, gValue = 0, gTick = {}, gHas = false, gContrib = 0;
      gIds.forEach(function (cid) {
        var at = accountTrades({ trades: dtrades }, cid);
        if (!at.length) return;
        gContrib++;
        var cb = null;
        var ckind = '';
        try {
          var cacc = accountById(st, cid);
          ckind = (cacc && typeof cacc.kind === 'string') ? cacc.kind : '';
        } catch (e) { ckind = ''; }
        try { cb = cashBalance(dtrades, cid, main, isCashKind(ckind)); } catch (e) { cb = null; }
        if (!cb) return;
        if (isFinite(Number(cb.main))) { gValue += Number(cb.main); gHas = true; }
        gNative += Number(cb.native) || 0;
        var ca = null;
        try { ca = accountById(st, cid); } catch (e) { ca = null; }
        if (ca && ca.ticker) gTick[String(ca.ticker).toUpperCase()] = true;
      });
      var gTickList = Object.keys(gTick);
      stats.appendChild(statCard('Balance', gHas ? (gTickList.length === 1 ? (fmtQty(gNative, gTickList[0]) + ' ' + gTickList[0]) : (gContrib + (gContrib === 1 ? ' account' : ' accounts'))) : 'New', gHas ? gNative : null));
      stats.appendChild(statCard('Value', gHas ? fmtMoney(gValue, main) : 'New', gHas ? gValue : null));
      stats.classList.add('cards-duo');
      host.appendChild(stats);
    } else {
      buildCashDetailStats(st, acc, dtrades, main, stats, host, mainOf ? { skipLedgers: true } : null);
    }
  } else {
    host.appendChild(stats);
    // Standalone asset accounts show Ledgers while the global switch is on
    // (grouped members and mains are covered by the group view instead).
    // assetLedgersShown feeds the + Ledger bootstrap in the Trades head.
    assetLedgersShown = false;
    if (!mainOf && !members.length) {
      try {
        if (assetLedgersOn(st)) assetLedgersShown = buildAssetLedgers(st, acc, dtrades, main, host) === true;
      } catch (e) { /* Ledgers never break the detail view */ }
    }
  }
  // Group mains: merged ledgers in the group currency plus sub-account
  // cards instead of the spent/fees lines and the trade history below.
  if (members.length) {
    buildGroupLedgers(st, acc, members, host, dtrades, main);
    buildGroupSubs(st, members, host, dtrades, main, method);
    return;
  }
  // Per-account spent (this account only): lifetime sell proceeds, cash legs
  // and crypto fees at the frozen tx-date rate — same definition as the home
  // SPENT AMOUNT, scoped to atrades. Orange pill above the red fees pill.
  var spentSum = 0;
  try {
    atrades.forEach(function (t) {
      if (!t) return;
      var sn = normalizeTrade(t);
      if (t.type === 'sell') {
        if (isFinite(sn.totalMain) && sn.totalMain > 0) spentSum += sn.totalMain;
      } else if (t.type === 'expense' || t.type === 'transfer') {
        if (isFinite(sn.netMain) && sn.netMain > 0) spentSum += sn.netMain;
        var cq = (t.type === 'transfer')
          ? ((t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee))
          : ((t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? 0 : Number(t.qty));
        if (isFinite(cq) && cq > 0) {
          var kr = null;
          try { kr = resolveExecPrice(t, main, accKind); } catch (e) { kr = null; }
          if (kr !== null && isFinite(Number(kr.price)) && Number(kr.price) > 0) {
            spentSum += cq * Number(kr.price);
          }
        }
      }
    });
  } catch (e) { spentSum = 0; }
  if (!isCashAccD && spentSum > 1e-9) {
    var spentLine = document.createElement('p');
    spentLine.className = 'spent-line';
    spentLine.setAttribute('data-label', 'Spent amount');
    spentLine.setAttribute('data-value', String(spentSum));
    spentLine.textContent = 'Spent amount: ' + fmtMoney(spentSum, main);
    host.appendChild(spentLine);
  }
  if (!isCashAccD && Math.abs(feesSum) > 1e-9) {
    var feesLine = document.createElement('p');
    feesLine.className = 'fees-line';
    feesLine.setAttribute('data-label', 'Total fees paid');
    feesLine.setAttribute('data-value', String(feesSum));
    feesLine.textContent = 'Total fees paid: ' + fmtMoney(feesSum, main);
    host.appendChild(feesLine);
  }
  var tHead = document.createElement('div');
  tHead.className = 'section-head';
  var tTitle = document.createElement('h2');
  tTitle.className = 'section-title';
  tTitle.textContent = 'Trades';
  tHead.appendChild(tTitle);
  if (atrades.length) {
    var tAdd = document.createElement('button');
    tAdd.type = 'button';
    tAdd.className = 'ghost t-add';
    tAdd.textContent = '+ Record';
    tAdd.setAttribute('aria-label', 'Add record to ' + acc.name);
    tAdd.addEventListener('click', function () { openPrefillTrade(acc.id, true); });
    tHead.appendChild(buildTradeTypeFilter(acc, atrades));
    // Bootstrap: standalone asset accounts with nothing labeled yet get
    // their + Ledger here (filter … + Ledger … + Record); once the Ledgers
    // section exists it owns the button instead.
    if (!isCashAccD && !mainOf && !members.length && !assetLedgersShown) {
      var showBoot = false;
      try { showBoot = assetLedgersOn(st); } catch (e) { showBoot = false; }
      if (showBoot) {
        var lBoot = document.createElement('button');
        lBoot.type = 'button';
        lBoot.className = 'ghost';
        lBoot.textContent = '+ Ledger';
        lBoot.setAttribute('data-ledger-add', acc.id);
        lBoot.setAttribute('aria-label', 'Add ledger to ' + acc.name);
        lBoot.addEventListener('click', function () { openLedgerDialog(acc.id); });
        tHead.appendChild(lBoot);
      }
    }
    tHead.appendChild(tAdd);
    host.appendChild(tHead);
    var nameById = function (aid) { var a = accountById(st, aid); return a ? a.name : ''; };
    var accKind = (acc && typeof acc.kind === 'string') ? acc.kind : undefined;
    // Paged records: sort once, then build DOM only for the visible slice.
    // Off-page records cost nothing per paint (no tradeBlock, no exec-rate
    // resolution, single fragment insert) while totals above still use all.
    // Record-type filter: view-only multi-select (null = every type). Stats,
    // totals and P&L above always cover every trade; only this list + its
    // pager follow the filter.
    var typeFilter = tradeTypeFilterFor(acc.id);
    var fullSorted = ledgerSortByDate(atrades).reverse();
    var sortedTrades = filterTradesByType(fullSorted, typeFilter);
    var tradeTotal = sortedTrades.length;
    var tradePageCount = tradePageCountFor(tradeTotal);
    var tradePage = tradePageGet(acc.id, tradeTotal);
    var tradeStart = tradePage * tradePageSize;
    var tradeEnd = Math.min(tradeStart + tradePageSize, tradeTotal);
    // Bottom bar, always on one line: range + pager + per-page selector.
    // The bar renders after the records (always at the bottom, even with a
    // single page); only the pager numbers hide when everything fits.
    var bottomBar = document.createElement('div');
    bottomBar.className = 'trade-bottom-bar';
    bottomBar.setAttribute('data-trade-bottom', '1');
    var rangeEl = document.createElement('span');
    rangeEl.className = 'muted trade-range';
    rangeEl.setAttribute('data-trade-range', '1');
    rangeEl.textContent = tradeTotal
      ? 'Showing ' + (tradeStart + 1) + '–' + tradeEnd + ' of ' + tradeTotal
      : 'No records match this filter';
    bottomBar.appendChild(rangeEl);
    if (tradePageCount > 1) bottomBar.appendChild(buildTradePager(acc.id, tradeTotal, tradePageCount, tradePage));
    var perWrap = document.createElement('label');
    perWrap.className = 'per-page';
    var perTxt = document.createElement('span');
    perTxt.className = 'muted';
    perTxt.textContent = 'Per page';
    perWrap.appendChild(perTxt);
    var perSel = document.createElement('select');
    perSel.setAttribute('data-trade-per-page', '1');
    perSel.setAttribute('aria-label', 'Records per page');
    TRADE_PAGE_SIZES.forEach(function (n) {
      var o = document.createElement('option');
      o.value = String(n);
      o.textContent = String(n);
      if (n === tradePageSize) o.selected = true;
      perSel.appendChild(o);
    });
    perSel.addEventListener('change', function () {
      tradePageSizeSet(perSel.value);
      tradePageSetFor(acc.id, 0, tradeTotal);
      render();
    });
    perWrap.appendChild(perSel);
    bottomBar.appendChild(perWrap);
    var frag = (typeof document.createDocumentFragment === 'function')
      ? document.createDocumentFragment()
      : null;
    // Linked-record jumps: same-page targets scroll + flash in place, while
    // off-page (paged-out) targets jump to their page first, then flash.
    var flashTradeCard = function (el) {
      // Phones: open first, then scroll — a lot-link jump should reveal the
      // record's facts, not flash a collapsed stub. (setTradeCardOpen runs the
      // ⓘ gate itself; desktop is untouched.)
      try { if (isMobileView()) setTradeCardOpen(el, true); } catch (e) { /* ignore */ }
      try {
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      } catch (e) { /* ignore */ }
      try {
        el.classList.add('flash');
        setTimeout(function () { try { el.classList.remove('flash'); } catch (e4) { /* ignore */ } }, 1600);
      } catch (e5) { /* ignore */ }
    };
    var gotoTrade = function (id) {
      if (typeof id !== 'string' || id === '') return;
      var target = null;
      try {
        var cards = host.querySelectorAll('[data-trade]');
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].getAttribute('data-trade') === id) { target = cards[i]; break; }
        }
      } catch (e) { target = null; }
      if (target) { flashTradeCard(target); return; }
      var idx = -1;
      for (var k = 0; k < sortedTrades.length; k++) {
        if (sortedTrades[k] && sortedTrades[k].id === id) { idx = k; break; }
      }
      if (idx < 0) {
        // Not in the filtered view: search the full list. A filtered-out
        // target clears the type filter so lot-link jumps still land.
        var fullIdx = -1;
        for (var k2 = 0; k2 < fullSorted.length; k2++) {
          if (fullSorted[k2] && fullSorted[k2].id === id) { fullIdx = k2; break; }
        }
        if (fullIdx < 0) return;
        setTradeTypeFilter(acc.id, null);
        var fullPage = Math.floor(fullIdx / tradePageSize);
        if (fullPage !== 0) {
          tradePageSetFor(acc.id, fullPage, fullSorted.length);
          render();
        }
        try {
          setTimeout(function () {
            var el = null;
            try {
              var cs = document.querySelectorAll('#account-detail [data-trade]');
              for (var j = 0; j < cs.length; j++) {
                if (cs[j].getAttribute('data-trade') === id) { el = cs[j]; break; }
              }
            } catch (e2b) { el = null; }
            if (el) flashTradeCard(el);
          }, 60);
        } catch (e3b) { /* ignore */ }
        return;
      }
      var pg = Math.floor(idx / tradePageSize);
      if (pg === tradePage) return;
      tradePageSetFor(acc.id, pg, tradeTotal);
      render();
      try {
        setTimeout(function () {
          var el = null;
          try {
            var cs = document.querySelectorAll('#account-detail [data-trade]');
            for (var j = 0; j < cs.length; j++) {
              if (cs[j].getAttribute('data-trade') === id) { el = cs[j]; break; }
            }
          } catch (e2) { el = null; }
          if (el) flashTradeCard(el);
        }, 60);
      } catch (e3) { /* ignore */ }
    };
    var fifoCtx = (method === 'fifo')
      ? { links: fifoLinks, byId: tradeById, main: main, go: gotoTrade }
      : null;
    for (var ti = tradeStart; ti < tradeEnd; ti++) {
      var tb = tradeBlock(sortedTrades[ti], main, nameById, accKind, fifoCtx);
      if (frag) frag.appendChild(tb);
      else host.appendChild(tb);
    }
    if (frag) host.appendChild(frag);
    host.appendChild(bottomBar);
    restoreTradeTypeFilterFocus();
  } else {
    host.appendChild(tHead);
    var emptyTrades = document.createElement('div');
    emptyTrades.className = 'empty-trades';
    var muted = document.createElement('p');
    muted.className = 'muted';
    muted.textContent = 'No trades yet — add one to see P&L.';
    emptyTrades.appendChild(muted);
    var eAdd = document.createElement('button');
    eAdd.type = 'button';
    eAdd.className = 'primary';
    eAdd.textContent = '+ Record';
    eAdd.setAttribute('aria-label', 'Add record to ' + acc.name);
    eAdd.addEventListener('click', function () { openPrefillTrade(acc.id, true); });
    emptyTrades.appendChild(eAdd);
    host.appendChild(emptyTrades);
  }
}

// Account id route() last painted. Scroll resets only when this changes
// (real navigation); re-renders of the same page keep the scroll position.
var lastRouteId = null;

function route() {
  var home = document.getElementById('view-home');
  var det = document.getElementById('view-account');
  if (!home || !det) return;
  var id = accountDetailId();
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
  syncTradeButtons();
}

// Trade entry lives inside accounts only: the top-bar +Trade and the mobile
// FAB hide on home (the elements stay in the DOM so programmatic clicks and
// tests keep working). First-run onboarding keeps its own guide CTA.
function syncTradeButtons() {
  var st = null;
  try {
    st = loadState();
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
  // Entry points live with their lists now (+ Account above accounts,
  // + Record above trades), so the top-bar duplicates stay hidden everywhere
  // (elements remain in the DOM for tests and programmatic use).
  var add = document.getElementById('tb-add');
  if (add) add.hidden = true;
  var acctBtn = document.getElementById('tb-account');
  if (acctBtn) acctBtn.hidden = true;
  var fab = document.getElementById('fab-trade');
  if (fab) fab.hidden = !(inAccount && hasAccts && hasTrades);
}

// --- Accounts CRUD (restored: must never be removed — the exposure block
// below and the UI/tests reference every one of these) ---

function accountTrades(st, accountId) {
  // Single-arg form accountTrades(accountId) reads live state (test helper).
  if (typeof st === 'string' && accountId === undefined) {
    return accountTrades(loadState(), st);
  }
  return ((st && st.trades) || []).filter(function (t) {
    return transferInvolvesAccount(t, accountId);
  });
}

function fxBadgeText(t) {
  var lock = t ? t.fxLock : null;
  if (!lock) return 'legacy rate';
  var r = Number(lock.rate);
  var bits = fmtEcbInText(String(lock.source || 'rate'));
  if (isFinite(r)) {
    var rounded = Math.round(r * 10000) / 10000;
    bits += ' @ ' + rounded;
  }
  if (lock.interpolated) bits += ' (prev close)';
  var head = bits;
  if (t && stableToUsd(t.currency)) {
    head = String(t.currency).toUpperCase() + '→USD 1.0 · ' + bits;
  }
  return head;
}

function createAccount(name, ticker, kind, extra) {
  var st = loadState();
  var tk = String(ticker || '').trim().toUpperCase();
  var nm = String(name || '').trim();
  if (!tk) { showBanner('Ticker is required (e.g. BTC).'); return null; }
  if (!/^[A-Z0-9._-]{1,12}$/.test(tk)) { showBanner('Ticker looks invalid — letters/numbers, up to 12 chars.'); return null; }
  if (!nm) nm = tk; // name defaults to ticker
  var kd = (typeof kind === 'string' && kind) ? kind.trim().toLowerCase() : 'crypto';
  if (kd !== 'crypto' && kd !== 'stock' && kd !== 'commodity' && kd !== 'custom' && kd !== 'cash') kd = 'crypto';
  var acc = { id: uid(), name: nm, ticker: tk, kind: kd, createdAt: new Date().toISOString() };
  if (extra && typeof extra === 'object') {
    if (typeof extra.address === 'string' && extra.address.trim() !== '') acc.address = extra.address.trim().slice(0, 128);
    if (typeof extra.note === 'string' && extra.note.trim() !== '') acc.note = extra.note.trim().slice(0, 280);
  }
  st.accounts.push(acc);
  if (!saveStateGuarded(st)) return null;
  clearBanner();
  render();
  return acc;
}

function openAccountDialog() {
  buildAccountDialog();
  openDialog('account-dialog');
  return null;
}

function renameAccount(id, name) {
  if (!id) return;
  var st = loadState();
  var acc = accountById(st, id);
  if (!acc) return;
  var nm = String(name === undefined || name === null ? '' : name).trim();
  if (!nm) { showBanner('Account name cannot be empty.'); return; }
  acc.name = nm;
  if (!saveStateGuarded(st)) return;
  clearBanner();
  render();
}

function deleteAccount(id) {
  if (!id) return;
  var st = loadState();
  var acc = accountById(st, id);
  if (!acc) return; // unknown id: no write, no dialog
  var n = accountTrades(st, id).length;
  var doomedSubs = groupMembers(st, id);
  var msg = 'Delete account "' + acc.name + '" (' + acc.ticker + ')' +
    (n ? ' and its ' + n + ' trade' + (n === 1 ? '' : 's') : '') +
    (doomedSubs.length ? ' and delete ' + doomedSubs.length + ' sub-account' + (doomedSubs.length === 1 ? '' : 's') + ' with all their trades' : '') +
    '? This cannot be undone.';
  confirmAction('Delete account', msg, 'Delete', true).then(function (ok) {
    if (!ok) return;
    var s2 = loadState();
    if (!accountById(s2, id)) return;
    var inSet = {};
    expandDeleteIds(s2, [id]).forEach(function (x) { inSet[x] = true; });
    s2.trades = (s2.trades || []).filter(function (t) { return !t || (!inSet[t.accountId] && !transferDestIds(t).some(function (x) { return !!inSet[x]; })); });
    s2.accounts = (s2.accounts || []).filter(function (a) { return !a || !inSet[a.id]; });
    if (!saveStateGuarded(s2)) return;
    try {
      Object.keys(inSet).forEach(function (x) { delete tradePageByAccount[x]; clearTradeTypeFilterState(x); });
    } catch (e) { /* ignore */ }
    clearBanner();
    render();
  });
}

function ungroupMain(mainId) {
  if (!mainId) return;
  var st = loadState();
  var acc = accountById(st, mainId);
  if (!acc) return;
  var n = groupMembers(st, mainId).length;
  if (!n) return;
  confirmAction('Ungroup', 'Release ' + n + ' sub-account' + (n === 1 ? '' : 's') + ' from "' + acc.name + '"? Records stay where they are.', 'Ungroup', false).then(function (ok) {
    if (!ok) return;
    var s2 = loadState();
    if (!accountById(s2, mainId)) return;
    ungroupAll(s2, mainId);
    if (!saveStateGuarded(s2)) return;
    clearBanner();
    render();
  });
}

// Direct sub-accounts, no home roundtrip: grouping target is this account
// (or its main when already grouped). A standalone account holding records
// moves them into sub-<name> and becomes the main; otherwise the sub starts
// empty with the same kind/ticker. Transfers pointing at the old account
// keep arriving there.
function createSubAccount(currentId) {
  if (!currentId) return;
  var st = loadState();
  var acc = accountById(st, currentId);
  if (!acc) return;
  if (groupMainOf(st, currentId)) { showBanner('Sub-accounts cannot have their own sub-accounts — create it in the main account instead.'); return; }
  var mainOf = groupMainOf(st, currentId);
  var parentMainId = mainOf ? mainOf.id : currentId;
  var nm = uniqueSubName(st, acc.name);
  var sub = { id: uid(), name: nm, ticker: acc.ticker, kind: acc.kind, createdAt: new Date().toISOString() };
  st.accounts.push(sub);
  sub.groupId = parentMainId;
  if (!mainOf && accountTrades(st, currentId).length > 0) {
    (st.trades || []).forEach(function (t) {
      if (t && t.accountId === currentId) t.accountId = sub.id;
    });
  }
  ensureGroupCurrency(st, parentMainId);
  if (!saveStateGuarded(st)) return;
  try { delete tradePageByAccount[currentId]; delete tradePageByAccount[sub.id]; clearTradeTypeFilterState(currentId); } catch (e) { /* ignore */ }
  clearBanner();
  navTo(parentMainId);
  render();
}

function deleteTrade(id) {
  if (!id) return;
  var st = loadState();
  var doomed = null;
  (st.trades || []).forEach(function (t) { if (t && t.id === id) doomed = t; });
  if (!doomed) return; // unknown id: no write
  // Swap legs live and die as a pair: deleting one side alone would orphan
  // the other (a costless sale booking phantom gains, or a purposeless buy
  // inflating holdings) and corrupt P&L.
  var pair = [];
  if (doomed.swapId) {
    (st.trades || []).forEach(function (t) {
      if (t && t.swapId === doomed.swapId && t.id !== doomed.id) pair.push(t);
    });
  }
  var desc = (doomed.type === 'sell' ? 'Sell ' : 'Buy ') + doomed.qty + ' ' +
    String(doomed.symbol || '') + ' (' + (doomed.date ? fmtDateDmy(doomed.date) : 'no date') + ')';
  var msg = pair.length
    ? 'Delete swap (' + desc + ' + its linked leg)? This cannot be undone.'
    : 'Delete trade ' + desc + '? This cannot be undone.';
  confirmAction('Delete trade', msg, 'Delete', true).then(function (ok) {
    if (!ok) return;
    var s2 = loadState();
    var drop = {};
    drop[id] = true;
    pair.forEach(function (t) { drop[t.id] = true; });
    var kept = (s2.trades || []).filter(function (t) { return !t || !drop[t.id]; });
    if (kept.length === (s2.trades || []).length) return;
    s2.trades = kept;
    if (!saveStateGuarded(s2)) return;
    render(); // cached live prices stay; no refetch needed on delete
  });
}

function buildAccountCreateRow() {
  var row = document.createElement('div');
  row.className = 'account-create-row';
  var fn = document.createElement('div');
  fn.className = 'fld';
  var ln = document.createElement('label');
  ln.setAttribute('for', 'acct-name');
  ln.textContent = 'Account name';
  var inName = document.createElement('input');
  inName.id = 'acct-name';
  inName.setAttribute('autocomplete', 'off');
  inName.setAttribute('spellcheck', 'false');
  inName.setAttribute('placeholder', 'e.g. Cold wallet');
  fn.appendChild(ln);
  fn.appendChild(inName);
  var ft = document.createElement('div');
  ft.className = 'fld';
  var lt = document.createElement('label');
  lt.setAttribute('for', 'acct-ticker');
  lt.textContent = 'Ticker';
  var inTick = document.createElement('input');
  inTick.id = 'acct-ticker';
  inTick.setAttribute('autocomplete', 'off');
  inTick.setAttribute('spellcheck', 'false');
  inTick.setAttribute('placeholder', 'e.g. BTC');
  ft.appendChild(lt);
  ft.appendChild(inTick);
  var create = document.createElement('button');
  create.type = 'button';
  create.id = 'acct-create';
  create.className = 'primary';
  create.textContent = 'Create account';
  row.appendChild(fn);
  row.appendChild(ft);
  row.appendChild(create);
  return row;
}

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
// data to protect. Throttled to one fetch per 60s per fiat.
var landingTickAt = 0;
var landingTickCur = '';
function refreshLandingTicker() {
  var main = 'EUR';
  try { main = String(loadState().settings.mainCurrency || 'EUR').toUpperCase(); } catch (e) { main = 'EUR'; }
  var syms = ['BTC', 'XAU', 'SPCX'];
  var ids = ['tick-btc', 'tick-xau', 'tick-spcx'];
  var now = Date.now();
  if (main === landingTickCur && (now - landingTickAt) < 60000) return;
  landingTickCur = main;
  landingTickAt = now;
  syms.forEach(function (s, i) {
    var el = document.getElementById(ids[i]);
    if (el) { el.textContent = '…'; paintLoading(el, true, s); }
  });
  // refreshAllPrices records the run in lastPriceErrors: save/restore it so
  // the ticker never disturbs the portfolio error state.
  var prevErr = null;
  try { prevErr = lastPriceErrors; } catch (e) { prevErr = null; }
  refreshAllPrices(syms, main, { BTC: 'crypto', XAU: 'commodity', SPCX: 'stock' }).then(function (out) {
    try { lastPriceErrors = prevErr; } catch (e) { /* keep */ }
    var curNow = 'EUR';
    try { curNow = String(loadState().settings.mainCurrency || 'EUR').toUpperCase(); } catch (e) { curNow = 'EUR'; }
    if (curNow !== main) return; // fiat moved mid-fetch: a newer run owns the paint
    syms.forEach(function (s, i) {
      var el = document.getElementById(ids[i]);
      if (!el) return;
      var v = out ? out[s] : null;
      paintLoading(el, false);
      el.textContent = (isFinite(Number(v)) && Number(v) > 0) ? fmtMoney(Number(v), main) : '—';
    });
  });
}

function buildAccounts() {
  var host = document.getElementById('accounts');
  if (host && !host.getAttribute('data-wired')) {
    host.setAttribute('data-wired', '1');
    host.addEventListener('click', function (e) {
      var t = e && e.target && e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.id === 'acct-create') {
        createAccount(uiVal('acct-name', ''), uiVal('acct-ticker', ''));
        return;
      }
      if (t.hasAttribute('data-guide-trade')) {
        openPrefillTrade(null);
        return;
      }
      if (t.hasAttribute('data-account-trade')) {
        openPrefillTrade(t.getAttribute('data-account-trade'), true);
        return;
      }
      if (t.hasAttribute('data-account-open')) {
        navTo(t.getAttribute('data-account-open'));
        return;
      }
      if (t.hasAttribute('data-account-rename')) {
        var rid = t.getAttribute('data-account-rename');
        var card = t.closest ? t.closest('[data-account]') : null;
        var headEl = t.closest ? t.closest('.account-head') : null;
        var nameEl = card ? card.querySelector('.account-name') : null;
        startInlineRename(rid, headEl, nameEl);
        return;
      }
      if (t.hasAttribute('data-account-delete')) {
        deleteAccount(t.getAttribute('data-account-delete'));
        return;
      }
      var del = e.target && e.target.closest ? e.target.closest('[data-del]') : null;
      if (del) {
        deleteTrade(del.getAttribute('data-del'));
        return;
      }
    });
  }
  var add = document.getElementById('tb-account');
  if (add && !add.getAttribute('data-wired')) {
    add.setAttribute('data-wired', '1');
    add.addEventListener('click', function () { openAccountDialog(); });
  }
  // Folder-card navigation (home → detail). Buttons keep their own
  // behavior; anything else on the card opens the account page.
  // Mousemove spotlight: cursor position feeds the card sheen (CSS vars).
  var navHost = document.getElementById('accounts');
  if (navHost && !navHost.getAttribute('data-nav-wired')) {
    navHost.setAttribute('data-nav-wired', '1');
    navHost.addEventListener('mousemove', function (e) {
      var card = e.target && e.target.closest ? e.target.closest('.account-card') : null;
      if (!card) return;
      var r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
    navHost.addEventListener('click', function (e) {
      if (!e || !e.target || !e.target.closest) return;
      if (suppressCardClick) { suppressCardClick = false; return; } // just finished a drag
      if (selectionMode) {
        var scard = e.target.closest('.account-card');
        if (scard && scard.getAttribute('data-account')) {
          toggleAccountSelect(scard.getAttribute('data-account'));
          return;
        }
      }
      if (e.target.closest('button')) return;
      var nav = e.target.closest('[data-account-nav]');
      if (nav && nav.getAttribute('data-account-nav')) {
        navTo(nav.getAttribute('data-account-nav'));
      }
    });
    navHost.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('button')) return;
      var nav = e.target.closest('[data-account-nav]');
      if (nav && nav.getAttribute('data-account-nav')) {
        e.preventDefault();
        navTo(nav.getAttribute('data-account-nav'));
      }
    });
  }
  wireAccountDnD();
  // Filter panel dismissal: click outside or Escape closes without render.
  if (!accountFilterOutsideWired && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    accountFilterOutsideWired = true;
    document.addEventListener('pointerdown', function (e) {
      var t = e && e.target;
      var inF = t && t.closest && (t.closest('[data-filter-panel]') || t.closest('[data-filter-btn]'));
      var inA = t && t.closest && (t.closest('[data-action-panel]') || t.closest('[data-action-btn]'));
      if (!inF) closeAccountFilter(false);
      if (!inF) closeTradeTypeFilter(false);
      if (!inA) closeAccountAction();
    });
    document.addEventListener('keydown', function (e) {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) { closeAccountFilter(true); closeTradeTypeFilter(true); closeAccountAction(); }
    });
  }
}

// --- Account drag-and-drop reorder (dice-grip handle, desktop) ---
// Order is the accounts array itself: saveState persists it to localStorage
// and export/import preserve it, so a reorder survives backup + restore with
// no extra fields. Drags start from the grip only; card clicks still open.

var ACCOUNT_PAGE_SIZE = 6;
var accountPage = 0;
// --- Trade pagination (per-account record list) ---
// Only the current page is ever built into DOM (DocumentFragment of at most
// pageSize tradeBlocks). Totals/P&L above still cover every trade; this only
// bounds the expensive per-record DOM + resolveExecPrice work per paint.
var TRADE_PAGE_SIZES = [15, 25, 50, 100];
var TRADE_PAGE_DEFAULT = 25;
var TRADE_PAGE_KEY = 'inoculens.tradepagesize.v1';
var tradePageSize = TRADE_PAGE_DEFAULT;
var tradePageByAccount = {}; // accountId -> 0-based page index
try {
  if (typeof localStorage !== 'undefined') {
    var _tps = Number(localStorage.getItem(TRADE_PAGE_KEY));
    if (TRADE_PAGE_SIZES.indexOf(_tps) !== -1) tradePageSize = _tps;
  }
} catch (e) { /* ignore: default stands */ }

function tradePageSizeGet() { return tradePageSize; }

function tradePageSizeSet(n) {
  var v = Number(n);
  if (TRADE_PAGE_SIZES.indexOf(v) === -1) return tradePageSize;
  tradePageSize = v;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TRADE_PAGE_KEY, String(v));
  } catch (e) { /* ignore */ }
  return tradePageSize;
}

function tradePageCountFor(total) {
  var t = Number(total) || 0;
  if (t <= 0) return 1;
  return Math.max(1, Math.ceil(t / tradePageSize));
}

function tradePageGet(accountId, total) {
  var pc = tradePageCountFor(total);
  var p = tradePageByAccount[accountId];
  if (!isFinite(p) || p < 0) p = 0;
  if (p > pc - 1) p = pc - 1;
  tradePageByAccount[accountId] = p;
  return p;
}

function tradePageSetFor(accountId, p, total) {
  var pc = tradePageCountFor(total);
  if (!isFinite(p) || p < 0) p = 0;
  if (p > pc - 1) p = pc - 1;
  tradePageByAccount[accountId] = p;
  return p;
}

// --- Trade-type filter (per-account record list) ---
// View-only multi-select over TRADE_TYPES, mirroring the home asset filter:
// null/absent = show every record, otherwise exactly these types. In-memory
// per account (like the page index, and unlike the home asset filter it is
// deliberately NOT persisted: no settings/export shape change). Totals and
// P&L above always cover every trade; only the visible list + pager follow.
var tradeTypeFilterByAccount = {}; // accountId -> normalized array of types
var tradeTypeFilterOpenByAccount = {}; // accountId -> bool (panel stays open across renders)
var tradeTypeFilterFocus = null; // type to refocus after render, then cleared

function normalizeTradeTypeFilter(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return null;
  var seen = {};
  var out = [];
  v.forEach(function (t) {
    var s = String(t === undefined || t === null ? '' : t).trim().toLowerCase();
    if (TRADE_TYPES.indexOf(s) === -1 || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out; // [] = none selected (valid: the list shows the no-match note)
}

function tradeTypeFilterFor(accountId) {
  if (typeof accountId !== 'string' || accountId === '') return null;
  if (!Object.prototype.hasOwnProperty.call(tradeTypeFilterByAccount, accountId)) return null;
  return normalizeTradeTypeFilter(tradeTypeFilterByAccount[accountId]);
}

function setTradeTypeFilter(accountId, next, focusType) {
  if (typeof accountId !== 'string' || accountId === '') return;
  var n = normalizeTradeTypeFilter(next);
  if (n === null) {
    try { delete tradeTypeFilterByAccount[accountId]; } catch (e) { /* ignore */ }
  } else {
    tradeTypeFilterByAccount[accountId] = n;
  }
  tradeTypeFilterFocus = focusType || null;
  try { tradePageByAccount[accountId] = 0; } catch (e) { /* page resets on next paint anyway */ }
  render();
}

function filterTradesByType(trades, filter) {
  if (!filter) return (trades || []).slice();
  return (trades || []).filter(function (t) {
    return !!t && filter.indexOf(String(t.type || '').toLowerCase()) !== -1;
  });
}

function clearTradeTypeFilterState(accountId) {
  try { delete tradeTypeFilterByAccount[accountId]; } catch (e) { /* ignore */ }
  try { delete tradeTypeFilterOpenByAccount[accountId]; } catch (e) { /* ignore */ }
}

function closeTradeTypeFilter(moveFocus) {
  var anyOpen = Object.keys(tradeTypeFilterOpenByAccount).some(function (id) {
    return !!tradeTypeFilterOpenByAccount[id];
  });
  tradeTypeFilterFocus = null;
  if (!anyOpen) return;
  Object.keys(tradeTypeFilterOpenByAccount).forEach(function (id) {
    tradeTypeFilterOpenByAccount[id] = false;
  });
  try {
    var host = document.getElementById('account-detail');
    var panel = host && host.querySelector ? host.querySelector('[data-filter-panel]') : null;
    if (panel) panel.hidden = true;
    var btn = host && host.querySelector ? host.querySelector('[data-filter-btn]') : null;
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      if (moveFocus && btn.focus) {
        try { btn.focus(); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
}

function restoreTradeTypeFilterFocus() {
  if (!tradeTypeFilterFocus) return;
  var anyOpen = Object.keys(tradeTypeFilterOpenByAccount).some(function (id) {
    return !!tradeTypeFilterOpenByAccount[id];
  });
  if (!anyOpen) { tradeTypeFilterFocus = null; return; }
  try {
    var host = document.getElementById('account-detail');
    var el = host && host.querySelector ? host.querySelector('[data-ttype="' + tradeTypeFilterFocus + '"]') : null;
    if (el && el.focus) el.focus();
  } catch (e) { /* ignore */ }
  tradeTypeFilterFocus = null;
}
var acctDrag = null; // {id,startX,startY,started,ghost,overId,after,flipTimer,flipCoolUntil,armedBtn}
var suppressCardClick = false;

function clearDropMarks() {
  var host = document.getElementById('accounts');
  if (!host || !host.querySelectorAll) return;
  Array.prototype.forEach.call(host.querySelectorAll('.account-card.drag-src,.account-card.drop-before,.account-card.drop-after'), function (el) {
    el.classList.remove('drag-src', 'drop-before', 'drop-after');
  });
}

function clearCardMarks() {
  var host = document.getElementById('accounts');
  if (!host || !host.querySelectorAll) return;
  Array.prototype.forEach.call(host.querySelectorAll('.account-card.drop-before,.account-card.drop-after'), function (el) {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function acctDragCardEl(id) {
  var host = document.getElementById('accounts');
  if (!host || !host.querySelector) return null;
  try {
    return host.querySelector('[data-account="' + String(id).replace(/"/g, '') + '"]');
  } catch (e) {
    return null;
  }
}

function visibleAccountIds(st) {
  var f = selectedTickers(st);
  return (st.accounts || []).filter(function (a) {
    return f === null || f.indexOf(String(a.ticker).toUpperCase()) !== -1;
  }).map(function (a) { return a.id; });
}

function pagerTargetPage(btn) {
  if (!btn || !btn.hasAttribute) return accountPage;
  if (btn.hasAttribute('data-page-prev')) return accountPage - 1;
  if (btn.hasAttribute('data-page-next')) return accountPage + 1;
  if (btn.hasAttribute('data-page-goto')) {
    var p = Number(btn.getAttribute('data-page-goto'));
    return isFinite(p) ? p : accountPage;
  }
  return accountPage;
}

function acctDragCleanup() {
  if (acctDrag && acctDrag.flipTimer) {
    try { clearTimeout(acctDrag.flipTimer); } catch (e) {}
  }
  if (acctDrag && acctDrag.ghost && acctDrag.ghost.parentNode) {
    try { acctDrag.ghost.parentNode.removeChild(acctDrag.ghost); } catch (e) {}
  }
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = '';
  } catch (e) {}
  try {
    var hintHost = (typeof document !== 'undefined') ? document.getElementById('accounts') : null;
    if (hintHost && hintHost.querySelectorAll) {
      Array.prototype.forEach.call(hintHost.querySelectorAll('[data-drag-hint]'), function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
    }
  } catch (e) {}
  clearDropMarks();
  acctDrag = null;
}

function markAcctDragSrc() {
  if (!acctDrag) return;
  var src = acctDragCardEl(acctDrag.id);
  if (src) src.classList.add('drag-src');
}

function acctStartDrag(src) {
  var r = null;
  try { r = src.getBoundingClientRect(); } catch (e) { r = null; }
  var ghost = null;
  try {
    ghost = src.cloneNode(true);
    ghost.classList.remove('drop-before', 'drop-after', 'drag-src');
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('id');
    ghost.style.width = (r && r.width ? r.width : 320) + 'px';
    ghost.style.left = (r ? r.left : 0) + 'px';
    ghost.style.top = (r ? r.top : 0) + 'px';
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(ghost);
    else ghost = null;
  } catch (e) { ghost = null; }
  acctDrag.started = true;
  acctDrag.ghost = ghost;
  suppressCardClick = true;
  acctShowDragHint();
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = 'none';
  } catch (e) {}
  markAcctDragSrc();
}

function acctShowDragHint() {
  try {
    var host = document.getElementById('accounts');
    if (!host) return;
    var st = loadState();
    if (visibleAccountIds(st).length <= ACCOUNT_PAGE_SIZE) return;
    if (host.querySelector && host.querySelector('[data-drag-hint]')) return;
    var hint = document.createElement('div');
    hint.className = 'pager-hint';
    hint.setAttribute('data-drag-hint', '1');
    hint.textContent = 'Drop on ‹ Prev, a page number, or Next › to move the card there';
    host.appendChild(hint);
  } catch (e) {}
}

function acctDisarmFlip() {
  if (acctDrag && acctDrag.flipTimer) {
    try { clearTimeout(acctDrag.flipTimer); } catch (e) {}
    acctDrag.flipTimer = null;
  }
  var host = document.getElementById('accounts');
  if (host && host.querySelectorAll) {
    Array.prototype.forEach.call(host.querySelectorAll('.page-btn.hot'), function (b) { b.classList.remove('hot'); });
  }
  if (acctDrag) acctDrag.armedBtn = null;
}

function acctFlipTo(page) {
  var st = loadState();
  var vis = visibleAccountIds(st);
  var pages = Math.max(1, Math.ceil(vis.length / ACCOUNT_PAGE_SIZE));
  if (page < 0 || page > pages - 1) return false;
  accountPage = page;
  render();
  if (acctDrag) {
    acctDrag.flipCoolUntil = Date.now() + 900;
    acctDrag.overId = null;
    acctDrag.after = false;
    markAcctDragSrc();
  }
  return true;
}

function wireAccountDnD() {
  var host = document.getElementById('accounts');
  if (!host || host.getAttribute('data-dnd-wired')) return;
  host.setAttribute('data-dnd-wired', '1');
  host.addEventListener('pointerdown', function (e) {
    var grip = e.target && e.target.closest ? e.target.closest('.drag-handle') : null;
    if (!grip) return;
    var card = grip.closest('.account-card');
    if (!card || !card.getAttribute('data-account')) return;
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    if (typeof e.clientX !== 'number') return;
    acctDrag = { id: card.getAttribute('data-account'), startX: e.clientX, startY: e.clientY, started: false, ghost: null, overId: null, after: false, flipTimer: null, flipCoolUntil: 0, armedBtn: null };
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
  });
  host.addEventListener('pointermove', function (e) {
    if (!acctDrag || !e || typeof e.clientX !== 'number') return;
    var dx = e.clientX - acctDrag.startX;
    var dy = e.clientY - acctDrag.startY;
    if (!acctDrag.started) {
      if (dx * dx + dy * dy < 49) return;
      var src = acctDragCardEl(acctDrag.id);
      if (!src) { acctDragCleanup(); return; }
      acctStartDrag(src);
    }
    if (acctDrag.ghost) {
      acctDrag.ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    var under = null;
    try {
      under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
    } catch (err) { under = null; }
    // Cross-page targets: pager buttons (prev, numbers, next) glow blue;
    // lingering on one flips the page while you keep holding.
    var pgBtn = under && under.closest ? under.closest('[data-page-prev],[data-page-next],[data-page-goto]') : null;
    var pgTarget = pgBtn ? pagerTargetPage(pgBtn) : accountPage;
    if (pgBtn && !pgBtn.disabled && pgTarget !== accountPage && Date.now() >= (acctDrag.flipCoolUntil || 0)) {
      if (acctDrag.armedBtn !== pgBtn) {
        acctDisarmFlip();
        acctDrag.armedBtn = pgBtn;
        pgBtn.classList.add('hot');
        acctDrag.flipTimer = setTimeout(function () {
          if (!acctDrag) return;
          acctDisarmFlip();
          acctFlipTo(pgTarget);
        }, 650);
      }
    } else {
      acctDisarmFlip();
    }
    clearCardMarks();
    var card = under && under.closest ? under.closest('.account-card') : null;
    acctDrag.overId = null;
    if (card && card.getAttribute('data-account') !== acctDrag.id) {
      var r = null;
      try { r = card.getBoundingClientRect(); } catch (err2) { r = null; }
      acctDrag.after = !!(r && (e.clientY - r.top) > r.height / 2);
      acctDrag.overId = card.getAttribute('data-account');
      card.classList.add(acctDrag.after ? 'drop-after' : 'drop-before');
    }
  });
  function acctFinishDrop(e) {
    if (!acctDrag) return;
    var wasStarted = acctDrag.started;
    var id = acctDrag.id;
    var overId = null;
    var after = false;
    var onPager = null;
    if (wasStarted && e && typeof e.clientX === 'number') {
      try {
        var under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
        var pb = under && under.closest ? under.closest('[data-page-prev],[data-page-next],[data-page-goto]') : null;
        if (pb && !pb.disabled) onPager = pb;
        else {
          var card = under && under.closest ? under.closest('.account-card') : null;
          if (card && card.getAttribute('data-account') !== id) {
            overId = card.getAttribute('data-account');
            var r = null;
            try { r = card.getBoundingClientRect(); } catch (err) { r = null; }
            after = !!(r && (e.clientY - r.top) > r.height / 2);
          }
        }
      } catch (err2) {}
    }
    acctDragCleanup();
    if (!wasStarted) return; // plain click: the nav handler opens the card
    var st = loadState();
    var vis = visibleAccountIds(st);
    if (vis.indexOf(id) === -1) { render(); return; }
    var fullIds = (st.accounts || []).map(function (a) { return a && a.id; });
    var fullFrom = fullIds.indexOf(id);
    var insertFull = -1;
    if (onPager) {
      var targetPage = pagerTargetPage(onPager);
      var pages = Math.max(1, Math.ceil(vis.length / ACCOUNT_PAGE_SIZE));
      if (targetPage < 0) targetPage = 0;
      if (targetPage > pages - 1) targetPage = pages - 1;
      if (targetPage === accountPage) { render(); return; } // dropped on the current page number
      // Prev + page numbers land at the page start, Next at the page end.
      var atEnd = onPager.hasAttribute && onPager.hasAttribute('data-page-next');
      accountPage = targetPage;
      var visIx = atEnd ? Math.min(vis.length, (targetPage + 1) * ACCOUNT_PAGE_SIZE) : targetPage * ACCOUNT_PAGE_SIZE;
      insertFull = visIx >= vis.length ? fullIds.length : fullIds.indexOf(vis[visIx]);
      if (insertFull === -1) insertFull = atEnd ? fullIds.length : 0;
    } else if (overId) {
      var visTo = vis.indexOf(overId);
      if (visTo === -1) { render(); return; }
      var wantVis = after ? visTo + 1 : visTo;
      insertFull = wantVis >= vis.length ? fullIds.length : fullIds.indexOf(vis[wantVis]);
      if (insertFull === -1) insertFull = fullIds.length;
    } else {
      render(); // released over nothing meaningful: snap back
      return;
    }
    var moved = st.accounts.splice(fullFrom, 1)[0];
    if (fullFrom < insertFull) insertFull--;
    if (insertFull !== fullFrom) {
      st.accounts.splice(insertFull, 0, moved);
      if (!saveStateGuarded(st)) { render(); return; }
    }
    render();
  }
  host.addEventListener('pointerup', acctFinishDrop);
  host.addEventListener('pointercancel', function () { acctDragCleanup(); });
}

// --- Sub-account drag-and-drop reorder (group mains) ---
// Same dice-grip pattern as the home list, scoped to one group's member
// cards. Order is the accounts array itself, so a sub reorder persists
// exactly like a home reorder (members stay hidden on home, so the home
// order is unaffected). Drags start from the grip only; card clicks still
// open the sub-account.
var subDrag = null; // {id,startX,startY,started,ghost,overId,after}

function subDragCleanup(wrap) {
  if (subDrag && subDrag.ghost && subDrag.ghost.parentNode) {
    try { subDrag.ghost.parentNode.removeChild(subDrag.ghost); } catch (e) {}
  }
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = '';
  } catch (e) {}
  try {
    var scope = (wrap && wrap.querySelectorAll) ? wrap : ((typeof document !== 'undefined') ? document.getElementById('account-detail') : null);
    if (scope && scope.querySelectorAll) {
      Array.prototype.forEach.call(scope.querySelectorAll('.account-card.drag-src,.account-card.drop-before,.account-card.drop-after'), function (el) {
        el.classList.remove('drag-src', 'drop-before', 'drop-after');
      });
    }
  } catch (e) {}
  subDrag = null;
}

function subStartDrag(wrap, src) {
  var r = null;
  try { r = src.getBoundingClientRect(); } catch (e) { r = null; }
  var ghost = null;
  try {
    ghost = src.cloneNode(true);
    ghost.classList.remove('drop-before', 'drop-after', 'drag-src');
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('id');
    ghost.style.width = (r && r.width ? r.width : 320) + 'px';
    ghost.style.left = (r ? r.left : 0) + 'px';
    ghost.style.top = (r ? r.top : 0) + 'px';
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(ghost);
    else ghost = null;
  } catch (e) { ghost = null; }
  subDrag.started = true;
  subDrag.ghost = ghost;
  suppressCardClick = true;
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = 'none';
  } catch (e) {}
  try {
    var cur = wrap && wrap.querySelector ? wrap.querySelector('[data-account="' + String(subDrag.id).replace(/"/g, '') + '"]') : null;
    if (cur) cur.classList.add('drag-src');
  } catch (e) {}
}

function subFinishDrop(wrap, e) {
  if (!subDrag) return;
  var wasStarted = subDrag.started;
  var id = subDrag.id;
  var overId = null;
  var after = false;
  if (wasStarted && e && typeof e.clientX === 'number') {
    try {
      var under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
      var card = under && under.closest ? under.closest('.group-subs .account-card') : null;
      if (card && wrap && typeof wrap.contains === 'function' && !wrap.contains(card)) card = null;
      if (card && card.getAttribute('data-account') !== id) {
        var r = null;
        try { r = card.getBoundingClientRect(); } catch (err) { r = null; }
        after = !!(r && (e.clientY - r.top) > r.height / 2);
        overId = card.getAttribute('data-account');
      }
    } catch (err2) {}
  }
  subDragCleanup(wrap);
  if (!wasStarted) return; // plain click: the wrap handler opens the card
  if (!overId) return; // released over nothing meaningful: snap back
  var st = null;
  try { st = loadState(); } catch (e2) { return; }
  var draggedAcc = accountById(st, id);
  var targetAcc = accountById(st, overId);
  var mainId = draggedAcc && typeof draggedAcc.groupId === 'string' ? draggedAcc.groupId : '';
  if (!draggedAcc || !targetAcc || !mainId || targetAcc.groupId !== mainId) return;
  var before = groupMembers(st, mainId).map(function (m) { return m.id; });
  if (before.indexOf(id) === -1 || before.indexOf(overId) === -1) return;
  var from = -1;
  for (var fi = 0; fi < st.accounts.length; fi++) {
    if (st.accounts[fi] && st.accounts[fi].id === id) { from = fi; break; }
  }
  if (from === -1) return;
  var moved = st.accounts.splice(from, 1)[0];
  var to = -1;
  for (var ti = 0; ti < st.accounts.length; ti++) {
    if (st.accounts[ti] && st.accounts[ti].id === overId) { to = ti; break; }
  }
  if (to === -1) return;
  if (after) to++;
  st.accounts.splice(to, 0, moved);
  var afterOrder = groupMembers(st, mainId).map(function (m) { return m.id; });
  var changed = afterOrder.length !== before.length ||
    afterOrder.some(function (mid, i) { return mid !== before[i]; });
  if (!changed) return; // adjacent no-op: visuals already match
  if (!saveStateGuarded(st)) { render(); return; }
  clearBanner();
  render();
}

function wireGroupSubsDnD(wrap) {
  if (!wrap || wrap.getAttribute('data-dnd-wired')) return;
  wrap.setAttribute('data-dnd-wired', '1');
  wrap.addEventListener('pointerdown', function (e) {
    var grip = e.target && e.target.closest ? e.target.closest('.drag-handle') : null;
    if (!grip) return;
    var card = grip.closest('.account-card');
    if (!card || !card.getAttribute('data-account')) return;
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    if (typeof e.clientX !== 'number') return;
    subDrag = { id: card.getAttribute('data-account'), startX: e.clientX, startY: e.clientY, started: false, ghost: null, overId: null, after: false };
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
  });
  wrap.addEventListener('pointermove', function (e) {
    if (!subDrag || !e || typeof e.clientX !== 'number') return;
    var dx = e.clientX - subDrag.startX;
    var dy = e.clientY - subDrag.startY;
    if (!subDrag.started) {
      if (dx * dx + dy * dy < 49) return;
      var src = null;
      try { src = wrap.querySelector('[data-account="' + String(subDrag.id).replace(/"/g, '') + '"]'); } catch (e2) { src = null; }
      if (!src) { subDragCleanup(wrap); return; }
      subStartDrag(wrap, src);
    }
    if (subDrag.ghost) {
      subDrag.ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    Array.prototype.forEach.call(wrap.querySelectorAll('.account-card.drop-before,.account-card.drop-after'), function (el) {
      el.classList.remove('drop-before', 'drop-after');
    });
    var under = null;
    try {
      under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
    } catch (err) { under = null; }
    var card = under && under.closest ? under.closest('.group-subs .account-card') : null;
    if (card && typeof wrap.contains === 'function' && !wrap.contains(card)) card = null;
    subDrag.overId = null;
    if (card && card.getAttribute('data-account') !== subDrag.id) {
      var r = null;
      try { r = card.getBoundingClientRect(); } catch (err2) { r = null; }
      subDrag.after = !!(r && (e.clientY - r.top) > r.height / 2);
      subDrag.overId = card.getAttribute('data-account');
      card.classList.add(subDrag.after ? 'drop-after' : 'drop-before');
    }
  });
  wrap.addEventListener('pointerup', function (e) { subFinishDrop(wrap, e); });
  wrap.addEventListener('pointercancel', function () { subDragCleanup(wrap); });
}

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
  var p = document.getElementById('na-error');
  if (!p) return;
  if (!msg) {
    p.textContent = '';
    p.hidden = true;
    return;
  }
  p.textContent = String(msg);
  p.hidden = false;
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
    '<p id="na-error" class="banner-error" role="alert" hidden></p>' +
    '<button id="na-create" class="primary" type="button">Create account</button>';
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

// --- Trade form ---
var TRADE_CCY_OPTIONS = ['EUR', 'USD', 'GBP', 'CHF', 'RON', 'USDC', 'USDT', 'DAI'];

function ccyOptions(selected) {
  var base = TRADE_CCY_OPTIONS.map(function (c) {
    return '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + c + '</option>';
  }).join('');
  return base + '<option value="CUSTOM"' + (selected === 'CUSTOM' ? ' selected' : '') + '>Other…</option>';
}

function buildTradeForm() {
  var host = document.getElementById('trade-dialog-body');
  if (!host || document.getElementById('trade-form')) return;
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<form id="trade-form">' +
    '<label for="t-side">Type</label>' +
    '<select id="t-side"><option value="buy">Buy</option><option value="sell">Sell</option><option value="transfer">Transfer (self move + gas)</option><option value="income">Income (reward / airdrop)</option><option value="expense">Expense / fee</option><option value="swap">Swap (coin → coin)</option></select>' +
    '<div id="t-account-row"><label for="t-account">Account</label>' +
    '<select id="t-account"></select></div>' +
    '<div id="t-toaccount-row" hidden><label for="t-toaccount">To account (optional)</label>' +
    '<select id="t-toaccount"></select><p class="fld-hint" id="t-toaccount-hint">Transfer moves cost basis — only the network + fiat fees count as losses.</p></div>' +
    '<div id="t-recipients" hidden><span class="fld-label">Recipients</span>' +
    '<div id="t-rec-list"></div>' +
    '<button type="button" id="t-rec-add">+ Add recipient</button>' +
    '<p class="fld-hint" id="t-rec-hint">One transaction, many recipients — internal moves keep their cost basis, external rows spend by default.</p></div>' +
    '<div id="t-selfrecv-row" hidden><label for="t-selfrecv" id="t-selfrecv-label">Received back (same account)</label>' +
    '<input id="t-selfrecv" inputmode="decimal" placeholder="e.g. 0.99">' +
    '<p class="fld-hint" id="t-selfrecv-hint">Amount that stayed in this account — the fee below fills in itself.</p></div>' +
    '<div class="fld-locked" hidden><span class="fld-label">Symbol (locked to account)</span> <span id="t-symbol-locked" role="status"></span></div>' +
    '<div id="t-qty-row"><label for="t-qty" id="t-qty-label">Quantity</label>' +
    '<input id="t-qty" inputmode="decimal" placeholder="e.g. 1">' +
    '<p class="fld-hint" id="t-qty-hint">Amount you received (net of any fee taken in asset).</p></div>' +
    '<div id="t-toqty-row" hidden><label for="t-toqty" id="t-toqty-label">Received quantity</label>' +
    '<input id="t-toqty" inputmode="decimal" placeholder="e.g. 15.2">' +
    '<p class="fld-hint" id="t-toqty-hint"></p></div>' +
    '<div id="t-total-row"><label for="t-total" id="t-total-label">Total (native currency)</label>' +
    '<input id="t-total" inputmode="decimal" placeholder="e.g. 50000">' +
    '<p class="fld-hint" id="t-total-hint">Full amount paid, including the fee below.</p></div>' +
    '<div id="t-currency-row"><label for="t-currency">Currency</label>' +
    '<select id="t-currency">' + ccyOptions('EUR') + '</select></div>' +
    '<label for="t-custom-ccy" id="t-custom-ccy-label" hidden>Custom currency code</label>' +
    '<input id="t-custom-ccy" autocomplete="off" spellcheck="false" placeholder="Code, e.g. JPY" hidden>' +
    '<label for="t-date">Date</label>' +
    '<input id="t-date" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="dd/mm/yyyy" maxlength="10">' +
    '<p class="fld-hint">Format dd/mm/yyyy.</p>' +
    '<details class="adv"><summary>Details</summary>' +
    '<div id="t-ledger-row" hidden><label for="t-ledger">Ledger (optional)</label>' +
    '<input id="t-ledger" autocomplete="off" spellcheck="false" placeholder="e.g. 1100" maxlength="24" list="t-ledger-codes">' +
    '<datalist id="t-ledger-codes"></datalist>' +
    '<label for="t-ledger-label">Ledger label (optional)</label>' +
    '<input id="t-ledger-label" autocomplete="off" spellcheck="false" placeholder="e.g. Income from X" maxlength="80">' +
    '<p class="fld-hint" id="t-ledger-hint">Bookkeeping code for this record — subledgers nest by prefix (1110 under 1100 under 1000).</p></div>' +
    '<div id="t-networkfee-row" hidden><label for="t-networkfee">Transfer fees (in same asset)</label>' +
    '<input id="t-networkfee" inputmode="decimal" placeholder="e.g. 0.0005" readonly>' +
    '<p class="fld-hint" id="t-networkfee-hint">Fee calculated automatically from the send and received inputs above.</p></div>' +
    '<div id="t-feefiat-row"><label for="t-fee">Fee (fiat, optional)</label>' +
    '<input id="t-fee" inputmode="decimal" placeholder="e.g. 0">' +
    '<p class="fld-hint">Denominated in the Currency above, like everything else on this trade. The total already includes it — the Real price is simply total ÷ qty (e.g. 50 EUR ÷ 0.00058193 BTC). Info only, zero P&L drag.</p></div>' +
    '<label for="t-note">Note (optional)</label>' +
    '<input id="t-note" autocomplete="off" placeholder="e.g. monthly savings">' +
    '<label for="t-txid">Transaction ID (optional)</label>' +
    '<input id="t-txid" autocomplete="off" spellcheck="false" placeholder="e.g. paste the tx hash">' +
    '<p class="fld-hint">Optional — saved with the record and linked to mempool.space.</p>' +
    '<div id="t-attach-row"><label for="t-attach">Attach invoice / receipt (optional)</label>' +
    '<input id="t-attach" type="file" accept="application/pdf,image/png,image/jpeg">' +
    '<p class="fld-hint" id="t-attach-hint">Optional — PDF, PNG or JPG up to 10 MB. Stored on this device, synced encrypted when sync is on.</p>' +
    '<p class="fld-hint" id="t-attach-cur" hidden></p>' +
    '<button type="button" id="t-attach-remove" hidden>Remove file</button></div>' +
    '<label for="t-manual-rate">Manual FX rate (optional fallback when ECB is unavailable)</label>' +
    '<input id="t-manual-rate" inputmode="decimal" placeholder="e.g. 0.92">' +
    '<label for="t-manual-price">Manual exec price (optional, this trade only, in trade fiat)</label>' +
    '<input id="t-manual-price" inputmode="decimal" placeholder="e.g. 67000">' +
    '</details>' +
    '<div class="fld-error-row"><p id="t-error" class="banner-error" role="alert" hidden></p>' +
    '<button type="button" id="t-error-close" aria-label="Dismiss this message" hidden>✕</button></div>' +
    '<button class="primary" type="submit" id="t-submit">Add record</button>' +
    '</form>';
  host.appendChild(wrap);
  var form = document.getElementById('trade-form');
  form.addEventListener('submit', onTradeSubmit);
  var acctSel = document.getElementById('t-account');
  if (acctSel) {
    acctSel.addEventListener('change', function () { syncLockedSymbol(); syncTradeTypeUI(); });
  }
  var sideSel = document.getElementById('t-side');
  if (sideSel) sideSel.addEventListener('change', syncTradeTypeUI);
  // One name per code: typing an existing code fills its current name when
  // the label is still empty (a different typed name renames everywhere on
  // save, same as the main Edit button).
  var ledCodeEl = document.getElementById('t-ledger');
  if (ledCodeEl) ledCodeEl.addEventListener('input', function () {
    try {
      var labEl = document.getElementById('t-ledger-label');
      if (!labEl || String(labEl.value || '').trim() !== '') return;
      var code = String(ledCodeEl.value || '').trim();
      if (!code) return;
      var stL = loadState();
      var accId = uiVal('t-account', '');
      if (!accountById(stL, accId)) return;
      var scope = null;
      try { scope = ledgerScopeOf(stL, accId); } catch (e) { scope = null; }
      var known = findLedgerLabel(stL, accId, code, scope);
      if (known) labEl.value = known;
    } catch (e) { /* never block typing */ }
  });
  var qtyEl = document.getElementById('t-qty');
  if (qtyEl) qtyEl.addEventListener('input', function () { try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var selfRecvEl = document.getElementById('t-selfrecv');
  if (selfRecvEl) selfRecvEl.addEventListener('input', function () { try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var toQtyEl = document.getElementById('t-toqty');
  if (toQtyEl) toQtyEl.addEventListener('input', function () { try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var recAdd = document.getElementById('t-rec-add');
  if (recAdd) recAdd.addEventListener('click', function () { try { addRecipientRow(); } catch (e) { /* ignore */ } try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var toSel = document.getElementById('t-toaccount');
  if (toSel) toSel.addEventListener('change', function () { try { syncTradeTypeUI(); } catch (e) { /* hint only */ } });
  var ccy = document.getElementById('t-currency');
  var custom = document.getElementById('t-custom-ccy');
  ccy.addEventListener('change', function () {
    var needCustom = (ccy.value === 'CUSTOM');
    custom.hidden = !needCustom;
    var clabel = document.getElementById('t-custom-ccy-label');
    if (clabel) clabel.hidden = !needCustom;
  });
  var attInp = document.getElementById('t-attach');
  if (attInp) attInp.addEventListener('change', function () {
    try {
      pendingAttachFile = (attInp.files && attInp.files[0]) ? attInp.files[0] : null;
      if (pendingAttachFile) pendingAttachRemove = false;
      var cur = document.getElementById('t-attach-cur');
      if (pendingAttachFile && cur) { cur.textContent = 'New file: ' + pendingAttachFile.name; cur.hidden = false; }
      attUiSync();
    } catch (e) { /* never block the form */ }
  });
  var attRm = document.getElementById('t-attach-remove');
  if (attRm) attRm.addEventListener('click', function () {
    pendingAttachFile = null;
    try { if (attInp) attInp.value = ''; } catch (e) { /* ignore */ }
    if (currentAttachMeta) pendingAttachRemove = true;
    else pendingAttachRemove = false;
    attUiSync();
  });
  syncTradeTypeUI();
}

// --- Multi-recipient transfer rows (form) ---
// One transaction, N recipients. Internal rows pick an own account;
// external rows take a label (Spend on = expense-like, off = neutral).
// The tx fee is sent − received; optional per-row fees attribute part of it.
function clearRecipientRows() {
  try {
    var list = document.getElementById('t-rec-list');
    if (list) list.innerHTML = '';
  } catch (e) { /* ignore */ }
}

function readRecipientRows() {
  var rows = [];
  try {
    var list = document.getElementById('t-rec-list');
    if (!list) return rows;
    var els = list.querySelectorAll ? list.querySelectorAll('.rec-row') : [];
    for (var i = 0; i < els.length; i++) {
      (function (row) {
        function q(sel) { var el = row.querySelector(sel); return el ? el : null; }
        function v(sel) { var el = q(sel); return el ? el.value : ''; }
        var kind = v('.rec-kind') === 'external' ? 'external' : 'internal';
        var spendEl = q('.rec-spend');
        rows.push({
          kind: kind,
          accountId: v('.rec-account'),
          label: v('.rec-label'),
          qty: v('.rec-qty'),
          fee: v('.rec-fee'),
          spend: spendEl ? !!spendEl.checked : true,
          toQty: v('.rec-toqty'),
          toSymbol: row.getAttribute('data-tosymbol') || ''
        });
      })(els[i]);
    }
  } catch (e) { /* ignore */ }
  return rows;
}

function syncRecipientRowMode(row) {
  try {
    if (!row) return;
    var kindEl = row.querySelector('.rec-kind');
    var kind = (kindEl && kindEl.value === 'external') ? 'external' : 'internal';
    var accW = row.querySelector('.rec-acc-wrap');
    var labW = row.querySelector('.rec-label-wrap');
    var spW = row.querySelector('.rec-spend-wrap');
    var toW = row.querySelector('.rec-toqty-wrap');
    if (accW) accW.hidden = (kind !== 'internal');
    if (labW) labW.hidden = (kind !== 'external');
    if (spW) spW.hidden = (kind !== 'external');
    // Cross-fiat arrival (cash): the received amount rides in the dest fiat.
    var showTo = false;
    if (kind === 'internal' && toW) {
      try {
        var st = loadState();
        var fromAcc = accountById(st, uiVal('t-account', ''));
        var pickAcc = accountById(st, (row.querySelector('.rec-account') || {}).value || '');
        if (fromAcc && pickAcc && isCashKind(fromAcc.kind) && isCashKind(pickAcc.kind) &&
          String(fromAcc.ticker).toUpperCase() !== String(pickAcc.ticker).toUpperCase()) {
          showTo = true;
          row.setAttribute('data-tosymbol', String(pickAcc.ticker).toUpperCase());
        } else {
          row.removeAttribute('data-tosymbol');
        }
      } catch (e) { showTo = false; }
    } else {
      try { row.removeAttribute('data-tosymbol'); } catch (e) { /* ignore */ }
    }
    if (toW) toW.hidden = !showTo;
  } catch (e) { /* ignore */ }
}

// Rebuild every internal row's account dropdown: same-asset accounts for
// crypto, every other cash account for cash (a different-fiat pick turns
// the row into a cross-fiat arrival). The current pick is always kept so
// edits of older records never lose their destination.
function refreshRecipientAccounts() {
  try {
    var list = document.getElementById('t-rec-list');
    if (!list || !list.querySelectorAll) return;
    var st = loadState();
    var fromId = uiVal('t-account', '');
    var fromAcc = accountById(st, fromId);
    var symU = fromAcc ? String(fromAcc.ticker || '').toUpperCase() : '';
    var isCash = !!(fromAcc && isCashKind(fromAcc.kind));
    var rows = list.querySelectorAll('.rec-row');
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var sel = row.querySelector('.rec-account');
        if (!sel) return;
        var cur = sel.value;
        sel.innerHTML = '';
        (st.accounts || []).forEach(function (a) {
          if (!a || a.id === fromId) return;
          if (isCash) {
            if (!isCashKind(a.kind)) return;
          } else {
            if (isCashKind(a.kind)) return;
            if (String(a.ticker).toUpperCase() !== symU) return;
          }
          var o = document.createElement('option');
          o.value = a.id;
          o.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
          sel.appendChild(o);
        });
        var has = false;
        for (var k = 0; k < sel.options.length; k++) if (sel.options[k].value === cur) { has = true; break; }
        if (cur && has) sel.value = cur;
        else if (cur && !has && accountById(st, cur)) {
          var keep = document.createElement('option');
          var ka = accountById(st, cur);
          keep.value = cur;
          keep.textContent = ka.name + ' · ' + String(ka.ticker).toUpperCase();
          sel.appendChild(keep);
          sel.value = cur;
        } else if (sel.options.length) sel.selectedIndex = 0;
        syncRecipientRowMode(row);
      })(rows[i]);
    }
  } catch (e) { /* ignore */ }
}

// Stored outputs from validated recipient rows: internal rows name the
// account, external rows the label (spend:false only for neutral rows —
// absent means spend). Optional per-row fees and cross-fiat arrivals ride
// along; legacy single-dest fields are never written with outputs.
function buildTransferOutputs(rows) {
  var out = [];
  (rows || []).forEach(function (r) {
    if (!r) return;
    var o = { qty: Number(r.qty) };
    if (r.kind === 'internal') {
      o.toAccountId = String(r.accountId || '').trim();
    } else {
      o.label = String(r.label || '').trim();
      if (r.spend === false) o.spend = false;
    }
    if (String(r.fee || '').trim() !== '') o.fee = Number(r.fee);
    if (String(r.toQty || '').trim() !== '' && r.toSymbol) {
      o.toQty = Number(r.toQty);
      o.toSymbol = String(r.toSymbol).toUpperCase();
    }
    out.push(o);
  });
  return out;
}

function addRecipientRow(data) {
  data = data || {};
  var list = document.getElementById('t-rec-list');
  if (!list) return null;
  var row = document.createElement('div');
  row.className = 'rec-row';
  row.innerHTML =
    '<div class="rec-grid">' +
    '<label>Kind<select class="rec-kind"><option value="internal">Internal — own account</option><option value="external">External — someone else</option></select></label>' +
    '<label class="rec-acc-wrap">Account<select class="rec-account"></select></label>' +
    '<label class="rec-label-wrap" hidden>Label<input class="rec-label" autocomplete="off" spellcheck="false" maxlength="80" placeholder="e.g. friend / merchant"></label>' +
    '<label>Amount<input class="rec-qty" inputmode="decimal" placeholder="e.g. 0.1"></label>' +
    '<label class="rec-toqty-wrap" hidden>Received (dest fiat)<input class="rec-toqty" inputmode="decimal" placeholder="e.g. 15.2"></label>' +
    '<label>Fee share (optional)<input class="rec-fee" inputmode="decimal" placeholder="e.g. 0.0001"></label>' +
    '</div>' +
    '<label class="rec-spend-wrap" hidden><input type="checkbox" class="rec-spend" checked> Spend (counts as expense — untick for a neutral hand-over)</label>' +
    '<button type="button" class="rec-remove quiet">Remove</button>';
  list.appendChild(row);
  function changed() { try { syncRecipientRowMode(row); } catch (e) { /* ignore */ } try { syncTransferFeePreview(); } catch (e) { /* ignore */ } }
  var kind = row.querySelector('.rec-kind');
  if (kind) kind.addEventListener('change', function () { try { refreshRecipientAccounts(); } catch (e) { /* ignore */ } changed(); });
  ['.rec-account', '.rec-qty', '.rec-fee', '.rec-toqty', '.rec-label'].forEach(function (sel) {
    var el = row.querySelector(sel);
    if (el) el.addEventListener('input', changed);
    if (el && sel === '.rec-account') el.addEventListener('change', changed);
  });
  var sp = row.querySelector('.rec-spend');
  if (sp) sp.addEventListener('change', changed);
  var rm = row.querySelector('.rec-remove');
  if (rm) rm.addEventListener('click', function () { try { row.parentNode.removeChild(row); } catch (e) { /* ignore */ } try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  try {
    if (data.kind === 'external' && kind) kind.value = 'external';
    if (data.accountId) {
      var sel0 = row.querySelector('.rec-account');
      if (sel0) {
        var tmp = document.createElement('option');
        tmp.value = data.accountId;
        tmp.textContent = data.accountId;
        sel0.appendChild(tmp);
        sel0.value = data.accountId;
      }
    }
    if (data.label) row.querySelector('.rec-label').value = data.label;
    if (data.qty !== undefined) row.querySelector('.rec-qty').value = data.qty;
    if (data.fee !== undefined) row.querySelector('.rec-fee').value = data.fee;
    if (data.toQty !== undefined && row.querySelector('.rec-toqty')) row.querySelector('.rec-toqty').value = data.toQty;
    if (data.spend === false && sp) sp.checked = false;
  } catch (e) { /* ignore */ }
  try { refreshRecipientAccounts(); } catch (e) { /* ignore */ }
  try { if (data.accountId) row.querySelector('.rec-account').value = data.accountId; } catch (e) { /* ignore */ }
  try { syncRecipientRowMode(row); } catch (e) { /* ignore */ }
  return row;
}

function syncTradeTypeUI() {
  var sideEl = document.getElementById('t-side');
  var type = sideEl ? sideEl.value : 'buy';
  function setHidden(id, hide) { var el = document.getElementById(id); if (el) el.hidden = !!hide; }
  function setLabel(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }
  // Cash accounts are bookkeeping ledgers: only money-movement types.
  // (Legacy buy/sell/swap records on cash stay editable, never creatable.)
  var cashAcc = null;
  try { cashAcc = accountById(loadState(), uiVal('t-account', '')); } catch (e) { cashAcc = null; }
  var isCash = !!(cashAcc && isCashKind(cashAcc.kind));
  var cashTicker = isCash ? String(cashAcc.ticker || '').toUpperCase() : '';
  var legacyCashEdit = false;
  try { legacyCashEdit = !!(editingTradeId && (type === 'buy' || type === 'sell' || type === 'swap')); } catch (e) { legacyCashEdit = false; }
  if (isCash && !legacyCashEdit && sideEl) {
    var want = ['income', 'expense', 'transfer'];
    var labels = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };
    var cur = sideEl.value;
    sideEl.innerHTML = '';
    want.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = labels[v];
      sideEl.appendChild(o);
    });
    sideEl.value = (want.indexOf(cur) !== -1) ? cur : 'income';
    type = sideEl.value;
  } else if (!isCash && sideEl && sideEl.options && sideEl.options.length !== 6) {
    // Back to a non-cash account: restore the full type list.
    var full = ['buy', 'sell', 'transfer', 'income', 'expense', 'swap'];
    var fullLabels = { buy: 'Buy', sell: 'Sell', transfer: 'Transfer (self move + gas)', income: 'Income (reward / airdrop)', expense: 'Expense / fee', swap: 'Swap (coin → coin)' };
    var curF = sideEl.value;
    sideEl.innerHTML = '';
    full.forEach(function (v) {
      var oo = document.createElement('option');
      oo.value = v;
      oo.textContent = fullLabels[v];
      sideEl.appendChild(oo);
    });
    if (full.indexOf(curF) !== -1) sideEl.value = curF;
    type = sideEl.value;
  }
  var isTransfer = type === 'transfer';
  var isSwap = type === 'swap';
  var isIncome = type === 'income';
  var isExpense = type === 'expense';
  var isBuySell = type === 'buy' || type === 'sell';
  setHidden('t-toaccount-row', !isSwap);
  // Attachments ride single-leg records; swaps create two linked legs, so
  // files attach by editing the resulting buy/sell instead.
  setHidden('t-attach-row', isSwap);
  setHidden('t-toqty-row', !isSwap);
  setHidden('t-recipients', !isTransfer);
  setHidden('t-selfrecv-row', !isTransfer);
  setHidden('t-networkfee-row', !(isTransfer));
  // Transfers carry no fiat of their own: the network fee IS the fee, valued
  // in fiat at the frozen historical rate. Fiat fee + total + currency stay
  // for the other types only.
  setHidden('t-feefiat-row', isTransfer);
  setHidden('t-total-row', isTransfer);
  setHidden('t-currency-row', isTransfer);
  if (isTransfer) {
    var custT = document.getElementById('t-custom-ccy');
    if (custT) custT.hidden = true;
    var clabT = document.getElementById('t-custom-ccy-label');
    if (clabT) clabT.hidden = true;
  }
  if (isTransfer) {
    setLabel('t-qty-label', 'You send (total)');
    setLabel('t-qty-hint', 'Total leaving the source — recipients + fee must equal this.');
    setLabel('t-total-label', 'Fiat fee value (optional, leave 0)');
    setLabel('t-total-hint', 'Optional cash fee on top — leave empty when the fee is crypto-only.');
  } else if (isSwap) {
    setLabel('t-qty-label', 'From quantity (you send)');
    setLabel('t-toqty-label', 'Received quantity');
    setLabel('t-total-label', 'Fiat value of swap (for tax, e.g. 50000)');
    setLabel('t-qty-hint', 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  } else if (isIncome) {
    setLabel('t-qty-label', isCash ? ('Amount (in ' + cashTicker + ')') : 'Quantity received');
    setLabel('t-total-label', 'Market value at receipt (optional, 0 = free)');
    setLabel('t-qty-hint', isCash ? 'Money in, in the account currency.' : 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  } else if (isExpense) {
    setLabel('t-qty-label', isCash ? ('Amount (in ' + cashTicker + ')') : 'Quantity lost (optional if cash-only)');
    setLabel('t-total-label', 'Fiat lost (optional if crypto-only)');
    setLabel('t-qty-hint', isCash ? 'Money out, in the account currency.' : 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  } else {
    setLabel('t-qty-label', 'Quantity');
    setLabel('t-total-label', 'Total (native currency)');
    setLabel('t-qty-hint', 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  }
  // Cash income/expense amounts live in the account fiat alone: the total
  // and currency rows hide (submit derives total=qty, currency=ticker).
  var cashSimple = isCash && (isIncome || isExpense);
  if (cashSimple) {
    setHidden('t-total-row', true);
    setHidden('t-currency-row', true);
    var custC = document.getElementById('t-custom-ccy');
    if (custC) custC.hidden = true;
    var clabC = document.getElementById('t-custom-ccy-label');
    if (clabC) clabC.hidden = true;
  }
  // Ledger row: cash income/expense always; asset income/expense only when
  // the global switch is on (optional at submit, required never).
  setHidden('t-ledger-row', !tradeLedgerAllowed(isCash, type));
  try {
    var dl = document.getElementById('t-ledger-codes');
    if (dl && tradeLedgerAllowed(isCash, type)) {
      var known = {};
      try {
        var stL = loadState();
        var dlScope = null;
        try { dlScope = ledgerScopeOf(stL, cashAcc.id); } catch (e) { dlScope = null; }
        if (!dlScope || !dlScope.length) dlScope = [cashAcc.id];
        var inDl = {};
        dlScope.forEach(function (sid) { inDl[sid] = true; });
        ((stL && stL.trades) || []).forEach(function (t) {
          if (t && inDl[t.accountId] && t.ledger && String(t.ledger).trim() !== '') known[String(t.ledger).trim()] = true;
        });
        var mapL = null;
        try {
          var chartAcc = cashAcc.id;
          var gmChart = groupMainOf(stL, cashAcc.id);
          if (gmChart) chartAcc = gmChart.id;
          mapL = ledgerChartFor(stL, chartAcc);
        } catch (e) { mapL = ledgerChartFor(stL, cashAcc.id); }
        Object.keys(mapL).forEach(function (k) { known[String(k).trim()] = true; });
      } catch (e) { /* ignore */ }
      dl.innerHTML = '';
      Object.keys(known).sort().forEach(function (c) {
        var op = document.createElement('option');
        op.value = c;
        dl.appendChild(op);
      });
    }
  } catch (e) { /* ignore */ }
  if (!isTransfer) {
    // Leaving a transfer must restore the custom-currency input when the
    // (now visible again) Currency select sits on Other….
    try {
      var ccySel = document.getElementById('t-currency');
      var needCustom = !!(ccySel && ccySel.value === 'CUSTOM');
      var custR = document.getElementById('t-custom-ccy');
      if (custR) custR.hidden = !needCustom;
      var clabR = document.getElementById('t-custom-ccy-label');
      if (clabR) clabR.hidden = !needCustom;
    } catch (e) { /* ignore */ }
  }
  // Rebuild to-account options for swaps (any other account). Transfers use
  // the recipients list below instead of this single select.
  try {
    var st = loadState();
    var fromId = uiVal('t-account', '');
    var fromAcc = accountById(st, fromId);
    var toSel = document.getElementById('t-toaccount');
    var hint = document.getElementById('t-toaccount-hint');
    if (toSel && isSwap) {
      var cur = toSel.value;
      toSel.innerHTML = '';
      var curKept = false;
      (st.accounts || []).forEach(function (a) {
        if (a.id === fromId) return;
        var o = document.createElement('option');
        o.value = a.id;
        o.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
        toSel.appendChild(o);
        if (a.id === cur) curKept = true;
      });
      if (cur && curKept) toSel.value = cur;
      else if (toSel.options.length) toSel.selectedIndex = 0;
      if (hint) hint.textContent = 'Transfer moves cost basis — only the network + fiat fees count as losses.';
    }
    if (isTransfer) {
      try { refreshRecipientAccounts(); } catch (e) { /* ignore */ }
      if (isCash) setLabel('t-qty-label', 'You send (total, in ' + cashTicker + ')');
    }
  } catch (e) { /* ignore */ }
  void isBuySell; void isIncome; void isExpense;
  try { syncTransferFeePreview(); } catch (e) { /* ignore */ }
}

// Transfer send/receive helper: fee = sent − received. The fee field is
// computed-only (read-only in the form): the two amounts are the source of
// truth, so a saved fee can never contradict them. Received is required.
// Derived amounts are rounded to 8 decimals (the app's quantity precision):
// raw binary subtraction leaves dust like 0.000017260000000000062.
function roundQty8(v) {
  var r = Math.round(Number(v) * 1e8) / 1e8;
  return (Math.abs(r) < 1e-12) ? 0 : r;
}
function transferFeeFrom(sentRaw, recvRaw) {
  var sent = Number(sentRaw);
  var recv = Number(recvRaw);
  if (String(recvRaw).trim() === '') return null;
  if (!isFinite(sent) || sent <= 0) return null;
  if (!isFinite(recv) || recv <= 0 || recv > sent) return null;
  var fee = roundQty8(sent - recv);
  if (!(fee >= 0 && fee < sent)) return null;
  return { sent: sent, recv: recv, fee: fee };
}

function syncTransferFeePreview() {
  var sideEl = document.getElementById('t-side');
  if (!sideEl || sideEl.value !== 'transfer') return;
  var hint = document.getElementById('t-rec-hint');
  var feeInput = document.getElementById('t-networkfee');
  var selfRow = document.getElementById('t-selfrecv-row');
  var rows = readRecipientRows();
  var sent = Number(uiVal('t-qty', ''));
  var sentOk = isFinite(sent) && sent > 0;
  var sym = '';
  try {
    var acc = accountById(loadState(), uiVal('t-account', ''));
    if (acc) sym = ' ' + String(acc.ticker).toUpperCase();
  } catch (e) { sym = ''; }
  if (!feeInput) return;
  // The fee is always computed — the field never unlocks. With recipients
  // it is sent − received across rows; with none (same-account move) it is
  // sent − received-back below.
  try { feeInput.setAttribute('readonly', ''); } catch (e) { /* ignore */ }
  if (selfRow) selfRow.hidden = rows.length > 0;
  if (!rows.length) {
    var r = transferFeeFrom(uiVal('t-qty', ''), uiVal('t-selfrecv', ''));
    if (!r) {
      var recvTxt = String(uiVal('t-selfrecv', '')).trim();
      feeInput.value = '';
      if (hint) hint.textContent = recvTxt === '' ? 'Enter what arrived back — the fee below fills in itself.' : 'Received back must be > 0 and at most what you sent.';
      return;
    }
    feeInput.value = String(r.fee);
    if (hint) {
      hint.textContent = r.fee === 0
        ? 'No fee — everything stayed in this account.'
        : 'Fee ' + String(r.fee) + sym + ' will be recorded as the loss.';
    }
    return;
  }
  // Single cross-fiat row: the arrival is a converted amount, not sent − fee.
  if (rows.length === 1 && rows[0].kind === 'internal' && rows[0].toSymbol) {
    feeInput.value = '0';
    if (hint) hint.textContent = 'Converted at the trade-date rate — enter what arrives in the destination fiat.';
    return;
  }
  var sum = 0, ok = true, feeSum = 0;
  rows.forEach(function (r) {
    var q = Number(r.qty);
    if (!isFinite(q) || q <= 0) ok = false;
    else sum += q;
    if (String(r.fee || '').trim() !== '') {
      var f = Number(r.fee);
      if (!isFinite(f) || f < 0) ok = false;
      else feeSum += f;
    }
  });
  sum = roundQty8(sum);
  if (!sentOk) {
    feeInput.value = '';
    if (hint) hint.textContent = 'Enter how much you sent first — the fee below fills in itself.';
    return;
  }
  if (!ok) {
    feeInput.value = '';
    if (hint) hint.textContent = 'Each recipient needs an amount > 0.';
    return;
  }
  var fee = roundQty8(sent - sum);
  if (!(fee >= 0)) {
    feeInput.value = '';
    if (hint) hint.textContent = 'Recipients exceed sent — lower an amount.';
    return;
  }
  feeInput.value = String(fee);
  if (hint) {
    var n = rows.length + (rows.length === 1 ? ' recipient' : ' recipients');
    if (feeSum - fee > 1e-12) {
      hint.textContent = 'Row fees exceed the tx fee (' + fee + sym + ') — lower a fee share.';
    } else {
      hint.textContent = fee === 0
        ? 'No fee — received equals sent across ' + n + '.'
        : 'Fee ' + fee + sym + ' shared across ' + n + (feeSum > 0 ? ' (' + roundQty8(feeSum) + ' attributed per row).' : '.');
    }
  }
}

// --- Account-bound trade dialog (Task 3) ---
// First field is the Account select (options rebuilt on every open);
// the symbol is shown locked read-only to that account's ticker.
// openPrefillTrade(accountId|null) preselects the originating card's
// account (or the default for null/unknown) and opens the dialog.

function syncLockedSymbol() {
  var sel = document.getElementById('t-account');
  var locked = document.getElementById('t-symbol-locked');
  if (!sel || !locked) return;
  var acc = accountById(loadState(), sel.value);
  locked.textContent = acc ? String(acc.ticker).toUpperCase() : '';
}

var editingTradeId = null;

// Pending attachment for the open trade dialog: a newly picked File, a
// remove flag, and the metadata of the record being edited (if any).
var pendingAttachFile = null;
var pendingAttachRemove = false;
var currentAttachMeta = null;
var pendingAttachResolved = 'keep'; // 'keep' | null | {name,mime,size,hash}
function attUiSync() {
  try {
    var cur = document.getElementById('t-attach-cur');
    var rm = document.getElementById('t-attach-remove');
    var inp = document.getElementById('t-attach');
    var label = '';
    var removed = !pendingAttachFile && pendingAttachRemove;
    if (pendingAttachFile) label = 'New file: ' + pendingAttachFile.name;
    else if (removed) label = '✓ Removed — press "Save changes" to confirm.';
    else if (currentAttachMeta) label = 'Attached: ' + currentAttachMeta.name;
    if (cur) {
      cur.textContent = label;
      cur.hidden = !label;
      try { cur.style.color = removed ? 'var(--gain)' : ''; } catch (e) { /* ignore */ }
    }
    if (rm) rm.hidden = !(pendingAttachFile || currentAttachMeta);
  } catch (e) { /* never block the form */ }
}
function attReset(meta) {
  pendingAttachFile = null;
  pendingAttachRemove = false;
  currentAttachMeta = (meta && isValidAttachment(meta)) ? meta : null;
  pendingAttachResolved = 'keep';
  try { var inp = document.getElementById('t-attach'); if (inp) inp.value = ''; } catch (e) { /* ignore */ }
  attUiSync();
}
// Resolves the dialog attachment plan into metadata for the trade being
// saved: cb(err, meta|'keep'|null). New files are hashed + stored in
// IndexedDB first; removals delete best-effort; 'keep' preserves edits.
function attResolveForSave(cb) {
  if (pendingAttachFile) {
    var f = pendingAttachFile;
    if (ATTACH_MIMES.indexOf(f.type) === -1) { cb('Only PDF, PNG or JPG files can be attached.'); return; }
    if (!f.size || f.size > ATTACH_MAX_BYTES) { cb('File is too large — up to 10 MB.'); return; }
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var buf = rd.result;
        attHashBytes(buf).then(function (hash) {
          var meta = { name: String(f.name).slice(0, 120), mime: f.type, size: f.size, hash: hash };
          attPut(hash, new Blob([buf], { type: f.type }), meta).then(function (ok) {
            if (!ok) { cb('Could not store the file on this device — record was not saved.'); return; }
            cb(null, meta);
          });
        }, function () { cb('Could not read the file — record was not saved.'); });
      } catch (e) { cb('Could not read the file — record was not saved.'); }
    };
    rd.onerror = function () { cb('Could not read the file — record was not saved.'); };
    try { rd.readAsArrayBuffer(f); } catch (e) { cb('Could not read the file — record was not saved.'); }
    return;
  }
  if (pendingAttachRemove && currentAttachMeta) {
    (function (h) { try { attDelete(h); } catch (e) { /* best-effort */ } })(currentAttachMeta.hash);
    cb(null, null);
    return;
  }
  cb(null, 'keep');
}

// Fresh-trade reset: a new dialog must never inherit type, amounts, notes or
// destination picks from the previous entry — otherwise e.g. a Transfer's
// To-account row leaks into the next Buy.
function resetTradeForm() {
  editingTradeId = null;
  uiSetVal('t-side', 'buy');
  uiSetVal('t-qty', '');
  uiSetVal('t-toqty', '');
  uiSetVal('t-selfrecv', '');
  clearRecipientRows();
  uiSetVal('t-total', '');
  var ccy = document.getElementById('t-currency');
  if (ccy) ccy.value = 'EUR';
  uiSetVal('t-custom-ccy', '');
  var cust = document.getElementById('t-custom-ccy');
  if (cust) cust.hidden = true;
  var clab = document.getElementById('t-custom-ccy-label');
  if (clab) clab.hidden = true;
  uiSetVal('t-fee', '');
  uiSetVal('t-note', '');
  uiSetVal('t-txid', '');
  uiSetVal('t-networkfee', '');
  uiSetVal('t-ledger', '');
  uiSetVal('t-ledger-label', '');
  uiSetVal('t-manual-rate', '');
  uiSetVal('t-manual-price', '');
  var toSel = document.getElementById('t-toaccount');
  if (toSel) toSel.innerHTML = '';
  var submitBtn0 = document.getElementById('t-submit');
  if (submitBtn0) { submitBtn0.textContent = 'Add record'; submitBtn0.disabled = false; }
  var titleEl0 = document.getElementById('trade-dialog-title');
  if (titleEl0) titleEl0.textContent = 'Add record';
  var dd = document.getElementById('t-date');
  if (dd) dd.value = todayDmy();
  tradeFormError(null);
  attReset(null);
}

function openPrefillTrade(accountId, lockIt, presetType) {
  var st = loadState();
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  if (!accounts.length) {
    showBanner('Create your first account to enable Add record.');
    var host = document.getElementById('accounts');
    if (host && host.scrollIntoView) {
      try { host.scrollIntoView(); } catch (e) { /* ignore */ }
    }
    return null;
  }
  editingTradeId = null;
  var target = ((typeof accountId === 'string' && accountId.length > 0) && accountById(st, accountId)) ||
    accounts[0];
  buildTradeForm(); // ensure the form exists (init normally builds it)
  var sel = document.getElementById('t-account');
  if (sel) {
    sel.innerHTML = '';
    accounts.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
      sel.appendChild(opt);
    });
    sel.value = target.id;
  }
  var sideSel = document.getElementById('t-side');
  if (sideSel && presetType && TRADE_TYPES.concat(['swap']).indexOf(presetType) !== -1) sideSel.value = presetType;
  // Locked context (e.g. opened from an account page): the account is fixed,
  // so the select is hidden. From home the select stays visible.
  var row = document.getElementById('t-account-row');
  if (row) row.style.display = (lockIt && target) ? 'none' : '';
  syncLockedSymbol();
  resetTradeForm();
  // resetTradeForm defaults the type to Buy; re-apply an explicit preset after it.
  if (sideSel && presetType && TRADE_TYPES.concat(['swap']).indexOf(presetType) !== -1) sideSel.value = presetType;
  syncTradeTypeUI();
  openDialog('trade-dialog');
  return target;
}

function openEditTrade(tradeId) {
  var st = loadState();
  var tr = null;
  (st.trades || []).forEach(function (t) { if (t && t.id === tradeId) tr = t; });
  if (!tr) return;
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  if (!accounts.length) return;
  buildTradeForm();
  editingTradeId = tradeId;
  var sel = document.getElementById('t-account');
  if (sel) {
    sel.innerHTML = '';
    accounts.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
      sel.appendChild(opt);
    });
    sel.value = tr.accountId || accounts[0].id;
  }
  var row = document.getElementById('t-account-row');
  if (row) row.style.display = '';
  var sideSel = document.getElementById('t-side');
  if (sideSel) {
    var tt = tr.type === 'buy' || tr.type === 'sell' || tr.type === 'transfer' || tr.type === 'income' || tr.type === 'expense' ? tr.type : 'buy';
    // Legacy buy/sell/swap on cash stays editable: ensure the full type
    // list exists before selecting (cash-new mode filters it).
    if ((tt === 'buy' || tt === 'sell' || tt === 'swap') && sideSel.options && sideSel.options.length !== 6) {
      var fullE = ['buy', 'sell', 'transfer', 'income', 'expense', 'swap'];
      var fullLE = { buy: 'Buy', sell: 'Sell', transfer: 'Transfer (self move + gas)', income: 'Income (reward / airdrop)', expense: 'Expense / fee', swap: 'Swap (coin → coin)' };
      sideSel.innerHTML = '';
      fullE.forEach(function (v) {
        var ooe = document.createElement('option');
        ooe.value = v;
        ooe.textContent = fullLE[v];
        sideSel.appendChild(ooe);
      });
    }
    sideSel.value = tt;
  }
  syncLockedSymbol();
  syncTradeTypeUI();
  uiSetVal('t-qty', tr.qty !== undefined && tr.qty !== null ? String(tr.qty) : '');
  uiSetVal('t-toqty', '');
  uiSetVal('t-total', tr.total !== undefined && tr.total !== null ? String(tr.total) : '');
  try {
    var cSel = document.getElementById('t-currency');
    if (cSel && tr.currency) {
      var cu = String(tr.currency).toUpperCase();
      var has = Array.prototype.some.call(cSel.options, function (o) { return o.value === cu; });
      if (has) cSel.value = cu;
      else { cSel.value = 'CUSTOM'; cSel.dispatchEvent(new Event('change', { bubbles: true })); uiSetVal('t-custom-ccy', cu); }
    }
  } catch (e) { /* ignore */ }
  uiSetVal('t-date', fmtDateDmy(tr.date || todayStr()));
  uiSetVal('t-fee', tr.fee !== undefined && tr.fee !== null ? String(tr.fee) : '');
  uiSetVal('t-note', tr.note || '');
  uiSetVal('t-ledger', (tr.ledger === undefined || tr.ledger === null) ? '' : String(tr.ledger));
  uiSetVal('t-ledger-label', (tr.ledgerLabel === undefined || tr.ledgerLabel === null) ? '' : String(tr.ledgerLabel));
  uiSetVal('t-txid', tr.txid !== undefined && tr.txid !== null ? String(tr.txid) : '');
  uiSetVal('t-networkfee', tr.networkFee !== undefined && tr.networkFee !== null ? String(tr.networkFee) : '');
  if (tr.type === 'transfer') {
    // Recipients replace the old single-destination inputs: stored outputs
    // repopulate row-for-row; legacy records migrate to one row on open.
    clearRecipientRows();
    var erows = [];
    if (Array.isArray(tr.outputs) && tr.outputs.length) {
      tr.outputs.forEach(function (o) {
        if (isTransferOutputInternal(o)) {
          erows.push({
            kind: 'internal',
            accountId: String(o.toAccountId).trim(),
            qty: String(o.qty),
            fee: (o.fee !== undefined && o.fee !== null) ? String(o.fee) : '',
            toQty: (o.toQty !== undefined && o.toQty !== null) ? String(o.toQty) : ''
          });
        } else if (o && typeof o === 'object') {
          erows.push({
            kind: 'external',
            label: String(o.label || ''),
            qty: String(o.qty),
            fee: (o.fee !== undefined && o.fee !== null) ? String(o.fee) : '',
            spend: o.spend !== false
          });
        }
      });
    } else if (tr.toAccountId) {
      var trQty = Number(tr.qty);
      var trNf = (tr.networkFee === undefined || tr.networkFee === null || String(tr.networkFee).trim() === '') ? 0 : Number(tr.networkFee);
      var crossSym = (tr.toSymbol !== undefined && tr.toSymbol !== null && String(tr.toSymbol).trim() !== '')
        ? String(tr.toSymbol).trim().toUpperCase() : String(tr.symbol || '').toUpperCase();
      if (crossSym !== String(tr.symbol || '').toUpperCase()) {
        erows.push({ kind: 'internal', accountId: tr.toAccountId, qty: String(tr.qty), fee: '', toQty: (tr.toQty !== undefined && tr.toQty !== null) ? String(tr.toQty) : '' });
      } else if (isFinite(trQty) && trQty > 0 && isFinite(trNf) && trNf >= 0 && trNf < trQty) {
        erows.push({ kind: 'internal', accountId: tr.toAccountId, qty: String(roundQty8(trQty - trNf)), fee: '' });
      }
    }
    erows.forEach(function (r) { try { addRecipientRow(r); } catch (e) { /* ignore */ } });
    if (!erows.length) {
      // Same-account move: restore what arrived back so the locked fee
      // recomputes exactly (legacy records carry sent + fee only).
      var selfQty = Number(tr.qty);
      var selfNf = (tr.networkFee === undefined || tr.networkFee === null || String(tr.networkFee).trim() === '') ? 0 : Number(tr.networkFee);
      if (isFinite(selfQty) && selfQty > 0 && isFinite(selfNf) && selfNf >= 0 && selfNf < selfQty) {
        uiSetVal('t-selfrecv', String(roundQty8(selfQty - selfNf)));
      }
    }
  }
  // Manual fields reflect their persistent state, like every other input:
  // the FX rate lives on in the trade's manual fxLock, the price in the
  // trade's manual execLock (else the global override for the symbol).
  // Blank only when nothing is stored anywhere.
  var manualFxRate = '';
  try {
    if (tr.fxLock && tr.fxLock.source === 'manual' && isFinite(Number(tr.fxLock.rate)) && Number(tr.fxLock.rate) > 0) {
      manualFxRate = String(tr.fxLock.rate);
    }
  } catch (e) { manualFxRate = ''; }
  uiSetVal('t-manual-rate', manualFxRate);
  var manualPx = '';
  try {
    var frMan = frozenExecOf(tr);
    if (frMan && String(frMan.source).toLowerCase() === 'manual') {
      manualPx = String(frMan.price);
    } else {
      var ovMan = priceOverrideEntry(tr.symbol);
      if (ovMan !== null) manualPx = String(ovMan.price);
    }
  } catch (e) { manualPx = ''; }
  uiSetVal('t-manual-price', manualPx);
  try {
    var toSel = document.getElementById('t-toaccount');
    if (toSel && tr.toAccountId && tr.type === 'swap') {
      // ensure options exist for transfer/swap
      syncTradeTypeUI();
      toSel.value = tr.toAccountId;
    }
  } catch (e) { /* ignore */ }
  try { syncTransferFeePreview(); } catch (e) { /* ignore */ }
  var submitBtn2 = document.getElementById('t-submit');
  if (submitBtn2) { submitBtn2.textContent = 'Save changes'; submitBtn2.disabled = false; }
  var titleEl2 = document.getElementById('trade-dialog-title');
  if (titleEl2) titleEl2.textContent = 'Edit record';
  tradeFormError(null);
  attReset(tr.attachment);
  openDialog('trade-dialog');
}

function tradeFormError(msg) {
  var p = document.getElementById('t-error');
  if (!p) return;
  var x = document.getElementById('t-error-close');
  if (!msg) {
    p.textContent = '';
    p.hidden = true;
    if (x) x.hidden = true;
    return;
  }
  p.textContent = String(msg);
  p.hidden = false;
  if (x) {
    x.hidden = false;
    if (!x.getAttribute('data-wired')) {
      x.setAttribute('data-wired', '1');
      x.addEventListener('click', function () { tradeFormError(null); });
    }
  }
}

// Implicit chart of accounts: remember a ledger label the user typed so
// the datalist and reports can reuse it. Learned into the record's own
// account (snapshotting the default on first edit); historic trades keep
// their own stored labels; this only updates the chart map.
// One name per code: chart first, then the first posted label in scope.
// Pure (no DOM, no save). scopeIds widens the search to the whole group
// (main first); omitted means the single account.
function findLedgerLabel(st, accountId, code, scopeIds) {
  code = (code === undefined || code === null) ? '' : String(code).trim();
  if (!code) return '';
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [accountId];
  var chartAcc = scope[0];
  try {
    var eff = ledgerChartFor(st, chartAcc);
    if (eff && eff[code]) return String(eff[code]);
  } catch (e) { /* ignore */ }
  var found = '';
  try {
    var inScope = {};
    scope.forEach(function (sid) { if (typeof sid === 'string' && sid !== '') inScope[sid] = true; });
    (st.trades || []).forEach(function (t) {
      if (found || !t || !inScope[t.accountId]) return;
      if (String(t.ledger || '').trim() === code && t.ledgerLabel && String(t.ledgerLabel).trim() !== '') {
        found = String(t.ledgerLabel).trim();
      }
    });
  } catch (e) { /* ignore */ }
  return found;
}

function learnLedgerLabel(st, trade) {
  try {
    if (!st || !trade) return;
    var code = (trade.ledger === undefined || trade.ledger === null) ? '' : String(trade.ledger).trim();
    var label = (trade.ledgerLabel === undefined || trade.ledgerLabel === null) ? '' : String(trade.ledgerLabel).trim();
    if (code === '' || label === '') return;
    var map = null;
    if (trade.accountId) {
      if (!accountById(st, trade.accountId)) return;
      map = ensureAccountChart(st, trade.accountId);
    } else {
      if (!st.settings || typeof st.settings !== 'object') return;
      map = st.settings.ledgerLabels;
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        map = {};
        st.settings.ledgerLabels = map;
      }
    }
    // Capped like the validator: beyond 500 codes nothing is learned, so a
    // large chart can never be wiped by normalization on reload. No
    // early-out on match: propagation below must still run for the records.
    if (!Object.prototype.hasOwnProperty.call(map, code) && Object.keys(map).length >= 500) return;
    map[code] = label;
    // One name per code: a (re)typed label propagates to the group chart
    // and every record carrying the code in scope, so the tree, the cards
    // and the records never disagree afterwards.
    try {
      var scope = null;
      try { scope = trade.accountId ? ledgerScopeOf(st, trade.accountId) : null; } catch (e) { scope = null; }
      if (scope && scope.length > 1) {
        var mainMap = ensureAccountChart(st, scope[0]);
        if (mainMap[code] !== label) {
          if (!Object.prototype.hasOwnProperty.call(mainMap, code) && Object.keys(mainMap).length >= 500) return;
          mainMap[code] = label;
        }
        (st.trades || []).forEach(function (t) {
          if (!t) return;
          var inScope = false;
          for (var i = 0; i < scope.length; i++) if (t.accountId === scope[i]) { inScope = true; break; }
          if (!inScope) return;
          if (String(t.ledger || '').trim() === code && String(t.ledgerLabel || '').trim() !== label) {
            t.ledgerLabel = label;
          }
        });
      } else if (trade.accountId) {
        (st.trades || []).forEach(function (t) {
          if (!t || t.accountId !== trade.accountId) return;
          if (String(t.ledger || '').trim() === code && String(t.ledgerLabel || '').trim() !== label) {
            t.ledgerLabel = label;
          }
        });
      }
    } catch (e) { /* propagation never breaks saving */ }
  } catch (e) { /* ignore */ }
}

function onTradeSubmit(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  tradeFormError(null);
  var st0 = loadState();
  var main = st0.settings.mainCurrency;
  var rawSide = uiVal('t-side', 'buy');
  var side = (rawSide === 'sell' || rawSide === 'transfer' || rawSide === 'income' || rawSide === 'expense' || rawSide === 'swap') ? rawSide : 'buy';
  var list = Array.isArray(st0.accounts) ? st0.accounts : [];
  var acc = accountById(st0, uiVal('t-account', '')) || list[0];
  if (!acc) { tradeFormError('Create your first account to enable Add record.'); return; }
  var symbol = String(acc.ticker).toUpperCase();
  var accountId = acc.id;
  var isCashAcc = isCashKind(acc.kind);
  var isEditing = !!(editingTradeId);
  // Cash accounts are bookkeeping ledgers: only money-movement types.
  if (isCashAcc && !isEditing && (side === 'buy' || side === 'sell' || side === 'swap')) {
    tradeFormError('Cash accounts use income, expense and transfer — buy/sell/swap are for assets.');
    return;
  }
  var submitBtn = document.getElementById('t-submit');
  function lockSubmit(locked, label) {
    if (!submitBtn) return;
    submitBtn.disabled = !!locked;
    if (label) submitBtn.textContent = label;
  }
  var dateRaw = uiVal('t-date', '').trim();
  var date = dateRaw ? parseDateInput(dateRaw) : todayStr();
  if (!date) { tradeFormError('Date must be dd/mm/yyyy.'); return; }
  if (!isValidDateStr(date)) { tradeFormError('Date must be dd/mm/yyyy.'); return; }
  if (isFutureDateStr(date)) { tradeFormError('date cannot be in the future'); return; }
  var note = uiVal('t-note', '').trim();
  var txid = uiVal('t-txid', '').trim();
  if (txid !== '' && !isValidTxid(txid)) { tradeFormError('Transaction ID looks invalid — paste the full tx hash.'); return; }
  var manualRateRaw = uiVal('t-manual-rate', '').trim();
  var manualPriceRaw = uiVal('t-manual-price', '').trim();
  var manualRate = (manualRateRaw === '') ? null : Number(manualRateRaw);
  if (manualRate !== null && (!isFinite(manualRate) || manualRate <= 0)) { tradeFormError('Manual rate must be > 0.'); return; }
  var manualPrice = (manualPriceRaw === '') ? null : Number(manualPriceRaw);
  if (manualPrice !== null && (!isFinite(manualPrice) || manualPrice <= 0)) { tradeFormError('Manual price must be > 0.'); return; }
  // Ledger inputs (cash income/expense). Length-checked here; attached below.
  // A blank code is allowed everywhere: cleared records pool into the
  // Unlabeled buckets instead of being forced into a ledger.
  var ledgerCode = uiVal('t-ledger', '').trim();
  var ledgerLabel = uiVal('t-ledger-label', '').trim();
  if (ledgerCode !== '' && !isValidLedgerCode(ledgerCode)) { tradeFormError('Ledger code is too long — up to 24 characters.'); return; }
  if (ledgerLabel !== '' && !isValidLedgerLabel(ledgerLabel)) { tradeFormError('Ledger label is too long — up to 80 characters.'); return; }
  // Parent-overview rule: ledgers with sub-ledgers are pure totals and take
  // no records; posting under a record-holding ledger is blocked with the
  // fix (move those records to a child, keep the parent record-free).
  // Grouped accounts judge against the whole group (main chart + members).
  // Any side that can carry a ledger is checked.
  if (ledgerCode !== '' && tradeLedgerAllowed(isCashAcc, side)) {
    var lscope = null;
    try { lscope = ledgerScopeOf(st0, accountId); } catch (e) { lscope = null; }
    var lconf = ledgerRecordConflict(st0, accountId, ledgerCode, isEditing ? editingTradeId : null, null, lscope);
    if (lconf) { tradeFormError(ledgerConflictMessage(lconf)); return; }
  }
  // --- Swap: creates a linked sell+buy pair ---
  if (side === 'swap' && !isEditing) {
    if (pendingAttachFile) { tradeFormError('Attachments ride single records — save the swap, then edit its buy/sell leg to attach the file.'); return; }
    var toAccSwap = accountById(st0, uiVal('t-toaccount', ''));
    if (!toAccSwap) { tradeFormError('Pick a destination account for the swap.'); return; }
    if (toAccSwap.id === accountId) { tradeFormError('Swap needs two different accounts.'); return; }
    if (isCashAcc || isCashKind(toAccSwap.kind)) { tradeFormError('Cash accounts do not swap — record income, expense or transfer instead.'); return; }
    var fromSym = symbol;
    var toSym = String(toAccSwap.ticker).toUpperCase();
    if (fromSym === toSym) { tradeFormError('Same asset — use Transfer instead of Swap.'); return; }
    var fromQty = Number(uiVal('t-qty', ''));
    var toQty = Number(uiVal('t-toqty', ''));
    var swapTotal = Number(uiVal('t-total', ''));
    var ccySelS = uiVal('t-currency', 'EUR');
    var swapCcy = (ccySelS === 'CUSTOM' ? uiVal('t-custom-ccy', '').trim().toUpperCase() : String(ccySelS).toUpperCase());
    var feeRawS = uiVal('t-fee', '').trim();
    var feeS = (feeRawS === '') ? 0 : Number(feeRawS);
    var feeCcyS = swapCcy; // one fiat per trade: fee follows the trade currency
    if (!isFinite(fromQty) || fromQty <= 0) { tradeFormError('From quantity must be > 0.'); return; }
    if (!isFinite(toQty) || toQty <= 0) { tradeFormError('Received quantity must be > 0.'); return; }
    if (!isFinite(swapTotal) || swapTotal <= 0) { tradeFormError('Fiat value must be > 0 (for tax).'); return; }
    if (!isValidCurrencyCode(swapCcy)) { tradeFormError('Currency code invalid.'); return; }
    if (!isFinite(feeS) || feeS < 0) { tradeFormError('Fee must be >= 0.'); return; }
    var heldFrom = 0;
    try { heldFrom = heldForAccount(st0.trades, accountId, fromSym); } catch (e) { heldFrom = heldQtyFor(accountTrades(st0, accountId), fromSym); }
    if (fromQty > heldFrom + LEDGER_EPS) { tradeFormError('oversell: max sellable is ' + heldFrom); return; }
    lockSubmit(true, 'Saving…');
    function proceedSwap(lock) {
      var st = loadState();
      var swapId = uid();
      var sellLeg = { id: uid(), type: 'sell', symbol: fromSym, qty: fromQty, total: swapTotal, currency: swapCcy, date: date, fee: feeS, feeCurrency: feeCcyS, note: (note ? note + ' ' : '') + '[swap]', fxLock: lock, accountId: accountId, swapId: swapId, createdAt: new Date().toISOString() };
      var buyLeg = { id: uid(), type: 'buy', symbol: toSym, qty: toQty, total: swapTotal, currency: swapCcy, date: date, fee: 0, feeCurrency: swapCcy, note: (note ? note + ' ' : '') + '[swap]', fxLock: lock, accountId: toAccSwap.id, swapId: swapId, createdAt: new Date().toISOString() };
      if (manualPrice !== null) {
        // Manual quote is for the received asset, denominated in the trade's
        // own Currency (like total and fee) — never the header display fiat.
        // The sold leg freezes via history.
        buyLeg.execLock = { price: manualPrice, vs: String(swapCcy).toUpperCase(), source: 'manual' };
      }
      var e1 = validateTrade(sellLeg, heldFrom);
      if (e1) { tradeFormError(e1); lockSubmit(false, 'Add record'); return; }
      st.trades.push(sellLeg);
      st.trades.push(buyLeg);
      if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Add record'); return; }
      // Freeze reference exec quotes in the background (saving never waits).
      try { freezeExecLock(sellLeg.id, fromSym, date, String(main).toUpperCase(), (acc && acc.kind) || undefined); } catch (e) { /* ignore */ }
      try { freezeExecLock(buyLeg.id, toSym, date, String(main).toUpperCase(), (toAccSwap && toAccSwap.kind) || undefined); } catch (e) { /* ignore */ }
      uiSetVal('t-qty', ''); uiSetVal('t-toqty', ''); uiSetVal('t-total', ''); uiSetVal('t-note', ''); uiSetVal('t-txid', ''); uiSetVal('t-manual-rate', ''); uiSetVal('t-manual-price', '');
      var dd = document.getElementById('t-date'); if (dd) dd.value = todayDmy();
      tradeFormError(null);
      lockSubmit(false, 'Add record');
      refreshPrices();
      try { tradePageByAccount[accountId] = 0; } catch (e) { /* ignore */ }
      try { tradePageByAccount[toAccSwap.id] = 0; } catch (e) { /* ignore */ }
      navTo(accountId);
      render();
      closeDialog('trade-dialog');
    }
    (function resolveSwapFx() {
      var mainU = String(main).toUpperCase();
      var needTotalS = (swapCcy !== mainU);
      function lock11S(f) { return { pair: f + '/' + mainU, rate: 1, source: '1:1', interpolated: false }; }
      function failSwap(pairs) {
        lockSubmit(false, 'Add record');
        showBanner('FX rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.', 'error', {
          title: 'FX error',
          lines: [
            'Pair: ' + pairs.join(', '),
            'Trade date: ' + fmtDateDmy(date),
            'Cause: no ECB fixing cached and the rate request failed (weekend gap or network).',
            'Tip: nothing was saved yet — enter the rate manually to proceed.'
          ]
        });
        tradeFormError('ECB rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.');
      }
      if (!needTotalS) {
        proceedSwap(lock11S(swapCcy));
        return;
      }
      if (manualRate !== null) {
        proceedSwap({ pair: swapCcy + '/' + mainU, rate: manualRate, source: 'manual', interpolated: false });
        return;
      }
      lockSubmit(true, 'Saving…');
      fetchEcbRate(date, swapCcy, mainU).then(function (tRes) {
        var tl = { pair: swapCcy + '/' + mainU, rate: tRes.rate, source: tRes.source, interpolated: !!tRes.interpolated };
        try { cacheRate(date, swapCcy, mainU, tRes.rate, tRes.source); saveFxCache(); } catch (e) { /* ignore */ }
        proceedSwap(tl);
      }, function () {
        failSwap([swapCcy + ' → ' + mainU]);
      });
    })();
    return;
  }
  // --- Single-leg types (buy/sell/transfer/income/expense), new or edit ---
  var qtyRaw = uiVal('t-qty', '');
  var totalRaw = uiVal('t-total', '');
  var ccySel = uiVal('t-currency', 'EUR');
  var currency = (ccySel === 'CUSTOM' ? uiVal('t-custom-ccy', '').trim().toUpperCase() : String(ccySel).toUpperCase());
  var feeRaw = uiVal('t-fee', '').trim();
  var fee = (feeRaw === '') ? 0 : Number(feeRaw);
  var feeCurrency = currency; // one fiat per trade: fee follows Currency
  var netRaw = uiVal('t-networkfee', '');
  var networkFee = (netRaw === undefined || netRaw === null || String(netRaw).trim() === '') ? 0 : Number(netRaw);
  // Recipients: one transaction, N outputs. The tx fee is sent − received
  // (computed); optional per-row fees attribute part of it. A lone
  // cross-fiat cash row carries the converted arrival instead of a fee.
  // transferRowsBuilt feeds the save paths below so both agree exactly.
  var transferRowsBuilt = null;
  var toAccId = (side === 'swap') ? uiVal('t-toaccount', '') : '';
  var toAccCash = null;
  var isCrossFiat = false;
  if (side === 'transfer') {
    var recRows = readRecipientRows();
    var sentChk = Number(qtyRaw);
    if (!isFinite(sentChk) || sentChk <= 0) { tradeFormError('Enter how much you sent (> 0).'); return; }
    if (recRows.length > TRANSFER_MAX_OUTPUTS) { tradeFormError('Too many recipients (max 20).'); return; }
    var seenAcc = {};
    var sumQ = 0, sumF = 0, crossN = 0, crossOne = null;
    var rowErr = null;
    for (var ri = 0; ri < recRows.length && !rowErr; ri++) {
      (function (rr, idx) {
        var label = 'Recipient ' + (idx + 1);
        function fail(m) { rowErr = m; }
        if (rr.kind === 'internal') {
          var accPick = accountById(st0, rr.accountId);
          if (!accPick) return fail(label + ' account not found.');
          if (accPick.id === accountId) return fail(label + ' must differ from the source.');
          if (seenAcc[accPick.id]) return fail('Pick each account once — merge the amounts instead.');
          seenAcc[accPick.id] = true;
          var pickTick = String(accPick.ticker).toUpperCase();
          if (!isCashAcc && (isCashKind(accPick.kind) || pickTick !== symbol)) return fail(label + ' needs the same asset in both accounts — use Swap for different assets.');
          if (isCashAcc && !isCashKind(accPick.kind)) return fail('Cash moves only between cash accounts.');
          var rf0 = (String(rr.fee || '').trim() === '') ? 0 : Number(rr.fee);
          if (!isFinite(rf0) || rf0 < 0) return fail(label + ' fee must be >= 0.');
          sumF += rf0;
          if (isCashAcc && isCashKind(accPick.kind) && pickTick !== symbol) {
            crossN++;
            crossOne = { row: rr, acc: accPick };
          } else {
            var rq0 = Number(rr.qty);
            if (!isFinite(rq0) || rq0 <= 0) return fail(label + ' needs an amount > 0.');
            sumQ += rq0;
          }
        } else {
          var rq = Number(rr.qty);
          if (!isFinite(rq) || rq <= 0) return fail(label + ' needs an amount > 0.');
          var rf = (String(rr.fee || '').trim() === '') ? 0 : Number(rr.fee);
          if (!isFinite(rf) || rf < 0) return fail(label + ' fee must be >= 0.');
          if (String(rr.label || '').trim() === '') return fail(label + ' needs a label.');
          if (String(rr.label).trim().length > TRANSFER_LABEL_MAX) return fail(label + ' label is too long.');
          sumQ += rq;
          sumF += rf;
        }
      })(recRows[ri], ri);
    }
    if (rowErr) { tradeFormError(rowErr); return; }
    if (crossN > 0 && recRows.length > 1) { tradeFormError('Cross-fiat moves stay single-recipient — split the same-fiat rows into their own record.'); return; }
    if (crossN === 1 && recRows.length === 1) {
      var rx = Number(crossOne.row.toQty);
      if (!isFinite(rx) || rx <= 0) { tradeFormError('Enter what arrives in ' + String(crossOne.acc.ticker).toUpperCase() + ' (> 0).'); return; }
      crossOne.row.qty = String(sentChk);
      crossOne.row.toSymbol = String(crossOne.acc.ticker).toUpperCase();
      crossOne.row.fee = '';
      sumQ = sentChk;
      sumF = 0;
      networkFee = 0;
      toAccCash = crossOne.acc;
      isCrossFiat = true;
    } else {
      sumQ = roundQty8(sumQ);
      networkFee = roundQty8(sentChk - sumQ);
      if (!(networkFee >= 0)) { tradeFormError('Recipients exceed sent — lower an amount.'); return; }
      if (sumF - networkFee > 1e-12) { tradeFormError('Recipient fees exceed the transfer fee (' + networkFee + ').'); return; }
    }
    if (!recRows.length) {
      // No recipients: same-account move — the fee derives from what
      // arrived back (the fee field is computed-only, as ever).
      var backRaw = uiVal('t-selfrecv', '');
      var backChk = transferFeeFrom(String(qtyRaw), backRaw);
      if (!backChk) {
        if (String(backRaw).trim() === '') tradeFormError('Enter what arrived back (> 0).');
        else tradeFormError('Received back must be > 0 and at most what you sent.');
        return;
      }
      networkFee = backChk.fee;
    }
    if (!isFinite(networkFee) || networkFee < 0 || networkFee >= sentChk) { tradeFormError('Transfer fees must be >= 0 and < qty.'); return; }
    uiSetVal('t-networkfee', String(networkFee));
    transferRowsBuilt = recRows;
  }
  if (!symbol || !/^[A-Z0-9._-]{1,12}$/.test(symbol)) { tradeFormError('Account ticker looks invalid.'); return; }
  if (!isFinite(fee) || fee < 0) { tradeFormError('Fee must be >= 0.'); return; }
  if (!isFinite(networkFee) || networkFee < 0) { tradeFormError('Transfer fees must be >= 0.'); return; }
  var qty = (side === 'expense' && String(qtyRaw).trim() === '') ? null : Number(qtyRaw);
  var total = (String(totalRaw).trim() === '') ? (side === 'buy' || side === 'sell' ? NaN : 0) : Number(totalRaw);
  // Cash income/expense amounts live in the account fiat alone: the amount
  // is the quantity, and total/currency derive from it (the rows hide).
  if (isCashAcc && (side === 'income' || side === 'expense')) {
    if (!isFinite(qty) || qty <= 0) { tradeFormError('Amount must be > 0.'); return; }
    total = qty;
    currency = symbol;
    feeCurrency = symbol;
  }
  if (side === 'transfer') {
    // Transfers carry no fiat of their own: the network fee IS the fee,
    // valued in fiat at the frozen historical rate. Ignore any stale fiat
    // inputs (the rows are hidden for transfers).
    fee = 0; total = 0; currency = String(main).toUpperCase(); feeCurrency = currency;
  }
  // Per-type validation (messages match legacy for buy/sell so tests keep passing).
  if (side === 'buy' || side === 'sell') {
    if (!isFinite(qty) || qty <= 0) { tradeFormError('Quantity must be > 0.'); return; }
    if (!isFinite(total) || total < 0) { tradeFormError('Total must be >= 0.'); return; }
    if (!isValidCurrencyCode(currency)) { tradeFormError('Currency code invalid — pick one or enter a 2–10 letter code.'); return; }
  } else if (side === 'transfer') {
    if (!isFinite(qty) || qty <= 0) { tradeFormError('Enter how much you sent (> 0).'); return; }
    if (!isFinite(networkFee) || networkFee < 0 || networkFee >= qty) { tradeFormError('Transfer fees must be >= 0 and < qty.'); return; }
    // Recipients were validated row-by-row above (accounts exist, tickers
    // eligible, label present, sums balance); nothing left to check here.
  } else if (side === 'income') {
    if (!isFinite(qty) || qty <= 0) { tradeFormError('Quantity must be > 0.'); return; }
    // Cash derives from the account fiat alone (total/currency rows hide):
    // hidden-field leftovers must never override the derivation below.
    if (isCashAcc) { total = qty; currency = symbol; }
    else if (String(totalRaw).trim() !== '' && (!isFinite(total) || total < 0)) { tradeFormError('Total must be >= 0.'); return; }
    else if (String(totalRaw).trim() !== '') {
      if (!isValidCurrencyCode(currency)) { tradeFormError('Currency code invalid.'); return; }
    } else { total = 0; currency = String(main).toUpperCase(); }
  } else if (side === 'expense') {
    var hasQ = !(String(qtyRaw).trim() === '');
    var hasT = !isCashAcc && !(String(totalRaw).trim() === '');
    if (!hasQ && !hasT) { tradeFormError('Expense needs a quantity or a cash amount.'); return; }
    if (hasQ && (!isFinite(qty) || qty <= 0)) { tradeFormError('Quantity must be > 0.'); return; }
    if (hasT && (!isFinite(total) || total <= 0)) { tradeFormError('Fiat amount must be > 0.'); return; }
    if (!hasQ) qty = null;
    if (isCashAcc) { total = qty; currency = symbol; }
    else if (!hasT) { total = 0; currency = String(main).toUpperCase(); }
    else if (!isValidCurrencyCode(currency)) { tradeFormError('Currency code invalid.'); return; }
  }
  var from = currency;
  // Held checks (directional: source holdings for sell/transfer/expense-qty).
  try {
    if (side === 'sell' || side === 'transfer' || (side === 'expense' && qty !== null)) {
      var heldNeed = side === 'transfer' ? qty : qty;
      var heldHave = 0;
      try { heldHave = heldForAccount(st0.trades, accountId, symbol); }
      catch (e) { heldHave = heldQtyFor(accountTrades(st0, accountId), symbol); }
      // When editing, add back the old qty if same account+symbol (so saving unchanged passes).
      if (isEditing) {
        var oldTr = null;
        (st0.trades || []).forEach(function (t) { if (t && t.id === editingTradeId) oldTr = t; });
        if (oldTr && oldTr.accountId === accountId && String(oldTr.symbol).toUpperCase() === symbol) {
          if (oldTr.type === 'sell' || oldTr.type === 'expense') heldHave += Number(oldTr.qty) || 0;
          else if (oldTr.type === 'buy' || oldTr.type === 'income') heldHave -= 0; // buys don't reduce held for oversell check of new qty? Actually editing a buy doesn't need held check.
          else if (oldTr.type === 'transfer' && oldTr.accountId === accountId) heldHave += Number(oldTr.qty) || 0;
        }
      }
      if (side !== 'buy' && side !== 'income' && qty !== null && qty > heldHave + LEDGER_EPS) {
        tradeFormError('oversell: max sellable is ' + heldHave);
        return;
      }
    }
  } catch (e) { /* validation continues; engine clamps anyway */ }
  // proceed() re-reads state so a slow ECB fetch cannot clobber newer writes.
  // The attachment (if any) resolves first: the trade is only built after
  // its file is hashed + stored, so a record never points at a missing blob.
    function proceed(lock) {
      var __lock = lock;
      lockSubmit(true, 'Saving…');
      try {
        attResolveForSave(function (err, meta) {
          if (err) { tradeFormError(err); lockSubmit(false, isEditing ? 'Save changes' : 'Add record'); return; }
          pendingAttachResolved = meta;
          try { proceedSave(__lock); } catch (e) { lockSubmit(false, 'Add record'); throw e; }
        });
      } catch (e) { tradeFormError('Could not save the attachment — record was not saved.'); lockSubmit(false, 'Add record'); }
    }
    function proceedSave(lock) {
    var st = loadState();
    // NOTE: a trade-dialog manual price stays per-trade (trade.execLock,
    // attached below) and never touches the global live-price overrides —
    // those belong to Settings only.
    function withFeeLock(trade) {
      // One fiat per trade: no separate fee lock is ever written; a stale one
      // from older data is dropped so the fee always rides the trade lock.
      try { delete trade.feeFxLock; } catch (e) { /* ignore */ }
      return trade;
    }
    var trade;
    if (isEditing) {
      var idx = -1;
      for (var ii = 0; ii < (st.trades || []).length; ii++) if (st.trades[ii] && st.trades[ii].id === editingTradeId) { idx = ii; break; }
      if (idx === -1) { tradeFormError('Trade not found — it may have been deleted.'); lockSubmit(false, 'Save changes'); return; }
      var prev = st.trades[idx];
      trade = {
        id: prev.id,
        type: side,
        symbol: symbol,
        qty: qty,
        total: total,
        currency: from,
        date: date,
        fee: fee,
        feeCurrency: feeCurrency,
        note: note,
        fxLock: lock,
        accountId: accountId,
        createdAt: prev.createdAt || new Date().toISOString()
      };
      if (txid !== '') trade.txid = txid;
      withFeeLock(trade);
      if (pendingAttachResolved !== 'keep') {
        if (pendingAttachResolved) trade.attachment = pendingAttachResolved;
        else { try { delete trade.attachment; } catch (e) { trade.attachment = undefined; } }
      } else if (prev.attachment && isValidAttachment(prev.attachment)) {
        trade.attachment = prev.attachment;
      }
      // Reference exec quote: manual wins; else keep the frozen quote when the
      // identifying fields are untouched; otherwise refreeze after save.
      // Transfers freeze it too: it values the network fee in fiat at the
      // tx-date rate (Fee in fiat rate). Other rows carry no execLock.
      var needRefreeze = false;
      if (side === 'buy' || side === 'sell' || side === 'transfer') {
        if (manualPrice !== null) {
          // Manual quote follows the trade's Currency field (like total and
          // fee), never the header display fiat — display converts it.
          trade.execLock = { price: manualPrice, vs: String(from).toUpperCase(), source: 'manual' };
        } else {
          var prevFrozen = null;
          try { prevFrozen = frozenExecOf(prev); } catch (e) { prevFrozen = null; }
          // A cleared manual field drops the manual quote (history refreezes);
          // an untouched history quote is kept as-is, no refetch.
          var keepIt = prevFrozen && String(prevFrozen.source).toLowerCase() !== 'manual' &&
            prev.date === date && String(prev.symbol).toUpperCase() === symbol;
          if (keepIt) {
            trade.execLock = { price: prevFrozen.price, vs: prevFrozen.vs, source: prevFrozen.source };
          } else {
            try { delete trade.execLock; } catch (e) { /* ignore */ }
            needRefreeze = true;
          }
        }
      } else {
        try { delete trade.execLock; } catch (e) { /* ignore */ }
      }
      if (side === 'transfer') {
        trade.networkFee = networkFee;
        var outsEdit = buildTransferOutputs(transferRowsBuilt);
        if (outsEdit.length) trade.outputs = outsEdit;
        try { delete trade.toAccountId; } catch (e) { trade.toAccountId = undefined; }
        try { delete trade.toQty; } catch (e) { trade.toQty = undefined; }
        try { delete trade.toSymbol; } catch (e) { trade.toSymbol = undefined; }
      }
      else if (side === 'expense' && qty === null) { delete trade.qty; }
      // Bookkeeping: ledger rides income/expense records — required on cash,
      // optional on asset accounts while the global switch is on.
      if (tradeLedgerAllowed(isCashAcc, side)) {
        if (ledgerCode !== '') trade.ledger = ledgerCode;
        if (ledgerLabel !== '') trade.ledgerLabel = ledgerLabel;
        if (ledgerCode === '') {
          try { delete trade.ledger; } catch (e) { trade.ledger = undefined; }
          try { delete trade.ledgerLabel; } catch (e) { trade.ledgerLabel = undefined; }
        }
      }
      // Cross-fiat cash move: the converted arrival rides the single row
      // (the trade-level lock below still converts the arrival leg).
      if (isCrossFiat) {
        if (destLockForTrade) trade.toFxLock = destLockForTrade;
      }
      // Cash transfers freeze both fiat legs (source + arrival); the
      // trade's own lock stays 1:1 main (total is 0, engine-neutral).
      if (isCashAcc && side === 'transfer' && srcFiatLockForTrade) {
        trade.fromFxLock = srcFiatLockForTrade;
        if (!isCrossFiat) trade.toFxLock = srcFiatLockForTrade;
      }
      if (prev.swapId) trade.swapId = prev.swapId;
      var errE = validateTrade(trade, 1e18); // structural only; held already checked directionally above
      if (errE && String(errE).indexOf('oversell') === -1) { tradeFormError(errE); lockSubmit(false, 'Save changes'); return; }
      // Re-check oversell directionally with fresh state (excluding self).
      try {
        var others = (st.trades || []).filter(function (t) { return !t || t.id !== editingTradeId; });
        if (side === 'sell' || side === 'transfer' || (side === 'expense' && qty !== null)) {
          var h2 = heldForAccount(others, accountId, symbol);
          var need2 = qty;
          if (need2 > h2 + LEDGER_EPS) { tradeFormError('oversell: max sellable is ' + h2); lockSubmit(false, 'Save changes'); return; }
        }
      } catch (e2) { /* ignore */ }
      st.trades[idx] = trade;
      learnLedgerLabel(st, trade);
      if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Save changes'); return; }
      attReset(trade.attachment);
      if (needRefreeze) {
        try { freezeExecLock(trade.id, symbol, date, mainU, (acc && acc.kind) || undefined); } catch (e) { /* ignore */ }
      }
      editingTradeId = null;
      tradeFormError(null);
      lockSubmit(false, 'Add record');
      var sb2 = document.getElementById('t-submit'); if (sb2) sb2.textContent = 'Add record';
      var tt2 = document.getElementById('trade-dialog-title'); if (tt2) tt2.textContent = 'Add record';
      refreshPrices();
      render();
      closeDialog('trade-dialog');
      return;
    }
    trade = {
      id: uid(),
      type: side,
      symbol: symbol,
      qty: qty,
      total: total,
      currency: from,
      date: date,
      fee: fee,
      feeCurrency: feeCurrency,
      note: note,
      fxLock: lock,
      accountId: accountId,
      createdAt: new Date().toISOString()
    };
    if (txid !== '') trade.txid = txid;
    withFeeLock(trade);
    if (pendingAttachResolved !== 'keep') {
      if (pendingAttachResolved) trade.attachment = pendingAttachResolved;
      else { try { delete trade.attachment; } catch (e) { trade.attachment = undefined; } }
    }
    if (side === 'transfer') {
      trade.networkFee = networkFee;
      var outsNew = buildTransferOutputs(transferRowsBuilt);
      if (outsNew.length) trade.outputs = outsNew;
    }
    if (side === 'expense' && qty === null) { delete trade.qty; }
    // Bookkeeping: ledger rides income/expense records — required on cash,
    // optional on asset accounts while the global switch is on.
    if (tradeLedgerAllowed(isCashAcc, side)) {
      if (ledgerCode !== '') trade.ledger = ledgerCode;
      if (ledgerLabel !== '') trade.ledgerLabel = ledgerLabel;
      if (ledgerCode === '') {
        try { delete trade.ledger; } catch (e) { trade.ledger = undefined; }
        try { delete trade.ledgerLabel; } catch (e) { trade.ledgerLabel = undefined; }
      }
    }
    // Cross-fiat cash move: the converted arrival rides the single row
    // (the trade-level lock below still converts the arrival leg).
    if (isCrossFiat) {
      if (destLockForTrade) trade.toFxLock = destLockForTrade;
    }
    // Cash transfers freeze both fiat legs (source + arrival); the
    // trade's own lock stays 1:1 main (total is 0, engine-neutral).
    if (isCashAcc && side === 'transfer' && srcFiatLockForTrade) {
      trade.fromFxLock = srcFiatLockForTrade;
      if (!isCrossFiat) trade.toFxLock = srcFiatLockForTrade;
    }
    if (side === 'buy' || side === 'sell' || side === 'transfer') {
      if (manualPrice !== null) {
        // Same rule as the edit path: the manual quote follows the trade's
        // Currency field, never the header display fiat.
        trade.execLock = { price: manualPrice, vs: String(from).toUpperCase(), source: 'manual' };
      }
    } else {
      try { delete trade.execLock; } catch (e) { /* ignore */ }
    }
    var heldForCheck = 1e18;
    try {
      if (side === 'sell' || side === 'transfer' || (side === 'expense' && qty !== null)) {
        heldForCheck = heldForAccount(st.trades, accountId, symbol);
      }
    } catch (e3) { heldForCheck = heldQtyFor(accountTrades(st, accountId), symbol); }
    var err = (side === 'sell' || side === 'transfer' || (side === 'expense' && qty !== null))
      ? validateTrade(trade, heldForCheck)
      : validateTrade(trade, 1e18);
    if (err) { tradeFormError(err); lockSubmit(false, 'Add record'); return; }
    st.trades.push(trade);
    learnLedgerLabel(st, trade);
    if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Add record'); return; }
    if ((side === 'buy' || side === 'sell' || side === 'transfer') && manualPrice === null) {
      // No manual quote: freeze the reference exec price in the background.
      // Saving never waits on it; failure just leaves the legacy async path.
      try { freezeExecLock(trade.id, symbol, date, mainU, (acc && acc.kind) || undefined); } catch (e) { /* ignore */ }
    }
    uiSetVal('t-qty', '');
    uiSetVal('t-toqty', '');
    uiSetVal('t-total', '');
    uiSetVal('t-note', '');
    uiSetVal('t-txid', '');
    uiSetVal('t-networkfee', '');
    uiSetVal('t-manual-rate', '');
    uiSetVal('t-manual-price', '');
    attReset(null);
    var d = document.getElementById('t-date');
    if (d) d.value = todayDmy();
    tradeFormError(null);
    lockSubmit(false, 'Add record');
    refreshPrices(); // recompute + render when fresh prices land (renders sync too)
    try { tradePageByAccount[accountId] = 0; } catch (e) { /* ignore */ }
    try { transferDestIds(trade).forEach(function (id) { tradePageByAccount[id] = 0; }); } catch (e) { /* ignore */ }
    navTo(side === 'transfer' ? accountId : accountId);
    render(); // route() picks up the URL: the trade's account page shows the new rows
    closeDialog('trade-dialog');
  }
  // One fiat per trade: only the trade currency->main rate is ever needed.
  // Native total/fee stay in stone; only the lock converts for display/P&L.
  // Cross-fiat cash moves additionally lock the arrival fiat (toFxLock) so
  // the destination balance converts in the right currency.
  var mainU = String(main).toUpperCase();
  var needTotal = (total > 0 && from !== mainU);
  var destSym = isCrossFiat ? String(toAccCash.ticker).toUpperCase() : null;
  var needDest = !!(isCrossFiat && destSym && destSym !== mainU);
  var destLockForTrade = null;
  // Cash transfers zero their own currency (engine-neutral: total stays 0),
  // so the source fiat needs its own frozen rate for balance math.
  var srcSymTx = (isCashAcc && side === 'transfer') ? symbol : null;
  var needSrcFiat = !!(srcSymTx && srcSymTx !== mainU);
  var srcFiatLockForTrade = null;
  function lock11(pairFrom) {
    return { pair: pairFrom + '/' + mainU, rate: 1, source: '1:1', interpolated: false };
  }
  function fxError(pairs) {
    lockSubmit(false, 'Add record');
    showBanner('FX rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.', 'error', {
      title: 'FX error',
      lines: [
        'Pair: ' + pairs.join(', '),
        'Trade date: ' + fmtDateDmy(date),
        'Cause: no ECB fixing cached and the rate request failed (weekend gap or network).',
        'Tip: nothing was saved yet — enter the rate manually to proceed.'
      ]
    });
    tradeFormError('ECB rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.');
  }
  if (!needTotal && !needDest) {
    if (isCrossFiat) destLockForTrade = lock11(destSym);
    if (isCashAcc && side === 'transfer') srcFiatLockForTrade = lock11(srcSymTx);
    proceed(lock11(from));
    return;
  }
  if (manualRate !== null && !needDest) {
    if (isCrossFiat) destLockForTrade = lock11(destSym);
    if (isCashAcc && side === 'transfer') srcFiatLockForTrade = lock11(srcSymTx);
    proceed((from === mainU) ? lock11(from)
      : { pair: from + '/' + mainU, rate: manualRate, source: 'manual', interpolated: false });
    return;
  }
  lockSubmit(true, 'Saving…');
  var srcP = !needTotal
    ? Promise.resolve(lock11(from))
    : (manualRate !== null
      ? Promise.resolve((from === mainU) ? lock11(from)
        : { pair: from + '/' + mainU, rate: manualRate, source: 'manual', interpolated: false })
      : fetchEcbRate(date, from, mainU).then(function (totalRes) {
        var tLock = { pair: from + '/' + mainU, rate: totalRes.rate, source: totalRes.source, interpolated: !!totalRes.interpolated };
        try { cacheRate(date, from, mainU, totalRes.rate, totalRes.source); saveFxCache(); } catch (e) { /* ignore */ }
        return tLock;
      }));
  var destP = !needDest
    ? Promise.resolve(isCrossFiat ? lock11(destSym) : null)
    : fetchEcbRate(date, destSym, mainU).then(function (destRes) {
      var dLock = { pair: destSym + '/' + mainU, rate: destRes.rate, source: destRes.source, interpolated: !!destRes.interpolated };
      try { cacheRate(date, destSym, mainU, destRes.rate, destRes.source); saveFxCache(); } catch (e) { /* ignore */ }
      return dLock;
    });
  var srcFiatP = !needSrcFiat
    ? Promise.resolve(srcSymTx ? lock11(srcSymTx) : null)
    : fetchEcbRate(date, srcSymTx, mainU).then(function (srcRes) {
      var sLock = { pair: srcSymTx + '/' + mainU, rate: srcRes.rate, source: srcRes.source, interpolated: !!srcRes.interpolated };
      try { cacheRate(date, srcSymTx, mainU, srcRes.rate, srcRes.source); saveFxCache(); } catch (e) { /* ignore */ }
      return sLock;
    });
  Promise.all([srcP, destP, srcFiatP]).then(function (locks) {
    destLockForTrade = locks[1];
    srcFiatLockForTrade = locks[2];
    proceed(locks[0]);
  }, function () {
    var pairs = (isCashAcc && side === 'transfer')
      ? [srcSymTx + ' → ' + mainU].concat(isCrossFiat ? [destSym + ' → ' + mainU] : [])
      : [from + ' → ' + mainU];
    fxError(pairs);
  });
}

// --- Top bar + dialogs ---
// Sticky top panel: totals, main currency, cost toggle, Add record +
// Settings buttons. The trade form and settings live in modal <dialog>s
// so the page never scrolls through them. Dialog content keeps the same
// element IDs, so tests.html and existing handlers keep working.

var dialogOpener = null;

// While any modal dialog is open the page underneath is frozen: no
// background scroll (body lock) and no background interaction (native
// showModal already makes the backdrop inert + traps focus). Stacked
// dialogs (e.g. Settings + confirm) count, so closing one never unlocks
// while another is still open. Ancient browsers without showModal fall
// back to the [open] attribute: scroll still locks, clicks do not.
var MODAL_IDS = ['trade-dialog', 'account-dialog', 'ledger-dialog', 'group-dialog', 'settings-dialog', 'confirm-dialog', 'note-dialog', 'error-dialog', 'color-dialog', 'attach-dialog'];

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
    if (open > 0) {
      try { body.classList.add('modal-open'); } catch (e) { /* ignore */ }
    } else {
      try { body.classList.remove('modal-open'); } catch (e) { /* ignore */ }
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

// Mobile-only viewport check: phones + small tablets. Desktop always false,
// so every branch guarded by it leaves desktop behavior byte-identical.
function isMobileView() {
  try {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(max-width: 720px)').matches;
  } catch (e) { return false; }
}

// Mobile-only keyboard avoidance: when the on-screen keyboard opens inside
// an open bottom-sheet dialog, the focused field is scrolled to the visible
// middle of the sheet. Purely additive — no dialog geometry, focus order or
// ledger/price logic changes; every handler early-returns off-mobile.
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
            if (field.scrollIntoView) {
              try { field.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch (e2) {
                try { field.scrollIntoView(); } catch (e3) { /* ignore */ }
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

function buildTopbar() {
  wireDialog('trade-dialog');
  wireDialog('settings-dialog');
  wireDialog('account-dialog');
  wireDialog('confirm-dialog');
  wireDialog('note-dialog');
  wireDialog('error-dialog');
  wireDialog('color-dialog');
  var cdlg = document.getElementById('color-dialog');
  if (cdlg && !cdlg.getAttribute('data-color-wired')) {
    cdlg.setAttribute('data-color-wired', '1');
    cdlg.addEventListener('click', function (e) {
      var pick = e.target && e.target.closest ? e.target.closest('[data-color-pick]') : null;
      if (pick) {
        applyColorToSelection(pick.getAttribute('data-color-pick'));
        return;
      }
    });
  }
  var cApply = document.getElementById('c-apply');
  if (cApply && !cApply.getAttribute('data-wired')) {
    cApply.setAttribute('data-wired', '1');
    cApply.addEventListener('click', function () {
      var raw = uiVal('c-hex', '').trim();
      if (raw !== '' && /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) raw = '#' + raw;
      if (raw !== '') {
        if (!isValidHexColor(raw)) {
          showBanner('Enter a hex color like #F7931A.');
          return;
        }
        applyColorToSelection(raw);
        return;
      }
      applyColorToSelection(uiVal('c-custom', '#e3c57c'));
    });
  }
  var cReset = document.getElementById('c-reset');
  if (cReset && !cReset.getAttribute('data-wired')) {
    cReset.setAttribute('data-wired', '1');
    cReset.addEventListener('click', function () { applyColorToSelection(null); });
  }
  var bclose = document.getElementById('banner-close');
  if (bclose && !bclose.getAttribute('data-wired')) {
    bclose.setAttribute('data-wired', '1');
    bclose.addEventListener('click', clearBanner);
  }
  var brandHome = document.getElementById('brand-home');
  if (brandHome && !brandHome.getAttribute('data-wired')) {
    brandHome.setAttribute('data-wired', '1');
    brandHome.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      navHome();
    });
  }
  var cok = document.getElementById('confirm-ok');
  if (cok && !cok.getAttribute('data-wired')) {
    cok.setAttribute('data-wired', '1');
    cok.addEventListener('click', function () {
      if (confirmSettle3) settleConfirm3('primary');
      else settleConfirm(true);
    });
  }
  var ccan = document.getElementById('confirm-cancel');
  if (ccan && !ccan.getAttribute('data-wired')) {
    ccan.setAttribute('data-wired', '1');
    ccan.addEventListener('click', function () {
      if (confirmSettle3) settleConfirm3('secondary');
      else settleConfirm(false);
    });
  }
  var cdlg = document.getElementById('confirm-dialog');
  if (cdlg && !cdlg.getAttribute('data-ev-wired')) {
    cdlg.setAttribute('data-ev-wired', '1');
    cdlg.addEventListener('cancel', function () { settleConfirm(false); settleConfirm3('dismiss'); });
    cdlg.addEventListener('close', function () { settleConfirm(false); settleConfirm3('dismiss'); });
  }
  var main = document.getElementById('tb-main');
  if (main && !main.getAttribute('data-wired')) {
    main.setAttribute('data-wired', '1');
    main.addEventListener('change', function (e) {
      var st = loadState();
      st.settings.mainCurrency = e.target.value;
      if (!saveStateGuarded(st)) return;
      clearBanner();
      livePrices = {}; // stale prices are in the old currency — clear before repaint
      priceLoading = {}; // refreshPrices() re-marks what is still missing
      render(); // instant paint, then historical pairs fill in + repaint
      refreshPrices(); // live valuation re-fetched in the new currency
    });
  }
  var methods = [['tb-avg', 'average'], ['tb-fifo', 'fifo']];
  methods.forEach(function (pair) {
    var b = document.getElementById(pair[0]);
    if (!b || b.getAttribute('data-wired')) return;
    b.setAttribute('data-wired', '1');
    b.addEventListener('click', function () {
      var st = loadState();
      st.settings.costMethod = pair[1];
      if (!saveStateGuarded(st)) return;
      render(); // no refetch: cost view needs no new prices
    });
  });
  var add = document.getElementById('tb-add');
  if (add && !add.getAttribute('data-wired')) {
    add.setAttribute('data-wired', '1');
    add.addEventListener('click', function () {
      var cur = loadState();
      if (!Array.isArray(cur.accounts) || cur.accounts.length === 0) {
        showBanner('Create your first account to enable Add record.');
        var host = document.getElementById('accounts');
        if (host && host.scrollIntoView) {
          try { host.scrollIntoView(); } catch (e) { /* ignore */ }
        }
        return;
      }
      // On an open account page the trade belongs to that account (locked);
      // on home the account stays selectable (defaults to the default).
      var rid = accountDetailId();
      var open = (typeof rid === 'string' && rid) ? accountById(cur, rid) : null;
      if (open) openPrefillTrade(open.id, true);
      else openPrefillTrade(null);
    });
  }
  var gear = document.getElementById('tb-settings');
  if (gear && !gear.getAttribute('data-wired')) {
    gear.setAttribute('data-wired', '1');
    gear.addEventListener('click', function () { showSettingsTab('overrides'); openDialog('settings-dialog'); });
  }
  var syncBtn = document.getElementById('tb-sync');
  if (syncBtn && !syncBtn.getAttribute('data-wired')) {
    syncBtn.setAttribute('data-wired', '1');
    syncBtn.addEventListener('click', function () { showSettingsTab('sync'); openDialog('settings-dialog'); });
  }
  var fab = document.getElementById('fab-trade');
  if (fab && !fab.getAttribute('data-wired')) {
    fab.setAttribute('data-wired', '1');
    fab.addEventListener('click', function () {
      var tb = document.getElementById('tb-add');
      if (tb) tb.click();
      else openPrefillTrade(null);
    });
  }
}

// --- Settings dialog ---
// Override editor, download/upload, clear-with-confirm. Main currency +
// cost method live in the sticky top bar (buildTopbar). A main-currency
// switch re-fetches live prices and refills historical display rates;
// stored trades (native amounts, entry locks) are never rewritten.

function showSettingsTab(name) {
  var host = document.getElementById('settings-dialog-body');
  if (!host) return;
  var want = 'overrides';
  Array.prototype.forEach.call(host.querySelectorAll('[data-settab]'), function (t) {
    if (t.getAttribute('data-settab') === name) want = name;
  });
  Array.prototype.forEach.call(host.querySelectorAll('[data-settab]'), function (t) {
    t.setAttribute('aria-selected', t.getAttribute('data-settab') === want ? 'true' : 'false');
  });
  Array.prototype.forEach.call(host.querySelectorAll('[data-setpanel]'), function (p) {
    p.hidden = p.getAttribute('data-setpanel') !== want;
  });
  if (want === 'ledgers') {
    try {
      var abox = document.getElementById('set-assetledgers');
      if (abox) abox.checked = assetLedgersOn(loadState());
    } catch (e) { /* ignore */ }
  }
}

function refreshLedgerList() {
  if (typeof document === 'undefined') return;
  var list = document.getElementById('l-list');
  if (!list) return;
  var map = {};
  try { map = normalizeLedgerLabels((loadState().settings || {}).ledgerLabels); } catch (e) { map = {}; }
  list.innerHTML = '';
  Object.keys(map).sort().forEach(function (code) {
    var li = document.createElement('li');
    var span = document.createElement('span');
    span.textContent = code + ' · ' + map[code];
    li.appendChild(span);
    var del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.setAttribute('data-ledger-del', code);
    del.setAttribute('aria-label', 'Delete ledger ' + code);
    li.appendChild(del);
    list.appendChild(li);
  });
}

function buildSettings() {
  var host = document.getElementById('settings-dialog-body');
  if (!host || document.getElementById('o-add')) return;
  var wrap = document.createElement('div');
  wrap.className = 'set-layout';
  wrap.innerHTML =
    '<div class="set-tabs" role="tablist" aria-label="Settings sections">' +
    '<button type="button" role="tab" data-settab="overrides" aria-selected="true">Price overrides</button>' +
    '<button type="button" role="tab" data-settab="ledgers" aria-selected="false">Ledgers (default)</button>' +
    '<button type="button" role="tab" data-settab="backup" aria-selected="false">Backup &amp; restore</button>' +
    '<button type="button" role="tab" data-settab="sync" aria-selected="false">Cloud Sync</button>' +
    '<button type="button" role="tab" data-settab="danger" aria-selected="false">Danger zone</button>' +
    '</div>' +
    '<div class="set-panels">' +
    '<section data-setpanel="overrides" role="tabpanel" aria-label="Price overrides">' +
    '<label for="o-symbol">Symbol</label>' +
    '<input id="o-symbol" autocomplete="off" spellcheck="false" placeholder="e.g. BTC">' +
    '<label for="o-price">Price (in current fiat)</label>' +
    '<input id="o-price" inputmode="decimal" placeholder="e.g. 67000">' +
    '<button id="o-add" type="button">Save override</button>' +
    '<ul id="o-list"></ul>' +
    '</section>' +
    '<section data-setpanel="ledgers" role="tabpanel" aria-label="Ledger codes" hidden>' +
    '<p class="muted set-blurb">Default bookkeeping codes every cash account starts from (e.g. 1000 income, 1100 income from X, 1110 detail). Subledgers nest by prefix. Editing codes inside an account diverges it from this default; renaming here changes future suggestions — records keep their own stored labels.</p>' +
    '<label class="sync-check" for="set-assetledgers"><input id="set-assetledgers" type="checkbox"> Ledgers on asset accounts (optional per income/expense record)</label>' +
    '<label for="l-code">Code</label>' +
    '<input id="l-code" autocomplete="off" spellcheck="false" placeholder="e.g. 1100" maxlength="24">' +
    '<label for="l-label">Label</label>' +
    '<input id="l-label" autocomplete="off" spellcheck="false" placeholder="e.g. Income from X" maxlength="80">' +
    '<button id="l-add" type="button">Save ledger</button>' +
    '<ul id="l-list"></ul>' +
    '</section>' +
    '<section data-setpanel="backup" role="tabpanel" aria-label="Backup and restore" hidden>' +
    '<p class="muted set-blurb">Your data never leaves this browser. Download a backup file to move it to another device.</p>' +
    '<button id="s-download" type="button">Download backup</button>' +
    '<button id="s-csv-trades" type="button">Export trades CSV</button>' +
    '<button id="s-csv-lots" type="button">Export tax lots CSV (FIFO)</button>' +
    '<span id="s-upload-label">Restore from file</span>' +
    '<input id="s-upload" type="file" accept="application/json,.json">' +
    '</section>' +
    '<section data-setpanel="sync" role="tabpanel" aria-label="Encrypted sync" hidden>' +
    '<p class="muted set-blurb">Sync an <strong>encrypted</strong> copy of your data to a drive you choose. The drive only ever sees ciphertext — bring the passphrase to any device to restore.</p>' +
    '<label for="sy-provider">Provider</label>' +
    '<select id="sy-provider">' +
    '<option value="webdav">WebDAV / Nextcloud</option>' +
    '<option value="gdrive">Google Drive</option>' +
    '<option value="dropbox">Dropbox</option>' +
    '<option value="megas3">MEGA (S4 object storage)</option>' +
    '</select>' +
    '<p class="muted set-blurb" id="sy-hint"></p>' +
    '<div id="sy-g-webdav">' +
    '<label for="sy-url">Server URL</label>' +
    '<input id="sy-url" autocomplete="off" spellcheck="false" placeholder="https://cloud.example.com/remote.php/dav/files/USER/INOCULENS-PLUTUS">' +
    '<label for="sy-user">Username</label>' +
    '<input id="sy-user" autocomplete="username" spellcheck="false">' +
    '<label for="sy-passwd">App password</label>' +
    '<input id="sy-passwd" type="password" autocomplete="current-password">' +
    '<label class="sync-check" for="sy-remember"><input id="sy-remember" type="checkbox"> Remember password in this browser</label>' +
    '<label for="sy-filename">File name</label>' +
    '<input id="sy-filename" autocomplete="off" spellcheck="false" placeholder="plutus.inoculens.com">' +
    '<p class="muted set-blurb">The ending .enc.json is fixed — type just the name. Missing folders are created automatically.</p>' +
    '</div>' +
    '<div id="sy-g-oauth" hidden>' +
    '<p class="muted set-blurb" id="sy-oneclick-note"></p>' +
    '<label for="sy-filename2">File name</label>' +
    '<input id="sy-filename2" autocomplete="off" spellcheck="false" placeholder="plutus.inoculens.com">' +
    '<p class="muted set-blurb">The ending .enc.json is fixed — type just the name.</p>' +
    '<label for="sy-folder2">Folder (optional)</label>' +
    '<input id="sy-folder2" autocomplete="off" spellcheck="false" placeholder="e.g. INOCULENS-PLUTUS/Work">' +
    '<p class="muted set-blurb">Keep profiles apart with folders — a name already taken in the folder is refused, never overwritten. Leave empty for the top level; subfolders are created if missing.</p>' +
    '<details class="adv" id="sy-adv">' +
    '<summary>Bring your own OAuth app (advanced)</summary>' +
    '<label for="sy-client">OAuth client ID (your own app)</label>' +
    '<input id="sy-client" autocomplete="off" spellcheck="false">' +
    '<div id="sy-g-secret">' +
    '<label for="sy-secret">OAuth client secret (Google only)</label>' +
    '<input id="sy-secret" type="password" autocomplete="off">' +
    '</div>' +
    '<p class="muted set-blurb">Redirect URI to register in your OAuth app:</p>' +
    '<p class="mono-break" id="sy-redirect"></p>' +
    '</details>' +
    '</div>' +
    '<div id="sy-g-megas3" hidden>' +
    '<label for="sy-endpoint">Endpoint</label>' +
    '<input id="sy-endpoint" autocomplete="off" spellcheck="false" placeholder="https://s3.eu-amsterdam.megas4.com">' +
    '<label for="sy-region">Region</label>' +
    '<input id="sy-region" autocomplete="off" spellcheck="false">' +
    '<label for="sy-bucket">Bucket</label>' +
    '<input id="sy-bucket" autocomplete="off" spellcheck="false">' +
    '<label for="sy-key">Access key</label>' +
    '<input id="sy-key" autocomplete="off" spellcheck="false">' +
    '<label for="sy-skey">Secret key</label>' +
    '<input id="sy-skey" type="password" autocomplete="off">' +
    '<label class="sync-check" for="sy-remember2"><input id="sy-remember2" type="checkbox"> Remember secret key in this browser</label>' +
    '<label for="sy-object">File name</label>' +
    '<input id="sy-object" autocomplete="off" spellcheck="false" placeholder="plutus.inoculens.com">' +
    '<p class="muted set-blurb">The ending .enc.json is fixed — type just the name.</p>' +
    '<label for="sy-folder3">Folder prefix (optional)</label>' +
    '<input id="sy-folder3" autocomplete="off" spellcheck="false" placeholder="e.g. backups/work">' +
    '<p class="muted set-blurb">Keep profiles apart with prefixes — a name already taken is refused, never overwritten. Leave empty for the bucket top level.</p>' +
    '</div>' +
    '<label for="sy-pass">Sync passphrase</label>' +
    '<input id="sy-pass" type="password" autocomplete="new-password" placeholder="Required — only you know it">' +
    '<label class="sync-check" for="sy-remember-pass"><input id="sy-remember-pass" type="checkbox"> Remember passphrase in this browser</label>' +
    '<p class="muted set-blurb" id="sy-fp">Key fingerprint: —</p>' +
    '<label class="sync-check" for="sy-auto"><input id="sy-auto" type="checkbox"> Sync automatically on every change</label>' +
    '<p class="muted set-blurb" id="sy-status">Not connected.</p>' +
    '<div class="sync-btns">' +
    '<button id="sy-connect" type="button">Connect</button>' +
    '<button id="sy-disconnect" type="button">Disconnect</button>' +
    '<button id="sy-push" type="button">Sync now (upload)</button>' +
    '<button id="sy-pull" type="button">Restore from drive</button>' +
    '<button id="sy-cleanup" type="button">Clean up cloud files</button>' +
    '</div>' +
    '<span id="s-enc-label">Encrypted file — needs your passphrase above</span>' +
    '<button id="sy-enc-download" type="button">Download encrypted file</button>' +
    '<input id="sy-enc-upload" type="file" accept="application/json,.json">' +
    '</section>' +
    '<section data-setpanel="danger" role="tabpanel" aria-label="Danger zone" hidden>' +
    '<button id="s-clear" type="button">Clear all data</button>' +
    '</section>' +
    '</div>';
  host.appendChild(wrap);
  host.addEventListener('click', function (e) {
    var tab = e && e.target && e.target.closest ? e.target.closest('[data-settab]') : null;
    if (!tab) return;
    showSettingsTab(tab.getAttribute('data-settab'));
  });
  document.getElementById('o-add').addEventListener('click', function () {
    var sym = uiVal('o-symbol', '').trim().toUpperCase();
    var price = Number(uiVal('o-price', ''));
    if (!sym) { showBanner('Override needs a symbol (e.g. BTC).'); return; }
    if (!isFinite(price) || price <= 0) { showBanner('Override price must be > 0.'); return; }
    var st = loadState();
    st.priceOverrides = (st.priceOverrides && typeof st.priceOverrides === 'object') ? st.priceOverrides : {};
    st.priceOverrides[sym] = { price: price, vs: String(st.settings.mainCurrency).toUpperCase() };
    if (!saveStateGuarded(st)) return;
    uiSetVal('o-symbol', '');
    uiSetVal('o-price', '');
    clearBanner();
    refreshPrices(); // override wins over network; recompute + render
  });
  document.getElementById('o-list').addEventListener('click', function (e) {
    var btn = e && e.target && e.target.closest ? e.target.closest('[data-override-del]') : null;
    if (!btn) return;
    var st = loadState();
    if (st.priceOverrides && Object.prototype.hasOwnProperty.call(st.priceOverrides, btn.getAttribute('data-override-del'))) {
      delete st.priceOverrides[btn.getAttribute('data-override-del')];
      if (!saveStateGuarded(st)) return;
    }
    refreshPrices();
  });
  // Ledger chart: explicit add/rename (same code overwrites) + delete.
  // Records keep their own stored labels regardless of this map.
  document.getElementById('l-add').addEventListener('click', function () {
    var code = uiVal('l-code', '').trim();
    var label = uiVal('l-label', '').trim();
    if (!code || !isValidLedgerCode(code) || String(code).trim() === '') { showBanner('Ledger needs a code (e.g. 1100).'); return; }
    if (!label) { showBanner('Ledger needs a label (e.g. Income from X).'); return; }
    if (!isValidLedgerLabel(label)) { showBanner('Ledger label is too long — up to 80 characters.'); return; }
    var st = loadState();
    if (!st.settings || typeof st.settings !== 'object') st.settings = defaultState().settings;
    var map = normalizeLedgerLabels(st.settings.ledgerLabels);
    map[String(code).trim()] = String(label).trim();
    st.settings.ledgerLabels = map;
    if (!saveStateGuarded(st)) return;
    uiSetVal('l-code', '');
    uiSetVal('l-label', '');
    clearBanner();
    refreshLedgerList();
    render();
  });
  document.getElementById('l-list').addEventListener('click', function (e) {
    var btn = e && e.target && e.target.closest ? e.target.closest('[data-ledger-del]') : null;
    if (!btn) return;
    var code = btn.getAttribute('data-ledger-del');
    var st = loadState();
    var map = normalizeLedgerLabels(st.settings && st.settings.ledgerLabels);
    if (Object.prototype.hasOwnProperty.call(map, code)) {
      delete map[code];
      st.settings.ledgerLabels = map;
      if (!saveStateGuarded(st)) return;
    }
    refreshLedgerList();
    render();
  });
  try { refreshLedgerList(); } catch (e) { /* ignore */ }
  var assetBox = document.getElementById('set-assetledgers');
  if (assetBox) {
    try { assetBox.checked = assetLedgersOn(loadState()); } catch (e) { /* ignore */ }
    if (!assetBox.getAttribute('data-wired')) {
      assetBox.setAttribute('data-wired', '1');
      assetBox.addEventListener('change', function () {
        var st = loadState();
        if (!st.settings || typeof st.settings !== 'object') st.settings = defaultState().settings;
        st.settings.assetLedgers = !!assetBox.checked;
        if (!saveStateGuarded(st)) return;
        clearBanner();
        render();
      });
    }
  }
  // Fiat tag for legacy bare-number overrides (saved before the entry fiat
  // was recorded): declaring it once converts the override everywhere
  // instead of reading it nominal in the display fiat.
  document.getElementById('o-list').addEventListener('change', function (e) {
    var sel = e && e.target && e.target.closest ? e.target.closest('[data-override-fiat]') : null;
    if (!sel || !sel.value) return;
    var sym = sel.getAttribute('data-override-fiat');
    var vs = String(sel.value).trim().toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(vs)) return;
    var st = loadState();
    if (!st.priceOverrides || typeof st.priceOverrides !== 'object') return;
    var cur = Object.prototype.hasOwnProperty.call(st.priceOverrides, sym)
      ? st.priceOverrides[sym] : null;
    var price = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? Number(cur.price) : Number(cur);
    if (!isFinite(price) || price <= 0) return;
    st.priceOverrides[sym] = { price: price, vs: vs };
    if (!saveStateGuarded(st)) return;
    clearBanner();
    refreshPrices(); // re-resolve + repaint with the declared fiat
  });
  document.getElementById('s-download').addEventListener('click', downloadBackup);
  var csvT = document.getElementById('s-csv-trades');
  if (csvT) csvT.addEventListener('click', downloadTradesCsv);
  var csvL = document.getElementById('s-csv-lots');
  if (csvL) csvL.addEventListener('click', downloadLotsCsv);
  document.getElementById('s-upload').addEventListener('change', function (e) {
    var input = e.target;
    var f = input && input.files && input.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result);
      // Encrypted backups (*.enc.json) are ours but unreadable here: point
      // at Cloud Sync instead of the cryptic 'unknown app' rejection.
      if (syncIsEncryptedBackup(text)) {
        showBanner('This backup is encrypted — restore it from the Cloud Sync tab.', 'error', {
          title: 'Encrypted backup',
          lines: [
            'This file holds an encrypted copy of your data. The normal restore cannot open it.',
            'Next step: open the Cloud Sync tab, type your sync passphrase, then upload the file with "Encrypted file" there.'
          ]
        });
        try { showSettingsTab('sync'); } catch (e2) { /* stay where we are */ }
        input.value = '';
        return;
      }
      try {
        importState(text);
      } catch (err) {
        showBanner('Import failed — your data was left untouched.', 'error', {
          title: 'Import error',
          lines: [String((err && err.message) || err)]
        });
        input.value = '';
        return;
      }
      input.value = '';
      clearBanner();
      refreshPrices();
      closeDialog('settings-dialog');
    };
    reader.onerror = function () {
      showBanner('Import failed — could not read the file.', 'error', {
        title: 'Import error',
        lines: ['The file could not be read. Pick an INOCULENS PLUTUS backup (.json) and retry.']
      });
      input.value = '';
    };
    reader.readAsText(f);
  });
  document.getElementById('s-clear').addEventListener('click', clearAllData);
  buildSyncSettings();
}

function syncTopbar(st) {
  var main = document.getElementById('tb-main');
  if (main) main.value = st.settings.mainCurrency;
  var avg = document.getElementById('tb-avg');
  var fifo = document.getElementById('tb-fifo');
  var isFifo = st.settings.costMethod === 'fifo';
  if (avg) avg.setAttribute('aria-pressed', isFifo ? 'false' : 'true');
  if (fifo) fifo.setAttribute('aria-pressed', isFifo ? 'true' : 'false');
  var list = document.getElementById('o-list');
  if (list) {
    list.innerHTML = '';
    var ov = (st.priceOverrides && typeof st.priceOverrides === 'object') ? st.priceOverrides : {};
    Object.keys(ov).sort().forEach(function (sym) {
      var li = document.createElement('li');
      var label = document.createElement('span');
      var oe = null;
      try { oe = priceOverrideEntry(sym); } catch (e) { oe = null; }
      var op = (oe && isFinite(Number(oe.price))) ? Number(oe.price) : Number(ov[sym]);
      var oc = (oe && oe.vs) ? oe.vs : st.settings.mainCurrency;
      label.textContent = sym + ' — ' + fmtMoney(op, oc) + ' ';
      li.appendChild(label);
      // Untagged legacy entries get a one-time fiat declaration so they
      // convert instead of reading nominal; tagged ones show their fiat.
      var fiatSel = document.createElement('select');
      fiatSel.setAttribute('data-override-fiat', sym);
      fiatSel.setAttribute('aria-label', 'Fiat for ' + sym + ' override');
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = (oe && oe.vs) ? oe.vs : 'fiat…';
      fiatSel.appendChild(ph);
      MAIN_CURRENCIES.forEach(function (code) {
        if (oe && oe.vs === code) return; // already shown as the current label
        var o = document.createElement('option');
        o.value = code;
        o.textContent = code;
        fiatSel.appendChild(o);
      });
      li.appendChild(fiatSel);
      li.appendChild(document.createTextNode(' '));
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = 'Remove';
      rm.setAttribute('data-override-del', sym);
      rm.setAttribute('aria-label', 'Remove override for ' + sym);
      li.appendChild(rm);
      list.appendChild(li);
    });
  }
  try { syncRefreshHeaderIcon(st); } catch (e) { /* never let sync break render */ }
}

function backupStamp() {
  var n = new Date();
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return n.getFullYear() + p(n.getMonth() + 1) + p(n.getDate());
}

function downloadBackup() {
  var json = exportState(loadState());
  var blob = new Blob([json], { type: 'application/json' });
  var name = 'plutus.inoculens.com-' + backupStamp() + '.json';
  var urls = window.URL || window.webkitURL;
  var url = urls.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    try { urls.revokeObjectURL(url); } catch (e) { /* ignore */ }
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1000);
}

function csvEsc(v) {
  var s = String(v === null || v === undefined ? '' : v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Free-text cells (notes, account names, labels): a leading = + - @ would
// run as a spreadsheet formula on open (payloads can arrive via an imported
// backup). The single-quote prefix renders invisibly in Excel/Sheets and
// keeps numeric columns untouched.
function csvSafeText(v) {
  var s = String(v === null || v === undefined ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return csvEsc(s);
}

function downloadTextFile(name, text, mime) {
  var blob = new Blob([text], { type: mime || 'text/csv' });
  var urls = window.URL || window.webkitURL;
  var url = urls.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    try { urls.revokeObjectURL(url); } catch (e) { /* ignore */ }
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1000);
}

// One-line destination summary for CSV export: legacy name, or every
// recipient joined (internal `name:qty`, external `label:qty (external)`).
function transferCsvDest(t, accName) {
  if (!t || t.type !== 'transfer') return '';
  var outs = transferOutputsOf(t);
  if (!outs.length) return '';
  return outs.map(function (o) {
    if (isTransferOutputInternal(o)) {
      var id = String(o.toAccountId).trim();
      var nm = (accName && accName[id]) || id;
      return nm + ':' + String(transferRowArrival(o, t.symbol));
    }
    return String(o.label || '').trim() + ':' + String(Number(o.qty)) + ' (external)';
  }).join('; ');
}

function downloadTradesCsv() {
  var st = loadState();
  var accName = {};
  (st.accounts || []).forEach(function (a) { accName[a.id] = a.name; });
  var rows = [['id', 'date', 'type', 'symbol', 'qty', 'total', 'currency', 'fee', 'feeCurrency', 'networkFee', 'account', 'toAccount', 'note', 'txid', 'fxRate', 'fxSource']];
  ledgerSortByDate(st.trades || []).forEach(function (t) {
    rows.push([
      t.id || '', fmtDateDmy(t.date || ''), t.type || '', String(t.symbol || '').toUpperCase(),
      t.qty !== undefined && t.qty !== null ? t.qty : '',
      t.total !== undefined && t.total !== null ? t.total : '',
      t.currency || '', t.fee !== undefined && t.fee !== null ? t.fee : '',
      t.feeCurrency || '', t.networkFee !== undefined && t.networkFee !== null ? t.networkFee : '',
      { text: accName[t.accountId] || t.accountId || '' },
      { text: transferCsvDest(t, accName) },
      { text: t.note || '' },
      { text: t.txid || '' },
      (t.fxLock && t.fxLock.rate) || '',
      fmtEcbInText((t.fxLock && t.fxLock.source) || '')
    ]);
  });
  downloadTextFile('plutus.inoculens.com-trades-' + backupStamp() + '.csv', rows.map(function (r) {
    return r.map(function (c) {
      // Free-text cells are wrapped ({text}) so formula triggers get
      // neutralized; numeric and validated-code cells stay spreadsheet-clean.
      return (c && typeof c === 'object') ? csvSafeText(c.text) : csvEsc(c);
    }).join(',');
  }).join('\n'), 'text/csv');
}

function downloadLotsCsv() {
  var st = loadState();
  var main = st.settings.mainCurrency;
  var dtrades = convertTrades(st.trades, main);
  var fifo = computeFifo(dtrades);
  var accName = {};
  (st.accounts || []).forEach(function (a) { accName[a.id] = a.name; });
  var rows = [['symbol', 'openDate', 'closeDate', 'qty', 'proceeds_' + main, 'cost_' + main, 'gain_' + main, 'holdingDays', 'accountId']];
  // Lots are per-symbol globally; attribute account where possible via close trade? FIFO lots don't carry account, but joint lots do.
  // Use joint portfolio lots (with accountId) for accuracy.
  try {
    var pf = computePortfolio(dtrades, {}, 'fifo');
    Object.keys(pf.states || {}).forEach(function (accId) {
      var syms = pf.states[accId];
      Object.keys(syms).forEach(function (sym) {
        (syms[sym].lots || []).forEach(function (l) {
          rows.push([sym, fmtDateDmy(l.openDate || ''), fmtDateDmy(l.closeDate || ''), l.qty, Math.round(l.proceeds * 100) / 100, Math.round(l.cost * 100) / 100, Math.round(l.gain * 100) / 100, l.holdingDays, { text: accName[accId] || accId }]);
        });
      });
    });
  } catch (e) {
    fifo.forEach(function (v, sym) {
      (v.lots || []).forEach(function (l) {
        rows.push([sym, fmtDateDmy(l.openDate || ''), fmtDateDmy(l.closeDate || ''), l.qty, Math.round(l.proceeds * 100) / 100, Math.round(l.cost * 100) / 100, Math.round(l.gain * 100) / 100, l.holdingDays, '']);
      });
    });
  }
  downloadTextFile('plutus.inoculens.com-tax-lots-' + backupStamp() + '.csv', rows.map(function (r) {
    return r.map(function (c) { return (c && typeof c === 'object') ? csvSafeText(c.text) : csvEsc(c); }).join(',');
  }).join('\n'), 'text/csv');
}

// --- Hero allocation (compact ring inside the Total balance panel; home stays one calm panel) ---

function allocationData(st, dtrades, visibleIds) {
  var method = st.settings.costMethod;
  var pf = null;
  try { pf = computePortfolio(dtrades, livePrices, method); } catch (e) { pf = null; }
  var bySym = {};
  var skipCash = {};
  try { skipCash = cashAccountIds(st); } catch (e) { skipCash = {}; }
  if (pf && pf.byAccount) {
    Object.keys(pf.byAccount).forEach(function (accId) {
      if (visibleIds && visibleIds.indexOf(accId) === -1) return; // honor the asset filter
      if (skipCash[accId]) return; // cash joins below as balance slices, never engine rows
      pf.byAccount[accId].forEach(function (p, sym) {
        var key = p.symbol;
        if (p.marketValue === null) {
          // unknown price: count cost as fallback so allocation still shows something?
          return;
        }
        bySym[key] = (bySym[key] || 0) + p.marketValue;
      });
    });
  }
  var total = 0;
  // Cash ledgers join the ring as balance slices (same totals as the hero).
  try {
    var cIds = cashAccountIds(st);
    var dAll = dtrades || [];
    Object.keys(cIds).forEach(function (aid) {
      if (visibleIds && visibleIds.indexOf(aid) === -1) return;
      var hasAny = dAll.some(function (t) { return transferInvolvesAccount(t, aid); });
      if (!hasAny) return;
      var cb = cashBalance(dAll, aid, st.settings.mainCurrency);
      var key = String(cb.ticker || '').toUpperCase();
      if (!key || !isFinite(cb.main)) return;
      bySym[key] = (bySym[key] || 0) + cb.main;
    });
  } catch (e) { /* ignore */ }
  Object.keys(bySym).forEach(function (k) { total += bySym[k]; });
  // Empty accounts never display: below half a cent prints as €0.00, so it
  // reads as content in the ring legend. Totals are unaffected (dust ≈ 0).
  var arr = Object.keys(bySym)
    .filter(function (k) { return Math.abs(bySym[k]) >= 0.005; })
    .map(function (k) { return { symbol: k, value: bySym[k], pct: total > 0 ? (bySym[k] / total) * 100 : 0 }; });
  arr.sort(function (a, b) { return b.value - a.value; });
  return { items: arr, total: total };
}

function renderHeroAlloc(st) {
  var host = document.getElementById('hero-alloc');
  if (!host) return;
  var main = st.settings.mainCurrency;
  if (!st.accounts.length || !(st.trades || []).length) { host.hidden = true; host.innerHTML = ''; return; }
  var dtrades = convertTrades(st.trades, main);
  var vf = selectedTickers(st);
  var vIds = vf === null ? null : (st.accounts || [])
    .filter(function (a) { return vf.indexOf(String(a.ticker).toUpperCase()) !== -1; })
    .map(function (a) { return a.id; });
  var al = allocationData(st, dtrades, vIds);
  if (!al.items.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = '';
  // Text first, ring last: legend sits left, circle pins to the very right.
  var palette = ['#e3c57c', '#7dd3fc', '#34d399', '#f472b6', '#a78bfa', '#fbbf24'];
  var leg = document.createElement('ul');
  leg.className = 'hero-alloc-legend';
  al.items.forEach(function (it, i) {
    var li = document.createElement('li');
    var dot = document.createElement('span');
    dot.className = 'hero-alloc-dot';
    dot.style.background = palette[i % palette.length];
    li.appendChild(dot);
    var tx = document.createElement('span');
    tx.textContent = it.symbol + ' · ' + fmtPct(it.pct) + ' · ' + fmtMoney(it.value, main);
    li.appendChild(tx);
    leg.appendChild(li);
  });
  host.appendChild(leg);
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('class', 'donut-sm');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Allocation by asset');
  var cx = 60, cy = 60, r = 46, circ = 2 * Math.PI * r;
  var off = 0;
  al.items.forEach(function (it, i) {
    var frac = it.pct / 100;
    var c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', palette[i % palette.length]);
    c.setAttribute('stroke-width', '14');
    c.setAttribute('stroke-dasharray', (frac * circ) + ' ' + circ);
    c.setAttribute('stroke-dashoffset', String(-off * circ));
    c.setAttribute('stroke-linecap', 'butt');
    c.setAttribute('transform', 'rotate(-90 60 60)');
    svg.appendChild(c);
    off += frac;
  });
  // Hole number matches the legend rows: every displayed asset counts,
  // empty ones never do.
  var nAssets = al.items.length;
  svg.setAttribute('aria-label', 'Allocation: ' + nAssets + (nAssets === 1 ? ' asset' : ' assets'));
  var num = document.createElementNS(svgNS, 'text');
  num.setAttribute('x', cx);
  num.setAttribute('y', '60');
  num.setAttribute('text-anchor', 'middle');
  num.setAttribute('class', 'donut-num');
  num.textContent = String(nAssets);
  svg.appendChild(num);
  var lab = document.createElementNS(svgNS, 'text');
  lab.setAttribute('x', cx);
  lab.setAttribute('y', '79');
  lab.setAttribute('text-anchor', 'middle');
  lab.setAttribute('class', 'donut-lab');
  lab.textContent = nAssets === 1 ? 'ASSET' : 'ASSETS';
  svg.appendChild(lab);
  host.appendChild(svg);
  syncHeroAllocHeight();
}

// The legend never stretches its box: capped at six rows on desktop / three
// rows on phones (the next asset scrolls) and never taller than the left
// amount block, so the hero cannot expand no matter how many assets exist.
// Re-synced on render + viewport and font changes because the amount scales
// with the viewport.
function syncHeroAllocHeight() {
  try {
    var host = document.getElementById('hero-alloc');
    if (!host || host.hidden) return;
    var hero = document.getElementById('hero');
    var main = hero ? hero.querySelector('.hero-main') : null;
    var leg = host.querySelector('.hero-alloc-legend');
    if (!main || !leg) return;
    var h = main.clientHeight;
    if (!(h > 0)) return;
    var cap = h;
    try {
      var root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var narrow = false;
      try {
        if (typeof window !== 'undefined' && window.matchMedia) {
          narrow = window.matchMedia('(max-width: 720px)').matches;
        }
      } catch (eN) {}
      // Row budget mirrors the legend metrics: desktop li 0.85rem / 0.35rem
      // gap, mobile li 0.6rem / 0.3rem gap (shared by all phone breakpoints).
      var rows = narrow ? 3 : 6;
      var rfs = narrow ? 0.6 : 0.85;
      var rlg = narrow ? 0.3 : 0.35;
      var budget = rows * (rfs * 1.55 * root) + (rows - 1) * (rlg * root);
      if (budget > 0 && budget < cap) cap = budget;
    } catch (e2) { /* fall back to the measured block height */ }
    leg.style.maxHeight = cap + 'px';
    // Pin the ring to exact pixels as well: percentage heights resolve
    // against sibling-influenced layout and drift per content — pixels
    // cannot. Cleared on narrow screens where the stylesheet size applies.
    try {
      var wide = true;
      try {
        if (typeof window !== 'undefined' && window.matchMedia) {
          wide = window.matchMedia('(min-width: 721px)').matches;
        }
      } catch (e3) {}
      var ring = host.querySelector('.donut-sm');
      if (ring && ring.style) {
        if (wide && h > 0) {
          ring.style.width = h + 'px';
          ring.style.height = h + 'px';
        } else {
          ring.style.width = '';
          ring.style.height = '';
        }
      }
    } catch (e4) { /* ring keeps its stylesheet size */ }
  } catch (e) { /* ignore */ }
}

function clearAllData() {
  confirmAction('Clear everything', 'Delete all accounts, trades, overrides and settings? This cannot be undone.', 'Delete everything', true).then(function (ok) {
    if (!ok) return;
    livePrices = {};
    priceLoading = {};
    if (!saveStateGuarded(defaultState())) return;
    clearBanner();
    render();
    closeDialog('settings-dialog');
  });
}

// --- Render loop ---

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
  var syms = uniqueSymbols(st.trades);
  var kinds = {};
  (st.accounts || []).forEach(function (a) {
    if (a && a.ticker) {
      var t = String(a.ticker).toUpperCase();
      if (syms.indexOf(t) === -1) syms.push(t); // unique: trades may already list it
      if (a.kind) kinds[t] = a.kind;
    }
  });
  // Trade symbols inherit their account's kind (stock/commodity accounts fetch live).
  (st.trades || []).forEach(function (tr) {
    if (!tr || !tr.symbol || !tr.accountId) return;
    var s = String(tr.symbol).toUpperCase();
    if (kinds[s]) return;
    var a = accountById(st, tr.accountId);
    if (a && a.kind) kinds[s] = a.kind;
  });
  if (!syms.length) {
    priceLoading = {};
    render();
    return Promise.resolve({});
  }
  var gen = ++priceReqGen;
  function isCurrent() {
    if (gen !== priceReqGen) return false; // superseded by a newer refresh
    try { return loadState().settings.mainCurrency === mainNow; }
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
          return s + ' — ' + (lastPriceErrors[s] || 'price unavailable');
        });
        showBanner('Live prices are unreachable right now — your data is safe and numbers will fill in automatically.', 'info', {
          title: 'Price errors',
          lines: detailLines
        });
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
    var fills = [ensureDisplayRates(trades, main, kindsByAccount).catch(function () { return false; })];
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
      if (heroRt) { try { clearTimeout(heroRt); } catch (e) { /* ignore */ } }
      heroRt = setTimeout(function () { fitHeroValue(); syncHeroAllocHeight(); try { syncInfoDots(); } catch (e) { /* ignore */ } }, 150);
    });
    try {
      if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
        document.fonts.ready.then(function () { syncHeroAllocHeight(); try { syncInfoDots(); } catch (e) { /* webfont metrics settle truncation */ } });
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
        if (cur) main = groupMainOf(loadState(), cur);
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
  refreshPrices();
  try { syncCheckOnLoad(); } catch (e) { /* the check never breaks boot */ }
}


// Runs the baked-quote repair once per page load (see dropBakedExecLocks).
// Later init() calls (tests re-render constantly) must not re-save.
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

// Expose Ui on window.Inoculens for tests.html; init/render are also bare
// globals (classic script top-level functions) for the DOM checklist.
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.init = init;
  window.Inoculens.render = render;
  window.Inoculens.refreshPrices = refreshPrices;
  window.Inoculens.isPriceLoading = isPriceLoading;
  window.Inoculens.anyPriceLoading = anyPriceLoading;
  window.Inoculens.getLivePrices = function () { return livePrices; };
  window.Inoculens.fxBadgeText = fxBadgeText;
  window.Inoculens.TRADE_CCY_OPTIONS = TRADE_CCY_OPTIONS;
  window.Inoculens.saveStateGuarded = saveStateGuarded;
  window.Inoculens.isValidImportTrade = isValidImportTrade;
  window.Inoculens.isValidTxid = isValidTxid;
  window.Inoculens.txExplorerUrl = txExplorerUrl;
  window.Inoculens.shortTxid = shortTxid;
  window.Inoculens.renderAccounts = renderAccounts;
  window.Inoculens.openAccountDialog = openAccountDialog;
  window.Inoculens.createAccount = createAccount;
  window.Inoculens.renameAccount = renameAccount;
  window.Inoculens.deleteAccount = deleteAccount;
  window.Inoculens.accountTrades = accountTrades;
  window.Inoculens.heldQtyFor = heldQtyFor;
  window.Inoculens.openPrefillTrade = openPrefillTrade;
  window.Inoculens.openEditTrade = openEditTrade;
  window.Inoculens.startInlineLabelEdit = startInlineLabelEdit;
  window.Inoculens.openNoteDialog = openNoteDialog;
  window.Inoculens.openErrorDialog = openErrorDialog;
  window.Inoculens.applyColorToSelection = applyColorToSelection;
  window.Inoculens.resetTradeForm = resetTradeForm;
  window.Inoculens.syncTradeButtons = syncTradeButtons;
  window.Inoculens.syncLockedSymbol = syncLockedSymbol;
  window.Inoculens.syncTradeTypeUI = syncTradeTypeUI;
  window.Inoculens.syncInfoDots = syncInfoDots;
  window.Inoculens.transferFeeFrom = transferFeeFrom;
  window.Inoculens.syncTransferFeePreview = syncTransferFeePreview;
  window.Inoculens.route = route;
  window.Inoculens.renderAccountDetail = renderAccountDetail;
  window.Inoculens.accountDetailId = accountDetailId;
  window.Inoculens.currentRouteId = currentRouteId;
  window.Inoculens.navTo = navTo;
  window.Inoculens.navHome = navHome;
  window.Inoculens.renderHeroAlloc = renderHeroAlloc;
  window.Inoculens.allocationData = allocationData;
  window.Inoculens.syncHeroAllocHeight = syncHeroAllocHeight;
  window.Inoculens.fitHeroValue = fitHeroValue;
  window.Inoculens.downloadTradesCsv = downloadTradesCsv;
  window.Inoculens.downloadLotsCsv = downloadLotsCsv;
  window.Inoculens.csvSafeText = csvSafeText;
  window.Inoculens.fmtDateDmy = fmtDateDmy;
  window.Inoculens.fmtQty = fmtQty;
  window.Inoculens.tradeNowValue = tradeNowValue;
  window.Inoculens.tradeNowPct = tradeNowPct;
  window.Inoculens.tradeNowMeta = tradeNowMeta;
  window.Inoculens.tradeNowText = tradeNowText;
  window.Inoculens.tradeDisplayId = tradeDisplayId;
  window.Inoculens.fifoLinksFor = fifoLinksFor;
  window.Inoculens.parseDateInput = parseDateInput;
  window.Inoculens.todayDmy = todayDmy;
  window.Inoculens.fmtDateTimeDmy = fmtDateTimeDmy;
  window.Inoculens.todayStr = todayStr;
  window.Inoculens.TRADE_PAGE_SIZES = TRADE_PAGE_SIZES;
  window.Inoculens.tradePageSizeGet = tradePageSizeGet;
  window.Inoculens.tradePageSizeSet = tradePageSizeSet;
  window.Inoculens.tradePageCountFor = tradePageCountFor;
  window.Inoculens.tradePageGet = tradePageGet;
  window.Inoculens.tradePageSetFor = tradePageSetFor;
  window.Inoculens.buildTradePager = buildTradePager;
  window.Inoculens.normalizeTradeTypeFilter = normalizeTradeTypeFilter;
  window.Inoculens.tradeTypeFilterFor = tradeTypeFilterFor;
  window.Inoculens.setTradeTypeFilter = setTradeTypeFilter;
  window.Inoculens.filterTradesByType = filterTradesByType;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', init);
  }
  // Surface unexpected errors visibly so users can report them with the version above.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('error', function (e) {
      try {
        showBanner('App error — please report this text plus your app version (bottom of page).', 'error', {
          title: 'App error',
          lines: [String((e && e.message) || 'unknown error'), 'Version ' + APP_VERSION]
        });
      } catch (err) { /* ignore */ }
    });
  }
}

// === Sync ===
// E2E encrypted sync to a drive of the user's choice. There is no INOCULENS PLUTUS
// server: the plaintext is always the exact exportState() JSON, it is
// encrypted in this browser with WebCrypto (PBKDF2-SHA256 -> AES-GCM-256),
// and only the ciphertext envelope below ever leaves the device:
//
//   {"app":"plutus.inoculens.com","v":1,"iter":N,"salt":b64,"iv":b64,
//    "ciphertext":b64}
//
// The passphrase lives only in the form (and, only if the user ticks
// Remember, in this browser's local storage — never on any server). To sync
// from another computer the user only needs the drive login plus the
// passphrase. A wrong passphrase fails closed (AES-GCM auth) and local data
// is never touched until a downloaded backup fully validates via importState().
// Providers: WebDAV/Nextcloud (Basic), Google Drive / Dropbox
// (OAuth one-click or PKCE with the user's own app), MEGA S4 (S3-compatible
// SigV4 with the user's own access keys).

var SYNC_APP = 'plutus.inoculens.com';
// Files written by the first release carry the old id; still accepted on
// read so early backups keep working. New files always use SYNC_APP.
var SYNC_APP_LEGACY = 'inoculens-plutus-sync';
var SYNC_VERSION = 1;
var SYNC_STORAGE_KEY = 'inoculens.sync.v1';
var SYNC_OAUTH_KEY = 'inoculens.oauth.v1';
var SYNC_DEFAULT_BASENAME = 'plutus.inoculens.com';
var SYNC_DEFAULT_FILENAME = 'plutus.inoculens.com.enc.json';
// Trust stamp for "this device synced this destination before". Bumped
// whenever the gate rules change so markers written by older app versions
// never count — the next push re-verifies instead of blindly overwriting.
var SYNC_LOC_V = 2;
var SYNC_PBKDF2_ITER = 600000;
var SYNC_PROVIDERS = [
  { id: 'webdav', label: 'WebDAV / Nextcloud', kind: 'basic' },
  { id: 'gdrive', label: 'Google Drive', kind: 'oauth' },
  { id: 'dropbox', label: 'Dropbox', kind: 'oauth' },
  { id: 'megas3', label: 'MEGA (S4 object storage)', kind: 's3' }
];
var SYNC_HINTS = {
  webdav: 'Nextcloud or any WebDAV host. Create a folder (e.g. INOCULENS-PLUTUS), paste its URL, and sign in with an app password. Only ciphertext is uploaded.',
  gdrive: 'One-click Google sign-in when enabled below — otherwise expand the advanced box and use your own OAuth app (Web application, Drive API enabled). The app only sees files it created.',
  dropbox: 'One-click Dropbox sign-in when enabled below — otherwise your own Dropbox app (Scoped access, App folder) plus its app key in the advanced box. Files stay in the private app folder.',
  megas3: 'MEGA S4 object storage (needs a MEGA account with S4). Create a bucket and access keys under Object Storage, then fill endpoint, region, bucket and keys. Only ciphertext is stored.'
};

// Built-in OAuth app IDs for one-click sign-in (public by design, exactly
// like rclone/Joplin ship theirs — the ID only names the app to the
// provider; tokens and ciphertext still flow directly browser<->provider
// with no INOCULENS PLUTUS server anywhere). Empty until the app owner registers
// them; while empty, users fall back to their own OAuth app below.
var SYNC_SHARED_APPS = { gdrive: '593485863383-tcl6m894iqoqa2cqan3ui80ihau93fq9.apps.googleusercontent.com', dropbox: 'rractvt806na5rn' };

function syncSharedId(providerId) {
  var v = SYNC_SHARED_APPS[providerId];
  return (typeof v === 'string' && v.trim() !== '') ? v.trim() : '';
}

// Effective client ID: the built-in one-click app wins when configured,
// otherwise the user's own app from the advanced box.
function syncEffectiveClientId(cfg) {
  var shared = syncSharedId(cfg.provider);
  if (shared) return shared;
  return (typeof cfg.clientId === 'string') ? cfg.clientId : '';
}

var syncBusy = false;
var syncMemSecrets = { password: '', secretKey: '' };
// True once a drive check proves the two sides disagree (drive newer or a
// real conflict) and nothing has resolved it since. Drives the header icon
// and the panel hint so "up to date" is never claimed on local hashes alone.
var syncPendingRemote = false;

// --- Small pure codecs (no atob/TextEncoder dependency) ---

var SYNC_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function syncB64encode(bytes) {
  var s = '';
  var i, a, b, c;
  for (i = 0; i < bytes.length; i += 3) {
    a = bytes[i] & 255;
    b = (i + 1 < bytes.length) ? (bytes[i + 1] & 255) : 0;
    c = (i + 2 < bytes.length) ? (bytes[i + 2] & 255) : 0;
    s += SYNC_B64.charAt(a >> 2);
    s += SYNC_B64.charAt(((a & 3) << 4) | (b >> 4));
    s += (i + 1 < bytes.length) ? SYNC_B64.charAt(((b & 15) << 2) | (c >> 6)) : '=';
    s += (i + 2 < bytes.length) ? SYNC_B64.charAt(c & 63) : '=';
  }
  return s;
}

function syncB64decode(str) {
  var clean = String(str).replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0) throw new Error('sync failed: bad base64 length.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('sync failed: bad base64 data.');
  var padAt = clean.indexOf('=');
  if (padAt !== -1 && padAt < clean.length - 2) throw new Error('sync failed: bad base64 padding.');
  var out = [];
  var i, e1, e2, e3, e4, triple;
  var c3, c4;
  for (i = 0; i < clean.length; i += 4) {
    e1 = SYNC_B64.indexOf(clean.charAt(i));
    e2 = SYNC_B64.indexOf(clean.charAt(i + 1));
    c3 = clean.charAt(i + 2);
    c4 = clean.charAt(i + 3);
    e3 = (c3 === '=') ? -1 : SYNC_B64.indexOf(c3);
    e4 = (c4 === '=') ? -1 : SYNC_B64.indexOf(c4);
    if (e1 < 0 || e2 < 0 || (c3 !== '=' && e3 < 0) || (c4 !== '=' && e4 < 0)) {
      throw new Error('sync failed: bad base64 data.');
    }
    triple = (e1 << 18) | (e2 << 12) | ((e3 < 0 ? 0 : e3) << 6) | (e4 < 0 ? 0 : e4);
    out.push((triple >> 16) & 255);
    if (e3 >= 0) out.push((triple >> 8) & 255);
    if (e4 >= 0) out.push(triple & 255);
  }
  return new Uint8Array(out);
}

function syncB64UrlEncode(bytes) {
  return syncB64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function syncHex(bytes) {
  var s = '';
  var i;
  for (i = 0; i < bytes.length; i++) {
    s += (bytes[i] < 16 ? '0' : '') + (bytes[i] & 255).toString(16);
  }
  return s;
}

function syncUtf8Encode(str) {
  var s = String(str);
  var out = [];
  var i, c, lo, cp;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      lo = s.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        cp = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
        continue;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function syncUtf8Decode(bytes) {
  var s = '';
  var i = 0;
  var b1, b2, b3, b4, cp;
  while (i < bytes.length) {
    b1 = bytes[i++] & 255;
    if (b1 < 0x80) {
      s += String.fromCharCode(b1);
    } else if ((b1 & 0xE0) === 0xC0) {
      b2 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      s += String.fromCharCode(((b1 & 31) << 6) | (b2 & 63));
    } else if ((b1 & 0xF0) === 0xE0) {
      b2 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      b3 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      s += String.fromCharCode(((b1 & 15) << 12) | ((b2 & 63) << 6) | (b3 & 63));
    } else {
      b2 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      b3 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      b4 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      cp = (((b1 & 7) << 18) | ((b2 & 63) << 12) | ((b3 & 63) << 6) | (b4 & 63)) - 0x10000;
      s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
    }
  }
  return s;
}

// --- Envelope + pure helpers (covered by tests.html) ---

function syncEnvelopeWrap(ctB64, saltB64, ivB64, iter) {
  return JSON.stringify({ app: SYNC_APP, v: SYNC_VERSION, iter: iter, salt: saltB64, iv: ivB64, ciphertext: ctB64 });
}

function syncEnvelopeParse(text) {
  var data;
  try {
    data = JSON.parse(String(text));
  } catch (e) {
    throw new Error('sync failed: file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('sync failed: bad envelope.');
  if (data.app !== SYNC_APP && data.app !== SYNC_APP_LEGACY) throw new Error('sync failed: not an INOCULENS PLUTUS sync file.');
  if (data.v !== SYNC_VERSION) throw new Error('sync failed: unsupported sync version.');
  var iter = Number(data.iter);
  if (!isFinite(iter) || Math.floor(iter) !== iter || iter < 1000 || iter > 5000000) {
    throw new Error('sync failed: bad envelope parameters.');
  }
  if (typeof data.salt !== 'string' || typeof data.iv !== 'string' || typeof data.ciphertext !== 'string') {
    throw new Error('sync failed: bad envelope parameters.');
  }
  var salt, iv, ct;
  try {
    salt = syncB64decode(data.salt);
    iv = syncB64decode(data.iv);
    ct = syncB64decode(data.ciphertext);
  } catch (e) {
    throw new Error('sync failed: bad envelope encoding.');
  }
  if (salt.length !== 16) throw new Error('sync failed: bad envelope salt.');
  if (iv.length !== 12) throw new Error('sync failed: bad envelope nonce.');
  if (ct.length < 16) throw new Error('sync failed: ciphertext too short.');
  return { iter: iter, salt: salt, iv: iv, ciphertext: ct };
}

// True when the text is one of our encrypted envelopes (a sync file or an
// encrypted download) rather than a plain backup. Pure and safe to probe
// with before importState(), whose 'unknown app' error would only confuse.
function syncIsEncryptedBackup(text) {
  try {
    syncEnvelopeParse(String(text));
    return true;
  } catch (e) {
    return false;
  }
}

// 'local-newer' | 'remote-newer' | 'equal' | 'unknown' (unparseable dates).
function syncCompareTimestamps(localIso, remoteIso) {
  var aOk = (typeof localIso === 'string') && isFinite(Date.parse(localIso));
  var bOk = (typeof remoteIso === 'string') && isFinite(Date.parse(remoteIso));
  if (!aOk || !bOk) return 'unknown';
  var ta = Date.parse(localIso);
  var tb = Date.parse(remoteIso);
  if (ta > tb) return 'local-newer';
  if (tb > ta) return 'remote-newer';
  return 'equal';
}

// Three-way sync decision from content hashes — never wall clocks. A fresh
// exportState() stamps exportedAt with "now", so comparing exportedAt values
// always reads local-newer and a stale device silently overwrites the drive
// (and every restore warns "drive copy is older", even for newer copies).
// baseHash is the last agreed sync point (cfg.lastSyncedHash):
//   in-sync     — both sides hold the same content
//   remote-only — this device is untouched; the drive moved (safe to pull)
//   local-only  — the drive is untouched; this device moved (safe to push)
//   conflict    — both moved, or no agreed point to judge by (ask the user)
//   unknown     — a hash is missing (fail closed: never guess)
function syncDirection(curHash, remoteHash, baseHash) {
  var c = String(curHash || '');
  var r = String(remoteHash || '');
  var b = String(baseHash || '');
  if (!c || !r) return 'unknown';
  if (c === r) return 'in-sync';
  if (b && c === b) return 'remote-only';
  if (b && r === b) return 'local-only';
  return 'conflict';
}

function syncIsProvider(id) {
  var i;
  for (i = 0; i < SYNC_PROVIDERS.length; i++) {
    if (SYNC_PROVIDERS[i].id === id) return true;
  }
  return false;
}

function syncProviderById(id) {
  var i;
  for (i = 0; i < SYNC_PROVIDERS.length; i++) {
    if (SYNC_PROVIDERS[i].id === id) return SYNC_PROVIDERS[i];
  }
  return null;
}

function syncProviderLabel(id) {
  var p = syncProviderById(id);
  return p ? p.label : String(id);
}

function syncJoinUrl(base, name) {
  var b = String(base || '').replace(/\s+$/g, '').replace(/\/+$/, '');
  return b + '/' + encodeURIComponent(String(name));
}

function syncSanitizeFilename(name) {
  // User-editable basename, fixed extension: strip any pasted extension,
  // unsafe characters and dot-segments, then lock '.enc.json' back on.
  // Idempotent: already-correct names pass through unchanged. Non-Latin1
  // characters become '_' so the name stays valid in HTTP headers too
  // (Dropbox carries the path in Dropbox-API-Arg, which must be Latin1).
  var s = String(name == null ? '' : name).trim();
  s = s.replace(/^[/\\.\s]+/, '');
  s = s.replace(/(\.enc\.json|\.json|\.enc)$/i, '');
  s = s.replace(/[/\\'"]/g, '');
  s = s.replace(/[^\x20-\xFF]/g, '_');
  s = s.replace(/[. ]+$/, '').slice(0, 100);
  if (!s) s = SYNC_DEFAULT_BASENAME;
  return s + '.enc.json';
}

function syncDisplayBasename(name) {
  return String(name == null ? '' : name).replace(/\.enc\.json$/i, '');
}

// Folder path inside the drive (Drive folder tree, Dropbox subfolder, S3
// key prefix). '' = drive root. Normalizes slashes, drops '.' and '..'
// segments so paths can never escape upward.
function syncNormalizeFolder(raw) {
  var f = String(raw == null ? '' : raw).replace(/\\/g, '/').trim();
  f = f.replace(/^\/+|\/+$/g, '');
  var parts = f.split('/');
  var out = [];
  var i;
  for (i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/^\.+$/, '');
    if (p === '' || p === '.' || p === '..') continue;
    out.push(p.slice(0, 128));
  }
  return out.join('/').slice(0, 256);
}

// Full identity of a save destination: the duplicate gate refuses to
// overwrite a file at a destination this device has never synced.
function syncLocationKey(cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  if (cfg.provider === 'webdav') return 'webdav|' + syncJoinUrl(cfg.url, cfg.filename);
  if (cfg.provider === 'megas3') return 'megas3|' + syncS3Url(cfg);
  return cfg.provider + '|' + folder + '/' + cfg.filename;
}

// Whose credentials the destination belongs to: switching app identity
// (another OAuth app, another username/key) must re-verify, because e.g.
// Drive's app-scoped files are invisible across different client IDs.
function syncTrustIdentity(cfg) {
  if (cfg.provider === 'gdrive' || cfg.provider === 'dropbox') {
    return 'oauth:' + syncEffectiveClientId(cfg);
  }
  if (cfg.provider === 'webdav') return 'basic:' + String(cfg.username || '');
  if (cfg.provider === 'megas3') return 's3:' + String(cfg.accessKey || '');
  return '';
}

function syncIsTrustedLocation(cfg, locKey) {
  if (!cfg.lastLocation || cfg.lastLocation !== locKey) return false;
  if (cfg.locV !== SYNC_LOC_V) return false;
  var ident = syncTrustIdentity(cfg);
  if (!ident) return false;
  return (cfg.lastIdentity || '') === ident;
}

function syncDefaultConfig() {
  return {
    provider: 'webdav',
    filename: SYNC_DEFAULT_FILENAME,
    url: '',
    username: '',
    password: '',
    rememberPassword: false,
    passphrase: '',
    rememberPassphrase: false,
    clientId: '',
    clientSecret: '',
    tokens: null,
    endpoint: 'https://s3.eu-amsterdam.megas4.com',
    region: 'eu-amsterdam',
    bucket: '',
    accessKey: '',
    secretKey: '',
    rememberSecret: false,
    objectKey: SYNC_DEFAULT_FILENAME,
    folder: '',
    lastLocation: null,
    locV: null,
    lastIdentity: null,
    autoSync: false,
    lastSyncedHash: null,
    lastSyncAt: null,
    lastRemoteAt: null
  };
}

function syncSanitizeConfig(raw) {
  var d = syncDefaultConfig();
  var c = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  if (syncIsProvider(c.provider)) d.provider = c.provider;
  if (typeof c.filename === 'string' && c.filename.trim() !== '') d.filename = syncSanitizeFilename(c.filename);
  if (typeof c.url === 'string') d.url = c.url.trim().slice(0, 512);
  if (typeof c.username === 'string') d.username = c.username.slice(0, 256);
  if (typeof c.password === 'string') d.password = c.password.slice(0, 512);
  d.rememberPassword = (c.rememberPassword === true);
  if (!d.rememberPassword) d.password = '';
  // Sync passphrase: persisted only with explicit opt-in, exactly like the
  // drive passwords above. Needed for auto-sync across reloads.
  d.rememberPassphrase = (c.rememberPassphrase === true);
  if (d.rememberPassphrase && typeof c.passphrase === 'string') d.passphrase = c.passphrase.slice(0, 512);
  else d.passphrase = '';
  if (typeof c.clientId === 'string') d.clientId = c.clientId.trim().slice(0, 256);
  if (typeof c.clientSecret === 'string') d.clientSecret = c.clientSecret.slice(0, 512);
  if (c.tokens && typeof c.tokens === 'object' && typeof c.tokens.access === 'string' && c.tokens.access !== '') {
    d.tokens = {
      access: String(c.tokens.access).slice(0, 4096),
      refresh: (typeof c.tokens.refresh === 'string') ? String(c.tokens.refresh).slice(0, 4096) : '',
      expiry: (isFinite(Number(c.tokens.expiry))) ? Number(c.tokens.expiry) : 0
    };
  } else {
    d.tokens = null;
  }
  if (typeof c.endpoint === 'string' && c.endpoint.trim() !== '') d.endpoint = c.endpoint.trim().replace(/\/+$/, '').slice(0, 256);
  if (typeof c.region === 'string' && c.region.trim() !== '') d.region = c.region.trim().slice(0, 64);
  if (typeof c.bucket === 'string') d.bucket = c.bucket.trim().slice(0, 128);
  if (typeof c.accessKey === 'string') d.accessKey = c.accessKey.trim().slice(0, 256);
  // MEGA secret key is only persisted when the user explicitly opts in
  // (sy-remember2); otherwise it lives in memory for this session only.
  d.rememberSecret = (c.rememberSecret === true);
  if (d.rememberSecret && typeof c.secretKey === 'string') d.secretKey = c.secretKey.slice(0, 512);
  else d.secretKey = '';
  if (typeof c.objectKey === 'string' && c.objectKey.trim() !== '') d.objectKey = c.objectKey.trim().replace(/^\/+/, '').slice(0, 256) || SYNC_DEFAULT_FILENAME;
  // Migrate legacy full-path object keys (folder/file) into the split fields.
  var folderFromKey = '';
  if (d.provider === 'megas3' && d.objectKey.indexOf('/') !== -1) {
    var segs = d.objectKey.split('/');
    d.objectKey = segs.pop() || SYNC_DEFAULT_FILENAME;
    folderFromKey = syncNormalizeFolder(segs.join('/'));
  }
  d.objectKey = syncSanitizeFilename(d.objectKey);
  d.folder = syncNormalizeFolder(c.folder) || folderFromKey;
  if (typeof c.lastLocation === 'string' && c.lastLocation !== '') d.lastLocation = c.lastLocation.slice(0, 512);
  d.locV = (c.locV === SYNC_LOC_V) ? SYNC_LOC_V : null;
  if (d.locV === null) d.lastLocation = null;
  if (typeof c.lastIdentity === 'string' && c.lastIdentity !== '') d.lastIdentity = c.lastIdentity.slice(0, 512);
  if (d.locV === null) d.lastIdentity = null;
  d.autoSync = (c.autoSync === true);
  if (typeof c.lastSyncedHash === 'string' && c.lastSyncedHash !== '') d.lastSyncedHash = c.lastSyncedHash.slice(0, 64);
  if (typeof c.lastSyncAt === 'string' && isFinite(Date.parse(c.lastSyncAt))) d.lastSyncAt = c.lastSyncAt;
  if (typeof c.lastRemoteAt === 'string' && isFinite(Date.parse(c.lastRemoteAt))) d.lastRemoteAt = c.lastRemoteAt;
  return d;
}

function syncLoadConfig() {
  var raw = null;
  try {
    if (typeof localStorage === 'undefined') return syncDefaultConfig();
    var s = localStorage.getItem(SYNC_STORAGE_KEY);
    raw = s ? JSON.parse(s) : null;
  } catch (e) {
    raw = null;
  }
  return syncSanitizeConfig(raw);
}

function syncSaveConfig(cfg) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(syncSanitizeConfig(cfg)));
    return true;
  } catch (e) {
    return false;
  }
}

// Secrets the user chose NOT to remember live only in memory, never in storage.
function syncPassword(cfg) {
  if (cfg.password) return cfg.password;
  return syncMemSecrets.password || '';
}

function syncSecret(cfg) {
  if (cfg.secretKey) return cfg.secretKey;
  return syncMemSecrets.secretKey || '';
}

// --- WebCrypto layer (async; guarded) ---

function syncCryptoObj() {
  try {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) return window.crypto;
    if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) return self.crypto;
    if (typeof crypto !== 'undefined' && crypto.subtle) return crypto;
  } catch (e) { /* ignore */ }
  return null;
}

function syncCryptoAvailable() {
  var c = syncCryptoObj();
  return !!(c && c.subtle && typeof c.subtle.importKey === 'function' && typeof c.getRandomValues === 'function');
}

function syncRandomBytes(n) {
  var c = syncCryptoObj();
  var out = new Uint8Array(n);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  // Never fall back to Math.random for salts, IVs or OAuth verifiers:
  // predictable randomness would break the encryption. Callers already
  // gate on syncCryptoAvailable(); this is a fail-closed backstop.
  throw new Error('sync failed: no secure randomness available in this browser.');
}

function syncSha256(bytes) {
  var c = syncCryptoObj();
  if (!c) return Promise.reject(new Error('sync failed: WebCrypto unavailable.'));
  return c.subtle.digest('SHA-256', bytes).then(function (d) { return new Uint8Array(d); });
}

function syncHmac(keyBytes, dataBytes) {
  var c = syncCryptoObj();
  if (!c) return Promise.reject(new Error('sync failed: WebCrypto unavailable.'));
  return c.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(function (k) {
    return c.subtle.sign('HMAC', k, dataBytes);
  }).then(function (sig) {
    return new Uint8Array(sig);
  });
}

function syncDeriveAesKey(passphrase, salt, iter) {
  var c = syncCryptoObj();
  if (!c) return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  var pwBytes = syncUtf8Encode(passphrase);
  return c.subtle.importKey('raw', pwBytes, { name: 'PBKDF2' }, false, ['deriveBits']).then(function (base) {
    return c.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, base, 256);
  }).then(function (bits) {
    return c.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  });
}

function syncEncryptEnvelope(plaintext, passphrase) {
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable). Use Download backup instead.'));
  }
  if (!passphrase) return Promise.reject(new Error('sync failed: enter a sync passphrase.'));
  var salt = syncRandomBytes(16);
  var iv = syncRandomBytes(12);
  var data = syncUtf8Encode(plaintext);
  return syncDeriveAesKey(passphrase, salt, SYNC_PBKDF2_ITER).then(function (key) {
    var c = syncCryptoObj();
    return c.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data);
  }).then(function (ct) {
    return syncEnvelopeWrap(syncB64encode(new Uint8Array(ct)), syncB64encode(salt), syncB64encode(iv), SYNC_PBKDF2_ITER);
  });
}

function syncDecryptEnvelope(envelopeText, passphrase) {
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  }
  if (!passphrase) return Promise.reject(new Error('sync failed: enter the sync passphrase.'));
  var env;
  try {
    env = syncEnvelopeParse(envelopeText);
  } catch (e) {
    return Promise.reject(e);
  }
  return syncDeriveAesKey(passphrase, env.salt, env.iter).then(function (key) {
    var c = syncCryptoObj();
    return c.subtle.decrypt({ name: 'AES-GCM', iv: env.iv }, key, env.ciphertext);
  }).then(function (pt) {
    return syncUtf8Decode(new Uint8Array(pt));
  }, function () {
    throw new Error('sync failed: wrong passphrase or corrupted file.');
  });
}

// Short display fingerprint so two devices can check they typed the same
// passphrase. Display-only; it never leaves the browser.
function syncFingerprint(passphrase) {
  if (!passphrase) return Promise.resolve('');
  return syncSha256(syncUtf8Encode('plutus-sync:' + passphrase)).then(function (h) {
    var hex = syncHex(h).slice(0, 12);
    return hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12);
  }, function () {
    return '';
  });
}

// --- Network helpers ---

function syncNetErr(label) {
  return function () {
    throw new Error('sync failed: cannot reach ' + label + '. Check your connection.');
  };
}

// All sync traffic goes through here: a hung connection aborts after
// SYNC_TIMEOUT_MS so the UI can never wedge with its buttons disabled.
// Degrades to plain fetch where AbortController/timers are unavailable.
var SYNC_TIMEOUT_MS = 30000;

function syncFetch(url, opts, label) {
  var o = opts || {};
  try {
    if (typeof AbortController !== 'undefined' && typeof setTimeout !== 'undefined') {
      var ctrl = new AbortController();
      o.signal = ctrl.signal;
      var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, SYNC_TIMEOUT_MS);
      return fetch(url, o).then(function (res) {
        try { clearTimeout(timer); } catch (e) { /* ignore */ }
        return res;
      }, function (err) {
        try { clearTimeout(timer); } catch (e) { /* ignore */ }
        if (err && err.name === 'AbortError') {
          throw new Error('sync failed: timed out reaching ' + label + '. Check your connection.');
        }
        throw new Error('sync failed: cannot reach ' + label + '. Check your connection.');
      });
    }
  } catch (e) { /* fall through to plain fetch */ }
  return fetch(url, o).then(null, syncNetErr(label));
}

// User-configured hosts must use https (loopback excepted) so logins and
// tokens never travel in cleartext where anyone on the network can read them.
function syncRequireHttpsUrl(url, label) {
  var s = String(url || '');
  var m = s.match(/^(https?):\/\/([^\/]+)/i);
  if (!m) throw new Error('sync failed: enter the ' + label + ' URL starting with https://.');
  var hostport = m[2].toLowerCase();
  var host = hostport;
  if (host.charAt(0) === '[') {
    host = host.slice(1, host.indexOf(']'));
  } else {
    host = host.split(':')[0];
  }
  var local = (host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.indexOf('127.') === 0);
  if (m[1].toLowerCase() !== 'https' && !local) {
    throw new Error('sync failed: the ' + label + ' URL must use https:// (not http) so your login stays private.');
  }
  return s;
}

function syncPostForm(url, body) {
  return syncFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  }, 'the sign-in server').then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        var msg = (data && (data.error_description || data.error)) || ('HTTP ' + res.status);
        throw new Error('sync failed: sign-in refused (' + String(msg).slice(0, 160) + ').');
      }
      return data || {};
    }, function () {
      if (!res.ok) throw new Error('sync failed: sign-in refused (HTTP ' + res.status + ').');
      throw new Error('sync failed: bad sign-in response.');
    });
  });
}

// --- OAuth (PKCE, user's own app credentials; tokens stay in this browser) ---

function syncRedirectUri() {
  try {
    if (typeof window === 'undefined' || !window.location) return '';
    var loc = window.location;
    if (!loc.protocol || loc.protocol.indexOf('http') !== 0 || !loc.host) return '';
    return loc.protocol + '//' + loc.host + String(loc.pathname || '/');
  } catch (e) {
    return '';
  }
}

function syncPkcePair() {
  var verifier = syncB64UrlEncode(syncRandomBytes(64));
  return syncSha256(syncUtf8Encode(verifier)).then(function (h) {
    return { verifier: verifier, challenge: syncB64UrlEncode(h) };
  });
}

function syncOAuthAuthUrl(providerId, clientId, redirectUri, challenge, state) {
  var scope;
  if (providerId === 'gdrive') {
    scope = 'https://www.googleapis.com/auth/drive.file';
    return 'https://accounts.google.com/o/oauth2/v2/auth' +
      '?client_id=' + encodeURIComponent(clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&response_type=code' +
      '&scope=' + encodeURIComponent(scope) +
      '&code_challenge=' + encodeURIComponent(challenge) +
      '&code_challenge_method=S256' +
      '&access_type=offline&prompt=consent&include_granted_scopes=true' +
      '&state=' + encodeURIComponent(state);
  }
  if (providerId === 'dropbox') {
    return 'https://www.dropbox.com/oauth2/authorize' +
      '?client_id=' + encodeURIComponent(clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&response_type=code' +
      '&code_challenge=' + encodeURIComponent(challenge) +
      '&code_challenge_method=S256' +
      '&token_access_type=offline' +
      '&state=' + encodeURIComponent(state);
  }
  return '';
}

function syncOAuthTokenExchange(providerId, cfg, code, verifier) {
  var redirect = syncRedirectUri();
  var cid = syncEffectiveClientId(cfg);
  var body;
  var url;
  if (providerId === 'gdrive') {
    url = 'https://oauth2.googleapis.com/token';
    body = 'grant_type=authorization_code' +
      '&code=' + encodeURIComponent(code) +
      '&redirect_uri=' + encodeURIComponent(redirect) +
      '&client_id=' + encodeURIComponent(cid) +
      '&client_secret=' + encodeURIComponent(cfg.clientSecret || '') +
      '&code_verifier=' + encodeURIComponent(verifier);
  } else if (providerId === 'dropbox') {
    url = 'https://api.dropboxapi.com/oauth2/token';
    body = 'grant_type=authorization_code' +
      '&code=' + encodeURIComponent(code) +
      '&redirect_uri=' + encodeURIComponent(redirect) +
      '&client_id=' + encodeURIComponent(cid) +
      '&code_verifier=' + encodeURIComponent(verifier);
  } else {
    return Promise.reject(new Error('sync failed: unknown provider.'));
  }
  return syncPostForm(url, body).then(function (tok) {
    return syncNormalizeTokens(tok);
  });
}

function syncOAuthRefresh(providerId, cfg) {
  var t = cfg.tokens || {};
  if (!t.refresh) return Promise.reject(new Error('sync failed: connect your drive first.'));
  var cid = syncEffectiveClientId(cfg);
  var body;
  var url;
  if (providerId === 'gdrive') {
    url = 'https://oauth2.googleapis.com/token';
    body = 'grant_type=refresh_token' +
      '&refresh_token=' + encodeURIComponent(t.refresh) +
      '&client_id=' + encodeURIComponent(cid) +
      '&client_secret=' + encodeURIComponent(cfg.clientSecret || '');
  } else if (providerId === 'dropbox') {
    url = 'https://api.dropboxapi.com/oauth2/token';
    body = 'grant_type=refresh_token' +
      '&refresh_token=' + encodeURIComponent(t.refresh) +
      '&client_id=' + encodeURIComponent(cid);
  } else {
    return Promise.reject(new Error('sync failed: unknown provider.'));
  }
  return syncPostForm(url, body).then(function (tok) {
    var n = syncNormalizeTokens(tok);
    if (!n.refresh) n.refresh = t.refresh;
    return n;
  });
}

function syncNormalizeTokens(tok) {
  var out = { access: '', refresh: '', expiry: 0 };
  if (tok && typeof tok.access_token === 'string') out.access = tok.access_token;
  if (tok && typeof tok.refresh_token === 'string') out.refresh = tok.refresh_token;
  var exp = tok ? Number(tok.expires_in) : 0;
  out.expiry = (isFinite(exp) && exp > 0) ? (Date.now() + exp * 1000) : 0;
  if (!out.access) throw new Error('sync failed: sign-in gave no access token.');
  return out;
}

function syncEnsureAccessToken(cfg) {
  var t = cfg.tokens;
  if (!t || !t.access) return Promise.reject(new Error('sync failed: connect your drive first.'));
  if (t.expiry && (t.expiry - Date.now()) > 60000) return Promise.resolve(t.access);
  if (!t.refresh) {
    if (t.expiry && t.expiry <= Date.now()) {
      return Promise.reject(new Error('sync failed: session expired — connect again.'));
    }
    return Promise.resolve(t.access);
  }
  return syncOAuthRefresh(cfg.provider, cfg).then(function (n) {
    cfg.tokens = n;
    syncSaveConfig(cfg);
    return n.access;
  });
}

function syncParseQuery(q) {
  var out = {};
  var pairs = String(q || '').split('&');
  var i, kv, k, v;
  for (i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    kv = pairs[i].split('=');
    k = kv[0];
    v = kv.slice(1).join('=');
    try { k = decodeURIComponent(k); } catch (e) { /* keep raw */ }
    try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ }
    out[k] = v;
  }
  return out;
}

// Runs in the OAuth popup after the provider redirects back to this page:
// hands the code to the opener window and closes itself.
function syncHandleOAuthRedirect() {
  try {
    if (typeof window === 'undefined' || !window.location || !window.opener) return;
    var search = String(window.location.search || '');
    if (search.indexOf('code=') === -1 && search.indexOf('error=') === -1) return;
    var q = syncParseQuery(search.replace(/^\?/, ''));
    if (!q.state || q.state.indexOf('plutus-') !== 0) return;
    if (!q.code && !q.error) return;
    try {
      window.opener.postMessage({ type: 'plutus-oauth', code: q.code || null, error: q.error || null, state: q.state }, window.location.origin);
    } catch (e) { /* ignore */ }
    try {
      if (document && document.body) {
        document.body.innerHTML = '<p style="font-family:sans-serif;padding:2rem">Signed in — you can close this window.</p>';
      }
    } catch (e2) { /* ignore */ }
    try { window.close(); } catch (e3) { /* ignore */ }
  } catch (e) { /* ignore */ }
}

// --- Provider transports (ciphertext in, ciphertext out) ---

function syncWebdavAuth(cfg) {
  var pw = syncPassword(cfg);
  if (!cfg.url) throw new Error('sync failed: enter the WebDAV server URL.');
  if (!pw) throw new Error('sync failed: enter the WebDAV password.');
  syncRequireHttpsUrl(cfg.url, 'WebDAV server');
  return 'Basic ' + syncB64encode(syncUtf8Encode(cfg.username + ':' + pw));
}

// Creates the destination collection and a few missing parents (MKCOL,
// capped depth, existing collections answer 405). Used before a first
// upload and as a one-time retry when a PUT hits a missing folder.
function syncWebdavMkdirP(cfg) {
  var auth;
  try {
    auth = syncWebdavAuth(cfg);
  } catch (e) {
    return Promise.reject(e);
  }
  var base = String(cfg.url).replace(/\s+$/g, '').replace(/\/+$/, '');
  var folder = syncJoinUrl(cfg.url, cfg.filename);
  var slash = folder.lastIndexOf('/');
  folder = (slash > 8) ? folder.slice(0, slash) : base;
  var chain = [];
  var cur = folder;
  var guard = 0;
  while (cur && cur.length > base.length && guard < 6) {
    chain.unshift(cur);
    var cut = cur.lastIndexOf('/');
    if (cut <= 8) break;
    cur = cur.slice(0, cut);
    guard++;
  }
  var p = Promise.resolve(true);
  chain.forEach(function (u) {
    p = p.then(function () {
      return syncFetch(u, { method: 'MKCOL', headers: { 'Authorization': auth } }, 'the WebDAV server').then(function (res) {
        if (res.ok || res.status === 405 || res.status === 412 || res.status === 200 || res.status === 207) return true;
        if (res.status === 401 || res.status === 403) {
          throw new Error('sync failed: WebDAV refused (HTTP ' + res.status + ') — check the app password and folder permissions.');
        }
        throw new Error('sync failed: WebDAV folder cannot be created (HTTP ' + res.status + '). Check the server URL.');
      });
    });
  });
  return p;
}

function syncWebdavUpload(cfg, text) {
  var auth;
  try {
    auth = syncWebdavAuth(cfg);
  } catch (e) {
    return Promise.reject(e);
  }
  var target = syncJoinUrl(cfg.url, cfg.filename);
  function putOnce() {
    return syncFetch(target, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: text
    }, 'the WebDAV server').then(function (res) {
      if (res.ok) return { done: true };
      if (res.status === 401 || res.status === 403) {
        throw new Error('sync failed: WebDAV login refused. Check the username and app password.');
      }
      if (res.status === 404) {
        throw new Error('sync failed: WebDAV folder not found. Check the server URL.');
      }
      if (res.status === 409) return { retryFolder: true };
      throw new Error('sync failed: WebDAV upload refused (HTTP ' + res.status + ').');
    });
  }
  return putOnce().then(function (r) {
    if (r.done) return true;
    return syncWebdavMkdirP(cfg).then(putOnce).then(function (r2) {
      if (r2.done) return true;
      throw new Error('sync failed: WebDAV upload refused (HTTP 409). Check the server URL.');
    });
  });
}

function syncWebdavDownload(cfg) {
  var pw = syncPassword(cfg);
  if (!cfg.url) return Promise.reject(new Error('sync failed: enter the WebDAV server URL.'));
  if (!pw) return Promise.reject(new Error('sync failed: enter the WebDAV password.'));
  try {
    syncRequireHttpsUrl(cfg.url, 'WebDAV server');
  } catch (e) {
    return Promise.reject(e);
  }
  var auth = 'Basic ' + syncB64encode(syncUtf8Encode(cfg.username + ':' + pw));
  return syncFetch(syncJoinUrl(cfg.url, cfg.filename), {
    method: 'GET',
    headers: { 'Authorization': auth }
  }, 'the WebDAV server').then(function (res) {
    if (res.ok) return res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error('sync failed: WebDAV login refused. Check the username and app password.');
    }
    if (res.status === 404) throw new Error('sync failed: no backup found on the server yet.');
    throw new Error('sync failed: WebDAV download refused (HTTP ' + res.status + ').');
  });
}

function syncDriveList(access, q) {
  var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
    '&fields=' + encodeURIComponent('files(id,name,modifiedTime)') + '&spaces=drive';
  return syncFetch(url, { headers: { 'Authorization': 'Bearer ' + access } }, 'Google Drive').then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) throw new Error('sync failed: Drive lookup refused (HTTP ' + res.status + ').');
      return (data && data.files) || [];
    }, function () {
      throw new Error('sync failed: bad Drive response.');
    });
  });
}

function syncDriveFind(access, name, folderId) {
  var parent = String(folderId || 'root').replace(/'/g, '');
  var q = "name = '" + String(name).replace(/'/g, '') + "' and '" + parent + "' in parents and trashed = false";
  return syncDriveList(access, q).then(function (files) {
    return (files.length && files[0].id) ? files[0].id : null;
  });
}

// Walks/creates a 'a/b/c' folder tree under Drive root. With create=false it
// only resolves (missing segment -> null) so downloads never create folders.
function syncDriveFolderId(access, folder, create) {
  var segs = String(folder || '').split('/').filter(function (s) { return s !== ''; });
  var chain = Promise.resolve('root');
  segs.forEach(function (seg) {
    chain = chain.then(function (pid) { return syncDriveFolderStep(access, seg, pid, create); });
  });
  return chain;
}

function syncDriveFolderStep(access, name, parentId, create) {
  if (parentId === null) return Promise.resolve(null);
  var clean = String(name).replace(/'/g, '');
  var q = "mimeType = 'application/vnd.google-apps.folder' and name = '" + clean +
    "' and '" + String(parentId).replace(/'/g, '') + "' in parents and trashed = false";
  return syncDriveList(access, q).then(function (files) {
    if (files.length && files[0].id) return files[0].id;
    if (!create) return null;
    return syncFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: clean, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    }, 'Google Drive').then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data || !data.id) {
          throw new Error('sync failed: Drive could not create the folder (HTTP ' + res.status + ').');
        }
        return data.id;
      }, function () {
        throw new Error('sync failed: bad Drive response.');
      });
    });
  });
}

function syncDrivePutMedia(access, id, text) {
  return syncFetch('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(id) + '?uploadType=media', {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
    body: text
  }, 'Google Drive').then(function (res) {
    if (res.ok) return true;
    throw new Error('sync failed: Drive upload refused (HTTP ' + res.status + ').');
  });
}

function syncDriveUpload(access, cfg, text) {
  var folder = syncNormalizeFolder(cfg.folder);
  return syncDriveFolderId(access, folder, true).then(function (fid) {
    return syncDriveFind(access, cfg.filename, fid).then(function (id) {
      if (id) return syncDrivePutMedia(access, id, text);
      return syncFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cfg.filename, mimeType: 'application/json', parents: [fid] })
      }, 'Google Drive').then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || !data || !data.id) {
            throw new Error('sync failed: Drive could not create the file (HTTP ' + res.status + ').');
          }
          return syncDrivePutMedia(access, data.id, text);
        }, function () {
          throw new Error('sync failed: bad Drive response.');
        });
      });
    });
  });
}

function syncDriveDownload(access, cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  return syncDriveFolderId(access, folder, false).then(function (fid) {
    if (!fid) throw new Error('sync failed: no backup found on the server yet.');
    return syncDriveFind(access, cfg.filename, fid).then(function (id) {
      if (!id) throw new Error('sync failed: no backup found on the server yet.');
      return syncFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
        headers: { 'Authorization': 'Bearer ' + access }
      }, 'Google Drive').then(function (res) {
        if (res.ok) return res.text();
        throw new Error('sync failed: Drive download refused (HTTP ' + res.status + ').');
      });
    });
  });
}

// Full Dropbox path including the optional subfolder (uploads auto-create it).
function syncDropboxFullPath(cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  return '/' + (folder ? folder + '/' : '') + cfg.filename;
}

function syncDropboxUpload(access, cfg, text) {
  return syncFetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: syncDropboxFullPath(cfg), mode: 'overwrite', autorename: false, mute: true })
    },
    body: text
  }, 'Dropbox').then(function (res) {
    if (res.ok) return true;
    throw new Error('sync failed: Dropbox upload refused (HTTP ' + res.status + ').');
  });
}

function syncDropboxDownload(access, cfg) {
  var arg = JSON.stringify({ path: syncDropboxFullPath(cfg) });
  return syncFetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access,
      'Dropbox-API-Arg': arg
    }
  }, 'Dropbox').then(function (res) {
    if (res.ok) return res.text();
    // 409 means the API refused the call: only treat path/not_found as
    // "no backup yet" — anything else is a real refusal, not a first sync.
    if (res.status === 409) {
      return res.text().then(function (body) {
        if (body && body.indexOf('not_found') !== -1) {
          throw new Error('sync failed: no backup found on the server yet.');
        }
        throw new Error('sync failed: Dropbox refused the request (HTTP 409).');
      }, function () {
        throw new Error('sync failed: Dropbox download refused (HTTP 409).');
      });
    }
    throw new Error('sync failed: Dropbox download refused (HTTP ' + res.status + ').');
  });
}

function syncDropboxExists(access, cfg) {
  return syncFetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: syncDropboxFullPath(cfg) })
  }, 'Dropbox').then(function (res) {
    if (res.ok) return true;
    if (res.status === 409) {
      return res.text().then(function (body) {
        if (body && body.indexOf('not_found') !== -1) return false;
        throw new Error('sync failed: Dropbox refused the request (HTTP 409).');
      }, function () {
        throw new Error('sync failed: Dropbox lookup refused (HTTP 409).');
      });
    }
    throw new Error('sync failed: Dropbox lookup refused (HTTP ' + res.status + ').');
  });
}

// --- MEGA S4 (S3-compatible SigV4; standard HMAC-SHA256, no custom crypto) ---

function syncSplitUrl(url) {
  var s = String(url || '');
  var m = s.match(/^https?:\/\/([^\/]+)(\/.*)?$/);
  var host = m ? m[1].toLowerCase() : '';
  var path = (m && m[2]) ? m[2] : '/';
  var q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  if (!path) path = '/';
  return { host: host, path: path };
}

// S3/SigV4 path encoding: encodeURIComponent leaves !'()* raw, but the
// canonical request requires them percent-encoded (uppercase hex), or AWS
// rejects the signature. Folders and keys share it; bucket names cannot
// contain those characters by S3 naming rules.
function syncS3EncodeSeg(seg) {
  return encodeURIComponent(String(seg)).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function syncS3Url(cfg) {
  var ep = String(cfg.endpoint || '').replace(/\/+$/, '');
  var folder = syncNormalizeFolder(cfg.folder);
  var key = String(cfg.objectKey || '').split('/').map(syncS3EncodeSeg).join('/');
  var full = (folder ? folder.split('/').map(syncS3EncodeSeg).join('/') + '/' : '') + key;
  return ep + '/' + encodeURIComponent(cfg.bucket) + '/' + full;
}

function syncS3CanonicalRequest(method, url, payloadHash, amzDate, qs) {
  var parts = syncSplitUrl(url);
  var signed, heads;
  if (method === 'PUT') {
    signed = 'content-type;host;x-amz-content-sha256;x-amz-date';
    heads = 'content-type:application/json\nhost:' + parts.host +
      '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amzDate + '\n';
  } else {
    signed = 'host;x-amz-content-sha256;x-amz-date';
    heads = 'host:' + parts.host +
      '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amzDate + '\n';
  }
  return method + '\n' + parts.path + '\n' + (qs || '') + '\n' + heads + '\n' + signed + '\n' + payloadHash;
}

function syncAmzDate(d) {
  function p(x, n) {
    x = String(x);
    while (x.length < n) x = '0' + x;
    return x;
  }
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1, 2) + p(d.getUTCDate(), 2) + 'T' +
    p(d.getUTCHours(), 2) + p(d.getUTCMinutes(), 2) + p(d.getUTCSeconds(), 2) + 'Z';
}

function syncS3Sign(cfg, method, payloadText) {
  // Cheap configuration checks first (no crypto needed, better messages on
  // exotic browsers, and unit-testable without WebCrypto).
  var secret = syncSecret(cfg);
  if (!cfg.endpoint || syncSplitUrl(cfg.endpoint).host === '') {
    return Promise.reject(new Error('sync failed: enter the S3 endpoint URL.'));
  }
  try {
    syncRequireHttpsUrl(cfg.endpoint, 'S3 endpoint');
  } catch (e) {
    return Promise.reject(e);
  }
  if (!cfg.bucket) return Promise.reject(new Error('sync failed: enter the S3 bucket.'));
  if (!cfg.accessKey) return Promise.reject(new Error('sync failed: enter the S3 access key.'));
  if (!secret) return Promise.reject(new Error('sync failed: enter the S3 secret key.'));
  if (!cfg.region) return Promise.reject(new Error('sync failed: enter the S3 region.'));
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  }
  var url = syncS3Url(cfg);
  var now = new Date();
  var amzDate = syncAmzDate(now);
  var dateStamp = amzDate.slice(0, 8);
  var payloadBytes = syncUtf8Encode(payloadText || '');
  return syncSha256(payloadBytes).then(function (phBytes) {
    var payloadHash = syncHex(phBytes);
    var canon = syncS3CanonicalRequest(method, url, payloadHash, amzDate);
    return syncSha256(syncUtf8Encode(canon)).then(function (chBytes) {
      var sts = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + dateStamp + '/' + cfg.region +
        '/s3/aws4_request\n' + syncHex(chBytes);
      return syncHmac(syncUtf8Encode('AWS4' + secret), syncUtf8Encode(dateStamp)).then(function (kDate) {
        return syncHmac(kDate, syncUtf8Encode(cfg.region));
      }).then(function (kRegion) {
        return syncHmac(kRegion, syncUtf8Encode('s3'));
      }).then(function (kService) {
        return syncHmac(kService, syncUtf8Encode('aws4_request'));
      }).then(function (kSigning) {
        return syncHmac(kSigning, syncUtf8Encode(sts));
      }).then(function (sigBytes) {
        var signedHeaders = (method === 'PUT')
          ? 'content-type;host;x-amz-content-sha256;x-amz-date'
          : 'host;x-amz-content-sha256;x-amz-date';
        var auth = 'AWS4-HMAC-SHA256 Credential=' + cfg.accessKey + '/' + dateStamp + '/' +
          cfg.region + '/s3/aws4_request, SignedHeaders=' + signedHeaders +
          ', Signature=' + syncHex(sigBytes);
        var headers = {
          'x-amz-date': amzDate,
          'x-amz-content-sha256': payloadHash,
          'Authorization': auth
        };
        if (method === 'PUT') headers['Content-Type'] = 'application/json';
        return { url: url, headers: headers };
      });
    });
  });
}

// Query-string sibling of syncS3Sign for ListObjectsV2: same validation
// and key derivation, but the canonical request carries the (already
// sorted + encoded) query string and the URL keeps it. Used only by
// attachment-blob listing; object traffic keeps using syncS3Sign.
function syncS3SignQuery(cfg, method, canonicalQs) {
  var secret = syncSecret(cfg);
  if (!cfg.endpoint || syncSplitUrl(cfg.endpoint).host === '') {
    return Promise.reject(new Error('sync failed: enter the S3 endpoint URL.'));
  }
  try {
    syncRequireHttpsUrl(cfg.endpoint, 'S3 endpoint');
  } catch (e) {
    return Promise.reject(e);
  }
  if (!cfg.bucket) return Promise.reject(new Error('sync failed: enter the S3 bucket.'));
  if (!cfg.accessKey) return Promise.reject(new Error('sync failed: enter the S3 access key.'));
  if (!secret) return Promise.reject(new Error('sync failed: enter the S3 secret key.'));
  if (!cfg.region) return Promise.reject(new Error('sync failed: enter the S3 region.'));
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  }
  var ep = String(cfg.endpoint || '').replace(/\/+$/, '');
  var path = '/' + encodeURIComponent(cfg.bucket) + '/';
  var url = ep + path + '?' + canonicalQs;
  var now = new Date();
  var amzDate = syncAmzDate(now);
  var dateStamp = amzDate.slice(0, 8);
  return syncSha256(syncUtf8Encode('')).then(function (phBytes) {
    var payloadHash = syncHex(phBytes);
    var canon = syncS3CanonicalRequest(method, url, payloadHash, amzDate, canonicalQs);
    return syncSha256(syncUtf8Encode(canon)).then(function (chBytes) {
      var sts = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + dateStamp + '/' + cfg.region +
        '/s3/aws4_request\n' + syncHex(chBytes);
      return syncHmac(syncUtf8Encode('AWS4' + secret), syncUtf8Encode(dateStamp)).then(function (kDate) {
        return syncHmac(kDate, syncUtf8Encode(cfg.region));
      }).then(function (kRegion) {
        return syncHmac(kRegion, syncUtf8Encode('s3'));
      }).then(function (kService) {
        return syncHmac(kService, syncUtf8Encode('aws4_request'));
      }).then(function (kSigning) {
        return syncHmac(kSigning, syncUtf8Encode(sts));
      }).then(function (sigBytes) {
        var auth = 'AWS4-HMAC-SHA256 Credential=' + cfg.accessKey + '/' + dateStamp + '/' +
          cfg.region + '/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date' +
          ', Signature=' + syncHex(sigBytes);
        return {
          url: url,
          headers: { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, 'Authorization': auth }
        };
      });
    });
  });
}

// Reads an S3 XML error body and maps it to a calm, specific message:
// clock skew vs wrong keys vs missing object are very different problems.
function syncS3ErrorBody(body, missingMsg) {
  if (body && body.indexOf('RequestTimeTooSkewed') !== -1) {
    return new Error('sync failed: the device clock looks wrong — S3 refused the time. Fix the date/time and retry.');
  }
  if (body && (body.indexOf('NoSuchBucket') !== -1 || body.indexOf('NoSuchKey') !== -1)) {
    return new Error(missingMsg);
  }
  return null;
}

function syncS3Put(cfg, text) {
  return syncS3Sign(cfg, 'PUT', text).then(function (s) {
    return syncFetch(s.url, { method: 'PUT', headers: s.headers, body: text }, 'the S3 endpoint').then(function (res) {
      if (res.ok) return true;
      if (res.status === 403 || res.status === 404) {
        return res.text().then(function (body) {
          throw syncS3ErrorBody(body, 'sync failed: S3 bucket not found. Check the endpoint and bucket name.') ||
            new Error('sync failed: S3 keys refused. Check the access key, secret, region and bucket policy.');
        }, function () {
          throw new Error('sync failed: S3 upload refused (HTTP ' + res.status + ').');
        });
      }
      throw new Error('sync failed: S3 upload refused (HTTP ' + res.status + ').');
    });
  });
}

function syncS3Get(cfg) {
  return syncS3Sign(cfg, 'GET', '').then(function (s) {
    return syncFetch(s.url, { method: 'GET', headers: s.headers }, 'the S3 endpoint').then(function (res) {
      if (res.ok) return res.text();
      if (res.status === 404 || res.status === 403) {
        return res.text().then(function (body) {
          throw syncS3ErrorBody(body, 'sync failed: no backup found on the server yet.') ||
            new Error('sync failed: S3 keys refused. Check the access key, secret, region and bucket policy.');
        }, function () {
          throw new Error('sync failed: S3 download refused (HTTP ' + res.status + ').');
        });
      }
      throw new Error('sync failed: S3 download refused (HTTP ' + res.status + ').');
    });
  });
}

function syncRemoteUpload(cfg, text) {
  if (cfg.provider === 'webdav') return syncWebdavUpload(cfg, text);
  if (cfg.provider === 'megas3') return syncS3Put(cfg, text);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') return syncDriveUpload(access, cfg, text);
    if (cfg.provider === 'dropbox') return syncDropboxUpload(access, cfg, text);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

function syncRemoteDownload(cfg) {
  if (cfg.provider === 'webdav') return syncWebdavDownload(cfg);
  if (cfg.provider === 'megas3') return syncS3Get(cfg);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') return syncDriveDownload(access, cfg);
    if (cfg.provider === 'dropbox') return syncDropboxDownload(access, cfg);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

// True when a file already lives at this destination. Auth and transport
// failures reject (never misread as "free") so the duplicate gate below
// can only pass on proof of absence.
function syncRemoteExists(cfg) {
  if (cfg.provider === 'webdav') {
    return syncWebdavDownload(cfg).then(function () { return true; }, function (err) {
      if (err && err.message && err.message.indexOf('no backup found') !== -1) return false;
      throw err;
    });
  }
  if (cfg.provider === 'megas3') {
    return syncS3Get(cfg).then(function () { return true; }, function (err) {
      if (err && err.message && err.message.indexOf('no backup found') !== -1) return false;
      throw err;
    });
  }
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') {
      return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), false).then(function (fid) {
        if (!fid) return false;
        return syncDriveFind(access, cfg.filename, fid).then(function (id) { return !!id; });
      });
    }
    if (cfg.provider === 'dropbox') return syncDropboxExists(access, cfg);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

// Idempotent folder preparation before an upload. WebDAV creates missing
// collections (MKCOL walking up at most a few levels); Drive walks and
// creates its folder tree; Dropbox and S3 need nothing (parents appear
// with the object itself).
function syncRemoteEnsureFolder(cfg) {
  if (cfg.provider === 'webdav') return syncWebdavMkdirP(cfg);
  if (cfg.provider === 'megas3') return Promise.resolve(true);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') {
      return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), true).then(function () { return true; });
    }
    if (cfg.provider === 'dropbox') return true;
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

// --- Record-attachment blobs (invoices / receipts) ---
// One encrypted object per file, flat next to the state file so every
// provider works unchanged: <base>-att-<hash>.enc.json (hex hash is safe
// in Drive names, Dropbox Latin1 paths, S3 keys and WebDAV URLs; the
// sanitizer passes it through byte-identical). The envelope reuses the
// state crypto: plaintext is JSON {v,name,mime,b64}, so binary rides the
// same text upload/download paths. Push uploads what this device holds
// (skip-if-exists); preview lazy-fetches what it lacks. Nothing is ever
// auto-deleted remotely: a hash missing here may be another device's
// pending upload.
function syncBlobFilename(cfg, hash) {
  return syncDisplayBasename(cfg.filename) + '-att-' + String(hash).toLowerCase() + '.enc.json';
}
function syncBlobCfgFor(cfg, filename) {
  var c = {};
  for (var k in cfg) { if (Object.prototype.hasOwnProperty.call(cfg, k)) c[k] = cfg[k]; }
  c.filename = filename;
  c.objectKey = filename;
  return c;
}
function syncBlobCfg(cfg, hash) {
  return syncBlobCfgFor(cfg, syncBlobFilename(cfg, hash));
}
// Parse our own blob names back to hashes: <base>-att-<hash>.enc.json.
// The base must match this destination's state file, so cleanup can never
// touch a stranger's files sharing the folder. Pure — covered by tests.
function syncBlobNameHash(name, base) {
  var s = String(name == null ? '' : name);
  var suffix = '.enc.json';
  if (s.length <= suffix.length + 6 || s.slice(-suffix.length) !== suffix) return null;
  var stem = s.slice(0, -suffix.length);
  var tag = '-att-';
  var i = stem.lastIndexOf(tag);
  if (i <= 0) return null;
  if (base !== undefined && stem.slice(0, i) !== String(base)) return null;
  var h = stem.slice(i + tag.length).toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(h)) return null;
  return h;
}
function syncAttachmentMetas(st) {
  var out = [], seen = {};
  (((st && st.trades) || [])).forEach(function (t) {
    if (t && t.attachment && isValidAttachment(t.attachment) && !seen[t.attachment.hash]) {
      seen[t.attachment.hash] = true;
      out.push(t.attachment);
    }
  });
  return out;
}
function attBlobToB64(blob) {
  return new Promise(function (resolve, reject) {
    try {
      var rd = new FileReader();
      rd.onload = function () {
        try { resolve(syncB64encode(new Uint8Array(rd.result))); }
        catch (e) { reject(new Error('sync failed: could not read the file.')); }
      };
      rd.onerror = function () { reject(new Error('sync failed: could not read the file.')); };
      rd.readAsArrayBuffer(blob);
    } catch (e) { reject(new Error('sync failed: could not read the file.')); }
  });
}
// Best-effort: resolves {up, skip} and never rejects, so blob trouble can
// never fail an already-synced state push — leftovers retry next push.
function syncPushAttachments(cfg, pass) {
  var metas = [];
  try { metas = syncAttachmentMetas(loadState()); } catch (e) { metas = []; }
  if (!metas.length || !pass) return Promise.resolve({ up: 0, skip: 0 });
  var up = 0, skipped = 0;
  var chain = Promise.resolve(true);
  metas.forEach(function (meta) {
    chain = chain.then(function () {
      return attGet(meta.hash).then(function (rec) {
        if (!rec || !rec.blob) { skipped++; return true; }
        var bc = syncBlobCfg(cfg, meta.hash);
        return syncRemoteExists(bc).then(function (exists) {
          if (exists) return true;
          return attBlobToB64(rec.blob).then(function (b64) {
            var plain = JSON.stringify({ v: 1, name: meta.name, mime: meta.mime, b64: b64 });
            return syncEncryptEnvelope(plain, pass).then(function (env) {
              return syncRemoteUpload(bc, env).then(function () { up++; return true; });
            });
          });
        });
      }, function () { skipped++; return true; });
    });
  });
  return chain.then(function () { return { up: up, skip: skipped }; },
    function () { return { up: up, skip: skipped }; });
}
function syncPullAttachment(cfg, pass, meta) {
  var bc = syncBlobCfg(cfg, meta.hash);
  return syncRemoteDownload(bc).then(function (envText) {
    return syncDecryptEnvelope(envText, pass);
  }).then(function (plain) {
    var d = JSON.parse(plain);
    if (!d || d.v !== 1 || typeof d.b64 !== 'string') throw new Error('sync failed: bad attachment file.');
    var bytes = syncB64decode(d.b64);
    var blob = new Blob([bytes], { type: d.mime || meta.mime });
    var full = { name: String(d.name || meta.name).slice(0, 120), mime: d.mime || meta.mime, size: bytes.length, hash: meta.hash };
    return attPut(meta.hash, blob, full).then(function () { return { blob: blob, meta: full }; });
  });
}

// --- Orphaned-blob cleanup ("Clean up cloud files") ---
// Lists our <base>-att-<hash>.enc.json objects at the destination, keeps
// the ones no record on this device references, and deletes the rest only
// after an explicit confirm. Never automatic: a hash missing here may be
// another device's pending upload, so the confirm warns to sync everywhere
// first. Only names matching our own base pattern are ever touched.
function syncFilterBlobNames(names, base) {
  var out = [];
  (names || []).forEach(function (n) {
    var h = syncBlobNameHash(n, base);
    if (h) out.push({ name: String(n), hash: h });
  });
  return out;
}
function syncDriveListBlobs(access, cfg) {
  return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), false).then(function (fid) {
    if (!fid) return [];
    var q = "name contains '-att-' and '" + String(fid).replace(/'/g, '') + "' in parents and trashed = false";
    var base = syncDisplayBasename(cfg.filename);
    return syncDriveList(access, q).then(function (files) {
      var names = (files || []).map(function (f) { return f && f.name; });
      return syncFilterBlobNames(names, base);
    });
  });
}
function syncDropboxListBlobs(access, cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  var base = syncDisplayBasename(cfg.filename);
  var out = [];
  function page(cursor) {
    var url, body;
    if (!cursor) {
      url = 'https://api.dropboxapi.com/2/files/list_folder';
      body = JSON.stringify({ path: folder ? '/' + folder : '', recursive: false, limit: 2000 });
    } else {
      url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
      body = JSON.stringify({ cursor: cursor });
    }
    return syncFetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' }, body: body }, 'Dropbox').then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error('sync failed: Dropbox listing refused (HTTP ' + res.status + ').');
        ((data && data.entries) || []).forEach(function (e) {
          if (e && e['.tag'] === 'file' && typeof e.name === 'string') {
            var h = syncBlobNameHash(e.name, base);
            if (h) out.push({ name: e.name, hash: h });
          }
        });
        if (data && data.has_more && data.cursor) return page(data.cursor);
        return out;
      }, function () { throw new Error('sync failed: bad Dropbox response.'); });
    });
  }
  return page(null);
}
function syncS3ListBlobs(cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  var base = syncDisplayBasename(cfg.filename);
  var prefix = folder ? folder + '/' : '';
  var out = [];
  function escQ(s) { return encodeURIComponent(s).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); }
  function page(token) {
    var qs = 'list-type=2&max-keys=1000&prefix=' + escQ(prefix);
    if (token) qs = 'continuation-token=' + escQ(token) + '&' + qs;
    return syncS3SignQuery(cfg, 'GET', qs).then(function (s) {
      return syncFetch(s.url, { headers: s.headers }, 'the S3 endpoint').then(function (res) {
        return res.text().then(function (body) {
          if (!res.ok) throw new Error('sync failed: S3 listing refused (HTTP ' + res.status + ').');
          var keys = [];
          try {
            var re = /<Key>([^<]*)<\/Key>/g, m;
            while ((m = re.exec(body)) !== null) keys.push(m[1]);
          } catch (e) { keys = []; }
          keys.forEach(function (k) {
            var name = String(k).split('/').pop();
            var h = syncBlobNameHash(name, base);
            if (h) out.push({ name: name, hash: h });
          });
          var trunc = /<IsTruncated>true<\/IsTruncated>/.test(body);
          var next = null;
          try { var nm = body.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/); next = nm ? nm[1] : null; } catch (e) { next = null; }
          if (trunc && next) return page(next);
          return out;
        });
      });
    });
  }
  return page(null);
}
function syncWebdavListBlobs(cfg) {
  var auth;
  try { auth = syncWebdavAuth(cfg); } catch (e) { return Promise.reject(e); }
  if (!cfg.url) return Promise.reject(new Error('sync failed: enter the WebDAV server URL.'));
  var base = syncDisplayBasename(cfg.filename);
  var root = String(cfg.url).replace(/\s+$/g, '').replace(/\/+$/, '');
  return syncFetch(root, {
    method: 'PROPFIND',
    headers: { 'Authorization': auth, 'Depth': '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><propname/></propfind>'
  }, 'the WebDAV server').then(function (res) {
    return res.text().then(function (body) {
      if (!res.ok && res.status !== 207) throw new Error('sync failed: WebDAV listing refused (HTTP ' + res.status + ').');
      var names = [];
      try {
        var re = /<[^>]*href[^>]*>([^<]+)<\//gi, m;
        while ((m = re.exec(body)) !== null) {
          var parts = decodeURIComponent(m[1]).split('/');
          var last = parts.pop() || '';
          if (last) names.push(last);
        }
      } catch (e) { names = []; }
      return syncFilterBlobNames(names, base);
    });
  });
}
function syncRemoteListBlobs(cfg) {
  if (cfg.provider === 'webdav') return syncWebdavListBlobs(cfg);
  if (cfg.provider === 'megas3') return syncS3ListBlobs(cfg);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') return syncDriveListBlobs(access, cfg);
    if (cfg.provider === 'dropbox') return syncDropboxListBlobs(access, cfg);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}
function syncRemoteDeleteBlob(cfg, name) {
  var bc = syncBlobCfgFor(cfg, name);
  if (cfg.provider === 'webdav') {
    var auth;
    try { auth = syncWebdavAuth(cfg); } catch (e) { return Promise.reject(e); }
    return syncFetch(syncJoinUrl(cfg.url, name), { method: 'DELETE', headers: { 'Authorization': auth } }, 'the WebDAV server').then(function (res) {
      if (res.ok || res.status === 404) return true;
      throw new Error('sync failed: WebDAV delete refused (HTTP ' + res.status + ').');
    });
  }
  if (cfg.provider === 'megas3') {
    return syncS3Sign(bc, 'DELETE', '').then(function (s) {
      var h = {};
      for (var k in s.headers) { if (Object.prototype.hasOwnProperty.call(s.headers, k) && k.toLowerCase() !== 'content-type') h[k] = s.headers[k]; }
      return syncFetch(s.url, { method: 'DELETE', headers: h }, 'the S3 endpoint').then(function (res) {
        if (res.ok || res.status === 404 || res.status === 204) return true;
        throw new Error('sync failed: S3 delete refused (HTTP ' + res.status + ').');
      });
    });
  }
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') {
      return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), false).then(function (fid) {
        if (!fid) return true;
        return syncDriveFind(access, name, fid).then(function (id) {
          if (!id) return true;
          return syncFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id), {
            method: 'DELETE', headers: { 'Authorization': 'Bearer ' + access }
          }, 'Google Drive').then(function (res) {
            if (res.ok || res.status === 404 || res.status === 204) return true;
            throw new Error('sync failed: Drive delete refused (HTTP ' + res.status + ').');
          });
        });
      });
    }
    if (cfg.provider === 'dropbox') {
      var folder = syncNormalizeFolder(cfg.folder);
      return syncFetch('https://api.dropboxapi.com/2/files/delete_v2', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/' + (folder ? folder + '/' : '') + name })
      }, 'Dropbox').then(function (res) {
        if (res.ok) return true;
        if (res.status === 409) return true; // already gone counts as cleaned
        throw new Error('sync failed: Dropbox delete refused (HTTP ' + res.status + ').');
      });
    }
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}
function syncCleanupFlow() {
  if (syncBusy) return;
  var cfg = syncReadForm().cfg;
  syncSetBusy(true, 'Listing cloud files…');
  var referenced = {};
  try {
    syncAttachmentMetas(loadState()).forEach(function (m) { referenced[m.hash] = true; });
  } catch (e) { /* ignore */ }
  syncRemoteListBlobs(cfg).then(function (items) {
    var orphans = (items || []).filter(function (it) { return it && it.hash && !referenced[it.hash]; });
    syncSetBusy(false);
    syncRefreshSyncPanel({ keepStatus: true });
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    if (!orphans.length) {
      syncSetStatus((items && items.length) ? 'Cloud files match your records — nothing orphaned.' : 'No invoice/receipt files in the drive folder yet.');
      return;
    }
    var count = orphans.length;
    confirmAction('Delete ' + count + ' orphaned file' + (count === 1 ? '' : 's') + '?',
      (count === 1)
      ? 'There is 1 cloud copy that belongs to no record on this device. Only continue if every device synced recently — a device that has not uploaded yet would lose its copy.'
      : 'There are ' + count + ' cloud copies that belong to no record on this device. Only continue if every device synced recently — a device that has not uploaded yet would lose its copy.',
      'Delete files').then(function (ok) {
      if (!ok) return;
      syncSetBusy(true, 'Deleting…');
      var done = 0, failed = 0;
      var chain = Promise.resolve(true);
      orphans.forEach(function (o) {
        chain = chain.then(function () {
          return syncRemoteDeleteBlob(cfg, o.name).then(function () { done++; }, function () { failed++; });
        });
      });
      chain.then(function () {
        syncSetBusy(false);
        syncRefreshSyncPanel({ keepStatus: true });
        try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
        syncSetStatus('Cleanup done: ' + done + ' deleted' + (failed ? ', ' + failed + ' failed' : '') + '.');
      });
    });
  }, function (err) {
    syncSetBusy(false);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    showBanner('Cleanup failed — nothing was deleted.', 'error', {
      title: 'Sync error',
      lines: [String((err && err.message) || err)]
    });
  });
}

// --- Push / pull orchestration (local data only replaced after full validation) ---

function syncSetStatus(text) {
  var el = (typeof document !== 'undefined') ? document.getElementById('sy-status') : null;
  if (el) el.textContent = String(text);
}

function syncSetBusy(on, note) {
  syncBusy = !!on;
  var ids = ['sy-connect', 'sy-disconnect', 'sy-push', 'sy-pull', 'sy-cleanup', 'sy-enc-download'];
  var i, el;
  for (i = 0; i < ids.length; i++) {
    el = (typeof document !== 'undefined') ? document.getElementById(ids[i]) : null;
    if (el) el.disabled = syncBusy;
  }
  if (on && note) syncSetStatus(note);
  try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
}

function syncLocalExportedAt(json) {
  try {
    var d = JSON.parse(json);
    if (d && typeof d.exportedAt === 'string') return d.exportedAt;
  } catch (e) { /* ignore */ }
  return '';
}

// Dirty tracking without crypto: a fast non-crypto hash (djb2 pair) over the
// stable backup projection (exportedAt excluded, or every push would look
// dirty). Used only to decide "same as last upload", never for security.
function syncStateHash(str) {
  var h1 = 5381;
  var h2 = 52711;
  var s = String(str);
  var i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    h1 = ((h1 * 33) ^ c) >>> 0;
    h2 = ((h2 * 33) ^ c) >>> 0;
  }
  return (h1 >>> 0).toString(16) + '-' + (h2 >>> 0).toString(16);
}

function syncHashOfExport(json) {
  try {
    var d = JSON.parse(String(json));
    return syncStateHash(JSON.stringify({
      settings: (d && d.settings) || {},
      accounts: (d && d.accounts) || [],
      trades: (d && d.trades) || [],
      priceOverrides: (d && d.priceOverrides) || {}
    }));
  } catch (e) {
    return '';
  }
}

function syncCurrentHash(st) {
  var s = st;
  try {
    if (!s) s = loadState();
    return syncHashOfExport(exportState(s));
  } catch (e) {
    return '';
  }
}

// "Connected" = enough filled in to attempt a sync right now (secrets may
// live only in the form for this session). The panel status and the header
// icon share this so they can never disagree.
function syncIsConnected(cfg) {
  if (!cfg) return false;
  if (cfg.provider === 'webdav') return !!(cfg.url && (cfg.password || syncMemSecrets.password));
  if (cfg.provider === 'megas3') {
    return !!(cfg.endpoint && cfg.bucket && cfg.accessKey && (cfg.secretKey || syncMemSecrets.secretKey));
  }
  return !!(cfg.tokens && cfg.tokens.access);
}

function syncSetSyncIcon(state, label) {
  var btn = (typeof document !== 'undefined') ? document.getElementById('tb-sync') : null;
  if (!btn) return;
  try { btn.setAttribute('data-sync', state); } catch (e) { /* ignore */ }
  try { btn.setAttribute('aria-label', label); } catch (e) { /* ignore */ }
  try { btn.title = label; } catch (e) { /* ignore */ }
  try {
    var img = document.getElementById('tb-sync-img');
    if (img) {
      img.src = state === 'busy' ? '/icons/sync-busy.png'
        : state === 'stale' ? '/icons/sync-stale.png'
        : '/icons/sync-ok.png';
    }
  } catch (e) { /* ignore */ }
}

function syncRefreshHeaderIcon(st) {
  var btn = (typeof document !== 'undefined') ? document.getElementById('tb-sync') : null;
  if (!btn) return;
  if (syncBusy) {
    btn.hidden = false;
    syncSetSyncIcon('busy', 'Sync: uploading…');
    return;
  }
  var cfg = syncLoadConfig();
  if (!syncIsConnected(cfg)) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (syncPendingRemote) {
    syncSetSyncIcon('stale', 'Sync: drive and this device disagree. Open sync settings to resolve.');
    return;
  }
  var cur = '';
  try { cur = syncCurrentHash(st); } catch (e) { cur = ''; }
  if (cur && cfg.lastSyncedHash && cur === cfg.lastSyncedHash) {
    syncSetSyncIcon('ok', 'Sync: up to date. Open sync settings.');
  } else {
    syncSetSyncIcon('stale', 'Sync: changes pending. Open sync settings to sync now.');
  }
}

// Auto-sync (opt-in checkbox in the Sync tab): every persisted change
// schedules one debounced encrypted push using the passphrase currently in
// the form. Silent by design — failures only touch the status line, and a
// newer drive copy never triggers a surprise overwrite prompt.
var SYNC_AUTO_DELAY_MS = 8000;
var syncAutoTimer = null;

function syncAutoDelay(ms) {
  if (ms !== undefined && isFinite(Number(ms)) && Number(ms) >= 0) SYNC_AUTO_DELAY_MS = Number(ms);
  return SYNC_AUTO_DELAY_MS;
}

function syncScheduleAuto() {
  try {
    if (typeof setTimeout === 'undefined') return;
    if (typeof confirmSettle !== 'undefined' && confirmSettle) return; // a confirm dialog owns the user right now
    var cfg = syncLoadConfig();
    if (!cfg.autoSync) return;
    if (syncBusy) return;
    if (syncAutoTimer) {
      try { clearTimeout(syncAutoTimer); } catch (e) { /* ignore */ }
      syncAutoTimer = null;
    }
    syncAutoTimer = setTimeout(function () {
      syncAutoTimer = null;
      try { syncAutoPush(); } catch (e) { /* ignore */ }
    }, SYNC_AUTO_DELAY_MS);
  } catch (e) { /* ignore */ }
}

function syncAutoPush() {
  if (syncBusy) return;
  var cfg;
  try {
    cfg = syncLoadConfig();
  } catch (e) {
    return;
  }
  if (!cfg.autoSync) return;
  // Same source as manual pushes: the typed value, falling back to the
  // remembered passphrase so auto-sync also works when Settings was never
  // opened this session. Without either, stay silent — the hourglass icon
  // already shows pending work, and Connect/Sync enforce the passphrase
  // when pressed.
  var pass = '';
  try {
    pass = syncReadForm().passphrase;
  } catch (e) {
    pass = '';
  }
  if (!pass) return;
  try {
    syncPushFlow({ auto: true });
  } catch (e) { /* ignore */ }
}

// Adopts an already-downloaded + decrypted drive backup (used by the
// taken-name prompt's "Download instead"). Validates fully before touching
// anything, like the pull flow; the confirm already happened, so no snapshot
// dance is needed. Keeps the settings dialog open with a status line.
function syncAdoptRemote(cfg, remotePlain) {
  var next;
  try {
    next = importState(remotePlain);
  } catch (e) {
    if (e && e.message === 'storage-unavailable') throw e;
    throw new Error('sync failed: the drive backup is invalid (' + String((e && e.message) || e).slice(0, 160) + ').');
  }
  if (!saveStateGuarded(next)) return 'failed';
  cfg.lastSyncAt = new Date().toISOString();
  try {
    var d = JSON.parse(remotePlain);
    if (d && typeof d.exportedAt === 'string') cfg.lastRemoteAt = d.exportedAt;
  } catch (e) { /* ignore */ }
  cfg.lastSyncedHash = syncHashOfExport(remotePlain);
  cfg.lastLocation = syncLocationKey(cfg);
  cfg.lastIdentity = syncTrustIdentity(cfg);
  cfg.locV = SYNC_LOC_V;
  syncPendingRemote = false;
    syncSaveConfig(cfg);
  syncRefreshSyncPanel();
  try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
  clearBanner();
  syncSetStatus('Restored from ' + syncProviderLabel(cfg.provider) + '.');
  refreshPrices();
  return 'pulled';
}

function syncPushFlow(opts) {  if (syncBusy) return;
  var auto = !!(opts && opts.auto);
  var rd = syncReadForm();
  var cfg = rd.cfg;
  var pass = rd.passphrase;
  if (!pass) {
    // Auto-sync without a passphrase stays silent (hourglass icon shows it);
    // manual attempts get the banner.
    if (auto) return;
    showBanner('Enter a sync passphrase first — it encrypts everything you upload.', 'error', {
      title: 'Sync needs a passphrase',
      lines: ['Type a passphrase in the Sync tab. It is never sent anywhere.']
    });
    return;
  }
  var st = loadState();
  if ((!st.accounts || !st.accounts.length) && (!st.trades || !st.trades.length)) {
    if (auto) {
      try { syncSetStatus('Nothing to sync yet.'); } catch (e) { /* ignore */ }
      return;
    }
    showBanner('Nothing to sync yet — add an account first.', 'error', {
      title: 'Sync',
      lines: ['Uploading an empty wallet could overwrite a good drive copy. Add data first.']
    });
    return;
  }
  syncPersistFormSecrets(cfg);
  syncSetBusy(true, 'Encrypting…');
  var plain = exportState(st);
  var localAt = syncLocalExportedAt(plain);
  var curHash = syncHashOfExport(plain);
  var baseHash = cfg.lastSyncedHash || '';
  syncEncryptEnvelope(plain, pass).then(function (env) {
    syncSetStatus('Uploading to ' + syncProviderLabel(cfg.provider) + '…');
    var locKey = syncLocationKey(cfg);
    // First save to a destination this device has never synced (or under
    // changed credentials): never clobber a stranger's file (e.g. another
    // profile's backup sharing the same drive). Trusted destinations
    // upload freely.
    if (!syncIsTrustedLocation(cfg, locKey)) {
      return syncRemoteExists(cfg).then(function (taken) {
        if (!taken) {
          return syncRemoteEnsureFolder(cfg).then(function () {
            return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
          });
        }
        return syncRemoteDownload(cfg).then(function (remoteText) {
          return syncDecryptEnvelope(remoteText, pass).then(function (remotePlain) {
            if (curHash && syncHashOfExport(remotePlain) === curHash) {
              // Same content (e.g. reconnect with nothing changed): adopt
              // silently — no prompt, no pointless re-upload.
              cfg.lastLocation = locKey;
              cfg.lastIdentity = syncTrustIdentity(cfg);
              cfg.locV = SYNC_LOC_V;
              cfg.lastRemoteAt = syncLocalExportedAt(remotePlain);
              cfg.lastSyncedHash = curHash;
              syncSaveConfig(cfg);
              syncSetBusy(false);
              syncRefreshSyncPanel();
              try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
              syncSetStatus('Already up to date.');
              return 'adopted';
            }
            // Different content under our name: both directions, explicit.
            // (Auto-sync never prompts either: it stands down for the user.)
            syncSetBusy(false);
            if (auto) {
              syncRefreshSyncPanel();
              try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
              syncSetStatus('Drive holds a different copy — open Sync to resolve.');
              return 'conflict-remote';
            }
            return confirmAction3(
              'Name already taken',
              'A different backup named "' + cfg.filename + '" already exists in this folder. Download it (replaces this device) or upload yours (overwrites the drive file)?',
              'Download instead',
              'Upload mine'
            ).then(function (choice) {
              if (choice === 'primary') return syncAdoptRemote(cfg, remotePlain);
              if (choice === 'secondary') {
                syncSetBusy(true, 'Uploading to ' + syncProviderLabel(cfg.provider) + '…');
                return syncRemoteEnsureFolder(cfg).then(function () {
                  return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
                });
              }
              syncSetStatus('Kept the drive file. Change the name or folder to sync here.');
              return 'cancelled';
            });
          }, function () {
            throw new Error('sync failed: "' + cfg.filename + '" already exists in this folder, under a different passphrase. Choose a different name or folder — or delete that file on the drive if it is yours.');
          });
        });
      });
    }
    // Trusted destination: reconcile against the drive copy using content
    // hashes, never wall clocks. The fresh exportedAt above always reads
    // "now", so a timestamp compare can never see a newer drive copy — a
    // stale device would report success while overwriting it. A clean local
    // tree still verifies the drive instead of assuming "up to date".
    if (curHash && baseHash && curHash === baseHash) {
      // Nothing local to upload — but prove the drive agrees first.
      return syncRemoteDownload(cfg).then(function (remoteText) {
        return syncDecryptEnvelope(remoteText, pass).then(function (remotePlain) {
          var remoteHash = syncHashOfExport(remotePlain);
          if (remoteHash && remoteHash === curHash) {
            cfg.lastLocation = locKey;
            cfg.lastIdentity = syncTrustIdentity(cfg);
            cfg.locV = SYNC_LOC_V;
            cfg.lastRemoteAt = syncLocalExportedAt(remotePlain);
            cfg.lastSyncedHash = curHash;
            syncSaveConfig(cfg);
            syncPendingRemote = false;
            syncSetBusy(false);
            syncRefreshSyncPanel();
            try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
            syncSetStatus('Already up to date.');
            return 'adopted';
          }
          // The drive moved while this device stood still: pull it in.
          // Nothing local to lose (local == last sync point).
          var pulledAt = syncAdoptRemote(cfg, remotePlain);
          syncSetStatus('Pulled newer changes from ' + syncProviderLabel(cfg.provider) + '.');
          try { render(); } catch (e) { /* ignore */ }
          return pulledAt;
        }, function () {
          // Drive file exists but this passphrase cannot open it: stop, do not overwrite blindly.
          throw new Error('sync failed: the drive file uses a different passphrase. Enter that passphrase, or clear the drive file first.');
        });
      }, function (dlErr) {
        // File gone (deleted remotely?) with nothing local to upload: stay
        // quiet — the next real change recreates it.
        if (dlErr && dlErr.message && dlErr.message.indexOf('no backup found') !== -1) {
          syncPendingRemote = false;
          syncSetBusy(false);
          syncRefreshSyncPanel();
          try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
          syncSetStatus('Already up to date.');
          return 'verified';
        }
        throw dlErr;
      });
    }
    // Dirty local tree: three-way decision against the last sync point.
    // Only-local-changed uploads freely; only-remote-changed is never
    // overwritten; both-changed asks the user (auto-sync stands down).
    syncSetStatus('Checking drive for newer changes…');
    return syncRemoteDownload(cfg).then(function (remoteText) {
      return syncDecryptEnvelope(remoteText, pass).then(function (remotePlain) {
        var remoteHash = syncHashOfExport(remotePlain);
        var dir = syncDirection(curHash, remoteHash, baseHash);
        if (dir === 'in-sync') {
          cfg.lastLocation = locKey;
          cfg.lastIdentity = syncTrustIdentity(cfg);
          cfg.locV = SYNC_LOC_V;
          cfg.lastRemoteAt = syncLocalExportedAt(remotePlain);
          cfg.lastSyncedHash = curHash;
          syncSaveConfig(cfg);
          syncPendingRemote = false;
          syncSetBusy(false);
          syncRefreshSyncPanel();
          try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
          syncSetStatus('Already up to date.');
          return 'adopted';
        }
        if (dir === 'local-only') {
          // Only this device changed: fast-forward upload, no prompt.
          syncSetStatus('Uploading to ' + syncProviderLabel(cfg.provider) + '…');
          return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
        }
        // remote-only or a true conflict: never overwrite blindly.
        // (Auto-sync never prompts: it stands down for the user.)
        syncPendingRemote = true;
        syncSetBusy(false);
        if (auto) {
          syncRefreshSyncPanel();
          try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
          syncSetStatus(dir === 'remote-only'
            ? 'Drive holds a newer copy — open Sync to resolve.'
            : 'Devices disagree — open Sync to resolve.');
          return 'conflict-remote';
        }
        return confirmAction3(
          dir === 'remote-only' ? 'Drive copy is newer' : 'Sync conflict',
          dir === 'remote-only'
            ? 'The drive backup changed since this device last synced, and this device has no new changes. Download it (replaces this device) or upload yours (overwrites the drive file)?'
            : 'Both this device and the drive changed since the last sync. Download the drive copy (replaces this device) or upload yours (overwrites the drive file)?',
          'Download instead',
          'Upload mine'
        ).then(function (choice) {
          if (choice === 'primary') {
            var pulledAt = syncAdoptRemote(cfg, remotePlain);
            try { render(); } catch (e) { /* ignore */ }
            return pulledAt;
          }
          if (choice === 'secondary') {
            syncSetBusy(true, 'Uploading to ' + syncProviderLabel(cfg.provider) + '…');
            return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
          }
          syncSetStatus('Upload cancelled — drive copy kept.');
          return 'cancelled';
        });
      }, function (decErr) {
        // Drive file exists but this passphrase cannot open it: stop, do not overwrite blindly.
        throw new Error('sync failed: the drive file uses a different passphrase. Enter that passphrase, or clear the drive file first.');
      });
    }, function (dlErr) {
      // Known destination but nothing there (deleted remotely?): recreate it.
      if (dlErr && dlErr.message && dlErr.message.indexOf('no backup found') !== -1) {
        return syncRemoteEnsureFolder(cfg).then(function () {
          return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
        });
      }
      throw dlErr;
    });
  }).then(function (outcome) {
    syncSetBusy(false);
    if (outcome === 'pushed' || outcome === 'adopted' || outcome === 'pulled' || outcome === 'verified') syncPendingRemote = false;
    if (outcome === 'cancelled' || outcome === 'conflict-remote' || outcome === 'adopted' || outcome === 'pulled' || outcome === 'verified') {
      // Dismissals and already-handled outcomes: re-lock the buttons to the
      // connection state but keep the specific status line that was set.
      syncRefreshSyncPanel({ keepStatus: true });
      try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
      return;
    }
    var now = new Date().toISOString();
    cfg.lastSyncAt = now;
    cfg.lastRemoteAt = localAt;
    cfg.lastSyncedHash = curHash;
    cfg.lastLocation = syncLocationKey(cfg);
    cfg.lastIdentity = syncTrustIdentity(cfg);
    cfg.locV = SYNC_LOC_V;
        syncSaveConfig(cfg);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    clearBanner();
    syncSetStatus('Synced ' + fmtDateTimeDmy(now) + '.');
    // Attachments ride along: upload this device's blobs (skip-if-exists)
    // after the state lands. Best-effort — state is already synced, blobs
    // retry on the next push, so this never fails the sync itself.
    if (outcome === 'pushed') {
      try {
        syncPushAttachments(cfg, pass).then(function (r) {
          if (r && r.up > 0) syncSetStatus('Synced ' + fmtDateTimeDmy(now) + ' + ' + r.up + ' file' + (r.up === 1 ? '' : 's') + '.');
        });
      } catch (e) { /* blobs retry next push */ }
    }
  }, function (err) {
    syncSetBusy(false);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    // Auto-sync fails quietly into the status line (it retries on the next
    // change); only manual attempts raise the banner.
    if (auto) {
      syncSetStatus('Auto-sync will retry on the next change.');
      return;
    }
    showBanner('Sync failed — your data was left untouched.', 'error', {
      title: 'Sync error',
      lines: [String((err && err.message) || err)]
    });
  });
}

function syncPullFlow() {
  if (syncBusy) return;
  var rd = syncReadForm();
  var cfg = rd.cfg;
  var pass = rd.passphrase;
  if (!pass) {
    showBanner('Enter the sync passphrase to restore.', 'error', {
      title: 'Sync needs a passphrase',
      lines: ['The drive copy is encrypted — the passphrase never leaves this browser.']
    });
    return;
  }
  syncPersistFormSecrets(cfg);
  syncSetBusy(true, 'Downloading from ' + syncProviderLabel(cfg.provider) + '…');
  // Snapshot first: importState() persists immediately, so a cancelled
  // restore must put the previous state back — the confirm is real.
  var beforeJson = null;
  try {
    beforeJson = exportState(loadState());
  } catch (e) {
    beforeJson = null;
  }
  syncRemoteDownload(cfg).then(function (remoteText) {
    return syncDecryptEnvelope(remoteText, pass);
  }).then(function (plain) {
    var next;
    try {
      next = importState(plain);
    } catch (e) {
      if (e && e.message === 'storage-unavailable') throw e;
      throw new Error('sync failed: the drive backup is invalid (' + String((e && e.message) || e).slice(0, 160) + ').');
    }
    syncSetBusy(false);
    // Stale-drive warning, decided by content — not by a fresh exportedAt
    // stamp (which always reads "now" and cried "older" even when the drive
    // copy was newer). Only when the drive still holds our last sync point
    // while this device moved on is the drive copy truly older.
    var remoteHashP = syncHashOfExport(plain);
    var curBeforeP = '';
    try { curBeforeP = syncHashOfExport(beforeJson || ''); } catch (e) { curBeforeP = ''; }
    var stale = (syncDirection(curBeforeP, remoteHashP, (cfg.lastSyncedHash || '')) === 'local-only');
    return confirmAction(
      stale ? 'Drive copy is older' : 'Replace this device?',
      stale
        ? 'The drive backup is older than this device. Restore it anyway? This replaces all accounts, trades and settings on this device with the older copy.'
        : 'Restore the drive backup here? This replaces all accounts, trades and settings on this device.',
      stale ? 'Restore older copy' : 'Restore backup',
      true
    ).then(function (ok) {
      if (!ok) {
        if (beforeJson) {
          try {
            saveStateGuarded(JSON.parse(beforeJson));
          } catch (e2) { /* banner already shown by the guard on storage failure */ }
        }
        // The drive still disagrees after a cancelled restore (unless the
        // drive copy is simply older): keep the stale icon + panel hint.
        try {
          var curAfter = '';
          try { curAfter = syncHashOfExport(beforeJson || ''); } catch (e5) { curAfter = ''; }
          var dirAfter = syncDirection(curAfter, remoteHashP, (cfg.lastSyncedHash || ''));
          syncPendingRemote = (dirAfter === 'remote-only' || dirAfter === 'conflict');
        } catch (e6) { /* flag stays as-is */ }
        syncSetStatus('Restore cancelled.');
        syncRefreshSyncPanel({ keepStatus: true });
        try { syncRefreshHeaderIcon(); } catch (e3) { /* ignore */ }
        return 'cancelled';
      }
      if (!saveStateGuarded(next)) {
        syncRefreshSyncPanel({ keepStatus: true });
        try { syncRefreshHeaderIcon(); } catch (e4) { /* ignore */ }
        return 'failed';
      }
      cfg.lastSyncAt = new Date().toISOString();
      try {
        var d = JSON.parse(plain);
        if (d && typeof d.exportedAt === 'string') cfg.lastRemoteAt = d.exportedAt;
      } catch (e) { /* ignore */ }
      cfg.lastSyncedHash = syncHashOfExport(plain);
      cfg.lastLocation = syncLocationKey(cfg); // adopt: future pushes update this file
      cfg.locV = SYNC_LOC_V;
      cfg.lastIdentity = syncTrustIdentity(cfg);
      syncPendingRemote = false;
            syncSaveConfig(cfg);
      syncRefreshSyncPanel();
      try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
      clearBanner();
      syncSetStatus('Restored from ' + syncProviderLabel(cfg.provider) + '.');
      refreshPrices();
      closeDialog('settings-dialog');
      return 'pulled';
    });
  }, function (err) {
    syncSetBusy(false);
    syncRefreshSyncPanel();
    showBanner('Restore failed — your data was left untouched.', 'error', {
      title: 'Sync error',
      lines: [String((err && err.message) || err)]
    });
  });
}

// One remote check, shared by the page-load hook below (and tests): download,
// decrypt and reconcile against the last sync point. Never overwrites local
// work blindly — remote-only changes are pulled, local-only changes are left
// for the next push, conflicts only raise the stale flag + status.
// Resolves 'in-sync' | 'pulled' | 'local-only' | 'conflict' | 'skipped' |
// 'unavailable' | 'unreachable' | 'unknown' | 'invalid' | 'busy'. Never rejects.
function syncCheckRemoteNow() {
  if (syncBusy) return Promise.resolve('busy');
  var rd = null;
  try {
    rd = syncReadForm();
  } catch (e) {
    return Promise.resolve('unavailable');
  }
  var cfg = rd.cfg;
  var pass = rd.passphrase;
  if (!syncIsConnected(cfg) || !pass) return Promise.resolve('skipped');
  if (!syncCryptoAvailable()) return Promise.resolve('unavailable');
  return syncRemoteDownload(cfg).then(function (remoteText) {
    return syncDecryptEnvelope(remoteText, pass);
  }).then(function (remotePlain) {
    var remoteHash = syncHashOfExport(remotePlain);
    var curHash = '';
    try {
      curHash = syncCurrentHash();
    } catch (e) {
      curHash = '';
    }
    if (!remoteHash || !curHash) return 'unknown';
    var dir = syncDirection(curHash, remoteHash, cfg.lastSyncedHash || '');
    if (dir === 'in-sync') {
      if (cfg.lastSyncedHash !== curHash) {
        cfg.lastSyncedHash = curHash;
        try {
          var d0 = JSON.parse(remotePlain);
          if (d0 && typeof d0.exportedAt === 'string') cfg.lastRemoteAt = d0.exportedAt;
        } catch (e0) { /* ignore */ }
        syncSaveConfig(cfg);
      }
      syncPendingRemote = false;
      syncRefreshSyncPanel();
      try {
        syncRefreshHeaderIcon();
      } catch (e1) { /* ignore */ }
      return 'in-sync';
    }
    if (dir === 'remote-only') {
      // Safe: this device holds no unsynced work, so adopting loses nothing.
      var pulled = null;
      try {
        pulled = syncAdoptRemote(cfg, remotePlain);
      } catch (e6) {
        return 'invalid';
      }
      if (pulled !== 'pulled') return pulled;
      try {
        render();
      } catch (e2) { /* ignore */ }
      syncSetStatus('Pulled newer changes from ' + syncProviderLabel(cfg.provider) + '.');
      return 'pulled';
    }
    if (dir === 'local-only') {
      syncPendingRemote = false;
      if (cfg.autoSync) {
        try {
          syncScheduleAuto();
        } catch (e3) { /* ignore */ }
      }
      syncRefreshSyncPanel();
      try {
        syncRefreshHeaderIcon();
      } catch (e4) { /* ignore */ }
      return 'local-only';
    }
    syncPendingRemote = true;
    if (!cfg.lastSyncedHash) syncSetStatus('Drive holds a copy — open Sync to resolve.');
    else syncSetStatus('Devices disagree — open Sync to resolve.');
    syncRefreshSyncPanel({ keepStatus: true });
    try {
      syncRefreshHeaderIcon();
    } catch (e5) { /* ignore */ }
    return 'conflict';
  }, function () {
    // Silent on a background check: offline, missing file, or a passphrase
    // the drive file does not accept. Manual sync still reports these.
    return 'unreachable';
  });
}

// Page-load hook: when this device wakes up behind another one, say so (or
// catch up) instead of claiming "up to date" on local hashes alone. Runs
// once per page load, never in the test harness, and never breaks boot.
var syncLoadChecked = false;
function syncCheckOnLoad() {
  if (syncLoadChecked) return;
  syncLoadChecked = true;
  try {
    if (typeof document !== 'undefined' && document.getElementById('ui-fixtures')) return; // tests.html: no network, no live state
    if (syncBusy) return;
    var cfg = null;
    try {
      cfg = syncLoadConfig();
    } catch (e) {
      return;
    }
    if (!syncIsConnected(cfg)) return;
    var pass = '';
    try {
      pass = syncReadForm().passphrase;
    } catch (e) {
      pass = '';
    }
    if (!pass || !syncCryptoAvailable()) return;
    syncCheckRemoteNow().then(function (outcome) {
      if (outcome !== 'pulled') return;
      var nAcc = 0;
      var nTr = 0;
      try {
        var s = loadState();
        nAcc = (s.accounts || []).length;
        nTr = (s.trades || []).length;
      } catch (e) { /* ignore */ }
      try {
        refreshPrices();
      } catch (e2) { /* ignore */ }
      try {
        showBanner('Pulled newer changes from the drive — this device had no unsynced changes, so nothing was lost (' + nAcc + ' accounts, ' + nTr + ' trades).', 'info', {
          title: 'Sync',
          lines: ['Pulled the newer drive copy (' + nAcc + ' accounts, ' + nTr + ' trades). This device had no unsynced changes, so nothing was lost.']
        });
      } catch (e3) { /* ignore */ }
    }, function () { /* silent: manual sync still reports */ });
  } catch (e) { /* never break boot */ }
}

function syncDownloadEncrypted() {
  if (syncBusy) return;
  var pass = uiVal('sy-pass', '');
  if (!pass) {
    showBanner('Enter a sync passphrase first — it encrypts the file.', 'error', {
      title: 'Encrypted file',
      lines: ['Type a passphrase in the Sync tab. It is never sent anywhere.']
    });
    return;
  }
  syncSetBusy(true, 'Encrypting…');
  syncEncryptEnvelope(exportState(loadState()), pass).then(function (env) {
    syncSetBusy(false);
    downloadTextFile('plutus.inoculens.com-' + backupStamp() + '.enc.json', env, 'application/json');
    clearBanner();
    syncSetStatus('Encrypted file downloaded. Keep it or upload it anywhere.');
  }, function (err) {
    syncSetBusy(false);
    showBanner('Encrypt failed.', 'error', {
      title: 'Encrypted file',
      lines: [String((err && err.message) || err)]
    });
  });
}

function syncRestoreEncryptedFile(file) {
  var pass = uiVal('sy-pass', '');
  if (!file) return;
  if (!pass) {
    showBanner('Enter the sync passphrase to open the file.', 'error', {
      title: 'Encrypted file',
      lines: ['The file is encrypted — the passphrase never leaves this browser.']
    });
    return;
  }
  var reader = new FileReader();
  reader.onload = function () {
    var beforeJson = null;
    try {
      beforeJson = exportState(loadState());
    } catch (e) {
      beforeJson = null;
    }
    syncDecryptEnvelope(String(reader.result), pass).then(function (plain) {
      var next;
      try {
        next = importState(plain);
      } catch (e) {
        if (e && e.message === 'storage-unavailable') {
          showBanner('Storage unavailable — change was not saved.', 'error', {
            title: 'Storage error',
            lines: ['Your data was left untouched. Free space or leave private mode, then retry.']
          });
          return;
        }
        showBanner('Import failed — your data was left untouched.', 'error', {
          title: 'Import error',
          lines: [String((e && e.message) || e)]
        });
        return;
      }
      confirmAction(
        'Replace this device?',
        'Restore this file here? This replaces all accounts, trades and settings on this device.',
        'Restore file',
        true
      ).then(function (ok) {
        if (!ok) {
          if (beforeJson) {
            try {
              saveStateGuarded(JSON.parse(beforeJson));
            } catch (e2) { /* banner already shown by the guard on storage failure */ }
          }
          syncSetStatus('Restore cancelled.');
          return;
        }
        if (!saveStateGuarded(next)) return;
        clearBanner();
        syncSetStatus('Restored from encrypted file.');
        refreshPrices();
        closeDialog('settings-dialog');
      });
    }, function (err) {
      showBanner('Import failed — your data was left untouched.', 'error', {
        title: 'Import error',
        lines: [String((err && err.message) || err)]
      });
    });
  };
  reader.onerror = function () {
    showBanner('Import failed — could not read the file.', 'error', {
      title: 'Import error',
      lines: ['Pick an INOCULENS PLUTUS encrypted backup (.enc.json) and retry.']
    });
  };
  reader.readAsText(file);
}

// --- Settings UI ---

function syncReadForm() {
  var cfg = syncLoadConfig();
  function val(id, fb) {
    var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    return el ? el.value : fb;
  }
  function checked(id, fb) {
    var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    if (!el) return !!fb;
    return !!el.checked;
  }
  var prov = val('sy-provider', cfg.provider);
  if (syncIsProvider(prov)) cfg.provider = prov;
  if (cfg.provider === 'webdav') {
    cfg.url = val('sy-url', cfg.url);
    cfg.username = val('sy-user', cfg.username);
    cfg.filename = syncSanitizeFilename(val('sy-filename', cfg.filename));
    var pwField = val('sy-passwd', '');
    cfg.rememberPassword = checked('sy-remember', cfg.rememberPassword);
    if (cfg.rememberPassword) {
      if (pwField !== '') cfg.password = pwField;
    } else {
      cfg.password = '';
      if (pwField !== '') syncMemSecrets.password = pwField;
    }
  } else if (cfg.provider === 'megas3') {
    cfg.endpoint = val('sy-endpoint', cfg.endpoint);
    cfg.region = val('sy-region', cfg.region);
    cfg.bucket = val('sy-bucket', cfg.bucket);
    cfg.accessKey = val('sy-key', cfg.accessKey);
    cfg.objectKey = syncSanitizeFilename(val('sy-object', cfg.objectKey));
    cfg.folder = val('sy-folder3', cfg.folder);
    var skField = val('sy-skey', '');
    var rememberSk = checked('sy-remember2', cfg.rememberSecret);
    cfg.rememberSecret = rememberSk;
    if (rememberSk) {
      if (skField !== '') cfg.secretKey = skField;
    } else {
      cfg.secretKey = '';
      if (skField !== '') syncMemSecrets.secretKey = skField;
    }
  } else {
    cfg.clientId = val('sy-client', cfg.clientId);
    cfg.clientSecret = val('sy-secret', cfg.clientSecret);
    var fn = val('sy-filename2', cfg.filename);
    cfg.filename = syncSanitizeFilename(fn);
    cfg.folder = val('sy-folder2', cfg.folder);
  }
  var out = syncSanitizeConfig(cfg);
  out.autoSync = !!checked('sy-auto', cfg.autoSync);
  var formPass = val('sy-pass', '');
  var rememberPass = checked('sy-remember-pass', cfg.rememberPassphrase);
  out.rememberPassphrase = rememberPass;
  if (rememberPass) {
    if (formPass !== '') out.passphrase = formPass;
  } else {
    out.passphrase = '';
  }
  var passphrase = formPass || out.passphrase;
  return { cfg: out, passphrase: passphrase };
}

function syncPersistFormSecrets(cfg) {
  var el, memPw, memSk;
  if (typeof document === 'undefined') return;
  if (cfg.provider === 'webdav') {
    el = document.getElementById('sy-passwd');
    memPw = el ? el.value : '';
    if (cfg.rememberPassword) {
      if (memPw !== '') cfg.password = memPw;
      syncMemSecrets.password = '';
    } else {
      cfg.password = '';
      if (memPw !== '') syncMemSecrets.password = memPw;
    }
  }
  if (cfg.provider === 'megas3') {
    el = document.getElementById('sy-skey');
    memSk = el ? el.value : '';
    if (cfg.rememberSecret) {
      if (memSk !== '') cfg.secretKey = memSk;
      syncMemSecrets.secretKey = '';
    } else {
      cfg.secretKey = '';
      if (memSk !== '') syncMemSecrets.secretKey = memSk;
    }
  }
  syncSaveConfig(cfg);
}

function syncSetVal(id, v) {
  var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
  if (el) el.value = v;
}

function syncRefreshSyncPanel(opts) {
  if (typeof document === 'undefined') return;
  if (!document.getElementById('sy-provider')) return;
  var cfg = syncLoadConfig();
  syncSetVal('sy-provider', cfg.provider);
  var groups = { webdav: 'sy-g-webdav', gdrive: 'sy-g-oauth', dropbox: 'sy-g-oauth', megas3: 'sy-g-megas3' };
  var i, g;
  var ids = ['sy-g-webdav', 'sy-g-oauth', 'sy-g-megas3'];
  for (i = 0; i < ids.length; i++) {
    g = document.getElementById(ids[i]);
    if (g) g.hidden = (groups[cfg.provider] !== ids[i]);
  }
  var hint = document.getElementById('sy-hint');
  if (hint) hint.textContent = SYNC_HINTS[cfg.provider] || '';
  var sec = document.getElementById('sy-g-secret');
  if (sec) sec.hidden = (cfg.provider !== 'gdrive');
  var redir = document.getElementById('sy-redirect');
  if (redir) {
    var ru = syncRedirectUri();
    redir.textContent = (cfg.provider === 'webdav' || cfg.provider === 'megas3')
      ? ''
      : (ru || 'Open the hosted https:// page — OAuth cannot start from file://.');
  }
  var sharedNow = syncSharedId(cfg.provider);
  var note = document.getElementById('sy-oneclick-note');
  if (note) {
    note.textContent = sharedNow
      ? ('One-click sign-in is ready — just press Connect.' + (cfg.provider === 'gdrive' ? ' Google sessions last about an hour; reconnect when asked.' : ''))
      : 'One-click is not set up for this provider yet — expand the advanced box below to use your own OAuth app.';
  }
  var adv = document.getElementById('sy-adv');
  if (adv) {
    try { adv.open = !sharedNow; } catch (e) { /* ignore */ }
  }
  if (cfg.provider === 'webdav') {
    syncSetVal('sy-url', cfg.url);
    syncSetVal('sy-user', cfg.username);
    if (cfg.password) syncSetVal('sy-passwd', cfg.password);
    syncSetVal('sy-filename', syncDisplayBasename(cfg.filename));
    var rem = document.getElementById('sy-remember');
    if (rem) rem.checked = cfg.rememberPassword;
  } else if (cfg.provider === 'megas3') {
    syncSetVal('sy-endpoint', cfg.endpoint);
    syncSetVal('sy-region', cfg.region);
    syncSetVal('sy-bucket', cfg.bucket);
    syncSetVal('sy-key', cfg.accessKey);
    if (cfg.secretKey) syncSetVal('sy-skey', cfg.secretKey);
    syncSetVal('sy-object', syncDisplayBasename(cfg.objectKey));
    syncSetVal('sy-folder3', cfg.folder);
    var rem2 = document.getElementById('sy-remember2');
    if (rem2) rem2.checked = !!cfg.rememberSecret;
  } else {
    syncSetVal('sy-client', cfg.clientId);
    if (cfg.clientSecret) syncSetVal('sy-secret', cfg.clientSecret);
    syncSetVal('sy-filename2', syncDisplayBasename(cfg.filename));
    syncSetVal('sy-folder2', cfg.folder);
  }
  var connected = syncIsConnected(cfg);
  var autoBox = document.getElementById('sy-auto');
  if (autoBox) autoBox.checked = !!cfg.autoSync;
  if (cfg.passphrase) syncSetVal('sy-pass', cfg.passphrase);
  var rememberPassBox = document.getElementById('sy-remember-pass');
  if (rememberPassBox) rememberPassBox.checked = !!cfg.rememberPassphrase;
  var last = cfg.lastSyncAt ? (' Last sync ' + fmtDateTimeDmy(cfg.lastSyncAt) + '.') : '';
  // keepStatus: early exits (cancel/dismiss/conflict) already set a specific
  // status line — refresh buttons + indicator but leave their message alone.
  var keepStatus = !!(opts && opts.keepStatus);
  if (!syncBusy && !keepStatus) syncSetStatus((connected ? ('Connected to ' + syncProviderLabel(cfg.provider) + '.') : 'Not connected.') + last + (syncPendingRemote ? ' Drive and this device disagree — open Sync to resolve.' : ''));
  // Connection state is unmistakable on every visit: Connect locks once
  // established, Disconnect unlocks, and the status line turns green.
  // (While busy, syncSetBusy owns the disabled flags — don't fight it.)
  if (!syncBusy) {
    var connectBtn = document.getElementById('sy-connect');
    if (connectBtn) connectBtn.disabled = connected;
    var disconnectBtn = document.getElementById('sy-disconnect');
    if (disconnectBtn) disconnectBtn.disabled = !connected;
  }
  var statusEl = document.getElementById('sy-status');
  if (statusEl && statusEl.classList) {
    try {
      if (connected) statusEl.classList.add('sync-live');
      else statusEl.classList.remove('sync-live');
    } catch (e) { /* ignore */ }
  }
  var fp = document.getElementById('sy-fp');
  var passEl = document.getElementById('sy-pass');
  if (fp && passEl && passEl.value) {
    var v0 = passEl.value;
    syncFingerprint(v0).then(function (f) {
      var cur = document.getElementById('sy-pass');
      if (cur && cur.value === v0) {
        var fel = document.getElementById('sy-fp');
        if (fel) fel.textContent = 'Key fingerprint: ' + (f || '—') + ' (same on all devices = same passphrase)';
      }
    });
  } else if (fp) {
    fp.textContent = 'Key fingerprint: —';
  }
  try { syncToggleEncButtons(); } catch (e) { /* ignore */ }
}

function syncClearOAuthAttempt() {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SYNC_OAUTH_KEY);
  } catch (e) { /* ignore */ }
}

function syncPassphraseOrBanner() {
  var pass = '';
  try {
    var el = (typeof document !== 'undefined') ? document.getElementById('sy-pass') : null;
    pass = el ? el.value : '';
    if (!pass) {
      var cfg = syncLoadConfig();
      if (cfg.rememberPassphrase && cfg.passphrase) pass = cfg.passphrase;
    }
  } catch (e) { pass = ''; }
  if (!pass) {
    showBanner('Enter a sync passphrase first — sync only works encrypted.', 'error', {
      title: 'Sync needs a passphrase',
      lines: ['Type a passphrase in the Sync tab. It encrypts everything you upload and is never sent anywhere.']
    });
    return null;
  }
  return pass;
}

function syncStartOAuth() {
  if (syncBusy) return;
  if (!syncPassphraseOrBanner()) return;
  var rd = syncReadForm();
  var cfg = rd.cfg;
  // WebDAV / MEGA have no OAuth dance: Connect simply tests the login.
  if (cfg.provider !== 'gdrive' && cfg.provider !== 'dropbox') {
    syncTestConnection();
    return;
  }
  if (!syncCryptoAvailable()) {
    showBanner('This browser cannot do encrypted sync (WebCrypto unavailable).', 'error', {
      title: 'Sync unavailable',
      lines: ['Use Download backup in the Backup & restore tab instead.']
    });
    return;
  }
  var shared = syncSharedId(cfg.provider);
  var clientId = shared || cfg.clientId;
  if (!clientId) {
    showBanner('One-click sign-in is not set up for ' + syncProviderLabel(cfg.provider) + ' yet.', 'error', {
      title: 'Connect',
      lines: ['Expand "Bring your own OAuth app" below, create an app with the provider, register the redirect URI shown, then paste its client ID.']
    });
    return;
  }
  if (cfg.provider === 'gdrive' && !shared && !cfg.clientSecret) {
    showBanner('Enter the OAuth client secret too (Google needs it for your own app).', 'error', {
      title: 'Connect',
      lines: ['Google Web-application clients always have a secret — paste it alongside the client ID.']
    });
    return;
  }
  // Google one-click uses Google's own sign-in library (loaded only now,
  // never on page load): no secret, no redirect URI, just your login.
  if (cfg.provider === 'gdrive' && shared) {
    syncPersistFormSecrets(cfg);
    syncSetBusy(true, 'Waiting for ' + syncProviderLabel(cfg.provider) + '…');
    syncGoogleOneClick(cfg).then(function (tok) {
      cfg.tokens = tok;
      syncSaveConfig(cfg);
      syncSetBusy(false);
      syncConnectThenSync();
    }, function (err) {
      syncSetBusy(false);
      syncRefreshSyncPanel();
      showBanner('Sign-in failed — your data was left untouched.', 'error', {
        title: 'Connect',
        lines: [String((err && err.message) || err)]
      });
    });
    return;
  }
  var redirect = syncRedirectUri();
  if (!redirect) {
    showBanner('OAuth needs the hosted https:// page.', 'error', {
      title: 'Connect',
      lines: ['Sign-in cannot start from a file:// window. Open your deployed site URL, then connect.']
    });
    return;
  }
  syncPersistFormSecrets(cfg);
  syncClearOAuthAttempt();
  syncSetBusy(true, 'Waiting for ' + syncProviderLabel(cfg.provider) + '…');
  syncPkcePair().then(function (pair) {
    var state = 'plutus-' + cfg.provider + '-' + syncB64UrlEncode(syncRandomBytes(12));
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SYNC_OAUTH_KEY, JSON.stringify({ state: state, verifier: pair.verifier, provider: cfg.provider }));
      }
    } catch (e) { /* ignore */ }
    var url = syncOAuthAuthUrl(cfg.provider, clientId, redirect, pair.challenge, state);
    var popup = null;
    try {
      popup = window.open(url, 'plutus-oauth', 'width=540,height=680');
    } catch (e) {
      popup = null;
    }
    if (!popup) {
      syncSetBusy(false);
      showBanner('Popup blocked — allow popups for this page, then try Connect again.', 'error', {
        title: 'Connect',
        lines: ['The drive sign-in opens in a popup window.']
      });
      return;
    }
    var done = false;
    var timer = null;
    function onMsg(e) {
      var d = e && e.data;
      if (!d || d.type !== 'plutus-oauth') return;
      try {
        if (e.origin !== window.location.origin) return;
      } catch (e2) { /* ignore */ }
      if (!d.state || d.state !== state) return;
      if (done) return;
      done = true;
      syncClearOAuthAttempt();
      try { window.removeEventListener('message', onMsg); } catch (e3) { /* ignore */ }
      try { if (timer) clearInterval(timer); } catch (e4) { /* ignore */ }
      if (d.error) {
        syncSetBusy(false);
        showBanner('Sign-in refused by the provider.', 'error', {
          title: 'Connect',
          lines: [String(d.error).slice(0, 200)]
        });
        return;
      }
      syncOAuthTokenExchange(cfg.provider, cfg, d.code, pair.verifier).then(function (tok) {
        cfg.tokens = tok;
        syncSaveConfig(cfg);
        syncSetBusy(false);
        syncConnectThenSync();
      }, function (err) {
        syncSetBusy(false);
        showBanner('Sign-in failed — your data was left untouched.', 'error', {
          title: 'Connect',
          lines: [String((err && err.message) || err)]
        });
      });
    }
    try { window.addEventListener('message', onMsg); } catch (e5) { /* ignore */ }
    timer = setInterval(function () {
      var closed = false;
      try { closed = !popup || popup.closed; } catch (e6) { closed = true; }
      if (closed) {
        try { clearInterval(timer); } catch (e7) { /* ignore */ }
        try { window.removeEventListener('message', onMsg); } catch (e8) { /* ignore */ }
        if (!done) {
          done = true;
          syncSetBusy(false);
          syncRefreshSyncPanel();
        }
      }
    }, 500);
  }, function () {
    syncSetBusy(false);
    showBanner('Could not start sign-in (WebCrypto unavailable).', 'error', {
      title: 'Connect',
      lines: ['Use Download backup in the Backup & restore tab instead.']
    });
  });
}

function syncDisconnect() {
  var cfg = syncLoadConfig();
  // Forget the whole connection: tokens, remembered passwords/keys and
  // session secrets — plus the location trust, so the next push treats the
  // destination as unknown and refuses to blindly overwrite it.
  // Boring config (provider, urls, names) stays.
  cfg.tokens = null;
  cfg.password = '';
  cfg.rememberPassword = false;
  cfg.secretKey = '';
  cfg.rememberSecret = false;
  cfg.passphrase = '';
  cfg.rememberPassphrase = false;
  cfg.lastLocation = null;
  cfg.locV = null;
  cfg.lastIdentity = null;
  cfg.lastSyncedHash = null;
  cfg.lastRemoteAt = null;
  cfg.lastSyncAt = null;
    syncMemSecrets.password = '';
  syncMemSecrets.secretKey = '';
  syncSaveConfig(cfg);
  syncClearOAuthAttempt();
  syncSetVal('sy-passwd', '');
  syncSetVal('sy-skey', '');
  syncSetVal('sy-pass', '');
  var rememberPassBox = (typeof document !== 'undefined') ? document.getElementById('sy-remember-pass') : null;
  if (rememberPassBox) rememberPassBox.checked = false;
  syncRefreshSyncPanel();
  try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
  clearBanner();
}

// Google one-click sign-in via Google's own sign-in library. The script is
// loaded lazily on first Connect — never on page load — and only needs the
// public client ID: you just log in with Google, no app to register.
var syncGisLoading = null;

function syncLoadGis() {
  try {
    if (typeof window !== 'undefined' && window.google && window.google.accounts && window.google.accounts.oauth2) {
      return Promise.resolve(window.google.accounts.oauth2);
    }
  } catch (e) { /* ignore */ }
  if (syncGisLoading) return syncGisLoading;
  syncGisLoading = new Promise(function (resolve, reject) {
    try {
      if (typeof document === 'undefined') throw new Error('sync failed: cannot load Google sign-in here.');
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = function () {
        try {
          resolve(window.google.accounts.oauth2);
        } catch (e) {
          syncGisLoading = null;
          reject(new Error('sync failed: could not start Google sign-in.'));
        }
      };
      s.onerror = function () {
        syncGisLoading = null;
        reject(new Error('sync failed: could not load Google sign-in. Check your connection.'));
      };
      document.head.appendChild(s);
    } catch (e) {
      syncGisLoading = null;
      reject(e);
    }
  });
  return syncGisLoading;
}

function syncGoogleOneClick(cfg) {
  return syncLoadGis().then(function (oauth2) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = null;
      try {
        if (typeof setTimeout !== 'undefined') {
          timer = setTimeout(function () {
            if (done) return;
            done = true;
            reject(new Error('sync cancelled — the Google window was closed.'));
          }, 180000);
        }
      } catch (e) { /* ignore */ }
      function settle(fn, arg) {
        if (done) return;
        done = true;
        try { if (timer) clearTimeout(timer); } catch (e2) { /* ignore */ }
        fn(arg);
      }
      try {
        var client = oauth2.initTokenClient({
          client_id: syncSharedId('gdrive'),
          scope: 'https://www.googleapis.com/auth/drive.file',
          callback: function (resp) {
            if (resp && resp.access_token) settle(resolve, resp);
            else settle(reject, new Error('sync failed: Google sign-in gave no token.'));
          }
        });
        client.requestAccessToken({ prompt: 'consent' });
      } catch (e) {
        settle(reject, new Error('sync failed: could not start Google sign-in.'));
      }
    });
  }).then(function (resp) {
    var exp = Number(resp.expires_in);
    if (!isFinite(exp) || exp <= 0) exp = 3600;
    return { access: resp.access_token, refresh: '', expiry: Date.now() + exp * 1000 };
  });
}

// WebDAV / MEGA have no OAuth: Connect simply proves the login works.
// Both "backup found" and "no backup yet" mean the login is good.
// Connect only proves the login; the first real sync happens right here so
// users never stare at an empty drive wondering why nothing uploaded.
function syncConnectThenSync() {
  var st = null;
  try {
    st = loadState();
  } catch (e) {
    st = null;
  }
  if (!st || ((!st.accounts || !st.accounts.length) && (!st.trades || !st.trades.length))) {
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    clearBanner();
    syncSetStatus('Connected — this wallet is empty. Restore from drive or add data, then sync.');
    return;
  }
  try {
    syncPushFlow();
  } catch (e) {
    showBanner('Sync failed — your data was left untouched.', 'error', {
      title: 'Sync error',
      lines: [String((e && e.message) || e)]
    });
  }
}

function syncTestConnection() {
  if (syncBusy) return;
  if (!syncPassphraseOrBanner()) return;
  var rd = syncReadForm();
  var cfg = rd.cfg;
  syncPersistFormSecrets(cfg);
  syncSetBusy(true, 'Checking connection…');
  return syncRemoteDownload(cfg).then(function () {
    syncSetBusy(false);
    syncSaveConfig(cfg);
    syncConnectThenSync();
  }, function (err) {
    syncSetBusy(false);
    var m = String((err && err.message) || err);
    if (m.indexOf('no backup found') !== -1) {
      syncSaveConfig(cfg);
      syncConnectThenSync();
      return;
    }
    syncRefreshSyncPanel();
    showBanner('Connection failed — your data was left untouched.', 'error', {
      title: 'Connect',
      lines: [m]
    });
  });
}

// The encrypted-file buttons need a passphrase to do anything, so they
// stay visibly disabled until one is typed (the flows keep their own
// guards as backstop).
function syncToggleEncButtons() {
  if (typeof document === 'undefined') return;
  var passEl = document.getElementById('sy-pass');
  var has = !!(passEl && passEl.value);
  var up = document.getElementById('sy-enc-upload');
  if (up) up.disabled = !has;
  var down = document.getElementById('sy-enc-download');
  if (down) down.disabled = !has;
}

function buildSyncSettings() {
  if (typeof document === 'undefined') return;
  var prov = document.getElementById('sy-provider');
  if (!prov || prov.getAttribute('data-wired')) return;
  prov.setAttribute('data-wired', '1');
  if (!syncCryptoAvailable()) {
    var st0 = document.getElementById('sy-status');
    if (st0) st0.textContent = 'Encrypted sync needs WebCrypto — this browser cannot do it. Use Download backup instead.';
  }
  prov.addEventListener('change', function () {
    var cfg = syncReadForm().cfg;
    syncSaveConfig(cfg);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
  });
  var autoBox = document.getElementById('sy-auto');
  if (autoBox && !autoBox.getAttribute('data-wired')) {
    autoBox.setAttribute('data-wired', '1');
    autoBox.addEventListener('change', function () {
      var cfg = syncReadForm().cfg;
      syncSaveConfig(cfg);
      syncRefreshSyncPanel();
      if (autoBox.checked) {
        syncSetStatus('Auto-sync on — changes upload a few seconds after you make them.');
      }
      try { syncScheduleAuto(); } catch (e) { /* ignore */ }
    });
  }
  var passEl = document.getElementById('sy-pass');
  if (passEl) {
    passEl.addEventListener('input', function () {
      var v = passEl.value || '';
      var fp = document.getElementById('sy-fp');
      if (!v) {
        if (fp) fp.textContent = 'Key fingerprint: —';
      } else {
        syncFingerprint(v).then(function (f) {
          var cur = document.getElementById('sy-pass');
          if (cur && cur.value === v) {
            var fel = document.getElementById('sy-fp');
            if (fel) fel.textContent = 'Key fingerprint: ' + (f || '—') + ' (same on all devices = same passphrase)';
          }
        });
      }
      try { syncToggleEncButtons(); } catch (e) { /* ignore */ }
    });
  }
  function wireBtn(id, fn) {
    var b = document.getElementById(id);
    if (b && !b.getAttribute('data-wired')) {
      b.setAttribute('data-wired', '1');
      b.addEventListener('click', fn);
    }
  }
  wireBtn('sy-connect', syncStartOAuth);
  wireBtn('sy-disconnect', syncDisconnect);
  wireBtn('sy-push', syncPushFlow);
  wireBtn('sy-pull', syncPullFlow);
  wireBtn('sy-cleanup', syncCleanupFlow);
  wireBtn('sy-enc-download', syncDownloadEncrypted);
  var up = document.getElementById('sy-enc-upload');
  if (up && !up.getAttribute('data-wired')) {
    up.setAttribute('data-wired', '1');
    up.addEventListener('change', function (e) {
      var input = e.target;
      var f = input && input.files && input.files[0];
      if (!f) return;
      syncRestoreEncryptedFile(f);
      try { input.value = ''; } catch (e2) { /* ignore */ }
    });
  }
  syncRefreshSyncPanel();
}

// Expose Sync on window.Inoculens for tests.html.
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.SYNC_PROVIDERS = SYNC_PROVIDERS;
  window.Inoculens.SYNC_SHARED_APPS = SYNC_SHARED_APPS;
  window.Inoculens.syncB64encode = syncB64encode;
  window.Inoculens.syncB64decode = syncB64decode;
  window.Inoculens.syncB64UrlEncode = syncB64UrlEncode;
  window.Inoculens.syncUtf8Encode = syncUtf8Encode;
  window.Inoculens.syncUtf8Decode = syncUtf8Decode;
  window.Inoculens.syncEnvelopeWrap = syncEnvelopeWrap;
  window.Inoculens.syncEnvelopeParse = syncEnvelopeParse;
  window.Inoculens.syncIsEncryptedBackup = syncIsEncryptedBackup;
  window.Inoculens.syncCompareTimestamps = syncCompareTimestamps;
  window.Inoculens.syncDirection = syncDirection;
  window.Inoculens.syncCheckOnLoad = syncCheckOnLoad;
  window.Inoculens.syncCheckRemoteNow = syncCheckRemoteNow;
  window.Inoculens.syncRemotePending = function () { return syncPendingRemote; };
  window.Inoculens.syncSetPendingRemote = function (v) { syncPendingRemote = !!v; return syncPendingRemote; };
  window.Inoculens.syncProviderById = syncProviderById;
  window.Inoculens.syncIsProvider = syncIsProvider;
  window.Inoculens.syncJoinUrl = syncJoinUrl;
  window.Inoculens.syncSanitizeFilename = syncSanitizeFilename;
  window.Inoculens.syncDisplayBasename = syncDisplayBasename;
  window.Inoculens.syncNormalizeFolder = syncNormalizeFolder;
  window.Inoculens.syncLocationKey = syncLocationKey;
  window.Inoculens.syncTrustIdentity = syncTrustIdentity;
  window.Inoculens.syncIsTrustedLocation = syncIsTrustedLocation;
  window.Inoculens.syncConnectThenSync = syncConnectThenSync;
  window.Inoculens.syncRemoteExists = syncRemoteExists;
  window.Inoculens.syncRemoteEnsureFolder = syncRemoteEnsureFolder;
  window.Inoculens.syncDropboxFullPath = syncDropboxFullPath;
  window.Inoculens.syncWebdavMkdirP = syncWebdavMkdirP;
  window.Inoculens.syncDefaultConfig = syncDefaultConfig;
  window.Inoculens.syncSanitizeConfig = syncSanitizeConfig;
  window.Inoculens.syncCryptoAvailable = syncCryptoAvailable;
  window.Inoculens.syncEncryptEnvelope = syncEncryptEnvelope;
  window.Inoculens.syncDecryptEnvelope = syncDecryptEnvelope;
  window.Inoculens.syncFingerprint = syncFingerprint;
  window.Inoculens.syncSha256 = syncSha256;
  window.Inoculens.syncHmac = syncHmac;
  window.Inoculens.syncOAuthAuthUrl = syncOAuthAuthUrl;
  window.Inoculens.syncParseQuery = syncParseQuery;
  window.Inoculens.syncS3CanonicalRequest = syncS3CanonicalRequest;
  window.Inoculens.syncAmzDate = syncAmzDate;
  window.Inoculens.syncSplitUrl = syncSplitUrl;
  window.Inoculens.syncS3Url = syncS3Url;
  window.Inoculens.syncRequireHttpsUrl = syncRequireHttpsUrl;
  window.Inoculens.syncS3ErrorBody = syncS3ErrorBody;
  window.Inoculens.syncFetch = syncFetch;
  window.Inoculens.syncStateHash = syncStateHash;
  window.Inoculens.syncHashOfExport = syncHashOfExport;
  window.Inoculens.syncCurrentHash = syncCurrentHash;
  window.Inoculens.syncIsConnected = syncIsConnected;
  window.Inoculens.syncRefreshHeaderIcon = syncRefreshHeaderIcon;
  window.Inoculens.syncAutoPush = syncAutoPush;
  window.Inoculens.syncAutoDelay = syncAutoDelay;
  window.Inoculens.syncRefreshSyncPanel = syncRefreshSyncPanel;
  window.Inoculens.syncSharedId = syncSharedId;
  window.Inoculens.syncEffectiveClientId = syncEffectiveClientId;
  window.Inoculens.syncTestConnection = syncTestConnection;
  window.Inoculens.updateModalLock = updateModalLock;
  window.Inoculens.syncPostForm = syncPostForm;
  window.Inoculens.syncEnsureAccessToken = syncEnsureAccessToken;
  window.Inoculens.syncOAuthRefresh = syncOAuthRefresh;
  window.Inoculens.syncWebdavUpload = syncWebdavUpload;
  window.Inoculens.syncWebdavDownload = syncWebdavDownload;
  window.Inoculens.syncDriveUpload = syncDriveUpload;
  window.Inoculens.syncDriveDownload = syncDriveDownload;
  window.Inoculens.syncDriveFind = syncDriveFind;
  window.Inoculens.syncDropboxUpload = syncDropboxUpload;
  window.Inoculens.syncDropboxDownload = syncDropboxDownload;
  window.Inoculens.syncS3Put = syncS3Put;
  window.Inoculens.syncS3Get = syncS3Get;
  window.Inoculens.syncRemoteUpload = syncRemoteUpload;
  window.Inoculens.syncRemoteDownload = syncRemoteDownload;
  window.Inoculens.syncLoadConfig = syncLoadConfig;
  window.Inoculens.syncSaveConfig = syncSaveConfig;
  window.Inoculens.syncReadForm = syncReadForm;
  window.Inoculens.syncPushFlow = syncPushFlow;
  window.Inoculens.syncPullFlow = syncPullFlow;
  window.Inoculens.confirmAction3 = confirmAction3;
  window.Inoculens.syncDisconnect = syncDisconnect;
  window.Inoculens.showBanner = showBanner;
  window.Inoculens.clearBanner = clearBanner;
  window.Inoculens.openDialog = openDialog;
  window.Inoculens.closeDialog = closeDialog;
  window.Inoculens.flushSettingsAlertToBanner = flushSettingsAlertToBanner;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', syncHandleOAuthRedirect);
  }
}

// === Consent / Analytics (GDPR Basic mode) ===
// Google Analytics 4 (G-0JEDV505S7) loads ONLY after the visitor presses
// Accept in #cookie-banner. Default is denied (see head inline consent).
// Choice persists in localStorage under CONSENT_KEY, separate from the
// portfolio store. Decline (or no choice) = gtag.js is never requested.
var GA_MEASUREMENT_ID = 'G-0JEDV505S7';
var CONSENT_KEY = 'inoculens.consent.v1';

function consentRead() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    var raw = window.localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    var v = JSON.parse(raw);
    if (v && (v.choice === 'accepted' || v.choice === 'declined')) return v.choice;
    return null;
  } catch (e) { return null; }
}

function consentWrite(choice) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ choice: choice, at: new Date().toISOString() }));
    }
  } catch (e) { /* private mode: choice lasts this session only */ }
  return choice;
}

function consentGtagStub() {
  try {
    if (typeof window === 'undefined') return;
    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag !== 'function') {
      window.gtag = function () { window.dataLayer.push(arguments); };
    }
  } catch (e) { /* ignore */ }
}

function consentLoadGA() {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (window.__gaLoaded) return true;
    consentGtagStub();
    window.gtag('js', new Date());
    window.gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
    s.setAttribute('data-ga', 'consent');
    var head = document.head || document.getElementsByTagName('head')[0];
    if (head) head.appendChild(s);
    window.__gaLoaded = true;
    return true;
  } catch (e) { return false; }
}

function consentApply(choice) {
  consentWrite(choice);
  try {
    consentGtagStub();
    window.gtag('consent', 'update', {
      analytics_storage: choice === 'accepted' ? 'granted' : 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied'
    });
  } catch (e) { /* ignore */ }
  if (choice === 'accepted') consentLoadGA();
  try {
    var b = typeof document !== 'undefined' ? document.getElementById('cookie-banner') : null;
    if (b) b.hidden = true;
  } catch (e) { /* ignore */ }
  return choice;
}

function consentInitBanner() {
  try {
    if (typeof document === 'undefined') return;
    var banner = document.getElementById('cookie-banner');
    if (!banner) return;
    var choice = consentRead();
    if (choice === 'accepted') { banner.hidden = true; consentLoadGA(); return; }
    if (choice === 'declined') { banner.hidden = true; return; }
    banner.hidden = false;
    var acc = document.getElementById('cookie-accept');
    var dec = document.getElementById('cookie-decline');
    if (acc && !acc.getAttribute('data-wired')) {
      acc.setAttribute('data-wired', '1');
      acc.addEventListener('click', function () { consentApply('accepted'); });
    }
    if (dec && !dec.getAttribute('data-wired')) {
      dec.setAttribute('data-wired', '1');
      dec.addEventListener('click', function () { consentApply('declined'); });
    }
  } catch (e) { /* banner never breaks boot */ }
}

if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.consentRead = consentRead;
  window.Inoculens.consentApply = consentApply;
  window.Inoculens.consentLoadGA = consentLoadGA;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', consentInitBanner);
    try {
      if (document.readyState === 'interactive' || document.readyState === 'complete') consentInitBanner();
    } catch (e) { /* listener covers it */ }
  }
}
