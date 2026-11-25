'use strict';
// Top bar: main currency, cost method, settings / sync buttons and the
// add-record button.

function buildTopbar() {
  wireDialog('trade-dialog');
  wireDialog('settings-dialog');
  wireDialog('account-dialog');
  wireDialog('confirm-dialog');
  wireDialog('note-dialog');
  wireDialog('error-dialog');
  wireDialog('color-dialog');
  // The color dialog serves both account cards and record cards: route to
  // whichever selection is live, so "Change color" paints what the reader
  // actually picked.
  function applyColorTarget(hex) {
    if (tradeSelectionMode && selectedTradeCount() > 0) {
      applyTradeColorToSelection(hex);
      return;
    }
    applyColorToSelection(hex);
  }
  var cdlg = document.getElementById('color-dialog');
  if (cdlg && !cdlg.getAttribute('data-color-wired')) {
    cdlg.setAttribute('data-color-wired', '1');
    cdlg.addEventListener('click', function (e) {
      var pick = e.target && e.target.closest ? e.target.closest('[data-color-pick]') : null;
      if (pick) {
        applyColorTarget(pick.getAttribute('data-color-pick'));
        return;
      }
    });
  }
  var cApply = document.getElementById('c-apply');
  if (cApply && !cApply.getAttribute('data-wired')) {
    cApply.setAttribute('data-wired', '1');
    cApply.addEventListener('click', function () {
      var raw = uiVal('c-hex', '').trim();
      if (raw !== '' && /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) raw = '#' + raw;
      if (raw !== '') {
        if (!isValidHexColor(raw)) {
          showBanner('Enter a hex color like #F7931A.');
          return;
        }
        applyColorTarget(raw);
        return;
      }
      applyColorTarget(uiVal('c-custom', '#c9c9cc'));
    });
  }
  var cReset = document.getElementById('c-reset');
  if (cReset && !cReset.getAttribute('data-wired')) {
    cReset.setAttribute('data-wired', '1');
    cReset.addEventListener('click', function () { applyColorTarget(null); });
  }
  var bclose = document.getElementById('banner-close');
  if (bclose && !bclose.getAttribute('data-wired')) {
    bclose.setAttribute('data-wired', '1');
    bclose.addEventListener('click', dismissBanner);
  }
  var brandHome = document.getElementById('brand-home');
  if (brandHome && !brandHome.getAttribute('data-wired')) {
    brandHome.setAttribute('data-wired', '1');
    brandHome.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      navHome();
    });
  }
  var navHomeLink = document.getElementById('nav-home');
  if (navHomeLink && !navHomeLink.getAttribute('data-wired')) {
    navHomeLink.setAttribute('data-wired', '1');
    navHomeLink.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      navHome();
    });
  }
  var cok = document.getElementById('confirm-ok');
  if (cok && !cok.getAttribute('data-wired')) {
    cok.setAttribute('data-wired', '1');
    cok.addEventListener('click', function () {
      if (confirmSettle3) settleConfirm3('primary');
      else settleConfirm(true);
    });
  }
  var ccan = document.getElementById('confirm-cancel');
  if (ccan && !ccan.getAttribute('data-wired')) {
    ccan.setAttribute('data-wired', '1');
    ccan.addEventListener('click', function () {
      if (confirmSettle3) settleConfirm3('secondary');
      else settleConfirm(false);
    });
  }
  var cdlg = document.getElementById('confirm-dialog');
  if (cdlg && !cdlg.getAttribute('data-ev-wired')) {
    cdlg.setAttribute('data-ev-wired', '1');
    cdlg.addEventListener('cancel', function () { settleConfirm(false); settleConfirm3('dismiss'); });
    cdlg.addEventListener('close', function () { settleConfirm(false); settleConfirm3('dismiss'); });
  }
  var main = document.getElementById('tb-main');
  if (main && !main.getAttribute('data-wired')) {
    main.setAttribute('data-wired', '1');
    main.addEventListener('change', function (e) {
      var st = loadState();
      st.settings.mainCurrency = e.target.value;
      if (!saveStateGuarded(st)) return;
      clearBanner();
      livePrices = {}; // stale prices are in the old currency — clear before repaint
      priceLoading = {}; // refreshPrices() re-marks what is still missing
      render(); // instant paint, then historical pairs fill in + repaint
      refreshPrices(); // live valuation re-fetched in the new currency
    });
  }
  var methods = [['tb-avg', 'average'], ['tb-fifo', 'fifo']];
  methods.forEach(function (pair) {
    var b = document.getElementById(pair[0]);
    if (!b || b.getAttribute('data-wired')) return;
    b.setAttribute('data-wired', '1');
    b.addEventListener('click', function () {
      var st = loadState();
      st.settings.costMethod = pair[1];
      if (!saveStateGuarded(st)) return;
      render(); // no refetch: cost view needs no new prices
    });
  });
  var gear = document.getElementById('tb-settings');
  if (gear && !gear.getAttribute('data-wired')) {
    gear.setAttribute('data-wired', '1');
    gear.addEventListener('click', function () { showSettingsTab('overrides'); openDialog('settings-dialog'); });
  }
  var syncBtn = document.getElementById('tb-sync');
  if (syncBtn && !syncBtn.getAttribute('data-wired')) {
    syncBtn.setAttribute('data-wired', '1');
    syncBtn.addEventListener('click', function () { showSettingsTab('sync'); openDialog('settings-dialog'); });
  }
  var fab = document.getElementById('fab-trade');
  if (fab && !fab.getAttribute('data-wired')) {
    fab.setAttribute('data-wired', '1');
    fab.addEventListener('click', function () {
      var id = accountDetailId();
      var account = id ? accountById(peekState(), id) : null;
      if (account) openPrefillTrade(account.id, true);
      else openPrefillTrade(null);
    });
  }
}

function syncTopbar(st) {
  var main = document.getElementById('tb-main');
  if (main) main.value = st.settings.mainCurrency;
  var dateFormat = normalizeDateFormat(st.settings.dateFormat);
  var dateFormatSelect = document.getElementById('set-date-format');
  var dateFormatCustom = document.getElementById('set-date-format-custom');
  var dateFormatPattern = document.getElementById('set-date-format-pattern');
  var dateFormatPreview = document.getElementById('set-date-format-preview');
  var isPresetDateFormat = DATE_FORMAT_PRESETS.indexOf(dateFormat) !== -1;
  if (dateFormatSelect) dateFormatSelect.value = isPresetDateFormat ? dateFormat : 'custom';
  if (dateFormatCustom) dateFormatCustom.hidden = isPresetDateFormat;
  if (dateFormatPattern) dateFormatPattern.value = isPresetDateFormat ? '' : dateFormat;
  if (dateFormatPreview) dateFormatPreview.textContent = 'Preview: ' + fmtDateDmy('2001-11-23');
  syncDateFormatInputs();
  var avg = document.getElementById('tb-avg');
  var fifo = document.getElementById('tb-fifo');
  var isFifo = st.settings.costMethod === 'fifo';
  if (avg) avg.setAttribute('aria-pressed', isFifo ? 'false' : 'true');
  if (fifo) fifo.setAttribute('aria-pressed', isFifo ? 'true' : 'false');
  var list = document.getElementById('o-list');
  if (list) {
    list.innerHTML = '';
    var ov = (st.priceOverrides && typeof st.priceOverrides === 'object') ? st.priceOverrides : {};
    Object.keys(ov).sort().forEach(function (sym) {
      var li = document.createElement('li');
      var label = document.createElement('span');
      var oe = parseOverrideRaw(ov[sym]);
      var op = (oe && isFinite(Number(oe.price))) ? Number(oe.price) : Number(ov[sym]);
      var oc = (oe && oe.vs) ? oe.vs : st.settings.mainCurrency;
      var parts = splitOverrideKey(sym);
      var bareUp = String(sym).trim().toUpperCase();
      var ambiguous = !parts && !!PRICE_COLLISIONS[bareUp];
      var shown = parts ? parts.sym + ' (' + parts.kind + ')' : (ambiguous ? bareUp + ' (unassigned)' : sym);
      label.textContent = shown + ' — ' + fmtMoney(op, oc) + ' ';
      li.appendChild(label);
      if (ambiguous) {
        // Shared ticker: this entry is applied to no asset until assigned.
        var asg = document.createElement('select');
        asg.setAttribute('data-override-assign', sym);
        asg.setAttribute('aria-label', 'Assign ' + bareUp + ' override to an asset kind');
        var aph = document.createElement('option');
        aph.value = '';
        aph.textContent = 'assign to…';
        asg.appendChild(aph);
        Object.keys(PRICE_KINDS_BY_SYMBOL[bareUp] || {}).forEach(function (k) {
          var ao = document.createElement('option');
          ao.value = k;
          ao.textContent = k;
          asg.appendChild(ao);
        });
        li.appendChild(asg);
        li.appendChild(document.createTextNode(' '));
      }
      // Untagged legacy entries get a one-time fiat declaration so they
      // convert instead of reading nominal; tagged ones show their fiat.
      var fiatSel = document.createElement('select');
      fiatSel.setAttribute('data-override-fiat', sym);
      fiatSel.setAttribute('aria-label', 'Fiat for ' + shown + ' override');
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = (oe && oe.vs) ? oe.vs : 'fiat…';
      fiatSel.appendChild(ph);
      MAIN_CURRENCIES.forEach(function (code) {
        if (oe && oe.vs === code) return; // already shown as the current label
        var o = document.createElement('option');
        o.value = code;
        o.textContent = code;
        fiatSel.appendChild(o);
      });
      li.appendChild(fiatSel);
      li.appendChild(document.createTextNode(' '));
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = 'Remove';
      rm.setAttribute('data-override-del', sym);
      rm.setAttribute('aria-label', 'Remove override for ' + shown);
      li.appendChild(rm);
      list.appendChild(li);
    });
  }
  try { syncRefreshHeaderIcon(st); } catch (e) { /* never let sync break render */ }
}
