'use strict';
// Record form, transfers: recipient rows, source rows, fee splitting and the
// live fee / arrival preview.

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
function transferRecipientAccountCompatible(fromAccount,candidateAccount){if(!fromAccount||!candidateAccount)return false;var cash=isCashKind(fromAccount.kind);if(isCashKind(candidateAccount.kind)!==cash)return false;return cash||String(candidateAccount.ticker||'').toUpperCase()===String(fromAccount.ticker||'').toUpperCase();}
function refreshRecipientAccounts(){
 try{
  var list=document.getElementById('t-rec-list');if(!list||!list.querySelectorAll)return;
  var st=loadState(),fromId=uiVal('t-account',''),fromAcc=accountById(st,fromId),sourceIds={},allowSourceOverlap=readSourceRows().length>1;
  readSourceRows().forEach(function(s){if(s.accountId)sourceIds[s.accountId]=true;});
  var rows=list.querySelectorAll('.rec-row');
  for(var i=0;i<rows.length;i++)(function(row){
   var sel=row.querySelector('.rec-account');if(!sel)return;var cur=sel.value;sel.innerHTML='';
   (st.accounts||[]).forEach(function(a){if(!a||(!allowSourceOverlap&&(a.id===fromId||sourceIds[a.id]))||!transferRecipientAccountCompatible(fromAcc,a))return;var o=document.createElement('option');o.value=a.id;o.textContent=a.name+' · '+String(a.ticker).toUpperCase();sel.appendChild(o);});
   var has=false;for(var k=0;k<sel.options.length;k++)if(sel.options[k].value===cur){has=true;break;}
   if(cur&&has)sel.value=cur;
   else if(cur){var keepAccount=accountById(st,cur);if(transferRecipientAccountCompatible(fromAcc,keepAccount)&&(allowSourceOverlap||(cur!==fromId&&!sourceIds[cur]))){var keep=document.createElement('option');keep.value=cur;keep.textContent=keepAccount.name+' · '+String(keepAccount.ticker).toUpperCase();sel.appendChild(keep);sel.value=cur;}else if(sel.options.length)sel.selectedIndex=0;}
   else if(sel.options.length)sel.selectedIndex=0;
   syncRecipientRowMode(row);
  })(rows[i]);
 }catch(e){/* ignore */}
}

// Stored outputs from validated recipient rows: internal rows name the
// account, external rows the label (spend:false only for neutral rows —
// absent means spend). Optional per-row fees and cross-fiat arrivals ride
// along; legacy single-dest fields are never written with outputs.
function buildTransferOutputs(rows, symbol) {
  var out = [];
  var decOut = qtyDecimals(symbol);
  (rows || []).forEach(function (r) {
    if (!r) return;
    var rqSc = exactScaledOf(r.qty, decOut);
    var o = { qty: (rqSc === null) ? Number(r.qty) : exactNumOrStr(rqSc, decOut) };
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
    '<label>Amount<input class="rec-qty" autocomplete="off" inputmode="decimal" placeholder="e.g. 0.1"></label>' +
    '<label class="rec-toqty-wrap" hidden>Received (dest fiat)<input class="rec-toqty" autocomplete="off" inputmode="decimal" placeholder="e.g. 15.2"></label>' +
    '<label>Fee share (optional)<input class="rec-fee" autocomplete="off" inputmode="decimal" placeholder="e.g. 0.0001"></label>' +
    '</div>' +
    '<label class="rec-spend-wrap" hidden><input type="checkbox" class="rec-spend" checked> Spend (counts as expense — untick for a neutral hand-over)</label>' +
    '<button type="button" class="rec-remove quiet">Remove</button>';
  list.appendChild(row);
  function changed() { try { syncRecipientRowMode(row); } catch (e) { /* ignore */ } try { refreshSourceAccounts(); } catch (e) { /* ignore */ } try { syncTransferFeePreview(); } catch (e) { /* ignore */ } }
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
  if (rm) rm.addEventListener('click', function () { try { row.parentNode.removeChild(row); } catch (e) { /* ignore */ } try { refreshSourceAccounts(); refreshRecipientAccounts(); syncTransferFeePreview(); } catch (e) { /* ignore */ } });
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

// --- Multi-source transfer rows (form) ---
// "Spend from" lets one transfer debit several accounts holding the same
// asset. The first row is fixed (primary/anchor: accountId = sources[0]);
// extra rows are added with + Add source account. Each row has qty, fee,
// Max (spend everything held at the record date), auto/manual fee toggle,
// and remove. Auto mode derives fees from an even split water-filled to
// per-source caps (fee < qty); manual mode lets the user attribute the fee
// to any source in full or partially. t-qty stays read-only and derived
// (sum of source qty). In multi-source transfers, an account can be both a
// source and a destination; its net balance reflects both legs.

function clearSourceRows() {
  try {
    var list = document.getElementById('t-source-list');
    if (list) list.innerHTML = '';
    transferSourceManualFees = {};
  } catch (e) { /* ignore */ }
}

function readSourceRows() {
  var rows = [];
  try {
    var list = document.getElementById('t-source-list');
    if (!list) return rows;
    var els = list.querySelectorAll ? list.querySelectorAll('.src-row') : [];
    for (var i = 0; i < els.length; i++) {
      (function (row, idx) {
        function q(sel) { var el = row.querySelector(sel); return el ? el : null; }
        function v(sel) { var el = q(sel); return el ? el.value : ''; }
        var autoEl = q('.src-auto');
        // A lone source has nothing to share the fee with: it always derives
        // the fee (sent - recipients - received back), never a typed value.
        var auto = els.length === 1 || !autoEl || autoEl.checked;
        var feeVal = v('.src-fee');
        rows.push({
          index: idx,
          accountId: v('.src-account'),
          qty: v('.src-qty'),
          fee: feeVal,
          auto: auto
        });
      })(els[i], i);
    }
  } catch (e) { /* ignore */ }
  return rows;
}

// Validate + build the `sources` array from source rows. Returns {sources, error}.
// qty > 0 per source, 0 <= fee < qty per source, unique accounts, anchor
// account (first row) is always included.
function transferHasAdditionalSources(rows){return Array.isArray(rows)&&rows.length>1;}

function buildTransferSources(rows, symbol) {
  var sources = [];
  var seen = dict();
  var symDec = qtyDecimals(symbol);
  var currentState = loadState();
  var primaryAccount = accountById(currentState, uiVal('t-account', ''));
  if (!primaryAccount) return { sources: null, error: 'Choose a valid primary source account.' };
  var cashClass = isCashKind(primaryAccount.kind);
  if (String(primaryAccount.ticker || '').toUpperCase() !== String(symbol || '').toUpperCase()) return { sources: null, error: 'Primary source ticker does not match the transfer asset.' };
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r) return { sources: null, error: 'Source row ' + (i + 1) + ' is invalid.' };
    var id = String(r.accountId || '').trim();
    if (!id) return { sources: null, error: 'Source row ' + (i + 1) + ' needs an account.' };
    if (seen[id]) return { sources: null, error: 'Pick each source account once — merge the amounts instead.' };
    seen[id] = true;
    var sourceAccount = accountById(currentState, id);
    if (!sourceAccount) return { sources: null, error: 'Source row ' + (i + 1) + ' account not found.' };
    if (isCashKind(sourceAccount.kind) !== cashClass || String(sourceAccount.ticker || '').toUpperCase() !== String(symbol || '').toUpperCase()) {
      return { sources: null, error: 'Every source must have the same ticker and cash/asset class as the primary account.' };
    }
    if (i === 0 && id !== primaryAccount.id) return { sources: null, error: 'The first source must be the primary account.' };
    var qSc = exactScaledOf(r.qty, symDec);
    if (qSc === null || qSc <= 0n) return { sources: null, error: 'Source row ' + (i + 1) + ' needs a quantity > 0.' };
    var fSc = 0n;
    if (String(r.fee || '').trim() !== '') {
      fSc = exactScaledOf(r.fee, symDec);
      if (fSc === null || fSc < 0n) return { sources: null, error: 'Source row ' + (i + 1) + ' fee must be >= 0.' };
      if (fSc >= qSc) return { sources: null, error: 'Source row ' + (i + 1) + ' fee must be less than its quantity.' };
    }
    sources.push({ accountId: id, qty: exactNumOrStr(qSc, symDec), fee: fSc > 0n ? exactNumOrStr(fSc, symDec) : '' });
  }
  if (!sources.length) return { sources: null, error: 'Add at least one source account.' };
  // Network fee must be < total qty.
  var totalQ = 0n, totalF = 0n;
  for (var j = 0; j < sources.length; j++) {
    var qj = exactScaledOf(sources[j].qty, symDec);
    var fj = exactScaledOf(sources[j].fee || '0', symDec);
    if (qj !== null) totalQ += qj;
    totalF += fj;
  }
  if (totalF >= totalQ) return { sources: null, error: 'Total fee must be less than total sent.' };
  return { sources: sources, error: null };
}

function addSourceRow(data) {
  data = data || {};
  var list = document.getElementById('t-source-list');
  if (!list) return null;
  var row = document.createElement('div');
  row.className = 'src-row';
  row.innerHTML =
    '<div class="src-grid">' +
    '<label>Account<select class="src-account"></select></label>' +
    '<label>Qty<input class="src-qty" autocomplete="off" inputmode="decimal" placeholder="e.g. 0.1"></label>' +
    '<label>Fee<input class="src-fee" autocomplete="off" inputmode="decimal" placeholder="e.g. 0.0001"></label>' +
    '<div class="src-actions"><button type="button" class="src-max quiet">Max</button>' +
    '<button type="button" class="src-remove quiet"' + (!list.querySelector('.src-row') ? ' hidden disabled' : '') + '>Remove</button></div>' +
    '<label class="src-auto-wrap"><input type="checkbox" class="src-auto" checked> Auto fee</label>' +
    '</div>';
  list.appendChild(row);
  function changed() { try { syncSourceRowMode(row); } catch (e) { /* ignore */ } try { refreshSourceAccounts(); refreshRecipientAccounts(); } catch (e) { /* ignore */ } try { syncTransferFeePreview(); } catch (e) { /* ignore */ } }
  var acct = row.querySelector('.src-account');
  if (acct) acct.addEventListener('change', changed);
  ['.src-qty', '.src-fee'].forEach(function (sel) {
    var el = row.querySelector(sel);
    if (el) el.addEventListener('input', changed);
  });
  var auto = row.querySelector('.src-auto');
  if (auto) auto.addEventListener('change', function () { try { syncSourceRowMode(row); } catch (e) { /* ignore */ } try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var maxBtn = row.querySelector('.src-max');
  if (maxBtn) maxBtn.addEventListener('click', function () {
    try { fillSourceMax(row); } catch (e) { /* ignore */ } try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var rm = row.querySelector('.src-remove');
  if (rm) rm.addEventListener('click', function () { try { row.parentNode.removeChild(row); } catch (e) { /* ignore */ } try { refreshSourceAccounts(); refreshRecipientAccounts(); syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  try {
    if (data.accountId) {
      var sel0 = row.querySelector('.src-account');
      if (sel0) {
        var tmp = document.createElement('option');
        tmp.value = data.accountId;
        tmp.textContent = data.accountId;
        sel0.appendChild(tmp);
        sel0.value = data.accountId;
      }
    }
    if (data.qty !== undefined) row.querySelector('.src-qty').value = data.qty;
    if (data.fee !== undefined) row.querySelector('.src-fee').value = data.fee;
    if (data.auto === false && auto) auto.checked = false;
  } catch (e) { /* ignore */ }
  try { refreshSourceAccounts(); refreshRecipientAccounts(); } catch (e) { /* ignore */ }
  try { syncSourceRowMode(row); } catch (e) { /* ignore */ }
  return row;
}

// Rebuild every source row's account dropdown: same asset class as the
// primary account (same ticker for non-cash, any cash for cash). The
// primary row is fixed to the current account; extra rows exclude accounts
// already picked as sources.
function refreshSourceAccounts() {
  try {
    var list = document.getElementById('t-source-list');
    if (!list || !list.querySelectorAll) return;
    var st = loadState();
    var primaryId = uiVal('t-account', '');
    var primaryAcc = accountById(st, primaryId);
    var symU = primaryAcc ? String(primaryAcc.ticker || '').toUpperCase() : '';
    var isCash = !!(primaryAcc && isCashKind(primaryAcc.kind));
    var rows = list.querySelectorAll('.src-row');
    var used = {};
    if (primaryId) used[primaryId] = true;
    if (rows.length === 1) readRecipientRows().forEach(function (rr) {
      if (rr.kind === 'internal' && rr.accountId) used[rr.accountId] = true;
    });
    for (var i = 0; i < rows.length; i++) {
      (function (row, index) {
        var sel = row.querySelector('.src-account');
        if (!sel) return;
        var cur = sel.value;
        sel.innerHTML = '';
        if (index === 0) {
          var primaryOption = document.createElement('option');
          primaryOption.value = primaryId;
          primaryOption.textContent = primaryAcc ? primaryAcc.name + ' · ' + symU : primaryId;
          sel.appendChild(primaryOption);
          sel.disabled = true;
          sel.value = primaryId;
          syncSourceRowMode(row);
          return;
        }
        sel.disabled = false;
        var placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose account';
        sel.appendChild(placeholder);
        (st.accounts || []).forEach(function (account) {
          if (!account || !account.id || used[account.id]) return;
          if (isCashKind(account.kind) !== isCash) return;
          if (String(account.ticker || '').toUpperCase() !== symU) return;
          var option = document.createElement('option');
          option.value = account.id;
          option.textContent = account.name + ' · ' + String(account.ticker).toUpperCase();
          sel.appendChild(option);
        });
        var canKeep = !!cur && !used[cur] && accountById(st, cur);
        if (canKeep) {
          var exists = false;
          for (var k = 0; k < sel.options.length; k++) {
            if (sel.options[k].value === cur) { exists = true; break; }
          }
          if (exists) sel.value = cur;
        }
        if (!sel.value) sel.value = '';
        if (sel.value) used[sel.value] = true;
        syncSourceRowMode(row);
      })(rows[i], i);
    }
  } catch (e) { /* ignore */ }
}
// Show/hide the fee input vs auto chip per source row based on the auto
// checkbox. Manual rows keep their typed fee; auto rows show a read-only
// chip derived from the even split.
function syncSourceRowMode(row) {
  if (!row) return;
  var auto = row.querySelector('.src-auto');
  var feeIn = row.querySelector('.src-fee');
  // With a single source row the fee is always derived: lock the row to auto
  // and hide the toggle (a manual fee would only restate the derived one).
  var siblings = row.parentNode && row.parentNode.querySelectorAll ? row.parentNode.querySelectorAll('.src-row') : [];
  var single = siblings.length === 1;
  if (single && auto) auto.checked = true;
  var autoFlag = single || !auto || auto.checked;
  if (feeIn) feeIn.disabled = autoFlag;
  var wrap = row.querySelector('.src-auto-wrap');
  if (wrap) {
    wrap.style.opacity = autoFlag ? '0.55' : '1';
    // .src-auto-wrap sets display with !important, so hide it the same way.
    if (single) wrap.style.setProperty('display', 'none', 'important');
    else wrap.style.removeProperty('display');
  }
}

// Most an account can spend on one date: what it held at that point of the
// ledger, as a plain decimal string ('' when nothing). Records dated after
// isoDate are ignored (they run later), and so is the record being edited:
// its own spend is about to be replaced, so it must not shrink the answer.
// Same-date records stay in, because a new record executes after them.
function transferSourceMaxQty(trades, accountId, symbol, isoDate, excludeId) {
  var sym = String(symbol || '').trim().toUpperCase();
  var list = (trades || []).filter(function (t) {
    if (!t) return false;
    if (excludeId && t.id === excludeId) return false;
    if (isoDate && typeof t.date === 'string' && t.date > isoDate) return false;
    return true;
  });
  var txt = exactQtyHeldString(list, accountId, sym);
  if (txt === null) return '';
  var ui = qtyUiText(txt, sym);
  if (!ui || ui.charAt(0) === '-' || !/[1-9]/.test(ui)) return '';
  return ui;
}

// Fill a source row's qty with everything the account held on the record's
// date (not today's balance). Used by the Max button.
function fillSourceMax(row) {
  try {
    var sel = row.querySelector('.src-account');
    if (!sel) return;
    var st = loadState();
    var acc = accountById(st, sel.value);
    if (!acc) return;
    var sym = String(acc.ticker || '').toUpperCase();
    var dateRaw = uiVal('t-date', '').trim();
    var iso = dateRaw ? parseDateInput(dateRaw) : todayStr();
    if (!iso || !isValidDateStr(iso)) iso = null;
    var maxTxt = transferSourceMaxQty(st.trades || [], sel.value, sym, iso, editingTradeId);
    var inp = row.querySelector('.src-qty');
    if (!inp) return;
    if (!maxTxt) {
      tradeFormError(acc.name + ' holds no ' + sym + (iso ? ' on ' + fmtDateDmy(iso) : '') + '.');
      return;
    }
    inp.value = maxTxt;
  } catch (e) { /* ignore */ }
}

// Apply an even fee split across all source rows (water-filled to caps),
// switching every row to auto mode. Called by the "Split evenly" button.
function splitFeeEvenlyUI() {
  try {
    var list = document.getElementById('t-source-list');
    var rows = list ? list.querySelectorAll('.src-row') : [];
    if (!rows.length) return;
    transferSourcesAuto = true;
    transferSourceManualFees = {};
    for (var i = 0; i < rows.length; i++) {
      var auto = rows[i].querySelector('.src-auto');
      var feeIn = rows[i].querySelector('.src-fee');
      if (auto) auto.checked = true;
      if (feeIn) feeIn.value = '';
      syncSourceRowMode(rows[i]);
    }
    syncTransferFeePreview();
  } catch (e) { /* ignore */ }
}

function syncTransferFeePreview() {
  var sideEl = document.getElementById('t-side');
  if (!sideEl || sideEl.value !== 'transfer') return;
  var hint = hintTextTarget(document.getElementById('t-rec-hint'));
  var feeInput = document.getElementById('t-networkfee');
  var qtyEl = document.getElementById('t-qty');
  var selfRow = document.getElementById('t-selfrecv-row');
  var srcRows = readSourceRows();
  var rows = readRecipientRows();
  var symDec = 0;
  var sym = '', tick = '';
  try {
    var acc = accountById(peekState(), uiVal('t-account', ''));
    if (acc) { tick = String(acc.ticker).trim().toUpperCase(); sym = ' ' + tick; symDec = qtyDecimals(tick); }
  } catch (e) { sym = ''; tick = ''; }
  if (!feeInput) return;
  try { feeInput.setAttribute('readonly', ''); } catch (e) { /* ignore */ }
  if (selfRow) selfRow.hidden = false;
  var selfRaw = String(uiVal('t-selfrecv', '')).trim();
  var selfSc = 0n;
  if (selfRaw !== '') {
    selfSc = exactScaledOf(selfRaw, symDec);
    if (selfSc === null || selfSc < 0n) {
      feeInput.value = '';
      if (qtyEl) qtyEl.readOnly = true;
      if (hint) hint.textContent = 'Received back must be a number >= 0.';
      return;
    }
  }
  function rowScaled(sc0) { var v = exactScaledOf(sc0, symDec); return v === null ? -1n : v; }

  // --- Multi-source mode: fee is derived from all outputs and self-return. ---
  var srcOk = true, srcTotalQ = 0n, manualFeeTotal = 0n;
  var srcEntries = [], autoSourceRows = [], autoCaps = [];
  for (var si = 0; si < srcRows.length; si++) {
    var r = srcRows[si], q = rowScaled(r.qty);
    if (q <= 0n) { srcOk = false; continue; }
    srcTotalQ += q;
    if (r.auto) { autoSourceRows.push(si); autoCaps.push(q - 1n); srcEntries.push({q:q,f:0n}); }
    else {
      var f = String(r.fee || '').trim() === '' ? 0n : rowScaled(r.fee);
      if (f < 0n || f >= q) { srcOk = false; continue; }
      manualFeeTotal += f; srcEntries.push({q:q,f:f});
    }
  }
  if (srcRows.length) {
    if (qtyEl) qtyEl.readOnly = true;
    if (!srcOk) {
      if (qtyEl) qtyEl.value = '';
      feeInput.value = '';
      if (hint) hint.textContent = 'Complete every source account, quantity and fee before setting the total.';
      return;
    }
    if (qtyEl) qtyEl.value = exactToStringTrim(srcTotalQ, symDec);
    if (srcRows.length === 1 && rows.length === 1 && rows[0].kind === 'internal' && rows[0].toSymbol) {
      if (selfSc >= srcTotalQ) {
        feeInput.value = '';
        if (hint) hint.textContent = 'Received back must be less than sent when another account receives funds.';
        return;
      }
      feeInput.value = '0';
      if (hint) {
        hint.textContent = 'Converted at the trade-date rate — enter what arrives in the destination fiat'
          + (selfSc > 0n ? '; ' + exactToStringTrim(selfSc, symDec) + sym + ' stayed here.' : '.');
      }
      return;
    }
    var srcIds = {};
    srcRows.forEach(function(r){if(r.accountId)srcIds[r.accountId]=true;});
    var recConflict = null;
    if(srcRows.length===1)rows.forEach(function(r){if(r.kind==='internal'&&srcIds[r.accountId])recConflict=r.accountId;});
    if(recConflict){feeInput.value='';if(hint)hint.textContent='An account cannot both fund and receive in a single-source transfer.';return;}
    var recSum=0n,recFeeSum=0n,recOk=true;
    rows.forEach(function(r){
      var rq=rowScaled(r.qty);if(rq<=0n)recOk=false;else recSum+=rq;
      if(String(r.fee||'').trim()!==''){var rf=rowScaled(r.fee);if(rf<0n)recOk=false;else recFeeSum+=rf;}
    });
    if(!recOk){feeInput.value='';if(hint)hint.textContent='Each recipient needs a valid amount and fee.';return;}
    var requiredFee=srcTotalQ-recSum-selfSc;
    if(requiredFee<0n){feeInput.value='';if(hint)hint.textContent='Recipients + received back exceed the source amounts.';return;}
    if(recFeeSum>requiredFee){feeInput.value='';if(hint)hint.textContent='Recipient fee attribution exceeds the transfer fee.';return;}
    if(manualFeeTotal>requiredFee){feeInput.value='';if(hint)hint.textContent='Manual source fees exceed the transfer fee implied by recipients.';return;}
    var remainderFee=requiredFee-manualFeeTotal;
    if(autoSourceRows.length){
      var shares=splitTransferFeeEven(remainderFee,autoCaps);
      if(!shares){feeInput.value='';if(hint)hint.textContent='The fee cannot be split across these sources without exceeding a source amount.';return;}
      autoSourceRows.forEach(function(rowIndex,ai){
        var rowEl=document.getElementById('t-source-list').querySelectorAll('.src-row')[rowIndex];
        if(!rowEl)return;
        var feeIn=rowEl.querySelector('.src-fee'),share=shares[ai]||0n;
        if(feeIn)feeIn.value=share>0n?exactToStringTrim(share,symDec):'';
        srcEntries[rowIndex].f=share;
      });
    } else if(remainderFee!==0n){feeInput.value='';if(hint)hint.textContent='Source fees must equal the transfer fee. Adjust a fee or choose Split evenly.';return;}
    if(requiredFee>=srcTotalQ){feeInput.value='';if(hint)hint.textContent='Total fee must be less than total sent.';return;}
    feeInput.value=exactToStringTrim(requiredFee,symDec);
    if(hint){
      var parts=[];
      srcEntries.forEach(function(e,i){var fTxt=e.f>0n?' fee '+exactToStringTrim(e.f,symDec):'';parts.push('src'+(i+1)+' '+exactToStringTrim(e.q,symDec)+sym+fTxt);});
      var backTxt=selfSc>0n?' · '+exactToStringTrim(selfSc,symDec)+sym+' received back':'';
      hint.textContent='Total '+exactToStringTrim(srcTotalQ,symDec)+sym+' = '+parts.join(' + ')+backTxt+' · fee '+exactToStringTrim(requiredFee,symDec)+sym+'.';
    }
    return;
  }

  // --- Legacy single-source mode (no explicit sources, or single auto source) ---
  if (qtyEl) qtyEl.readOnly = false;
  var sentSc = exactScaledOf(uiVal('t-qty', ''), 8);
  if (sentSc === null) sentSc = 0n;
  var sentOk = sentSc > 0n;
  if (!sentOk) {
    feeInput.value = '';
    if (hint) hint.textContent = 'Enter how much you sent first.';
    return;
  }
  // Re-read with the symbol's decimals for exactness.
  sentSc = exactScaledOf(uiVal('t-qty', ''), symDec);
  if (sentSc === null) sentSc = 0n;
  sentOk = sentSc > 0n;
  if (!sentOk) {
    feeInput.value = '';
    if (hint) hint.textContent = 'Enter how much you sent first.';
    return;
  }
  // No recipients: same-account move — fee derives from sent − arrived back.
  if (!rows.length) {
    var selfMove = transferFeeFrom(uiVal('t-qty', ''), uiVal('t-selfrecv', ''), tick);
    if (!selfMove) {
      var recvTxt = selfRaw;
      feeInput.value = '';
      if (hint) hint.textContent = recvTxt === '' ? 'Enter what arrived back — the fee below fills in itself.' : 'Received back must be > 0 and at most what you sent.';
      return;
    }
    var rFeeSc = exactScaledOf(selfMove.fee, symDec);
    feeInput.value = rFeeSc !== null ? exactToStringTrim(rFeeSc, symDec) : String(selfMove.fee);
    if (hint) {
      var rFeeTxt = (rFeeSc !== null) ? exactToStringTrim(rFeeSc, symDec) : String(selfMove.fee);
      hint.textContent = rFeeSc === 0n
        ? 'No fee — everything stayed in this account.'
        : 'Fee ' + rFeeTxt + sym + ' will be recorded as the loss.';
    }
    return;
  }
  // Single cross-fiat row: the arrival is a converted amount, not sent − fee.
  if (rows.length === 1 && rows[0].kind === 'internal' && rows[0].toSymbol) {
    if (!sentOk) {
      feeInput.value = '';
      if (hint) hint.textContent = 'Enter how much you sent first.';
      return;
    }
    if (selfSc >= sentSc) {
      feeInput.value = '';
      if (hint) hint.textContent = 'Received back must be less than sent when another account receives funds.';
      return;
    }
    feeInput.value = '0';
    if (hint) {
      hint.textContent = 'Converted at the trade-date rate — enter what arrives in the destination fiat'
        + (selfSc > 0n ? '; ' + exactToStringTrim(selfSc, symDec) + sym + ' stayed here.' : '.');
    }
    return;
  }
  var sumSc = 0n, okRows = true, feeSumSc = 0n;
  rows.forEach(function (r) {
    var q = rowScaled(r.qty);
    if (q <= 0n) okRows = false;
    else sumSc += q;
    if (String(r.fee || '').trim() !== '') {
      var f = rowScaled(r.fee);
      if (f < 0n) okRows = false;
      else feeSumSc += f;
    }
  });
  if (!sentOk) {
    feeInput.value = '';
    if (hint) hint.textContent = 'Enter how much you sent first — the fee below fills in itself.';
    return;
  }
  if (!okRows) {
    feeInput.value = '';
    if (hint) hint.textContent = 'Each recipient needs an amount > 0.';
    return;
  }
  var feeSc = sentSc - sumSc - selfSc;
  if (feeSc < 0n) {
    feeInput.value = '';
    if (hint) hint.textContent = selfSc > 0n
      ? 'Recipients + received back exceed sent — lower an amount.'
      : 'Recipients exceed sent — lower an amount.';
    return;
  }
  var feeTxt = exactToStringTrim(feeSc, symDec);
  feeInput.value = feeTxt;
  if (hint) {
    var n = rows.length + (rows.length === 1 ? ' recipient' : ' recipients');
    backTxt = selfSc > 0n ? ' ' + exactToStringTrim(selfSc, symDec) + sym + ' stayed here.' : '';
    if (feeSumSc > feeSc) {
      hint.textContent = 'Row fees exceed the tx fee (' + feeTxt + sym + ') — lower a fee share.';
    } else {
      hint.textContent = feeSc === 0n
        ? 'No fee — received equals sent across ' + n + '.' + backTxt
        : 'Fee ' + feeTxt + sym + ' shared across ' + n + (feeSumSc > 0n ? ' (' + exactToStringTrim(feeSumSc, symDec) + ' attributed per row).' : '.') + backTxt;
    }
  }
}

// Multi-source transfer form state.
// transferSourcesAuto: when true, every source fee is derived from an even
// split (water-filled to caps) and rows show read-only fee chips; when false,
// each source fee is a manual input and the total fee must equal the sum.
// Reset on every form open/reset; repopulated on edit of a multi-source
// record (auto rows absorb the remainder, manual rows keep their values).
var transferSourcesAuto = true;
var transferSourceManualFees = {}; // rowIndex -> fee string (manual mode only)
