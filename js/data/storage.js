'use strict';
// Local-first persistence of the whole state in localStorage, with
// protection for damaged data and a validated-state cache.
// Key: exactly 'inoculens.v2' (v1 is never read at runtime; v1 files import
// via the grouping branch in importState). Export envelope: exactly
// {app:"inoculens-plutus", version:2, exportedAt, settings, accounts, trades, priceOverrides}.
// Failed imports throw Error(reason) and leave stored data untouched.

var STORAGE_KEY = 'inoculens.v2';

// --- Damaged-data protection ---
// A stored state that cannot be read (bad JSON / wrong shape) or that loses
// records in validation must never be silently replaced by the next save.
// The raw text is first preserved as a recovery copy under a separate key,
// the user is told, and the copy can be downloaded from Settings > Backups.
// Only an explicit "Clear all data" discards recovery copies.
var RECOVERY_KEY = STORAGE_KEY + '.recovery';
var RECOVERY_KEEP = 3;
var storageRecovery = null; // {kind:'unreadable'|'rejected', accounts, trades, shape, settings, overrides, accountFields, tradeFields, groups, saved}
var lastSeenRaw = null;      // stored text last read clean, or last written by saveState
var lastPreservedRaw = null; // stored text already kept as a recovery copy

function readRecoveryCopies() {
  try {
    var r = localStorage.getItem(RECOVERY_KEY);
    if (!r) return [];
    var list = JSON.parse(r);
    if (!Array.isArray(list)) return [];
    return list.filter(function (c) { return c && typeof c.raw === 'string'; });
  } catch (e) {
    return [];
  }
}

function preserveRawState(raw, reason) {
  if (typeof raw !== 'string') return false;
  if (raw === lastPreservedRaw) return true;
  var list = readRecoveryCopies();
  var have = list.some(function (c) { return c.raw === raw; });
  if (!have) {
    list.push({ at: new Date().toISOString(), reason: reason, raw: raw });
    while (list.length > RECOVERY_KEEP) list.shift();
    var ok = false;
    while (list.length) {
      try {
        localStorage.setItem(RECOVERY_KEY, JSON.stringify(list));
        ok = true;
        break;
      } catch (e) {
        if (list.length <= 1) break; // keep the newest; drop older copies to make room
        list.shift();
      }
    }
    if (!ok) return false;
  }
  lastPreservedRaw = raw;
  return true;
}

function noteStorageDamage(raw, damage) {
  var saved = preserveRawState(raw, damage.kind);
  storageRecovery = {
    kind: damage.kind,
    accounts: damage.accounts || 0,
    trades: damage.trades || 0,
    shape: !!damage.shape,
    settings: !!damage.settings,
    overrides: damage.overrides || 0,
    accountFields: damage.accountFields || 0,
    tradeFields: damage.tradeFields || 0,
    groups: damage.groups || 0,
    saved: saved
  };
  return saved;
}

function clearRecoveryCopies() {
  try { localStorage.removeItem(RECOVERY_KEY); } catch (e) { /* ignore */ }
  storageRecovery = null;
  lastPreservedRaw = null;
  lastSeenRaw = null;
  try {
    var rb = document.getElementById('s-recovery');
    if (rb) rb.style.display = 'none';
  } catch (e) { /* ignore */ }
}

// --- Optional-field damage detection ---
// normalizeAccount / normalizeSettings / normalizeTradeForStore quietly drop
// or default optional fields that fail validation. Before that can happen to
// stored data, these counters (run on the RAW stored objects) report how many
// objects carry an invalid optional field, so recovery preserves the original.
// The record itself still loads (a bad colour must not hide an account and
// all its history). Absent / null / blank means "not set" and is never damage;
// legitimate normalization (trim, upper-casing, de-duplication) is not damage.
function fieldPresent(v) {
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
}

function ledgerMapIsClean(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  return Object.keys(normalizeLedgerLabels(m)).length === Object.keys(m).length;
}

// Number of invalid optional fields on a stored account that passed isValidAccount.
function accountFieldIssues(a, accounts) {
  var n = 0;
  if (a.createdAt !== undefined && a.createdAt !== null) {
    if (typeof a.createdAt !== 'string' || a.createdAt.trim() === '' || !isFinite(Date.parse(a.createdAt))) n++;
  }
  if (a.address !== undefined && a.address !== null) {
    if (typeof a.address !== 'string' || a.address.trim().length > ACCOUNT_LABEL_MAX) n++;
  }
  if (a.note !== undefined && a.note !== null) {
    if (typeof a.note !== 'string' || a.note.trim().length > 280) n++;
  }
  if (fieldPresent(a.color) && !isValidHexColor(a.color)) n++;
  if (a.ledgers !== undefined && a.ledgers !== null && !ledgerMapIsClean(a.ledgers)) n++;
  if (fieldPresent(a.groupId) && (typeof a.groupId !== 'string' || a.groupId === a.id)) n++;
  if (fieldPresent(a.groupCurrency) &&
      (typeof a.groupCurrency !== 'string' || MAIN_CURRENCIES.indexOf(a.groupCurrency.trim().toUpperCase()) === -1)) n++;
  if (a.debtPositions !== undefined && a.debtPositions !== null && !isValidDebtPositions(a, accounts)) n++;
  if (a.stakeRewards !== undefined && a.stakeRewards !== null && !isValidStakeRewards(a, accounts)) n++;
  return n;
}

// Same for a stored trade that passed isValidImportTrade (which already
// rejects bad attachment, ledger, fee and quantity fields).
function tradeFieldIssues(t) {
  var n = 0;
  if (fieldPresent(t.color) && !isValidHexColor(t.color)) n++;
  if (t.outputs !== undefined && t.outputs !== null) {
    if (!Array.isArray(t.outputs)) n++;
    else if (t.outputs.some(function (o) { return !o || typeof o !== 'object' || Array.isArray(o); })) n++;
  }
  var hasOutputs = Array.isArray(t.outputs) && t.outputs.length > 0;
  // selfQty (received back, multi-output transfers). Zero is the same as
  // absent (normalization removes it, the validator accepts it): not damage.
  // Negative / non-finite / non-numeric values never get here (the validator
  // rejects the record, which is counted as damage already).
  if (fieldPresent(t.selfQty)) {
    var zeroSelf = (typeof t.selfQty === 'number' || typeof t.selfQty === 'string') && Number(t.selfQty) === 0;
    if (!zeroSelf) {
      if (!hasOutputs) {
        n++; // the app writes it only with outputs; normalization would delete it
      } else {
        var sq = NaN;
        try { sq = exactQtyValue(t.selfQty, String(t.symbol || '').toUpperCase()); } catch (e) { sq = NaN; }
        if (!(isFinite(Number(sq)) && Number(sq) > 0)) n++;
      }
    }
  }
  // Per-source fee modes. normalizeTradeForStore only touches this field when
  // the trade carries a sources list, so that is the only case reported (a
  // lone sourceFeeAuto is kept as stored: nothing is lost). With a valid
  // multi-source list the modes must be one boolean per source; a one-entry
  // list may carry matching modes (legacy shape, both dropped quietly);
  // anything else is deleted by normalization and therefore reported.
  if (t.sources !== undefined && t.sources !== null && t.sourceFeeAuto !== undefined && t.sourceFeeAuto !== null) {
    var srcs = (t.type === 'transfer') ? transferSourcesOf(t) : null;
    var autoOk = Array.isArray(t.sourceFeeAuto) && t.sourceFeeAuto.every(function (v) { return typeof v === 'boolean'; });
    if (!(srcs && srcs.length >= 1 && autoOk && t.sourceFeeAuto.length === srcs.length)) n++;
  }
  // sources only means something on a transfer; elsewhere normalization deletes it.
  if (t.type !== 'transfer' && t.sources !== undefined && t.sources !== null) n++;
  return n;
}

// Number of invalid optional settings (settings that passed isValidSettings).
function settingsFieldIssues(s) {
  var n = 0;
  if (s.assetLedgers !== undefined && s.assetLedgers !== null && typeof s.assetLedgers !== 'boolean') n++;
  if (s.accountFilter !== undefined && s.accountFilter !== null) {
    if (!Array.isArray(s.accountFilter)) n++;
    else if (s.accountFilter.some(function (x) {
      if (typeof x !== 'string') return true; // malformed entry
      var u = x.trim().toUpperCase();
      return u !== '' && !isValidSymbolCode(u); // blank entries are ignored by normalization
    })) n++;
  }
  if (s.ledgerLabels !== undefined && s.ledgerLabels !== null && !ledgerMapIsClean(s.ledgerLabels)) n++;
  return n;
}

// Parse + validate stored text without side effects. `parsed` is null when
// the text is unreadable. `damage` is null when nothing was lost.
function readStoredState(raw) {
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { parsed: null, damage: { kind: 'unreadable' } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { parsed: null, damage: { kind: 'unreadable' } };
  }
  var rawAccounts = Array.isArray(parsed.accounts) ? parsed.accounts.filter(isValidAccount) : [];
  var accounts = rawAccounts.map(function (account) { return normalizeAccount(account, rawAccounts); });
  var nestedLinks = nestedGroupLinkCount(accounts); // must run before sanitizeGroups
  accounts = sanitizeGroups(accounts);
  var accountIds = accounts.map(function (a) { return a.id; });
  var validTrades = Array.isArray(parsed.trades)
    ? parsed.trades.filter(function (t) { return isValidImportTrade(t, accountIds, accounts); })
    : [];
  var trades = validTrades.map(normalizeTradeForStore);
  var accountFieldDamage = 0;
  var tradeFieldDamage = 0;
  if (Array.isArray(parsed.accounts)) {
    parsed.accounts.forEach(function (a) { if (isValidAccount(a) && accountFieldIssues(a, rawAccounts) > 0) accountFieldDamage++; });
  }
  validTrades.forEach(function (t) { if (tradeFieldIssues(t) > 0) tradeFieldDamage++; });
  var droppedAccounts = Array.isArray(parsed.accounts) ? parsed.accounts.length - accounts.length : 0;
  var droppedTrades = Array.isArray(parsed.trades) ? parsed.trades.length - trades.length : 0;
  var shape = (parsed.accounts !== undefined && parsed.accounts !== null && !Array.isArray(parsed.accounts)) ||
    (parsed.trades !== undefined && parsed.trades !== null && !Array.isArray(parsed.trades));
  // Settings: present but invalid (or with chart labels that fail validation)
  // would be replaced by defaults on load -- report it instead.
  var settingsBad = false;
  if (parsed.settings !== undefined && parsed.settings !== null) {
    if (!isValidSettings(parsed.settings) || settingsFieldIssues(parsed.settings) > 0) settingsBad = true;
  }
  // Manual price overrides: keep every valid entry, count the rest.
  var overrides = {};
  var droppedOverrides = 0;
  var overridesShape = false;
  var po = parsed.priceOverrides;
  if (po !== undefined && po !== null) {
    if (typeof po !== 'object' || Array.isArray(po)) {
      overridesShape = true;
    } else {
      Object.keys(po).forEach(function (k) {
        if (isValidOverrideValue(po[k])) overrides[k] = po[k];
        else droppedOverrides++;
      });
    }
  }
  var damage = (droppedAccounts > 0 || droppedTrades > 0 || shape || settingsBad || droppedOverrides > 0 || overridesShape ||
      accountFieldDamage > 0 || tradeFieldDamage > 0 || nestedLinks > 0)
    ? {
        kind: 'rejected', accounts: droppedAccounts, trades: droppedTrades,
        shape: shape || overridesShape, settings: settingsBad, overrides: droppedOverrides,
        accountFields: accountFieldDamage, tradeFields: tradeFieldDamage, groups: nestedLinks
      }
    : null;
  return { parsed: parsed, accounts: accounts, trades: trades, overrides: overrides, damage: damage };
}

// Parsed-state cache. Validating every stored record is the most expensive
// thing the app does, and the app reads its state from dozens of places per
// paint (often once per record). The validated result is kept for as long
// as the stored text is byte-identical AND the latest calendar date that
// exists anywhere is unchanged (future-date validation depends on it), so a
// read never re-parses unchanged data. loadState() hands out a private deep
// copy, so callers may still mutate what they get; peekState() returns the
// shared copy and is for read-only hot paths only.
var stateCache = null; // {raw, day, state, damage}
var symbolKindsSource = null; // stateCache entry the price-kind maps were last built from

function qtyKindsSignature() {
  return Object.keys(QTY_NON_CRYPTO).sort().join('|');
}

function readStateCached() {
  var fallback = defaultState();
  var raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    return { state: fallback, shared: false };
  }
  if (raw === null || raw === undefined) return { state: fallback, shared: false };
  var day = maxCalendarDateAnywhere();
  var hit = stateCache && stateCache.raw === raw && stateCache.day === day ? stateCache : null;
  if (!hit) {
    var info = readStoredState(raw);
    var state = null;
    if (info.parsed) {
      // Record validation reads the price-kind maps (a stock or commodity
      // ticker keeps 8 decimals even when it is also a crypto symbol), and the
      // maps are built from the loaded state. Build them from THIS state and
      // validate again when they differ from the ones just used, so the result
      // never depends on what was loaded before.
      var kindsUsed = qtyKindsSignature();
      try { noteSymbolKinds(info.accounts, info.trades); } catch (e) { /* never breaks load */ }
      if (qtyKindsSignature() !== kindsUsed) info = readStoredState(raw);
    }
    if (info.parsed) {
      var accounts = info.accounts;
      var trades = info.trades;
      try { repairCashTradeAmounts(trades, accounts); } catch (e) { /* repair never breaks load */ }
      // Legacy override migration reads the price-kind maps, so build them first.
      try { noteSymbolKinds(accounts, trades); } catch (e) { /* never breaks load */ }
      var priceOverrides = info.overrides;
      try { priceOverrides = migrateLegacyOverrides(priceOverrides); } catch (e) { /* never breaks load */ }
      state = {
        settings: normalizeSettings(info.parsed.settings, fallback.settings),
        accounts: accounts,
        trades: trades,
        priceOverrides: priceOverrides
      };
    }
    hit = stateCache = { raw: raw, day: day, state: state, damage: info.damage };
    if (state) symbolKindsSource = hit;
  }
  if (hit.damage) {
    noteStorageDamage(raw, hit.damage);
  } else {
    lastSeenRaw = raw;
  }
  if (!hit.state) return { state: fallback, shared: false };
  if (symbolKindsSource !== hit) {
    try { noteSymbolKinds(hit.state.accounts, hit.state.trades); } catch (e) { /* never breaks load */ }
    symbolKindsSource = hit;
  }
  return { state: hit.state, shared: true };
}

function loadState() {
  var r = readStateCached();
  activeDateFormat = r.state.settings.dateFormat;
  return r.shared ? cloneJson(r.state) : r.state;
}

// Read-only view of the stored state (no copy). Never mutate the result.
function peekState() {
  var r = readStateCached();
  activeDateFormat = r.state.settings.dateFormat;
  return r.state;
}

// Before a save replaces the stored text, make sure that text is either
// clean or already preserved. If a damaged original cannot be preserved
// (quota), or the stored value cannot be read at all, the save is refused
// rather than risking the existing data.
function guardStoredStateBeforeSave() {
  var raw;
  // If the existing data cannot even be read, we cannot know it is safe to
  // replace: block the save (the next attempt re-checks, so retry works).
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { throw new Error('storage-unreadable'); }
  if (raw === null || raw === undefined || raw === lastSeenRaw) return;
  var info = readStoredState(raw);
  if (!info.damage) { lastSeenRaw = raw; return; }
  if (!noteStorageDamage(raw, info.damage)) throw new Error('storage-unavailable');
}

// opts.replaceDamaged: explicit user action (Clear all data) that is allowed
// to drop a damaged original without keeping a recovery copy.
function saveState(s, opts) {
  try { noteSymbolKinds(s && s.accounts, s && s.trades); } catch (e) { /* ignore */ }
  if (!(opts && opts.replaceDamaged)) guardStoredStateBeforeSave();
  var out;
  var prevRaw = null;
  try { prevRaw = localStorage.getItem(STORAGE_KEY); } catch (e) { prevRaw = null; }
  try {
    out = JSON.stringify(s);
    localStorage.setItem(STORAGE_KEY, out);
  } catch (e) {
    throw new Error('storage-unavailable');
  }
  lastSeenRaw = out;
  // The metadata change is saved: only now release blobs nothing references.
  try {
    attReleasedHashes(prevRaw, s).forEach(function (h) { attDelete(h); });
  } catch (e) { /* best-effort: a leftover blob is harmless, a lost one is not */ }
  // Any persisted change may make the drive copy stale: let auto-sync
  // (opt-in, Sync tab) schedule an encrypted push. Never breaks saving.
  try { syncScheduleAuto(); } catch (e) { /* ignore */ }
}
