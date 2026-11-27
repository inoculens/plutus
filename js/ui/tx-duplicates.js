'use strict';
// Duplicate transaction IDs in the UI (rules live in js/data/tx-duplicates.js):
// the Save anyway prompt of the record form, the warning pill + Tx-row marker
// on record cards, and the dialog that ignores a group's warning or brings it
// back.

// One list row of the dialog: the account stands out (name + its color
// dot), the record's date · type · amount sit muted underneath.
function txidDupRow(st, t, isThis) {
  var acc = null;
  try { acc = accountById(st, t.accountId); } catch (e) { acc = null; }
  var type = '';
  try { type = tradeTypeMeta(tradeUiType(t) || t.type).label; } catch (e) { type = String(t.type || ''); }
  var qty = '';
  try {
    if (t.qty !== undefined && t.qty !== null && String(t.qty).trim() !== '') qty = fmtQty(t.qty, t.symbol) + ' ' + String(t.symbol || '').toUpperCase();
  } catch (e) { qty = ''; }
  var li = document.createElement('li');
  var dot = document.createElement('span');
  dot.className = 'txdup-dot';
  dot.setAttribute('aria-hidden', 'true');
  if (acc && acc.color && isValidHexColor(acc.color)) {
    try { dot.style.setProperty('--dot', String(acc.color).trim()); } catch (e) { /* ignore */ }
  }
  var name = document.createElement('span');
  name.className = 'txdup-acc';
  name.textContent = acc && acc.name ? String(acc.name) : 'Deleted account';
  name.title = name.textContent;
  var meta = document.createElement('span');
  meta.className = 'txdup-meta';
  meta.textContent = [fmtDateDmy(t.date || ''), type, qty].filter(function (x) { return x !== ''; }).join(' · ');
  li.appendChild(dot);
  li.appendChild(name);
  if (isThis) {
    var me = document.createElement('span');
    me.className = 'txdup-this';
    me.textContent = 'this record';
    li.appendChild(me);
  }
  li.appendChild(meta);
  return li;
}

// Fills the shared dialog: hash line, short lead, record rows, hint, and
// the two buttons. mode 'prompt' (record form) or 'card' (pill / marker).
var txidDupMode = 'card';
var txidDupPromptSettle = null;
function txidDupFill(o) {
  var hash = document.getElementById('txdup-hash');
  var lead = document.getElementById('txdup-message');
  var ul = document.getElementById('txdup-list');
  var hint = document.getElementById('txdup-hint');
  var cancel = document.getElementById('txdup-cancel');
  var btn = document.getElementById('txdup-toggle');
  if (!hash || !lead || !ul || !hint || !cancel || !btn) return false;
  hash.textContent = o.hash;
  lead.textContent = o.lead;
  ul.innerHTML = '';
  o.rows.forEach(function (li) { ul.appendChild(li); });
  hint.textContent = o.hint;
  cancel.textContent = o.cancel;
  btn.textContent = o.action;
  btn.className = o.actionClass || 'primary';
  txidDupWire();
  return true;
}

function txidDupSettlePrompt(v) {
  var s = txidDupPromptSettle;
  txidDupPromptSettle = null;
  if (s) s(v);
}

function txidDupWire() {
  var dlg = document.getElementById('txdup-dialog');
  var btn = document.getElementById('txdup-toggle');
  if (!dlg || !btn || btn.getAttribute('data-wired')) return;
  btn.setAttribute('data-wired', '1');
  // X, Cancel and Esc answer "no". A close event queued by an earlier close
  // must not answer a prompt that is on screen again, hence the open check.
  dlg.addEventListener('close', function () { if (!dlg.open) txidDupSettlePrompt(false); });
  btn.addEventListener('click', function () {
    if (txidDupMode === 'prompt') {
      txidDupSettlePrompt(true);
      closeDialog('txdup-dialog');
      return;
    }
    var st2 = loadState();
    var list = txidDupIndex(st2).byKey[txidDupDialogKey];
    if (!list) { closeDialog('txdup-dialog'); render(); return; }
    txidDupSetIgnored(st2, txidDupDialogKey, txidDupGroupOpen(list));
    if (!saveStateGuarded(st2)) { showBanner('Storage unavailable — the change was not saved.'); return; }
    closeDialog('txdup-dialog');
    render();
  });
  wireDialog('txdup-dialog');
}

// "ADA · a1b2c3d4…7e8f90" for each asset involved.
function txidDupHashLine(pairs) {
  return pairs.map(function (p) { return p.symbol + ' · ' + shortTxid(p.txid); }).join('   ');
}

// Save-time question. Resolves true for Save anyway.
function txidDupConfirm(st, hits) {
  if (txidDupPromptSettle) txidDupSettlePrompt(false);
  var rows = [];
  var seen = {};
  hits.forEach(function (h) {
    h.matches.forEach(function (t) {
      var u = txidDupUnit(t);
      if (seen[u]) return;
      seen[u] = true;
      rows.push(txidDupRow(st, t, false));
    });
  });
  txidDupMode = 'prompt';
  var ok = txidDupFill({
    hash: txidDupHashLine(hits.map(function (h) { return { symbol: h.symbol, txid: h.matches[0].txid }; })),
    lead: 'Already saved on:',
    rows: rows,
    hint: 'Save anyway only if one transaction is split into several records.',
    cancel: 'Cancel',
    action: 'Save anyway'
  });
  if (!ok) return confirmAction('Duplicate transaction ID', 'This transaction ID is already saved for this asset.', 'Save anyway', false);
  openDialog('txdup-dialog');
  return new Promise(function (resolve) { txidDupPromptSettle = resolve; });
}

// Form gate shared by every save path. Returns:
//   { prompt: Promise } — a question is on screen; stop this submit.
//   { ackKeys, prevById } — go on; pass these to txidDupStamp before saving.
// A confirmed collision is remembered by its signature, so the resubmit that
// Save anyway triggers (and any retry after fixing another field) passes.
var txidDupBypassSig = '';
function txidDupGate(st, drafts, excludeIds, resubmit) {
  var prevById = {};
  (st.trades || []).forEach(function (t) {
    if (t && (excludeIds || []).indexOf(t.id) !== -1) prevById[t.id] = t;
  });
  var hits = [];
  try { hits = txidDupMatches(st, drafts, excludeIds); } catch (e) { hits = []; }
  var ackKeys = {};
  if (hits.length) {
    var sig = txidDupSignature(hits);
    if (sig !== txidDupBypassSig) {
      return {
        prompt: txidDupConfirm(st, hits).then(function (ok) {
          if (!ok) return;
          txidDupBypassSig = sig;
          resubmit();
        })
      };
    }
    hits.forEach(function (h) { ackKeys[h.key] = true; });
  }
  return { ackKeys: ackKeys, prevById: prevById };
}

// Called right before a successful save writes: marks confirmed groups and
// forgets the bypass so the next record asks again.
function txidDupApply(st, saved, gate) {
  try { txidDupStamp(st, saved, gate && gate.ackKeys, gate && gate.prevById); } catch (e) { /* metadata only */ }
  txidDupBypassSig = '';
}

// Card helpers. legIds: the record ids a card shows (both legs on a swap).
function txidDupCardState(legIds) {
  var st = null;
  try { st = peekState(); } catch (e) { st = null; }
  if (!st) return null;
  var found = null;
  for (var i = 0; i < legIds.length; i++) {
    var s = txidDupStatus(st, legIds[i]);
    if (!s) continue;
    s.id = legIds[i];
    if (s.open) return s;
    if (!found) found = s;
  }
  return found;
}

// Head pill: shows only while the warning is on.
function txidDupPill(status) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'trade-dup';
  b.textContent = 'Duplicate tx';
  b.title = 'Another record of this asset has the same transaction ID';
  b.setAttribute('aria-label', 'Duplicate transaction ID: show the records');
  b.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    openTxDupDialog(status.id);
  });
  return b;
}

// Tx-row marker: a compact ⚠ after the hash (the Tx column is narrow, the
// hash keeps its room). Amber while warning, faded once ignored: the way
// back to the warning. The label lives in the tooltip / aria-label.
function txidDupRowMark(status) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'tx-dup-mark' + (status.open ? ' is-open' : ' is-ignored');
  b.textContent = '⚠';
  b.title = status.open ? 'Duplicate transaction ID — review' : 'Duplicate warning ignored — tap to bring it back';
  b.setAttribute('aria-label', b.title);
  b.addEventListener('click', function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    openTxDupDialog(status.id);
  });
  return b;
}

var txidDupDialogKey = '';
function openTxDupDialog(tradeId) {
  var st = loadState();
  var s = txidDupStatus(st, tradeId);
  if (!s) return;
  if (txidDupPromptSettle) txidDupSettlePrompt(false);
  txidDupDialogKey = s.key;
  var sym = s.key.split('\n')[0];
  var rows = [];
  var shown = {};
  var self = null;
  s.records.forEach(function (t) { if (t.id === tradeId) self = t; });
  s.records.forEach(function (t) {
    var u = txidDupUnit(t);
    if (shown[u]) return;
    shown[u] = true;
    rows.push(txidDupRow(st, t, t.id === tradeId));
  });
  txidDupMode = 'card';
  var ok = txidDupFill({
    hash: txidDupHashLine([{ symbol: sym, txid: (self || s.records[0]).txid }]),
    lead: s.open ? 'Same transaction ID on:' : 'Warning ignored for:',
    rows: rows,
    hint: s.open ? 'Delete the extra record, or ignore this if the transaction is split.' : 'Show it again to bring back the Duplicate tx pill.',
    cancel: 'Close',
    action: s.open ? 'Ignore warning' : 'Show warning again'
  });
  if (!ok) return;
  openDialog('txdup-dialog');
}
