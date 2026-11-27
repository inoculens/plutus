'use strict';
// Duplicate transaction IDs in the UI (rules live in js/data/tx-duplicates.js):
// the Save anyway prompt of the record form, the warning pill + Tx-row marker
// on record cards, and the dialog that ignores a group's warning or brings it
// back.

// One-line description of a record for the warnings: account · date · type · qty.
function txidDupRecordLine(st, t) {
  var acc = null;
  try { acc = accountById(st, t.accountId); } catch (e) { acc = null; }
  var type = '';
  try { type = tradeTypeMeta(tradeUiType(t) || t.type).label; } catch (e) { type = String(t.type || ''); }
  var qty = '';
  try {
    if (t.qty !== undefined && t.qty !== null && String(t.qty).trim() !== '') qty = fmtQty(t.qty, t.symbol) + ' ' + String(t.symbol || '').toUpperCase();
  } catch (e) { qty = ''; }
  return [acc && acc.name ? String(acc.name) : 'Deleted account', fmtDateDmy(t.date || ''), type, qty]
    .filter(function (s) { return s !== ''; }).join(' · ');
}

// Save-time question. Resolves true for Save anyway.
function txidDupConfirm(st, hits) {
  var parts = [];
  hits.forEach(function (h) {
    var lines = h.matches.slice(0, 2).map(function (t) { return txidDupRecordLine(st, t); });
    if (h.matches.length > 2) lines.push('+' + (h.matches.length - 2) + ' more');
    parts.push('This ' + h.symbol + ' transaction ID is already on ' +
      (h.matches.length === 1 ? 'a record' : h.matches.length + ' records') + ': ' + lines.join('; ') + '.');
  });
  parts.push('Save anyway only if one transaction really is split into separate records (e.g. a reward claim plus a transfer). Otherwise this is probably a duplicate.');
  return confirmAction('Duplicate transaction ID', parts.join(' '), 'Save anyway', false);
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
  txidDupDialogKey = s.key;
  var msg = document.getElementById('txdup-message');
  var ul = document.getElementById('txdup-list');
  var btn = document.getElementById('txdup-toggle');
  if (!msg || !ul || !btn) return;
  var sym = s.key.split('\n')[0];
  msg.textContent = s.open
    ? 'These ' + sym + ' records share one transaction ID. If one of them was entered twice, delete the extra record. If the transaction really is split into separate records, ignore the warning.'
    : 'You ignored the warning for these ' + sym + ' records that share one transaction ID. Bring it back to show the Duplicate tx pill again.';
  ul.innerHTML = '';
  var shown = {};
  s.records.forEach(function (t) {
    var u = txidDupUnit(t);
    if (shown[u]) return;
    shown[u] = true;
    var li = document.createElement('li');
    li.textContent = txidDupRecordLine(st, t);
    if (t.id === tradeId) {
      var me = document.createElement('span');
      me.className = 'txdup-this';
      me.textContent = 'this record';
      li.appendChild(me);
    }
    ul.appendChild(li);
  });
  btn.textContent = s.open ? 'Ignore warning' : 'Show warning again';
  if (!btn.getAttribute('data-wired')) {
    btn.setAttribute('data-wired', '1');
    btn.addEventListener('click', function () {
      var st2 = loadState();
      var cur = null;
      var list = txidDupIndex(st2).byKey[txidDupDialogKey];
      if (list) cur = txidDupGroupOpen(list);
      if (cur === null) { closeDialog('txdup-dialog'); render(); return; }
      txidDupSetIgnored(st2, txidDupDialogKey, cur);
      if (!saveStateGuarded(st2)) { showBanner('Storage unavailable — the change was not saved.'); return; }
      closeDialog('txdup-dialog');
      render();
    });
  }
  wireDialog('txdup-dialog');
  openDialog('txdup-dialog');
}
