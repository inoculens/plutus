'use strict';
// Page banner: one calm line plus a "More details" popup (never ticker lists
// in the line itself), auto-dismissed after a dwell. While the Settings
// dialog is open the banner is mirrored inside it. saveStateGuarded() saves
// and reports storage failures here.

// Optional 4th arg `source` tags the banner with data-source so subsystem-
// scoped clears (e.g. clearPriceBanner) only retire their own messages.
function showBanner(msg, kind, details, source) {
  var b = document.getElementById('banner');
  if (!b) return;
  var hasDetails = !!(details && ((details.lines && details.lines.length) || details.message));
  if (hasDetails) {
    lastErrorDetails = {
      title: details.title || 'Details',
      message: details.message || String(msg),
      lines: (details.lines || []).slice(0, 200)
    };
  } else {
    lastErrorDetails = null;
  }
  // Settings sits above the page: while it is open the message lives ONLY
  // in the dialog mirror. Errors born here die with the dialog; a message
  // moved in from a pre-existing page banner moves back on close.
  if (!suppressMirror && settingsDialogOpen()) {
    lastMirror = { msg: String(msg), kind: kind, details: details || null, source: source || '', fromPage: false };
    try { mirrorBannerToSettings(String(msg), kind === 'info' ? 'info' : 'error', hasDetails); } catch (e) { /* never let the mirror break the banner */ }
    return;
  }
  var t = document.getElementById('banner-text');
  if (t) t.textContent = String(msg);
  else b.textContent = String(msg);
  // Already on screen: update in place (no second slide-in). Hidden or
  // mid-exit: (re)start the entrance from off-screen.
  var wasShowing = !b.hidden && b.classList.contains('show');
  cancelBannerTimers();
  b.hidden = false;
  b.classList.remove('error', 'info', 'hide');
  b.classList.add(kind === 'info' ? 'info' : 'error');
  if (!wasShowing) { b.classList.remove('show'); void b.offsetWidth; b.classList.add('show'); }
  try { b.dataset.kind = kind === 'info' ? 'info' : 'error'; } catch (e) { /* ignore */ }
  try { b.dataset.source = source ? String(source) : ''; } catch (e) { /* ignore */ }
  var old = document.getElementById('banner-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  // Optional drill-down: every error with something more to say gets a
  // "More details" button opening the fixed-size error popup. The banner
  // itself stays one calm general line no matter how many tickers fail.
  if (hasDetails) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'banner-details';
    btn.className = 'quiet';
    btn.textContent = 'More details';
    btn.setAttribute('aria-label', 'Show error details');
    btn.addEventListener('click', function () { openErrorDialog(); });
    var actions = b.querySelector('.banner-actions');
    var closeBtn = document.getElementById('banner-close');
    if (actions && closeBtn && closeBtn.parentNode === actions) actions.insertBefore(btn, closeBtn); // X stays rightmost
    else if (actions) actions.appendChild(btn);
    else b.appendChild(btn);
  }
  // Timing: the progress bar waits for the slide-in (lead), then drains over
  // BANNER_DWELL_MS; the exit starts exactly when it runs out.
  var lead = wasShowing ? 0 : BANNER_IN_MS;
  try {
    b.style.setProperty('--banner-in', BANNER_IN_MS + 'ms');
    b.style.setProperty('--banner-out', BANNER_OUT_MS + 'ms');
    b.style.setProperty('--banner-dwell', BANNER_DWELL_MS + 'ms');
    b.style.setProperty('--banner-lead', lead + 'ms');
  } catch (e) { /* ignore */ }
  b.classList.remove('run');
  void b.offsetWidth; // restart the bar animation
  b.classList.add('run');
  var bannerDelay = lead + BANNER_DWELL_MS;
  bannerTimerEnd = Date.now() + bannerDelay;
  bannerTimer = setTimeout(dismissBanner, bannerDelay);}

function cancelBannerTimers() {
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
  if (bannerOutTimer) { clearTimeout(bannerOutTimer); bannerOutTimer = null; }
  bannerTimerEnd = 0;}

// Animated exit (progress bar ran out, or the X was pressed): dip, then
// slide back up off-screen; only then is the element really hidden.
function dismissBanner() {
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
  bannerTimerEnd = 0;
  var b = document.getElementById('banner');
  if (!b || b.hidden || b.classList.contains('hide')) return;
  b.classList.remove('show'); // 'run' stays so the bar does not snap back to full during the exit
  b.classList.add('hide');
  bannerOutTimer = setTimeout(function () {
    bannerOutTimer = null;
    var bb = document.getElementById('banner');
    if (bb && bb.classList.contains('hide')) clearBanner();
  }, BANNER_OUT_MS + 50);}

function clearBanner() {
  cancelBannerTimers();
  var b = document.getElementById('banner');
  if (!b) return;
  var t = document.getElementById('banner-text');
  if (t) t.textContent = '';
  else b.textContent = '';
  b.classList.remove('error', 'info', 'show', 'hide', 'run');
  try { delete b.dataset.kind; } catch (e) { /* ignore */ }
  var old = document.getElementById('banner-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  lastErrorDetails = null;
  lastMirror = null;
  b.hidden = true;
  try { hideSettingsAlert(); } catch (e) { /* ignore */ }}

var lastErrorDetails = null; // {title, message, lines[]} for the error-details popup

// While Settings is open the message lives ONLY in the dialog mirror;
// suppressMirror + lastMirror carry it back to the page banner on close.
var suppressMirror = false;
var lastMirror = null; // {msg, kind, details} or null
var BANNER_IN_MS = 600;      // slide-in duration (CSS --banner-in)
var BANNER_OUT_MS = 550;     // slide-out duration (CSS --banner-out)
var BANNER_DWELL_MS = 5000;  // on-screen time = progress bar run time
var bannerTimer = null;      // starts the animated exit when the bar runs out
var bannerOutTimer = null;   // finishes the exit (really hides) after the slide-out
// Page-visibility pause/resume: CSS animations freeze for background tabs but
// setTimeout does not, so the timer can fire while the bar still shows time.
// bannerTimerEnd stores the absolute wall-clock time the timer should fire at;
// on visibility restore we schedule a new timeout for the remaining duration.
var bannerTimerEnd = 0;
(function () {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      // Tab going background: cancel the timeout but remember when it was due.
      if (bannerTimer && bannerTimerEnd) {
        clearTimeout(bannerTimer);
        bannerTimer = null;
        // bannerTimerEnd already set to the correct future timestamp.
      }
    } else {
      // Tab becoming visible again: re-arm for the remaining dwell time.
      // Also resume the CSS progress bar animation from where it paused.
      if (!bannerTimer && bannerTimerEnd) {
        var remaining = bannerTimerEnd - Date.now();
        if (remaining <= 0) {
          // Time already elapsed while hidden: dismiss immediately.
          dismissBanner();
        } else {
          var b = document.getElementById('banner');
          if (b && b.classList.contains('run')) {
            // Re-sync CSS animation: set the remaining time as the new dwell,
            // with zero lead (bar is already mid-drain), so animation duration
            // matches the rescheduled JS timer exactly.
            try {
              b.style.setProperty('--banner-dwell', remaining + 'ms');
              b.style.setProperty('--banner-lead', '0ms');
            } catch (e) { /* ignore */ }
            b.classList.remove('run');
            void b.offsetWidth;
            b.classList.add('run');
          }
          bannerTimer = setTimeout(dismissBanner, remaining);
        }
      }
    }
  });
}());

// Settings-dialog mirror of the page banner: modal dialogs paint above the
// page, so without this an error fired from the Sync tab hides behind the
// dialog until it is closed. The mirror shows the same line (+ its own
// More details button, which stacks above) and hides with clearBanner.
function settingsDialogOpen() {
  try {
    var d = (typeof document !== 'undefined') ? document.getElementById('settings-dialog') : null;
    return !!(d && (d.open || (d.hasAttribute && d.hasAttribute('open'))));
  } catch (e) {
    return false;
  }
}

function settingsAlertEl() {
  var dlg = document.getElementById('settings-dialog');
  var host = document.getElementById('settings-dialog-body');
  if (!dlg || !host) return null;
  var el = document.getElementById('settings-alert');
  if (!el) {
    el = document.createElement('div');
    el.id = 'settings-alert';
    el.className = 'dlg-note';
    el.hidden = true;
    var sp = document.createElement('span');
    sp.id = 'settings-alert-text';
    el.appendChild(sp);
    // Child of the dialog itself (above the body), NOT of the grid body:
    // the body is a single-row grid and a second child would break it.
    dlg.insertBefore(el, host);
  }
  // Once per dialog: when Settings closes, a mirrored message moves back to
  // the page banner so it is not silently lost. Native Esc closes fire
  // 'close' too, so this catches every path (not just closeDialog).
  if (!dlg.getAttribute('data-alert-wired')) {
    dlg.setAttribute('data-alert-wired', '1');
    dlg.addEventListener('close', function () {
      try { flushSettingsAlertToBanner(); } catch (e) { /* ignore */ }
      try { updateModalLock(); } catch (e2) { /* ignore */ }
    });
  }
  return el;
}

function mirrorBannerToSettings(msg, kind, hasDetails) {
  if (typeof document === 'undefined') return;
  if (!settingsDialogOpen()) return;
  var el = settingsAlertEl();
  if (!el) return;
  el.classList.remove('error', 'info');
  el.classList.add(kind === 'info' ? 'info' : 'error');
  var sp = document.getElementById('settings-alert-text');
  if (sp) sp.textContent = String(msg);
  else el.textContent = String(msg);
  var old = document.getElementById('settings-alert-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  if (hasDetails) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'settings-alert-details';
    btn.textContent = 'More details';
    btn.setAttribute('aria-label', 'Show error details');
    btn.addEventListener('click', function () { openErrorDialog(); });
    el.appendChild(btn);
  }
  // Every error gets a way out: dismissing here clears the message
  // everywhere (mirror and page banner are one message).
  var x = document.getElementById('settings-alert-close');
  if (!x) {
    x = document.createElement('button');
    x.type = 'button';
    x.id = 'settings-alert-close';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Dismiss this message');
    x.addEventListener('click', function () {
      try { clearBanner(); } catch (e) { /* ignore */ }
    });
  }
  el.appendChild(x); // last: after any details button
  el.hidden = false;
}

function hideSettingsAlert() {
  if (typeof document === 'undefined') return;
  var el = document.getElementById('settings-alert');
  if (el) el.hidden = true;
}

function refreshSettingsAlert() {
  // Settings opened while a page banner shows: move the message into the
  // dialog (it moves back on close), so it lives in exactly one place.
  try {
    var s = pageBannerState();
    if (!s) return;
    hidePageBannerOnly();
    lastMirror = { msg: s.msg, kind: s.kind, details: lastErrorDetails, fromPage: true };
    mirrorBannerToSettings(s.msg, s.kind === 'info' ? 'info' : 'error', s.hasDetails);
  } catch (e) { /* ignore */ }
}

function pageBannerState() {
  try {
    var b = document.getElementById('banner');
    if (!b || b.hidden) return null;
    var t = document.getElementById('banner-text');
    var kind = 'error';
    try { kind = (b.dataset && b.dataset.kind === 'info') ? 'info' : 'error'; } catch (e) { /* ignore */ }
    return { msg: t ? t.textContent : b.textContent, kind: kind, hasDetails: !!document.getElementById('banner-details') };
  } catch (e) {
    return null;
  }
}

function hidePageBannerOnly() {
  // Hides the page banner but keeps lastErrorDetails, for the move into/out
  // of the settings mirror. Prefer clearBanner() when the message is done.
  var b = document.getElementById('banner');
  if (!b) return;
  var t = document.getElementById('banner-text');
  if (t) t.textContent = '';
  else b.textContent = '';
  cancelBannerTimers();
  b.classList.remove('error', 'info', 'show', 'hide', 'run');
  try { delete b.dataset.kind; } catch (e) { /* ignore */ }
  var old = document.getElementById('banner-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  b.hidden = true;
}

function flushSettingsAlertToBanner() {
  var m = lastMirror;
  lastMirror = null;
  try { hideSettingsAlert(); } catch (e) { /* ignore */ }
  if (!m || !m.fromPage) return;
  suppressMirror = true;
  try {
    showBanner(m.msg, m.kind, m.details);
  } finally {
    suppressMirror = false;
  }
}

function openErrorDialog() {
  var d = lastErrorDetails || { title: 'Details', message: '', lines: [] };
  var t = document.getElementById('error-dialog-title');
  if (t) t.textContent = d.title || 'Details';
  var m = document.getElementById('error-dialog-message');
  if (m) {
    m.textContent = d.message || '';
    m.hidden = !d.message;
  }
  var ul = document.getElementById('error-dialog-list');
  if (ul) {
    ul.innerHTML = '';
    (d.lines || []).forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = String(line);
      ul.appendChild(li);
    });
    ul.hidden = !(d.lines && d.lines.length);
  }
  wireDialog('error-dialog');
  openDialog('error-dialog');
}

// Price notices are informational and transient: only clear the banner
// when it shows a price notice, so FX/storage errors are never wiped.
// Checks data-source === 'price' so sync-pull and other info banners survive.
function clearPriceBanner() {
  // A mirrored info notice lives in the dialog while the page banner hides
  // (see showBanner): clear that copy too — but never an error mirror.
  try {
    if (lastMirror && lastMirror.kind === 'info' && lastMirror.source === 'price') {
      lastMirror = null;
      hideSettingsAlert();
    }
  } catch (e) { /* ignore */ }
  var b = document.getElementById('banner');
  if (!b || b.hidden) return;
  var kind = null;
  var src = null;
  try { kind = b.dataset.kind; } catch (e) { kind = null; }
  try { src = b.dataset.source; } catch (e) { src = null; }
  if (kind === 'info' && src === 'price') clearBanner();
}

// Guarded persistence for UI mutations: saveState throws
// Error('storage-unavailable') on private-mode/quota failure. Every UI
// mutation must go through here so no storage failure bricks the UI
// uncaught — the failure surfaces via the existing banner path.
// Errors saveState throws when it refuses or fails to write.
function isStorageWriteError(e) {
  return !!e && (e.message === 'storage-unavailable' || e.message === 'storage-unreadable');
}

function saveStateGuarded(s, opts) {
  try {
    saveState(s, opts);
    return true;
  } catch (e) {
    if (e && e.message === 'storage-unreadable') {
      showBanner('Save blocked — stored data could not be checked.', 'error', {
        title: 'Save blocked',
        lines: [
          'What happened: the data already saved in this browser could not be read, so replacing it was not safe.',
          'Your change was NOT saved and the existing data was left untouched.',
          'Make storage accessible again (leave private mode, allow site data), then retry the change.'
        ]
      });
      return false;
    }
    if (e && e.message === 'storage-unavailable') {
      showBanner('Storage unavailable — change was not saved.', 'error', {
        title: 'Storage error',
        lines: [
          'What failed: saving your latest change to this browser.',
          'Common causes: private window, or storage full / quota exceeded.',
          'Your change was NOT saved — free space or leave private mode, then retry.'
        ]
      });
      return false;
    }
    throw e;
  }
}
