'use strict';
// Exact quantity math (BigInt fixed point) for user-entered amounts: precision
// limits per asset, exact held balances and display trimming.

// Quantity precision + exact decimal core. Satoshis (8) for BTC, piconero
// (12) for XMR, and 18 decimals (the EVM base-unit standard) for every other
// known crypto ticker; unknown custom tickers, cash and stocks keep the old
// 8-decimal default. Scaled BigInt keeps amounts on the chosen grid exactly:
// raw binary subtraction left dust like 0.000017260000000000062, and 18-dec
// tokens (AAVE and every other EVM asset) push past what float64 can hold
// at all — its ~15.95 significant digits would corrupt wei digits on sight.
function qtyDecimals(symbol) {
  var s = String(symbol || '').trim().toUpperCase();
  if (s !== '' && Object.prototype.hasOwnProperty.call(QTY_NON_CRYPTO, s)) return 8; // stock/commodity accounts only
  if (s !== '' && Object.prototype.hasOwnProperty.call(QTY_NATIVE_DECIMALS, s)) return QTY_NATIVE_DECIMALS[s];
  if (s !== '' && typeof SYMBOL_MAP === 'object' && SYMBOL_MAP && SYMBOL_MAP[s]) return 18;
  return 8;
}

var EX_ACT_POW10 = [1n, 10n, 100n]; // grows on demand, one entry per exponent
function exactPow10(n) {
  var p = Number(n);
  if (!isFinite(p) || p < 0) p = 0;
  if (p > 30) p = 30;
  p = Math.floor(p);
  if (!EX_ACT_POW10 || EX_ACT_POW10.length < 3) EX_ACT_POW10 = [1n, 10n, 100n];
  while (EX_ACT_POW10.length <= p) EX_ACT_POW10.push(EX_ACT_POW10[EX_ACT_POW10.length - 1] * 10n);
  return EX_ACT_POW10[p];
}

// Parse a decimal string (or the String() of a number, exponent forms
// included) into a scaled BigInt quantized half-up at `dec` decimals.
// Never goes through a float, so no digit is lost or fabricated.
// Returns null for anything that is not a plain decimal number.
function exactScaledOf(raw, dec) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!isFinite(raw)) return null;
    raw = String(raw);
  }
  var s = String(raw).trim();
  if (s === '' || s.length > 400) return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  var neg = false;
  if (s.charAt(0) === '+' || s.charAt(0) === '-') { neg = (s.charAt(0) === '-'); s = s.slice(1); }
  var eIdx = s.indexOf('e');
  if (eIdx < 0) eIdx = s.indexOf('E');
  var exp = 0;
  if (eIdx >= 0) {
    exp = parseInt(s.slice(eIdx + 1), 10);
    if (isNaN(exp) || exp < -400 || exp > 400) return null;
    s = s.slice(0, eIdx);
  }
  var dot = s.indexOf('.');
  var ip = dot >= 0 ? (dot > 0 ? s.slice(0, dot) : '0') : s;
  var fp = dot >= 0 ? s.slice(dot + 1) : '';
  // Fold the exponent into the digit string: the decimal point sits
  // fracLen = fp.length − exp digits before the end of ip+fp. Everything
  // (exponents both directions) reduces to that one rule.
  var digits = (ip + fp).replace(/[^0-9]/g, '');
  if (digits === '') return null;
  var fracLen = fp.length - exp;
  if (fracLen <= 0) {
    for (var z = 0; z < -fracLen; z++) digits += '0';
    fp = '';
    ip = digits;
  } else {
    var intLen = digits.length - fracLen;
    if (intLen >= 0) {
      ip = digits.slice(0, intLen);
      fp = digits.slice(intLen);
    } else {
      ip = '0';
      fp = '';
      for (var z2 = 0; z2 < -intLen; z2++) fp += '0';
      fp += digits;
    }
  }
  if (ip === '') ip = '0';
  var kept = fp.slice(0, dec);
  while (kept.length < dec) kept += '0';
  var scaled = BigInt(ip + kept);
  // Half-up on the absolute value (matches Math.round-based rounding).
  if (fp.length > dec && fp.charAt(dec) >= '5') scaled += 1n;
  if (scaled === 0n) return 0n;
  return neg ? -scaled : scaled;
}

// True when `raw` carries non-zero digits beyond what the asset can hold
// (0.123456789 BTC). Forms reject these instead of silently rounding.
function qtyOverPrecise(raw, symbol) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return false;
  var dec = qtyDecimals(symbol);
  var hi = exactScaledOf(raw, 30);
  if (hi === null) return false; // malformed input is rejected elsewhere
  return hi % exactPow10(30 - dec) !== 0n;
}
function qtyPrecisionError(symbol) {
  return String(symbol) + ' allows at most ' + qtyDecimals(symbol) + ' decimals — shorten the amount.';
}

// Exact fixed-decimal print: always exactly `dec` places after the point
// (e.g. 0.1 AAVE at 18 → "0.100000000000000000").
function exactToStringFixed(sc, dec) {
  var d = Math.max(0, Math.min(30, Math.floor(Number(dec) || 0)));
  var neg = sc < 0n;
  var a = neg ? -sc : sc;
  var scale = exactPow10(d);
  var ip = a / scale;
  var fp = a % scale;
  var frac = fp.toString();
  while (frac.length < d) frac = '0' + frac;
  var out = ip.toString();
  if (d > 0) out += '.' + frac;
  return (neg && (ip !== 0n || fp !== 0n)) ? '-' + out : out;
}

// Exact print with trailing zeros trimmed (integers lose the point too).
function exactToStringTrim(sc, dec) {
  var s = exactToStringFixed(sc, dec);
  if (!/\./.test(s)) return s;
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

// Number when the exact value survives a float round-trip (so stored
// records, tests and money math keep today's shapes), the exact digit
// string otherwise — numbers simply cannot represent more precision.
function exactNumOrStr(sc, dec) {
  var s = exactToStringFixed(sc, dec);
  var n = Number(s);
  if (isFinite(n) && exactScaledOf(n, dec) === sc) return n;
  return sc === 0n ? 0 : exactToStringTrim(sc, dec);
}

// Form/store entry point: parse the raw input exactly at the symbol's
// quantity precision — number when it round-trips, exact string when it
// does not, and the old NaN-through-Number behavior for garbage.
function exactQtyValue(raw, symbol) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return Number(raw);
  var sc = exactScaledOf(raw, qtyDecimals(symbol));
  if (sc === null) return Number(raw);
  return exactNumOrStr(sc, qtyDecimals(symbol));
}

// Transfer send/receive helper: fee = sent − received. The fee field is
// computed-only (read-only in the form): the two amounts are the source of
// truth, so a saved fee can never contradict them. Received is required.
// Everything runs on the exact grid, so the derived fee carries every digit.
function transferFeeFrom(sentRaw, recvRaw, symbol) {
  if (String(recvRaw).trim() === '') return null;
  var dec = qtyDecimals(symbol);
  var sentSc = exactScaledOf(sentRaw, dec);
  var recvSc = exactScaledOf(recvRaw, dec);
  if (sentSc === null || recvSc === null) return null;
  if (sentSc <= 0n) return null;
  if (recvSc <= 0n || recvSc > sentSc) return null;
  var feeSc = sentSc - recvSc;
  return {
    sent: exactNumOrStr(sentSc, dec),
    recv: exactNumOrStr(recvSc, dec),
    fee: exactNumOrStr(feeSc, dec)
  };
}

// Exact holdings walk (BigInt mirror of the ledger engines' quantity flow):
// only balances are tracked here — money math (cost, proceeds, realized)
// stays in the float engines untouched. Clamping mirrors the engines, so the
// returned exact quantity agrees with the qtyHeld a unit shows. Walk keys are
// timelineHeldKey-shaped (accountId \u0001 SYMBOL).
function exactQtyHeldMap(allTrades) {
  var db = new Map();
  var decs = new Map();
  function getDec(sym) {
    var d = decs.get(sym);
    if (d === undefined) { d = qtyDecimals(sym); decs.set(sym, d); }
    return d;
  }
  function get(key) { return db.get(key) || 0n; }
  function add(key, sym, sc) {
    if (sc === null || sc === 0n) return;
    var v = get(key) + sc;
    db.set(key, v);
  }
  function held(key) { var v = get(key); return v > 0n ? v : 0n; }
  var list = ledgerSortByDate(allTrades || []);
  for (var wi = 0; wi < list.length; wi++) {
    var t = list[wi];
    if (!t || typeof t.accountId !== 'string' || t.accountId === '') continue;
    var sym = ledgerSym(t);
    if (!sym) continue;
    var key = timelineHeldKey(t.accountId, sym);
    var d = getDec(sym);
    var sc = exactScaledOf(t.qty, d);
    if (t.type === 'buy' || t.type === 'income') {
      if (sc !== null && sc > 0n) add(key, sym, sc);
      continue;
    }
    var isExp = (t.type === 'expense') && !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
    if (t.type === 'sell' || isExp) {
      if (sc === null || sc <= 0n) continue; // nothing to sell
      var avail = held(key);
      var lean = sc < avail ? sc : avail; // engine clamps oversells
      add(key, sym, -lean);
      continue;
    }
    if (t.type !== 'transfer') continue;
    if (sc === null || sc <= 0n) continue;
    var nfRaw = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? '0' : t.networkFee;
    var nfSc = exactScaledOf(nfRaw, d);
    if (nfSc === null || nfSc < 0n || nfSc >= sc) continue; // structurally invalid rows never book
    var totalNetSc = sc - nfSc;
    var exactLegs = [];
    var explicitExact = transferSourcesOf(t);
    if (t.sources !== undefined && t.sources !== null && explicitExact === false) continue;
    if (explicitExact) {
      for (var eli = 0; eli < explicitExact.length; eli++) {
        var exs = explicitExact[eli];
        var exq = exactScaledOf(exs.qtyRaw, d);
        var exf = exactScaledOf(exs.feeRaw, d);
        if (exq === null || exq <= 0n || exf === null || exf < 0n) { exactLegs = []; break; }
        exactLegs.push({ accountId: exs.accountId, qty: exq, fee: exf });
      }
    }
    if (!exactLegs.length) exactLegs = [{ accountId: String(t.accountId || ''), qty: sc, fee: nfSc }];
    var movedNetSc = 0n;
    exactLegs.forEach(function (leg) {
      var lk = timelineHeldKey(leg.accountId, sym);
      var avail = held(lk);
      var moved = leg.qty < avail ? leg.qty : avail;
      var feeMoved = leg.qty > 0n ? (leg.fee * moved) / leg.qty : 0n;
      add(lk, sym, -moved);
      leg.__key = lk;
      leg.__net = moved - feeMoved;
      movedNetSc += leg.__net;
    });
    var outs = (Array.isArray(t.outputs) && t.outputs.length) ? t.outputs : null;
    var hasTo = (t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '');
    if (!outs && !hasTo) {
      // Same-account sweep: each source keeps its own net.
      exactLegs.forEach(function (leg) {
        if (leg.__net > 0n) add(leg.__key, sym, leg.__net);
      });
      continue;
    }
    if (!outs) {
      // Legacy single destination. Cross-fiat arrivals land at the
      // destination's own grid via the stored converted amount.
      var dSym = (t.toSymbol !== undefined && t.toSymbol !== null && String(t.toSymbol).trim() !== '')
        ? String(t.toSymbol).trim().toUpperCase() : sym;
      if (dSym === sym) {
        if (movedNetSc > 0n) add(timelineHeldKey(String(t.toAccountId).trim(), sym), sym, movedNetSc);
      } else {
        var dDec = getDec(dSym);
        var arrSc = exactScaledOf(t.toQty, dDec);
        if (arrSc !== null && arrSc > 0n) {
          var leanArrLegacy = totalNetSc > 0n ? (arrSc * movedNetSc) / totalNetSc : 0n;
          if (leanArrLegacy > 0n) add(timelineHeldKey(String(t.toAccountId).trim(), dSym), dSym, leanArrLegacy);
        }
      }
      continue;
    }
    // Multi-recipient: the same-account remainder and internal same-symbol
    // rows stay in the pool; cross-fiat rows arrive at their converted qty;
    // external spend rows leave (already debited above). Every share scales
    // with each source's actually moved net slice, floored on the grid like
    // the engines.
    var selfSc = exactScaledOf(t.selfQty, d);
    if (selfSc !== null && selfSc > 0n && totalNetSc > 0n && movedNetSc > 0n) {
      // The remainder scales with what actually moved, like every recipient
      // row. Legs that also receive a recipient row fund their own return
      // first; the rest is split by largest remainder so the shares add up
      // to the remainder exactly (no floored dust).
      var selfEff = (selfSc * movedNetSc) / totalNetSc;
      var coverRows = [];
      outs.forEach(function (o) {
        if (!o) return;
        var cvDest = transferFundingDest(o, sym);
        var cvSc = exactScaledOf(o.qty, d);
        if (cvDest && cvSc !== null && cvSc > 0n) coverRows.push({ destId: cvDest, qty: (cvSc * movedNetSc) / totalNetSc });
      });
      var selfShares = transferSelfSplitExact(
        exactLegs.map(function (leg) { return leg.__net; }),
        exactLegs.map(function (leg) { return leg.accountId; }),
        selfEff,
        coverRows
      );
      exactLegs.forEach(function (leg, li) {
        if (selfShares[li] > 0n) add(leg.__key, sym, selfShares[li]);
      });
    }
    for (var oi = 0; oi < outs.length; oi++) {
      var o = outs[oi];
      if (!o) continue;
      var osSc = exactScaledOf(o.qty, d);
      if (osSc === null || osSc <= 0n) continue;
      var destId = (o.toAccountId !== undefined && o.toAccountId !== null) ? String(o.toAccountId).trim() : '';
      if (destId !== '') {
        var dSymO = (o.toSymbol !== undefined && o.toSymbol !== null && String(o.toSymbol).trim() !== '')
          ? String(o.toSymbol).trim().toUpperCase() : sym;
        if (dSymO === sym) {
          var keep = totalNetSc > 0n ? (osSc * movedNetSc) / totalNetSc : 0n;
          if (keep > 0n) add(timelineHeldKey(destId, sym), sym, keep);
          continue;
        }
        var dDecO = getDec(dSymO);
        var arrO = exactScaledOf(o.toQty, dDecO);
        if (arrO !== null && arrO > 0n) {
          var leanArr = totalNetSc > 0n ? (arrO * movedNetSc) / totalNetSc : 0n;
          if (leanArr > 0n) add(timelineHeldKey(destId, dSymO), dSymO, leanArr);
        }
      }
    }
  }
  return { db: db, decimals: decs };
}

// Exact holding string for one (account, symbol) pair, or summed across all
// accounts when accountId is null. Fixed decimals like fmtQty's exact path.
// Null when nothing is tracked (the caller falls back to its own render).
function exactQtyHeldString(allTrades, accountId, symbol) {
  try {
    var sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return null;
    var w = exactQtyHeldMap(allTrades);
    var d = (w.decimals.get(sym) !== undefined) ? w.decimals.get(sym) : qtyDecimals(sym);
    var total = 0n;
    var matchAccts = (accountId === null || accountId === undefined) ? null : (Array.isArray(accountId) ? accountId.map(String) : [String(accountId)]);
    w.db.forEach(function (sc, key) {
      var parts = String(key).split('\u0001');
      if (matchAccts !== null && matchAccts.indexOf(parts[0]) === -1) return;
      if (parts[1] !== sym) return;
      total += sc;
    });
    return exactToStringFixed(total, d);
  } catch (e) { return null; }
}


// Form-facing quantity text: the stored exact digits in plain decimal form
// (a round-trip number like 1e-18 reads "0.000000000000000001", exponent
// forms never leak into inputs). Garbage passes through untouched.
function qtyUiText(raw, symbol) {
  try {
    if (raw === undefined || raw === null || String(raw).trim() === '') return '';
    var dec = qtyDecimals(symbol);
    var sc = exactScaledOf(raw, dec);
    return (sc !== null) ? exactToStringTrim(sc, dec) : String(raw);
  } catch (e) { return String(raw); }
}

// Display-side trim for exact fixed strings: BTC and XMR keep their fixed
// satoshi/piconero grids (the padding is the identity there); EVM tokens
// drop the 18-dec zero padding so long walls never bully the card cells —
// trailing zeros carry no information and the popup still shows every
// exact digit the value actually has.
function qtyDisplayTrim(txt, symbol) {
  if (txt === null || txt === undefined) return txt;
  var s = String(symbol || '').trim().toUpperCase();
  if (s === 'BTC' || s === 'XMR') return txt;
  return qtyUiText(txt, s);
}
