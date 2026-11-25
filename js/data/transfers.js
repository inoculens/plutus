'use strict';
// Transfer model: multi-recipient outputs and multi-source funding of one
// on-chain transaction, with fee splitting and per-account arrival amounts.

// --- Multi-recipient transfers (one on-chain tx, N recipients) ---
// A transfer may carry `outputs`: one entry per recipient of the same tx.
// Internal entries move into an own account ({toAccountId, qty}); external
// entries pay someone else ({label, qty, spend}). Each row may attribute
// part of the tx fee ({fee}, optional — blank means unattributed shared
// fee). Row qty is always denominated in the SOURCE symbol (for a cash
// cross-fiat row it is the sent portion; the converted arrival rides
// {toQty, toSymbol}). Top-level qty is the total leaving the source:
// sum(row qty) + selfQty + networkFee == qty. selfQty is the part that lands
// back in the source account (same asset/currency) and is stored only when
// outputs exist. Absent/empty outputs = legacy behavior (single toAccountId,
// or a same-account on-chain move when no dest, deriving received as qty-fee).
// External rows default to spend:true (expense-like: cost books as a loss);
// spend:false is a neutral hand-over (holdings drop, no P&L beyond the fee).
var TRANSFER_MAX_OUTPUTS = 20;
var TRANSFER_MAX_SOURCES = 50;
var TRANSFER_LABEL_MAX = 80;

// --- Multi-source transfers ---
// A transfer may spend from several accounts holding the same asset. The
// optional `sources` list carries one {accountId, qty, fee} row per source;
// the record keeps accountId as the primary anchor (sources[0]) and its
// top-level qty/networkFee stay the exact totals. Legacy records without
// `sources` behave exactly as before (one source = accountId).
// Validated list, or null when the record has no explicit sources (legacy).
// Both the per-source sums and the anchor rule must match the record, so a
// corrupt imported list can never move money out of an arbitrary account.
function transferSourcesOf(t) {
  if(!t||t.type!=='transfer'||t.sources===undefined||t.sources===null)return null;
  if(!Array.isArray(t.sources)||!t.sources.length||t.sources.length>TRANSFER_MAX_SOURCES)return false;
  var out=[],seen={},sumQ=0n,sumF=0n,dec=qtyDecimals(t.symbol);
  for(var i=0;i<t.sources.length;i++){
    var s=t.sources[i];if(!s||typeof s!=='object'||Array.isArray(s))return false;
    if(typeof s.accountId!=='string'||s.accountId.trim()==='')return false;
    var id=s.accountId.trim();if(seen[id])return false;seen[id]=true;
    if(typeof s.qty!=='number'&&typeof s.qty!=='string')return false;if(qtyOverPrecise(s.qty,t.symbol))return false;
    var q=Number(s.qty),qSc=exactScaledOf(s.qty,dec);if(!isFinite(q)||q<=0||qSc===null||qSc<=0n)return false;
    var rawF=(s.fee===undefined||s.fee===null||String(s.fee).trim()==='')?0:s.fee;
    if(typeof rawF!=='number'&&typeof rawF!=='string')return false;if(qtyOverPrecise(rawF,t.symbol))return false;
    var f=Number(rawF),fSc=exactScaledOf(rawF,dec);if(!isFinite(f)||f<0||f>=q||fSc===null||fSc<0n||fSc>=qSc)return false;
    sumQ+=qSc;sumF+=fSc;out.push({accountId:id,qty:q,fee:f,qtyRaw:s.qty,feeRaw:rawF});
  }
  if(out[0].accountId!==String(t.accountId||''))return false;
  if(typeof t.qty!=='number'&&typeof t.qty!=='string')return false;if(qtyOverPrecise(t.qty,t.symbol))return false;
  var tq=Number(t.qty),tqSc=exactScaledOf(t.qty,dec);
  var nfRaw=(t.networkFee===undefined||t.networkFee===null||String(t.networkFee).trim()==='')?0:t.networkFee;
  if(typeof nfRaw!=='number'&&typeof nfRaw!=='string')return false;if(qtyOverPrecise(nfRaw,t.symbol))return false;
  var nf=Number(nfRaw),nfSc=exactScaledOf(nfRaw,dec);
  if(!isFinite(tq)||tq<=0||tqSc===null||tqSc<=0n)return false;
  if(!isFinite(nf)||nf<0||nf>=tq||nfSc===null||nfSc<0n||nfSc>=tqSc)return false;
  if(sumQ!==tqSc||sumF!==nfSc)return false;return out;
}

// Every source account id of a transfer (primary first), or [] otherwise.
function transferSourceIds(t){if(!t||t.type!=='transfer'||typeof t.accountId!=='string'||t.accountId==='')return[];var explicit=transferSourcesOf(t);if(explicit===false)return[];var out=[],seen={};function add(id){var s=String(id===undefined||id===null?'':id).trim();if(!s||seen[s])return;seen[s]=true;out.push(s);}if(explicit)explicit.forEach(function(s){add(s.accountId);});add(t.accountId);return out;}

// Source legs in record order: numeric qty/fee plus the net contribution
// (qty - fee) and its share of the record's total net. Outputs and returned
// remainders are apportioned by these shares, so attributing a fee to one
// source genuinely shifts who funds the recipients.
function transferSourceLegs(t){
 if(!t||t.type!=='transfer')return[];var explicit=transferSourcesOf(t);if(explicit===false)return[];
 if(explicit){var totalNet=0;explicit.forEach(function(s){totalNet+=s.qty-s.fee;});return explicit.map(function(s){var net=s.qty-s.fee;return{accountId:s.accountId,qty:s.qty,fee:s.fee,net:net,share:totalNet>0?net/totalNet:0};});}
 var q=Number(t.qty),nfRaw=(t.networkFee===undefined||t.networkFee===null||String(t.networkFee).trim()==='')?0:Number(t.networkFee),nf=isFinite(nfRaw)&&nfRaw>=0?nfRaw:0;
 if(!isFinite(q)||q<=0||!isFinite(nf)||nf>=q)return[];return[{accountId:String(t.accountId||''),qty:q,fee:nf,net:q-nf,share:1}];
}

function transferSourceQtyFor(t, accountId) {
  if (typeof accountId !== 'string' || accountId === '') return 0;
  var legs = transferSourceLegs(t);
  for (var i = 0; i < legs.length; i++) {
    if (legs[i].accountId === accountId) return legs[i].qty;
  }
  return 0;
}

function transferSourceFeeFor(t, accountId) {
  if (typeof accountId !== 'string' || accountId === '') return 0;
  var legs = transferSourceLegs(t);
  for (var i = 0; i < legs.length; i++) {
    if (legs[i].accountId === accountId) return legs[i].fee;
  }
  return 0;
}

function transferSourceShareOf(t, accountId) {
  if (typeof accountId !== 'string' || accountId === '') return 0;
  var legs = transferSourceLegs(t);
  for (var i = 0; i < legs.length; i++) {
    if (legs[i].accountId === accountId) return legs[i].share;
  }
  return 0;
}

// Which source legs fund what leaves a multi-source transfer. Everything that
// is sent out (the "received back" remainder and every recipient row) is paid
// by the legs' net contributions (qty - fee). A source account that is also a
// same-asset recipient first funds what lands back in itself, so its own
// money returns to it; only what is left of every leg is then pooled pro
// rata. Without such an overlap this is exactly the plain net-share split.
// nets: moved net per leg; legIds: account id per leg; items: in funding order
// [{qty, destId}] where destId names the account credited by a same-asset
// internal row ('' for the received-back remainder, external and cross-asset
// rows). Returns parts[item][leg] in the units of nets/qty.
function transferFundingParts(nets, legIds, items) {
  var n = nets.length, k, ii;
  var rem = nets.map(function (v) { return (isFinite(v) && v > 0) ? v : 0; });
  var parts = [], left = [];
  for (ii = 0; ii < items.length; ii++) {
    var it = items[ii];
    var q = (it && isFinite(it.qty) && it.qty > 0) ? it.qty : 0;
    var row = [];
    for (k = 0; k < n; k++) row.push(0);
    var p = (q > 0 && it.destId) ? legIds.indexOf(it.destId) : -1;
    if (p !== -1) {
      var own = Math.min(q, rem[p]);
      row[p] = own;
      rem[p] -= own;
      q -= own;
    }
    parts.push(row);
    left.push(q);
  }
  for (ii = 0; ii < items.length; ii++) {
    var need = left[ii];
    if (!(need > 0)) continue;
    var tot = 0;
    for (k = 0; k < n; k++) tot += rem[k];
    if (!(tot > 0)) continue;
    var use = Math.min(need, tot);
    var snap = rem.slice();
    for (k = 0; k < n; k++) {
      var share = use * (snap[k] / tot);
      parts[ii][k] += share;
      rem[k] = Math.max(0, rem[k] - share);
    }
  }
  return parts;
}

// Exact twin of transferFundingParts for the received-back remainder only, on
// the symbol grid (BigInt). Recipient rows cover their own source account
// first (rows: [{qty, destId}] in record order); the remainder is split over
// what every leg has left by largest remainder, so the shares add up to
// selfSc to the last unit and no dust is lost or invented.
function transferSelfSplitExact(netsSc, legIds, selfSc, rows) {
  var n = netsSc.length, k;
  var shares = [];
  for (k = 0; k < n; k++) shares.push(0n);
  if (selfSc <= 0n || !n) return shares;
  var rem = netsSc.map(function (v) { return v > 0n ? v : 0n; });
  (rows || []).forEach(function (r) {
    if (!r || !r.destId || r.qty <= 0n) return;
    var p = legIds.indexOf(r.destId);
    if (p === -1) return;
    var own = r.qty < rem[p] ? r.qty : rem[p];
    rem[p] -= own;
  });
  var tot = 0n;
  for (k = 0; k < n; k++) tot += rem[k];
  var weights = rem;
  if (tot <= 0n) {
    weights = netsSc.map(function (v) { return v > 0n ? v : 0n; });
    tot = 0n;
    for (k = 0; k < n; k++) tot += weights[k];
    if (tot <= 0n) return shares;
  }
  var used = 0n, fracs = [];
  for (k = 0; k < n; k++) {
    var num = selfSc * weights[k];
    shares[k] = num / tot;
    used += shares[k];
    fracs.push({ k: k, r: num % tot });
  }
  fracs.sort(function (a, b) { return a.r > b.r ? -1 : a.r < b.r ? 1 : a.k - b.k; });
  var extra = selfSc - used;
  for (var f = 0; f < fracs.length && extra > 0n; f++) {
    if (weights[fracs[f].k] <= 0n) continue;
    shares[fracs[f].k] += 1n;
    extra -= 1n;
  }
  return shares;
}

// Same-asset internal recipient row -> credited account id, else ''.
function transferFundingDest(o, symbol) {
  if (!isTransferOutputInternal(o)) return '';
  var symU = String(symbol || '').toUpperCase();
  var toU = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
    ? symU : String(o.toSymbol).trim().toUpperCase();
  return toU === symU ? String(o.toAccountId).trim() : '';
}

// Same-account remainder credited to one source. Multi-source records fund it
// from the legs that still have net left after paying what returns to their
// own account (see transferFundingParts); a destinationless move returns each
// source's own net (the fee is the only thing that left).
function transferSelfArrivalFor(t, accountId) {
  if (!t || t.type !== 'transfer' || typeof accountId !== 'string' || accountId === '') return 0;
  var legs = transferSourceLegs(t);
  var legIdx = -1;
  var totalNet = 0;
  for (var i = 0; i < legs.length; i++) {
    totalNet += legs[i].net;
    if (legs[i].accountId === accountId) legIdx = i;
  }
  if (legIdx === -1) return 0;
  var leg = legs[legIdx];
  var outs = transferOutputsOf(t);
  var hasTo = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
  if (!outs.length && !hasTo) return leg.net; // same-account sweep: own net stays
  if (!outs.length) return 0;
  var selfQ = transferSelfQtyOf(t);
  if (!(selfQ > 0) || !(totalNet > 0)) return 0;
  var items = [{ qty: selfQ, destId: '' }];
  outs.forEach(function (o) {
    var dest = transferFundingDest(o, t.symbol);
    if (dest) items.push({ qty: Number(o.qty), destId: dest });
  });
  var parts = transferFundingParts(legs.map(function (l) { return l.net; }), legs.map(function (l) { return l.accountId; }), items);
  return parts[0][legIdx];
}

// Exact even split across sources, water-filled to each source's fee cap
// (fee must stay < qty, i.e. at least one grid unit remains). Returns BigInt
// shares on the symbol grid, or null when the total cannot fit the caps.
function splitTransferFeeEven(totalSc, capsSc) {
  var n = capsSc.length;
  if (!n || totalSc < 0n) return null;
  var capSum = 0n;
  for (var i = 0; i < n; i++) { if (capsSc[i] < 0n) return null; capSum += capsSc[i]; }
  if (capSum < totalSc) return null;
  if (totalSc === 0n) return capsSc.map(function () { return 0n; });
  // Largest level L with sum(min(cap, L)) <= total.
  var lo = 0n;
  var hi = 0n;
  for (var h = 0; h < n; h++) if (capsSc[h] > hi) hi = capsSc[h];
  while (lo < hi) {
    var mid = (lo + hi + 1n) / 2n;
    var sumMid = 0n;
    for (var m = 0; m < n; m++) sumMid += (capsSc[m] < mid ? capsSc[m] : mid);
    if (sumMid <= totalSc) lo = mid; else hi = mid - 1n;
  }
  var shares = [];
  var used = 0n;
  for (var a = 0; a < n; a++) {
    var sh = capsSc[a] < lo ? capsSc[a] : lo;
    shares.push(sh);
    used += sh;
  }
  var left = totalSc - used;
  for (var b = 0; b < n && left > 0n; b++) {
    if (shares[b] < capsSc[b]) { shares[b] += 1n; left -= 1n; }
  }
  if (left > 0n) return null;
  return shares;
}

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

// Explicit same-account remainder of a multi-output transfer, in source
// units. Stored only when outputs exist; legacy self-moves derive it below.
function transferSelfQtyOf(t) {
  if (!t || t.type !== 'transfer') return 0;
  if (!(Array.isArray(t.outputs) && t.outputs.length)) return 0;
  var s = Number(t.selfQty);
  return (isFinite(s) && s > 0) ? s : 0;
}

// Portion of a transfer that returns to the source account: explicit selfQty
// on multi-output records, or the legacy same-account move (no outputs, no
// destination) where sent - fee stayed in place.
function transferSelfArrivalOf(t){if(!t||t.type!=='transfer')return 0;if(t.sources!==undefined&&t.sources!==null&&transferSourcesOf(t)===false)return 0;var outs=transferOutputsOf(t);if(outs.length)return transferSelfQtyOf(t);var hasTo=t.toAccountId!==undefined&&t.toAccountId!==null&&String(t.toAccountId).trim()!=='';if(hasTo)return 0;var sent=Number(t.qty),nfRaw=(t.networkFee===undefined||t.networkFee===null||String(t.networkFee).trim()==='')?0:Number(t.networkFee),nf=isFinite(nfRaw)&&nfRaw>=0?nfRaw:0,net=sent-nf;return isFinite(net)&&net>0?net:0;}

// External recipient amount: value genuinely leaving the portfolio.
function transferExternalQtyOf(t){if(!t||t.type!=='transfer'||!(Array.isArray(t.outputs)&&t.outputs.length))return 0;if(t.sources!==undefined&&t.sources!==null&&transferSourcesOf(t)===false)return 0;var q=0;t.outputs.forEach(function(o){if(!o||isTransferOutputInternal(o))return;var rq=Number(o.qty);if(isFinite(rq)&&rq>0)q+=rq;});return q;}

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
  var seen = dict();
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

function transferInvolvesAccount(t,id){if(!t||typeof id!=='string'||id==='')return false;if(t.type==='transfer'&&t.sources!==undefined&&t.sources!==null&&transferSourcesOf(t)===false)return false;if(t.accountId===id)return true;if(transferSourceIds(t).indexOf(id)!==-1)return true;return transferDestIds(t).indexOf(id)!==-1;}

// Check if a trade involves any of the given account IDs (as primary,
// source, or destination). Used for ledger label propagation and
// scope-aware tree building.
function tradeTouchesAccounts(t,accountIds){if(!t||!Array.isArray(accountIds)||!accountIds.length)return false;if(t.type==='transfer'){for(var i=0;i<accountIds.length;i++)if(transferInvolvesAccount(t,accountIds[i]))return true;return false;}var inScope={};accountIds.forEach(function(id){if(typeof id==='string'&&id!=='')inScope[id]=true;});return !!(t.accountId&&inScope[t.accountId]);}

// Amount of this transfer credited to one internal destination (0 when the
// account is not a recipient). Covers legacy single-dest trades too.
function transferArrivalFor(t,accountId){if(!t||t.type!=='transfer'||typeof accountId!=='string'||accountId==='')return 0;if(t.sources!==undefined&&t.sources!==null&&transferSourcesOf(t)===false)return 0;var sum=0,outs=transferOutputsOf(t);for(var i=0;i<outs.length;i++){var o=outs[i];if(isTransferOutputInternal(o)&&String(o.toAccountId).trim()===accountId)sum+=transferRowArrival(o,t.symbol);}return sum;}

// Structural check for one recipient row. accountIds (when supplied) is the
// known-account roster; sourceId guards the no-self-payment rule and
// sourceIds (when supplied) excludes every source account from receiving.
function isValidTransferOutput(o, symbol, sourceId, accountIds, sourceIds) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  var internal = isTransferOutputInternal(o);
  var hasLabel = o.label !== undefined && o.label !== null && String(o.label).trim() !== '';
  if (internal === hasLabel) return false; // exactly one of account / label
  if (internal) {
    if (typeof o.toAccountId !== 'string') return false;
    var id = o.toAccountId.trim();
    if (id === '' || id === sourceId) return false;
    if (Array.isArray(sourceIds) && sourceIds.indexOf(id) !== -1) return false;
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

function transferSourceIdsOfRaw(t) {
  var out = [];
  if (!t || !Array.isArray(t.sources)) return out;
  t.sources.forEach(function (s) {
    if (!s || typeof s.accountId !== 'string') return;
    var id = s.accountId.trim();
    if (id && out.indexOf(id) === -1) out.push(id);
  });
  return out;
}

// Shared structural checks for the optional `sources` list. accountIds is
// the known-account roster (strict import paths); accounts (when supplied)
// additionally proves every source is the same ticker and cash/asset class
// as the primary — sources may never cross assets.
function transferSourcesStructuralError(t,accountIds,accounts){
 if(!t||t.type!=='transfer'||t.sources===undefined||t.sources===null)return null;
 var explicit=transferSourcesOf(t);if(!explicit)return'sources are invalid or their totals do not match the transfer';
 var primary=null;if(Array.isArray(accounts)){for(var ai=0;ai<accounts.length;ai++){var pa=accounts[ai];if(pa&&pa.id===t.accountId){primary=pa;break;}}if(!primary)return'transfer source account not found';}
 for(var i=0;i<explicit.length;i++){
  var id=explicit[i].accountId;if(accountIds!==undefined){if(!Array.isArray(accountIds))return'accounts must be an array';if(accountIds.indexOf(id)===-1)return'source account not found';}
  if(Array.isArray(accounts)){var sa=null;for(var sj=0;sj<accounts.length;sj++)if(accounts[sj]&&accounts[sj].id===id){sa=accounts[sj];break;}
   if(!sa)return'source account not found';if(String(sa.ticker||'').trim().toUpperCase()!==String(t.symbol||'').trim().toUpperCase())return'every source must hold the same asset';
   if(isCashKind(sa.kind)!==isCashKind(primary.kind))return'cash and asset accounts cannot share a transfer';}
 }return null;
}
