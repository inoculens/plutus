'use strict';
// Accounts: validation and normalization, colors, cash ledger charts (codes and
// labels), account groups (main + sub-accounts) and lookup helpers.

var ACCOUNT_ID_MAX_LENGTH = 128;

// Account ids: 1-128 chars of [A-Za-z0-9._:-] (uid() emits 't' + base36),
// never a name that already exists on Object.prototype ("__proto__",
// "constructor", "toString", "hasOwnProperty", ...). Pure.
function isValidAccountId(id) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > ACCOUNT_ID_MAX_LENGTH) return false;
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return false;
  if (id === '__proto__' || id === 'prototype' || (id in Object.prototype)) return false;
  return true;
}

function isValidAccount(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  if (!isValidAccountId(a.id)) return false;
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

function normalizeAccount(a, accountList) {
  var tk = String(a.ticker || '').trim().toUpperCase();
  var nm = String(a.name == null ? '' : a.name).trim() || tk;
  var kd = (a && typeof a.kind === 'string') ? a.kind.trim().toLowerCase() : 'crypto';
  if (kd !== 'crypto' && kd !== 'stock' && kd !== 'commodity' && kd !== 'custom' && kd !== 'cash') kd = 'crypto';
  var out = {
    id: a.id,
    name: nm,
    ticker: tk,
    kind: kd,
    // An unparsable value is replaced (the original survives in the recovery
    // copy, see accountFieldIssues) so the repaired state is clean on reload.
    createdAt: (typeof a.createdAt === 'string' && a.createdAt.trim().length > 0 && isFinite(Date.parse(a.createdAt)))
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
  if (isValidDebtPositions(a, accountList || [a])) {
    if (Array.isArray(a.debtPositions)) out.debtPositions = a.debtPositions.map(function (position) { return normalizeDebtPosition(position, a); });
  }
  if (isValidStakeRewards(a, accountList || [a]) && Array.isArray(a.stakeRewards) && a.stakeRewards.length) {
    out.stakeRewards = a.stakeRewards.map(normalizeStakeReward);
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
  var byId = dict();
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

// Links sanitizeGroups would remove: an account that is a member of an
// existing main AND has members of its own (groups are flat; assignGroup never
// creates this, so a stored one is an invariant violation). Same predicate as
// sanitizeGroups, run on the accounts BEFORE it, so the loss is reported
// instead of silent. Dangling links (no such main) stay, by design.
function nestedGroupLinkCount(accounts) {
  var list = accounts || [];
  var byId = dict();
  list.forEach(function (a) { if (a && a.id) byId[a.id] = a; });
  return list.filter(function (a) {
    if (!a || typeof a.groupId !== 'string' || a.groupId === '') return false;
    var main = byId[a.groupId];
    if (!main || main === a) return false;
    return list.some(function (m) { return m && m.groupId === a.id; });
  }).length;
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

function isValidHexColor(v) {
  return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
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
  var seen = dict();
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
  var set = dict();
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
  var out = dict();
  ((st && st.accounts) || []).forEach(function (a) {
    if (a && a.id && isCashKind(a.kind)) out[a.id] = true;
  });
  return out;
}

function accountById(st, id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  var list = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}
