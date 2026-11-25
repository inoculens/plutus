'use strict';
// Settings dialog.
// Override editor, download/upload, clear-with-confirm. Main currency +
// cost method live in the sticky top bar (buildTopbar). A main-currency
// switch re-fetches live prices and refills historical display rates;
// stored trades (native amounts, entry locks) are never rewritten.

function showSettingsTab(name) {
  var host = document.getElementById('settings-dialog-body');
  if (!host) return;
  var want = 'overrides';
  Array.prototype.forEach.call(host.querySelectorAll('[data-settab]'), function (t) {
    if (t.getAttribute('data-settab') === name) want = name;
  });
  Array.prototype.forEach.call(host.querySelectorAll('[data-settab]'), function (t) {
    t.setAttribute('aria-selected', t.getAttribute('data-settab') === want ? 'true' : 'false');
  });
  Array.prototype.forEach.call(host.querySelectorAll('[data-setpanel]'), function (p) {
    p.hidden = p.getAttribute('data-setpanel') !== want;
  });
  if (want === 'ledgers') {
    try {
      var abox = document.getElementById('set-assetledgers');
      if (abox) abox.checked = assetLedgersOn(peekState());
    } catch (e) { /* ignore */ }
  }
  // Callers select the tab before the dialog is opened, and a closed dialog
  // has no layout, so reveal once now and again after it has been laid out.
  revealSelectedSettingsTab(host);
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(function () { revealSelectedSettingsTab(host); });
  }
}

// On phones the tab strip scrolls sideways; a tab past the right edge (Cloud
// sync, Delete data) must already be in view when the dialog opens. Scrolls
// only the strip itself, never the page, and only on an axis that overflows.
function revealSelectedSettingsTab(host) {
  try {
    var bar = host && host.querySelector('.set-tabs');
    var sel = bar && bar.querySelector('[aria-selected="true"]');
    if (!bar || !sel) return;
    var b = bar.getBoundingClientRect();
    var t = sel.getBoundingClientRect();
    if (bar.scrollWidth > bar.clientWidth) {
      bar.scrollLeft += (t.left - b.left) - (bar.clientWidth - t.width) / 2;
    }
    if (bar.scrollHeight > bar.clientHeight) {
      bar.scrollTop += (t.top - b.top) - (bar.clientHeight - t.height) / 2;
    }
  } catch (e) { /* tab reveal never blocks the dialog */ }
}

function refreshLedgerList() {
  if (typeof document === 'undefined') return;
  var list = document.getElementById('l-list');
  if (!list) return;
  var map = {};
  try { map = normalizeLedgerLabels((peekState().settings || {}).ledgerLabels); } catch (e) { map = {}; }
  list.innerHTML = '';
  Object.keys(map).sort().forEach(function (code) {
    var li = document.createElement('li');
    var span = document.createElement('span');
    span.textContent = code + ' · ' + map[code];
    li.appendChild(span);
    var del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.setAttribute('data-ledger-del', code);
    del.setAttribute('aria-label', 'Delete ledger ' + code);
    li.appendChild(del);
    list.appendChild(li);
  });
}

function buildSettings() {
  var host = document.getElementById('settings-dialog-body');
  if (!host || document.getElementById('o-add')) return;
  initInfoPills();
  var wrap = document.createElement('div');
  wrap.className = 'set-layout';
  wrap.innerHTML =
    '<div class="set-tabs" role="tablist" aria-label="Settings sections">' +
    '<button type="button" role="tab" data-settab="overrides" aria-selected="true">Price overrides</button>' +
    '<button type="button" role="tab" data-settab="date-format" aria-selected="false">Date format</button>' +
    '<button type="button" role="tab" data-settab="ledgers" aria-selected="false">Ledger defaults</button>' +
    '<button type="button" role="tab" data-settab="backup" aria-selected="false">Backups</button>' +
    '<button type="button" role="tab" data-settab="sync" aria-selected="false">Cloud sync</button>' +
    '<button type="button" role="tab" data-settab="danger" aria-selected="false">Delete data</button>' +
    '</div>' +
    '<div class="set-panels">' +
    '<section data-setpanel="overrides" role="tabpanel" aria-label="Price overrides">' +
    '<h3 class="set-heading">Market pricing ' + infoPill('Use a manual quote when a market price is unavailable or you prefer a specific source. It takes priority over fetched quotes for that symbol.') + '</h3>' +
    '<label for="o-symbol">Symbol</label>' +
    '<input id="o-symbol" autocomplete="off" spellcheck="false" placeholder="e.g. BTC">' +
    '<label for="o-kind">Asset kind</label>' +
    '<select id="o-kind"><option value="auto">Auto (from my accounts)</option><option value="crypto">Crypto</option><option value="stock">Stock</option><option value="commodity">Commodity</option></select>' +
    '<label for="o-price">Price (in current fiat)</label>' +
    '<input id="o-price" inputmode="decimal" placeholder="e.g. 67000">' +
    '<button id="o-add" type="button">Save override</button>' +
    '<ul id="o-list"></ul>' +
    '</section>' +
    '<section data-setpanel="date-format" role="tabpanel" aria-label="Date format" hidden>' +
    '<h3 class="set-heading">Date display ' + infoPill('Changes how dates appear. Your records are stored the same way regardless.') + '</h3>' +
    '<label for="set-date-format">Date format</label>' +
    '<select id="set-date-format">' +
    '<option value="DD/MM/YYYY">Day first · DD/MM/YYYY</option>' +
    '<option value="MM/DD/YYYY">Month first · MM/DD/YYYY</option>' +
    '<option value="YYYY/MM/DD">Year first · YYYY/MM/DD</option>' +
    '<option value="YYYY-MM-DD">ISO · YYYY-MM-DD</option>' +
    '<option value="custom">Custom</option>' +
    '</select>' +
    '<div id="set-date-format-custom" hidden>' +
    '<label for="set-date-format-pattern">Custom pattern ' + infoPill('D or DD for day, M or MM for month, YYYY for year, in any order, separated by / . - or a space.') + '</label>' +
    '<input id="set-date-format-pattern" autocomplete="off" spellcheck="false" maxlength="10" placeholder="e.g. DD.MM.YYYY">' +
        '</div>' +
    '<p class="muted set-blurb" id="set-date-format-preview"></p>' +
    '<button id="set-date-format-apply" type="button">Apply date format</button>' +
    '</section>' +
    '<section data-setpanel="ledgers" role="tabpanel" aria-label="Ledger codes" hidden>' +
    '<h3 class="set-heading">Bookkeeping defaults ' + infoPill('The starting template for new cash accounts. Subledgers nest by code prefix. Changes only affect future suggestions; existing records keep their saved labels. To customize one account, edit its ledger directly.') + '</h3>' +
    '<label class="sync-check" for="set-assetledgers"><input id="set-assetledgers" type="checkbox"> Ledgers on asset accounts ' + infoPill('Optional for each income or expense record.') + '</label>' +
    '<label for="l-code">Code</label>' +
    '<input id="l-code" autocomplete="off" spellcheck="false" placeholder="e.g. 1100" maxlength="24">' +
    '<label for="l-label">Label</label>' +
    '<input id="l-label" autocomplete="off" spellcheck="false" placeholder="e.g. Income from X" maxlength="80">' +
    '<button id="l-add" type="button">Save ledger</button>' +
    '<ul id="l-list"></ul>' +
    '</section>' +
    '<section data-setpanel="backup" role="tabpanel" aria-label="Backup and restore" hidden>' +
    '<h3 class="set-heading">Backups ' + infoPill('Records live on this device. Download a JSON backup to keep a safe copy or move to another device. CSV exports are for spreadsheets and tax-lot review.') + '</h3>' +
    '<button id="s-download" type="button">Download backup</button>' +
    '<button id="s-recovery" type="button" style="display:none">Download recovery copy</button>' +
    '<button id="s-csv-trades" type="button">Trades CSV</button>' +
    '<button id="s-csv-lots" type="button">FIFO tax lots CSV</button>' +
    '<span id="s-upload-label">Restore from file</span>' +
    '<input id="s-upload" type="file" accept="application/json,.json">' +
    '</section>' +
    '<section data-setpanel="sync" role="tabpanel" aria-label="Encrypted sync" hidden>' +
    '<h3 class="set-heading">Encrypted cloud copy ' + infoPill('Your passphrase encrypts the data before upload, so the provider only stores ciphertext. Use the same passphrase on each device.') + '</h3>' +
    '<label for="sy-provider">Cloud provider ' + infoPill('', 'sy-hint') + '</label>' +
    '<select id="sy-provider">' +
    '<option value="webdav">WebDAV / Nextcloud</option>' +
    '<option value="gdrive">Google Drive</option>' +
    '<option value="dropbox">Dropbox</option>' +
    '<option value="megas3">MEGA (S4 object storage)</option>' +
    '</select>' +
        '<div id="sy-g-webdav">' +
    '<label for="sy-url">Server URL</label>' +
    '<input id="sy-url" autocomplete="off" spellcheck="false" placeholder="https://cloud.example.com/remote.php/dav/files/USER/INOCULENS-PLUTUS">' +
    '<label for="sy-user">Username</label>' +
    '<input id="sy-user" autocomplete="username" spellcheck="false">' +
    '<div class="sync-field-group">' +
    '<label for="sy-passwd">App-specific password</label>' +
    '<input id="sy-passwd" type="password" autocomplete="current-password">' +
    '<label class="sync-check" for="sy-remember"><input id="sy-remember" type="checkbox"> Remember password</label>' +
    '</div>' +
    '<label for="sy-filename">File name ' + infoPill('The .enc.json ending is added automatically. Missing folders are created automatically.') + '</label>' +
    '<input id="sy-filename" autocomplete="off" spellcheck="false" placeholder="plutus.inoculens.com">' +
        '</div>' +
    '<div id="sy-g-oauth" hidden>' +
    '<p class="muted set-blurb" id="sy-oneclick-note"></p>' +
    '<label for="sy-filename2">File name ' + infoPill('The .enc.json ending is added automatically.') + '</label>' +
    '<input id="sy-filename2" autocomplete="off" spellcheck="false" placeholder="plutus.inoculens.com">' +
    '<label for="sy-folder2">Folder ' + infoPill('Optional. Keeps backups separate; existing files are never overwritten. Leave blank for the top level. Missing folders are created automatically.') + '</label>' +
    '<input id="sy-folder2" autocomplete="off" spellcheck="false" placeholder="e.g. INOCULENS-PLUTUS/Work">' +
        '<details class="adv" id="sy-adv">' +
    '<summary>Your own OAuth app</summary>' +
    '<label for="sy-client">Client ID</label>' +
    '<input id="sy-client" autocomplete="off" spellcheck="false">' +
    '<div id="sy-g-secret">' +
    '<label for="sy-secret">Client secret</label>' +
    '<input id="sy-secret" type="password" autocomplete="off">' +
    '</div>' +
    '<label>Redirect URI ' + infoPill('Add this address to your OAuth app.') + '</label>' +
    '<p class="mono-break" id="sy-redirect"></p>' +
    '</details>' +
    '</div>' +
    '<div id="sy-g-megas3" hidden>' +
    '<label for="sy-endpoint">Endpoint</label>' +
    '<input id="sy-endpoint" autocomplete="off" spellcheck="false" placeholder="https://s3.eu-amsterdam.megas4.com">' +
    '<label for="sy-region">Region</label>' +
    '<input id="sy-region" autocomplete="off" spellcheck="false">' +
    '<label for="sy-bucket">Bucket</label>' +
    '<input id="sy-bucket" autocomplete="off" spellcheck="false">' +
    '<label for="sy-key">Access key</label>' +
    '<input id="sy-key" autocomplete="off" spellcheck="false">' +
    '<div class="sync-field-group">' +
    '<label for="sy-skey">Secret key</label>' +
    '<input id="sy-skey" type="password" autocomplete="off">' +
    '<label class="sync-check" for="sy-remember2"><input id="sy-remember2" type="checkbox"> Remember secret key</label>' +
    '</div>' +
    '<label for="sy-object">File name ' + infoPill('The .enc.json ending is added automatically.') + '</label>' +
    '<input id="sy-object" autocomplete="off" spellcheck="false" placeholder="plutus.inoculens.com">' +
    '<label for="sy-folder3">Folder prefix ' + infoPill('Optional. Keeps backups separate; existing files are never overwritten. Leave blank for the bucket top level.') + '</label>' +
    '<input id="sy-folder3" autocomplete="off" spellcheck="false" placeholder="e.g. backups/work">' +
        '</div>' +
    '<div class="sync-field-group">' +
    '<label for="sy-pass">Passphrase ' + infoPill('Required to encrypt and restore your data. The same passphrase gives the same key fingerprint on every device.') + '</label>' +
    '<input id="sy-pass" type="password" autocomplete="new-password" placeholder="Required">' +
    '<label class="sync-check" for="sy-remember-pass"><input id="sy-remember-pass" type="checkbox"> Remember passphrase</label>' +
    '<p class="muted set-blurb" id="sy-fp">Key fingerprint —</p>' +
    '</div>' +
    '<label class="sync-check" for="sy-auto"><input id="sy-auto" type="checkbox"> Sync automatically ' + infoPill('Syncs after every change. Connected devices check for newer changes every few seconds and update on their own.') + '</label>' +
    '<div class="sync-feature-group" id="price-history-group">' +
    '<h4 class="sync-subheading">Price history</h4>' +
    '<label class="sync-check" for="pd-same"><input id="pd-same" type="checkbox"> Store with records ' + infoPill('Historical quotes and chart data are included in the encrypted records backup. Turn this off only if you need a separate destination.') + '</label>' +
    '<div id="pd-independent" class="sync-feature-settings" hidden>' +
    '<label for="pd-provider">Price history destination ' + infoPill('Google Drive and Dropbox reuse the sign-in above. The file is encrypted with your passphrase.') + '</label>' +
    '<select id="pd-provider">' +
    '<option value="webdav">WebDAV / Nextcloud</option>' +
    '<option value="gdrive">Google Drive</option>' +
    '<option value="dropbox">Dropbox</option>' +
    '<option value="megas3">MEGA (S4 object storage)</option>' +
    '</select>' +
    '<label for="pd-filename">File name ' + infoPill('The file uses the name you enter. Sign-in details are stored apart from your main records connection.') + '</label>' +
    '<input id="pd-filename" autocomplete="off" spellcheck="false" placeholder="price-data.plutus.inoculens.com">' +
    '<label for="pd-folder">Folder</label>' +
    '<input id="pd-folder" autocomplete="off" spellcheck="false" placeholder="e.g. INOCULENS-PLUTUS/Prices">' +
    '<div id="pd-g-webdav" hidden>' +
    '<label for="pd-url">WebDAV server URL</label>' +
    '<input id="pd-url" autocomplete="off" spellcheck="false" placeholder="https://cloud.example.com/remote.php/dav/files/USER/INOCULENS-PLUTUS">' +
    '<label for="pd-user">Username</label>' +
    '<input id="pd-user" autocomplete="username" spellcheck="false">' +
    '<div class="sync-field-group">' +
    '<label for="pd-passwd">App-specific password</label>' +
    '<input id="pd-passwd" type="password" autocomplete="current-password">' +
    '<label class="sync-check" for="pd-remember"><input id="pd-remember" type="checkbox"> Remember password</label>' +
    '</div>' +
    '</div>' +
    '<div id="pd-g-oauth" hidden></div>' +
    '<div id="pd-g-megas3" hidden>' +
    '<label for="pd-endpoint">MEGA S4 endpoint</label>' +
    '<input id="pd-endpoint" autocomplete="off" spellcheck="false" placeholder="https://s3.eu-amsterdam.megas4.com">' +
    '<label for="pd-region">Region</label>' +
    '<input id="pd-region" autocomplete="off" spellcheck="false">' +
    '<label for="pd-bucket">Bucket</label>' +
    '<input id="pd-bucket" autocomplete="off" spellcheck="false">' +
    '<label for="pd-key">Access key</label>' +
    '<input id="pd-key" autocomplete="off" spellcheck="false">' +
    '<div class="sync-field-group">' +
    '<label for="pd-skey">Secret key</label>' +
    '<input id="pd-skey" type="password" autocomplete="off">' +
    '<label class="sync-check" for="pd-remember2"><input id="pd-remember2" type="checkbox"> Remember secret key</label>' +
    '</div>' +
    '</div>' +
        '<div class="sync-btns">' +
    '<button id="pd-connect" type="button">Connect</button>' +
    '<button id="pd-sync" type="button">Sync prices</button>' +
    '</div>' +
    '</div>' +
    '<p class="muted set-blurb" id="pd-status">Stored with your records.</p>' +
    '</div>' +
    '<p class="muted set-blurb" id="sy-status">Not connected.</p>' +
    '<div class="sync-btns">' +
    '<button id="sy-connect" type="button">Connect</button>' +
    '<button id="sy-disconnect" type="button">Disconnect</button>' +
    '<button id="sy-push" type="button">Sync now</button>' +
    '<button id="sy-pull" type="button">Restore from drive</button>' +
    '<button id="sy-cleanup" type="button">Clean up</button>' +
    '</div>' +
    '<span id="s-enc-label">Encrypted backup' + infoPill('Needs your passphrase to open.') + '</span>' +
    '<button id="sy-enc-download" type="button">Download encrypted backup</button>' +
    '<span id="sy-enc-upload-label">Restore from encrypted file</span>' +
    '<input id="sy-enc-upload" type="file" accept="application/json,.json" aria-label="Restore from encrypted file">' +
    '</section>' +
    '<section data-setpanel="danger" role="tabpanel" aria-label="Delete data" hidden>' +
    '<h3 class="set-heading">Clear this browser ' + infoPill('Permanently removes the accounts, records and settings stored in this browser. Copies on a cloud drive are separate and must be deleted there.') + '</h3>' +
    '<button id="s-clear" type="button">Clear all data</button>' +
    '</section>' +
    '</div>';
  host.appendChild(wrap);
  host.addEventListener('click', function (e) {
    var tab = e && e.target && e.target.closest ? e.target.closest('[data-settab]') : null;
    if (!tab) return;
    showSettingsTab(tab.getAttribute('data-settab'));
  });
  var dateFormatSelect = document.getElementById('set-date-format');
  var dateFormatCustom = document.getElementById('set-date-format-custom');
  var dateFormatPattern = document.getElementById('set-date-format-pattern');
  var dateFormatPreview = document.getElementById('set-date-format-preview');
  function updateDateFormatPreview() {
    var selectedFormat = dateFormatSelect && dateFormatSelect.value === 'custom'
      ? String(dateFormatPattern && dateFormatPattern.value || '').trim()
      : String(dateFormatSelect && dateFormatSelect.value || DEFAULT_DATE_FORMAT);
    if (dateFormatPreview) {
      dateFormatPreview.textContent = isValidDateFormat(selectedFormat)
        ? 'Preview: ' + selectedFormat.replace(/YYYY|DD|MM|D|M/g, function (token) {
          return token === 'YYYY' ? '2001' : (token === 'MM' || token === 'M' ? '11' : '23');
        })
        : 'Enter a pattern using D or DD, M or MM, and YYYY once each.';
    }
  }
  if (dateFormatSelect) {
    dateFormatSelect.addEventListener('change', function () {
      if (dateFormatCustom) dateFormatCustom.hidden = dateFormatSelect.value !== 'custom';
      updateDateFormatPreview();
    });
  }
  if (dateFormatPattern) dateFormatPattern.addEventListener('input', updateDateFormatPreview);
  document.getElementById('set-date-format-apply').addEventListener('click', function () {
    var nextFormat = dateFormatSelect && dateFormatSelect.value === 'custom'
      ? String(dateFormatPattern && dateFormatPattern.value || '').trim()
      : String(dateFormatSelect && dateFormatSelect.value || DEFAULT_DATE_FORMAT);
    if (!isValidDateFormat(nextFormat)) {
      showBanner('Use D or DD, M or MM, and YYYY once each, separated by /, ., - or spaces.', 'error');
      return;
    }
    var tradeDate = document.getElementById('t-date');
    var tradeDateIso = tradeDate ? parseDateInput(tradeDate.value) : null;
    var st = loadState();
    st.settings.dateFormat = nextFormat;
    if (!saveStateGuarded(st)) return;
    activeDateFormat = nextFormat;
    if (tradeDateIso && tradeDate) tradeDate.value = fmtDateDmy(tradeDateIso);
    clearBanner();
    render();
  });
  document.getElementById('o-add').addEventListener('click', function () {
    var sym = uiVal('o-symbol', '').trim().toUpperCase();
    var price = Number(uiVal('o-price', ''));
    if (!sym) { showBanner('Override needs a symbol (e.g. BTC).'); return; }
    if (!isFinite(price) || price <= 0) { showBanner('Override price must be > 0.'); return; }
    var st = loadState();
    st.priceOverrides = (st.priceOverrides && typeof st.priceOverrides === 'object') ? st.priceOverrides : {};
    // The override belongs to one asset kind (a coin and a stock can share a
    // ticker). Auto picks the kind the portfolio holds this ticker under; a
    // shared ticker must be chosen explicitly.
    var added = overrideAdd(st.priceOverrides, sym, price, st.settings.mainCurrency, uiVal('o-kind', 'auto'));
    if (!added.ok) { showBanner(added.error); return; }
    if (!saveStateGuarded(st)) return;
    uiSetVal('o-symbol', '');
    uiSetVal('o-kind', 'auto');
    uiSetVal('o-price', '');
    clearBanner();
    refreshPrices(); // override wins over network; recompute + render
  });
  document.getElementById('o-list').addEventListener('click', function (e) {
    var btn = e && e.target && e.target.closest ? e.target.closest('[data-override-del]') : null;
    if (!btn) return;
    var st = loadState();
    if (overrideRemove(st.priceOverrides, btn.getAttribute('data-override-del'))) {
      if (!saveStateGuarded(st)) return;
    }
    refreshPrices();
  });
  // Ledger chart: explicit add/rename (same code overwrites) + delete.
  // Records keep their own stored labels regardless of this map.
  document.getElementById('l-add').addEventListener('click', function () {
    var code = uiVal('l-code', '').trim();
    var label = uiVal('l-label', '').trim();
    if (!code || !isValidLedgerCode(code) || String(code).trim() === '') { showBanner('Ledger needs a code (e.g. 1100).'); return; }
    if (!label) { showBanner('Ledger needs a label (e.g. Income from X).'); return; }
    if (!isValidLedgerLabel(label)) { showBanner('Ledger label is too long — up to 80 characters.'); return; }
    var st = loadState();
    if (!st.settings || typeof st.settings !== 'object') st.settings = defaultState().settings;
    var map = normalizeLedgerLabels(st.settings.ledgerLabels);
    map[String(code).trim()] = String(label).trim();
    st.settings.ledgerLabels = map;
    if (!saveStateGuarded(st)) return;
    uiSetVal('l-code', '');
    uiSetVal('l-label', '');
    clearBanner();
    refreshLedgerList();
    render();
  });
  document.getElementById('l-list').addEventListener('click', function (e) {
    var btn = e && e.target && e.target.closest ? e.target.closest('[data-ledger-del]') : null;
    if (!btn) return;
    var code = btn.getAttribute('data-ledger-del');
    var st = loadState();
    var map = normalizeLedgerLabels(st.settings && st.settings.ledgerLabels);
    if (Object.prototype.hasOwnProperty.call(map, code)) {
      delete map[code];
      st.settings.ledgerLabels = map;
      if (!saveStateGuarded(st)) return;
    }
    refreshLedgerList();
    render();
  });
  try { refreshLedgerList(); } catch (e) { /* ignore */ }
  var assetBox = document.getElementById('set-assetledgers');
  if (assetBox) {
    try { assetBox.checked = assetLedgersOn(peekState()); } catch (e) { /* ignore */ }
    if (!assetBox.getAttribute('data-wired')) {
      assetBox.setAttribute('data-wired', '1');
      assetBox.addEventListener('change', function () {
        var st = loadState();
        if (!st.settings || typeof st.settings !== 'object') st.settings = defaultState().settings;
        st.settings.assetLedgers = !!assetBox.checked;
        if (!saveStateGuarded(st)) return;
        clearBanner();
        render();
      });
    }
  }
  // Fiat tag for legacy bare-number overrides (saved before the entry fiat
  // was recorded): declaring it once converts the override everywhere
  // instead of reading it nominal in the display fiat.
  document.getElementById('o-list').addEventListener('change', function (e) {
    var sel = e && e.target && e.target.closest ? e.target.closest('[data-override-fiat]') : null;
    if (!sel || !sel.value) return;
    var sym = sel.getAttribute('data-override-fiat');
    var st = loadState();
    if (!st.priceOverrides || typeof st.priceOverrides !== 'object') return;
    if (!overrideSetFiat(st.priceOverrides, sym, sel.value)) return;
    if (!saveStateGuarded(st)) return;
    clearBanner();
    refreshPrices(); // re-resolve + repaint with the declared fiat
  });
  // Ambiguous legacy override (bare ticker shared by several asset kinds):
  // the user says which asset it belongs to; nothing else is touched.
  document.getElementById('o-list').addEventListener('change', function (e) {
    var sel = e && e.target && e.target.closest ? e.target.closest('[data-override-assign]') : null;
    if (!sel || !sel.value) return;
    var from = sel.getAttribute('data-override-assign');
    var kind = String(sel.value).trim().toLowerCase();
    var st = loadState();
    if (!st.priceOverrides) return;
    var moved = overrideAssignKind(st.priceOverrides, from, kind);
    if (!moved.ok) {
      if (moved.error === 'exists') showBanner('A ' + kind + ' override for ' + String(from).toUpperCase() + ' already exists — remove one of them first.');
      return;
    }
    if (!saveStateGuarded(st)) return;
    clearBanner();
    refreshPrices();
  });
  document.getElementById('s-download').addEventListener('click', downloadBackup);
  var recBtn = document.getElementById('s-recovery');
  if (recBtn) recBtn.addEventListener('click', downloadRecoveryCopy);
  var csvT = document.getElementById('s-csv-trades');
  if (csvT) csvT.addEventListener('click', downloadTradesCsv);
  var csvL = document.getElementById('s-csv-lots');
  if (csvL) csvL.addEventListener('click', downloadLotsCsv);
  document.getElementById('s-upload').addEventListener('change', function (e) {
    var input = e.target;
    var f = input && input.files && input.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result);
      // Encrypted backups (*.enc.json) are ours but unreadable here: point
      // at Cloud Sync instead of the cryptic 'unknown app' rejection.
      if (syncIsEncryptedBackup(text)) {
        showBanner('This backup is encrypted — restore it from the Cloud Sync tab.', 'error', {
          title: 'Encrypted backup',
          lines: [
            'This file holds an encrypted copy of your data. The normal restore cannot open it.',
            'Next step: open the Cloud Sync tab, type your sync passphrase, then upload the file with "Encrypted file" there.'
          ]
        });
        try { showSettingsTab('sync'); } catch (e2) { /* stay where we are */ }
        input.value = '';
        return;
      }
      try {
        importState(text);
      } catch (err) {
        showBanner('Import failed — your data was left untouched.', 'error', {
          title: 'Import error',
          lines: [String((err && err.message) || err)]
        });
        input.value = '';
        return;
      }
      input.value = '';
      clearBanner();
      refreshPrices();
      closeDialog('settings-dialog');
    };
    reader.onerror = function () {
      showBanner('Import failed — could not read the file.', 'error', {
        title: 'Import error',
        lines: ['The file could not be read. Pick an INOCULENS PLUTUS backup (.json) and retry.']
      });
      input.value = '';
    };
    reader.readAsText(f);
  });
  document.getElementById('s-clear').addEventListener('click', clearAllData);
  buildSyncSettings();
}

function clearAllData() {
  confirmAction('Clear everything', 'Delete all accounts, trades, receipts and attachments, net-worth history, price caches, settings and saved sync sign-ins from this browser? Copies already stored in your own cloud storage are not touched. This cannot be undone.', 'Delete everything', true).then(function (ok) {
    if (!ok) return;
    livePrices = {};
    priceLoading = {};
    // Explicit wipe: discard any recovery copies too ("cannot be undone").
    if (!saveStateGuarded(defaultState(), { replaceDamaged: true })) return;
    clearRecoveryCopies();
    clearBanner();
    wipeAllBrowserData().then(function () {
      // A reload drops every in-memory copy (sync timers and secrets, cached
      // history, open dialogs) so nothing can write the wiped data back.
      try { location.reload(); return; } catch (e) { /* fall through */ }
      render();
      closeDialog('settings-dialog');
    });
  });
}
