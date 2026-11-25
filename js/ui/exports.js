'use strict';
// Downloads: JSON backup, recovery copies and CSV exports (records, lots).

function backupStamp() {
  var n = new Date();
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return n.getFullYear() + p(n.getMonth() + 1) + p(n.getDate());
}

function downloadBackup() {
  var json;
  try {
    json = exportStateStrict(loadState());
  } catch (e) {
    showBanner('Export failed — no file was created.', 'error', {
      title: 'Export error',
      lines: [String((e && e.message) || e)]
    });
    return;
  }
  var blob = new Blob([json], { type: 'application/json' });
  var name = 'plutus.inoculens.com-' + backupStamp() + '.json';
  var urls = window.URL || window.webkitURL;
  var url = urls.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    try { urls.revokeObjectURL(url); } catch (e) { /* ignore */ }
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1000);
}

// The newest preserved copy of stored data that could not be read in full.
// Written as plain text: an unreadable original is not valid JSON.
function downloadRecoveryCopy() {
  var list = readRecoveryCopies();
  if (!list.length) return;
  downloadTextFile('plutus.inoculens.com-recovery-' + backupStamp() + '.txt', list[list.length - 1].raw, 'text/plain');
}

// One calm banner when saved data was unreadable or partly rejected.
function announceStorageRecovery() {
  var r = storageRecovery;
  if (!r) return;
  try {
    var rb = document.getElementById('s-recovery');
    if (rb && r.saved) rb.style.display = '';
  } catch (e) { /* ignore */ }
  var lines;
  var msg;
  if (r.kind === 'unreadable') {
    msg = 'Saved data in this browser could not be read.';
    lines = [
      'What happened: the stored data is damaged, so the app started empty.'
    ];
  } else {
    msg = 'Some saved data could not be loaded.';
    var parts = [];
    if (r.accounts) parts.push(r.accounts + ' account(s)');
    if (r.trades) parts.push(r.trades + ' record(s)');
    if (r.accountFields) parts.push(r.accountFields + ' account(s) with invalid details');
    if (r.tradeFields) parts.push(r.tradeFields + ' record(s) with invalid details');
    if (r.groups) parts.push(r.groups + ' invalid account group link(s)');
    if (r.overrides) parts.push(r.overrides + ' manual price override(s)');
    if (r.settings) parts.push('your settings');
    if (r.shape) parts.push('some malformed data');
    lines = [
      'What happened: ' + (parts.join(', ') || 'part of the saved data') + ' failed validation. The invalid parts were not loaded' + (r.settings ? ' (settings fall back to defaults)' : '') + '.'
    ];
  }
  if (r.saved) {
    lines.push('The original data is kept as a recovery copy in this browser. Download it from Settings > Backups > Download recovery copy.');
  } else {
    lines.push('The original data could NOT be copied (browser storage is full). Free space before making changes — saving is blocked to protect it.');
  }
  lines.push('Your next change will replace the active data; the recovery copy stays until you use Clear all data.');
  showBanner(msg, 'error', { title: 'Saved data problem', lines: lines });
}

function csvEsc(v) {
  var s = String(v === null || v === undefined ? '' : v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Free-text cells (notes, account names, labels): a leading = + - @ would
// run as a spreadsheet formula on open (payloads can arrive via an imported
// backup). The single-quote prefix renders invisibly in Excel/Sheets and
// keeps numeric columns untouched.
function csvSafeText(v) {
  var s = String(v === null || v === undefined ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return csvEsc(s);
}

function downloadTextFile(name, text, mime) {
  var blob = new Blob([text], { type: mime || 'text/csv' });
  var urls = window.URL || window.webkitURL;
  var url = urls.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    try { urls.revokeObjectURL(url); } catch (e) { /* ignore */ }
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1000);
}

// One-line destination summary for CSV export: legacy name, or every
// recipient joined (internal `name:qty`, external `label:qty (external)`).
function transferCsvDest(t, accName) {
  if (!t || t.type !== 'transfer') return '';
  var outs = transferOutputsOf(t);
  if (!outs.length) return '';
  var parts = outs.map(function (o) {
    if (isTransferOutputInternal(o)) {
      var id = String(o.toAccountId).trim();
      var nm = (accName && accName[id]) || id;
      return nm + ':' + String(transferRowArrival(o, t.symbol));
    }
    return String(o.label || '').trim() + ':' + String(Number(o.qty)) + ' (external)';
  });
  var selfQ = transferSelfQtyOf(t);
  if (selfQ > 0) parts.push('same account:' + String(selfQ));
  return parts.join('; ');
}

// Per-source breakdown of a multi-source transfer for the trades CSV:
// "Account:qty:fee; Account:qty:fee". Empty for every other record, so the
// existing columns keep their meaning and single-source rows stay unchanged.
function transferCsvSources(t, accName) {
  try {
    var legs = (t && t.type === 'transfer') ? transferSourcesOf(t) : null;
    if (!legs || legs.length < 2) return '';
    return legs.map(function (l) {
      var nm = (accName && accName[l.accountId]) || l.accountId;
      return nm + ':' + l.qtyRaw + ':' + l.feeRaw;
    }).join('; ');
  } catch (e) { return ''; }
}

function downloadTradesCsv() {
  var st = loadState();
  var accName = {};
  (st.accounts || []).forEach(function (a) { accName[a.id] = a.name; });
  var rows = [['id', 'date', 'type', 'symbol', 'qty', 'total', 'currency', 'fee', 'feeCurrency', 'networkFee', 'account', 'toAccount', 'note', 'txid', 'fxRate', 'fxSource', 'sources']];
  ledgerSortByDate(st.trades || []).forEach(function (t) {
    rows.push([
      t.id || '', fmtDateDmy(t.date || ''), t.type || '', String(t.symbol || '').toUpperCase(),
      t.qty !== undefined && t.qty !== null ? t.qty : '',
      t.total !== undefined && t.total !== null ? t.total : '',
      t.currency || '', t.fee !== undefined && t.fee !== null ? t.fee : '',
      t.feeCurrency || '', t.networkFee !== undefined && t.networkFee !== null ? t.networkFee : '',
      { text: accName[t.accountId] || t.accountId || '' },
      { text: transferCsvDest(t, accName) },
      { text: t.note || '' },
      { text: t.txid || '' },
      (t.fxLock && t.fxLock.rate) || '',
      fmtEcbInText((t.fxLock && t.fxLock.source) || ''),
      { text: transferCsvSources(t, accName) }
    ]);
  });
  downloadTextFile('plutus.inoculens.com-trades-' + backupStamp() + '.csv', rows.map(function (r) {
    return r.map(function (c) {
      // Free-text cells are wrapped ({text}) so formula triggers get
      // neutralized; numeric and validated-code cells stay spreadsheet-clean.
      return (c && typeof c === 'object') ? csvSafeText(c.text) : csvEsc(c);
    }).join(',');
  }).join('\n'), 'text/csv');
}

function downloadLotsCsv() {
  var st = loadState();
  var main = st.settings.mainCurrency;
  var dtrades = convertTrades(st.trades, main);
  var fifo = computeFifo(dtrades);
  var rows = [['symbol', 'openDate', 'closeDate', 'qty', 'proceeds_' + main, 'cost_' + main, 'gain_' + main, 'holdingDays', 'accountId']];
  function appendLotRow(lot, accountId, symbol) {
    var proceedsCents = Math.round(Number(lot.proceeds) * 100);
    var costCents = Math.round(Number(lot.cost) * 100);
    rows.push([
      lot.symbol || symbol || '',
      fmtDateDmy(lot.openDate || ''),
      fmtDateDmy(lot.closeDate || ''),
      lot.qty,
      proceedsCents / 100,
      costCents / 100,
      (proceedsCents - costCents) / 100,
      lot.holdingDays,
      { text: accountId || '' }
    ]);
  }
  // Lots are per-symbol globally; attribute account where possible via close trade? FIFO lots don't carry account, but joint lots do.
  // Use joint portfolio lots (with accountId) for accuracy.
  try {
    var pf = computePortfolio(dtrades, {}, 'fifo');
    Object.keys(pf.states || {}).forEach(function (accId) {
      var syms = pf.states[accId];
      Object.keys(syms).forEach(function (sym) {
        (syms[sym].lots || []).forEach(function (l) {
          appendLotRow(l, accId, sym);
        });
      });
    });
  } catch (e) {
    fifo.forEach(function (v, sym) {
    (v.lots || []).forEach(function (l) {
      appendLotRow(l, '', sym);
    });
    });
  }
  downloadTextFile('plutus.inoculens.com-tax-lots-' + backupStamp() + '.csv', rows.map(function (r) {
    return r.map(function (c) { return (c && typeof c === 'object') ? csvSafeText(c.text) : csvEsc(c); }).join(',');
  }).join('\n'), 'text/csv');
}
