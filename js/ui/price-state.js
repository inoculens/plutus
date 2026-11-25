'use strict';
// Live price state of the current session and the "loading" placeholders.

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
  var keyParts = splitPriceKey(up); // KIND:SYM carries its own kind
  var keyKind = null;
  if (keyParts) { up = keyParts.sym; keyKind = keyParts.kind; }
  var kd = null;
  try {
    if (keyKind !== null) kd = keyKind;
    else if (kinds && Object.prototype.hasOwnProperty.call(kinds, up)) kd = kinds[up];
    else if (kinds) {
      var ks = Object.keys(kinds);
      for (var i = 0; i < ks.length; i++) {
        if (String(ks[i]).toUpperCase() === up) { kd = kinds[ks[i]]; break; }
      }
    }
  } catch (e) { kd = null; }
  var kdl = (typeof kd === 'string') ? kd.trim().toLowerCase() : '';
  try { if (priceOverrideEntry(up, kdl || undefined) !== null) return true; } catch (e) { /* fall through */ }
  if (kdl === 'cash' || kdl === 'custom') return false;
  if (kdl === 'stock') return true;
  if (kdl === 'commodity') return hasCommoditySource(up);
  try { if (SYMBOL_MAP && SYMBOL_MAP[up]) return true; } catch (e) { /* fall through */ }
  return false;
}

function isPriceLoading(sym, accountId) {
  try {
    var up = String(sym || '').toUpperCase();
    return !!priceLoading[accountId === undefined ? up : priceKeyForAccount(up, accountId)];
  } catch (e) { return false; }
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
