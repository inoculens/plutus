'use strict';
// Manual price overrides (Settings).
//
// Override identity:
// Overrides follow the same asset-identity rule as live prices: a ticker is
// not a unique asset. Entries are stored under "kind:SYM" (crypto:W, stock:W).
// Legacy entries stored under the bare ticker keep working while the ticker
// belongs to a single asset kind; once a ticker is shared by several kinds a
// bare entry is ambiguous and is applied to NONE of them (it stays stored,
// untouched, until the user assigns it to a kind in Settings).
var OVERRIDE_KIND_RE = /^(crypto|stock|commodity|cash|custom):(.+)$/i;

function overrideKey(kind, symbol) {
  return normPriceKind(kind) + ':' + String(symbol === undefined || symbol === null ? '' : symbol).trim().toUpperCase();
}

// "stock:W" -> {kind:'stock', sym:'W'}; a bare ticker -> null.
function splitOverrideKey(key) {
  var m = OVERRIDE_KIND_RE.exec(String(key === undefined || key === null ? '' : key).trim());
  return m ? { kind: m[1].toLowerCase(), sym: m[2].trim().toUpperCase() } : null;
}

// Kind a caller means: its explicit kind, else the only kind the portfolio
// holds this ticker under, else null (unknown).
function overrideKindFor(sym, kind) {
  var k = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  if (k === 'crypto' || k === 'stock' || k === 'commodity' || k === 'cash' || k === 'custom') return k;
  var held = Object.keys(PRICE_KINDS_BY_SYMBOL[sym] || {});
  return held.length === 1 ? held[0] : null;
}

// Parse one stored override value into {price, vs} (vs null for a legacy bare
// number), or null when invalid.
function parseOverrideRaw(raw) {
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

// Which stored entry applies to this asset: {key, raw} or null.
function findOverrideRaw(ov, symbol, kind) {
  if (!ov || typeof ov !== 'object') return null;
  var sym = String(symbol === undefined || symbol === null ? '' : symbol).trim().toUpperCase();
  if (!sym) return null;
  var keys = Object.keys(ov);
  var eff = overrideKindFor(sym, kind);
  var i, parts;
  if (eff) {
    for (i = 0; i < keys.length; i++) {
      parts = splitOverrideKey(keys[i]);
      if (parts && parts.sym === sym && parts.kind === eff) return { key: keys[i], raw: ov[keys[i]] };
    }
  }
  if (PRICE_COLLISIONS[sym]) return null; // shared ticker: a bare/other-kind entry could be another asset's
  for (i = 0; i < keys.length; i++) { // legacy bare entry (tolerates key casing)
    if (!splitOverrideKey(keys[i]) && String(keys[i]).trim().toUpperCase() === sym) return { key: keys[i], raw: ov[keys[i]] };
  }
  if (!eff) { // kind unknown and ticker unshared: a single composite entry is unambiguous
    var found = null;
    for (i = 0; i < keys.length; i++) {
      parts = splitOverrideKey(keys[i]);
      if (parts && parts.sym === sym) { if (found) return null; found = { key: keys[i], raw: ov[keys[i]] }; }
    }
    return found;
  }
  return null;
}

// Move legacy bare entries to "kind:SYM" when the portfolio holds the ticker
// under exactly one kind. Ambiguous (shared) and unheld tickers are left as
// stored; nothing is deleted or overwritten. Returns a new object.
function migrateLegacyOverrides(ov) {
  var out = {};
  if (!ov || typeof ov !== 'object' || Array.isArray(ov)) return out;
  var keys = Object.keys(ov);
  var taken = {};
  keys.forEach(function (k) { var pr = splitOverrideKey(k); if (pr) taken[pr.kind + ':' + pr.sym] = true; });
  keys.forEach(function (k) {
    if (splitOverrideKey(k)) { out[k] = ov[k]; return; }
    var sym = String(k).trim().toUpperCase();
    var held = Object.keys(PRICE_KINDS_BY_SYMBOL[sym] || {});
    if (held.length === 1 && !taken[held[0] + ':' + sym]) {
      out[held[0] + ':' + sym] = ov[k];
      taken[held[0] + ':' + sym] = true;
    } else {
      out[k] = ov[k];
    }
  });
  return out;
}

// Settings-list operations on the stored map, by exact key. Each touches only
// the one entry it names. Pure (mutate the passed map, no storage access).

// Add/replace an override from the form. pickedKind: 'crypto'|'stock'|
// 'commodity' or anything else for Auto (the kind the portfolio holds the
// ticker under; a shared ticker must be chosen). Returns {ok, key} or {ok:false, error}.
function overrideAdd(ov, symbol, price, vs, pickedKind) {
  var sym = String(symbol === undefined || symbol === null ? '' : symbol).trim().toUpperCase();
  var k = String(pickedKind === undefined || pickedKind === null ? '' : pickedKind).trim().toLowerCase();
  var key = sym;
  if (k === 'crypto' || k === 'stock' || k === 'commodity') {
    key = overrideKey(k, sym);
  } else {
    var held = Object.keys(PRICE_KINDS_BY_SYMBOL[sym] || {});
    if (held.length > 1) {
      return { ok: false, error: sym + ' is held as more than one asset kind — choose which one this override is for.' };
    }
    if (held.length === 1) key = overrideKey(held[0], sym);
  }
  ov[key] = { price: price, vs: String(vs).toUpperCase() };
  return { ok: true, key: key };
}

function overrideSetFiat(ov, key, vs) {
  var fiat = String(vs === undefined || vs === null ? '' : vs).trim().toUpperCase();
  if (!/^[A-Z]{2,10}$/.test(fiat)) return false;
  if (!ov || !Object.prototype.hasOwnProperty.call(ov, key)) return false;
  var cur = ov[key];
  var price = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? Number(cur.price) : Number(cur);
  if (!isFinite(price) || price <= 0) return false;
  ov[key] = { price: price, vs: fiat };
  return true;
}

function overrideRemove(ov, key) {
  if (!ov || !Object.prototype.hasOwnProperty.call(ov, key)) return false;
  delete ov[key];
  return true;
}

// Give an ambiguous bare entry to one asset kind. Never overwrites an
// existing entry for that kind.
function overrideAssignKind(ov, fromKey, kind) {
  if (!ov || !Object.prototype.hasOwnProperty.call(ov, fromKey)) return { ok: false, error: 'missing' };
  if (splitOverrideKey(fromKey)) return { ok: false, error: 'already assigned' };
  var to = overrideKey(kind, fromKey);
  if (Object.prototype.hasOwnProperty.call(ov, to)) return { ok: false, error: 'exists', key: to };
  ov[to] = ov[fromKey];
  delete ov[fromKey];
  return { ok: true, key: to };
}

function priceOverrideFor(symbol, kind) {
  var e = null;
  try { e = priceOverrideEntry(symbol, kind); } catch (err) { e = null; }
  return e ? e.price : null;
}

// Raw override entry with its fiat: {price, vs} where vs is null for legacy
// bare numbers (fiat unknown — treated as the requested fiat, exactly the
// old behavior). New saves always tag the fiat they were entered in.
// `kind` is the asset kind of the position being priced; see "Manual
// override identity" for how shared tickers are resolved.
function priceOverrideEntry(symbol, kind) {
  var ov = null;
  try {
    var st = peekState();
    ov = st ? st.priceOverrides : null;
  } catch (e) {
    ov = null;
  }
  var hit = findOverrideRaw(ov, symbol, kind);
  return hit ? parseOverrideRaw(hit.raw) : null;
}

function priceDefaultVs(vs) {
  if (typeof vs === 'string' && vs.length > 0) return vs;
  try {
    var st = peekState();
    if (st && st.settings && typeof st.settings.mainCurrency === 'string' && st.settings.mainCurrency.length > 0) {
      return st.settings.mainCurrency;
    }
  } catch (e) { /* fall through */ }
  return 'EUR';
}
