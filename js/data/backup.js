'use strict';
// Backup files: export envelope and import (current v2 plus legacy v1).
// Envelope keys stay exactly {app,version,exportedAt,settings,accounts,trades,priceOverrides}.

var APP_ID = 'inoculens-plutus';
var STORE_VERSION = 2;

// Shared by exportState and the strict variant: the normalized envelope parts
// plus a count of stored records that cannot be exported (invalid accounts,
// trades that fail import validation, unusable price overrides).
function exportPrepare(s) {
  var st = s || {};
  var dropped = 0;
  var srcAccounts = Array.isArray(st.accounts) ? st.accounts : [];
  var rawAccounts = srcAccounts.filter(isValidAccount);
  dropped += srcAccounts.length - rawAccounts.length;
  var accounts = rawAccounts.map(function (account) { return normalizeAccount(account, rawAccounts); });
  var accountIds = accounts.map(function (a) { return a.id; });
  var srcTrades = Array.isArray(st.trades) ? st.trades : [];
  var okTrades = srcTrades.filter(function (t) { return isValidImportTrade(t, accountIds, accounts); });
  dropped += srcTrades.length - okTrades.length;
  var priceOverrides = {};
  if (st.priceOverrides && typeof st.priceOverrides === 'object' && !Array.isArray(st.priceOverrides)) {
    if (isValidPriceOverrides(st.priceOverrides)) priceOverrides = st.priceOverrides;
    else dropped += 1;
  }
  return {
    dropped: dropped,
    envelope: {
      app: APP_ID,
      version: STORE_VERSION,
      exportedAt: new Date().toISOString(),
      settings: normalizeSettings(st.settings, defaultState().settings),
      accounts: accounts,
      trades: okTrades.map(normalizeTradeForStore),
      priceOverrides: priceOverrides
    }
  };
}

// Tolerant export, kept for internal comparisons (sync hashes): records that
// fail validation are left out.
function exportState(s) {
  return JSON.stringify(exportPrepare(s).envelope);
}

// Export for anything the person keeps or uploads (backup download, encrypted
// file, sync push). Refuses instead of writing an incomplete file that would
// look like a successful backup.
function exportStateStrict(s) {
  var prepared = exportPrepare(s);
  if (prepared.dropped > 0) {
    throw new Error('export failed: ' + prepared.dropped + ' stored record' + (prepared.dropped === 1 ? ' is' : 's are') +
      ' invalid and would be missing from the file. Nothing was exported.');
  }
  return JSON.stringify(prepared.envelope);
}

// Validate and normalize a backup WITHOUT touching stored state. Restore
// flows that ask for confirmation use this, so nothing is written until the
// user agrees (a tab closed or crashed at the prompt used to leave the remote
// copy already persisted over local data).
function parseImportedState(json) {
  return importState(json, { dryRun: true });
}

function importState(json, opts) {
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
    return importStateV1(data, opts);
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
  var seenIds = dict();
  for (var di = 0; di < accountIds.length; di++) {
    if (Object.prototype.hasOwnProperty.call(seenIds, accountIds[di])) {
      throw new Error('import failed: duplicate account id ' + accountIds[di]);
    }
    seenIds[accountIds[di]] = true;
  }
  for (var dpa = 0; dpa < data.accounts.length; dpa++) {
    if (!isValidDebtPositions(data.accounts[dpa], data.accounts)) {
      throw new Error('import failed: invalid debt positions for account ' + data.accounts[dpa].id);
    }
  }
  if (!Array.isArray(data.trades)) {
    throw new Error('import failed: trades must be an array');
  }
  for (var ti = 0; ti < data.trades.length; ti++) {
    if (!isValidImportTrade(data.trades[ti], accountIds, data.accounts)) {
      throw new Error('import failed: invalid trade at index ' + ti);
    }
  }
  var seenTradeIds = dict();
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
    accounts: sanitizeGroups(data.accounts.map(function (account) { return normalizeAccount(account, data.accounts); })),
    trades: mappedTrades,
    priceOverrides: priceOverrides
  };
  if (!(opts && opts.dryRun)) saveState(next);
  return next;
}

// Legacy v1 file import: group v1 trades (account-less) into auto-created
// per-symbol accounts. No legacy runtime paths — v1 is never read from
// localStorage, only accepted here.
function importStateV1(data, opts) {
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
    if (!isValidImportTrade(trades[vi], accountIds, accounts)) {
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
  if (!(opts && opts.dryRun)) saveState(next);
  return next;
}
