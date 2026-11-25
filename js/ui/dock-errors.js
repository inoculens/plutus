'use strict';
// Form error panel in the dialog dock and highlighting of missing fields.

// Debt dialogs use the Add/Edit record dock: the Save button sticks to the
// bottom of the dialog and the error rises from behind it with the same
// bounce, dismiss button and draining timer bar (BANNER_* timings).
var dockErrorState = Object.create(null);

function dockErrorFor(id) {
  if (!dockErrorState[id]) dockErrorState[id] = { timer: null, outTimer: null };
  return dockErrorState[id];
}

function dockErrorCancel(st) {
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  if (st.outTimer) { clearTimeout(st.outTimer); st.outTimer = null; }
}

function dockErrorClear(id) {
  var st = dockErrorFor(id);
  dockErrorCancel(st);
  var panel = document.getElementById(id);
  var text = document.getElementById(id + '-text');
  if (text) text.textContent = '';
  if (panel) {
    panel.classList.remove('show', 'hide', 'run');
    panel.hidden = true;
  }
}

function dockErrorDismiss(id) {
  var st = dockErrorFor(id);
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  var panel = document.getElementById(id);
  if (!panel || panel.hidden || panel.classList.contains('hide')) return;
  panel.classList.remove('show'); // 'run' stays so the bar does not snap back during the exit
  panel.classList.add('hide');
  st.outTimer = setTimeout(function () {
    st.outTimer = null;
    var pn = document.getElementById(id);
    if (pn && pn.classList.contains('hide')) dockErrorClear(id);
  }, BANNER_OUT_MS + 50);
}

function dockErrorShow(id, msg) {
  var panel = document.getElementById(id);
  var text = document.getElementById(id + '-text');
  if (!panel || !text) return;
  var st = dockErrorFor(id);
  var close = document.getElementById(id + '-close');
  if (close && !close.getAttribute('data-wired')) {
    close.setAttribute('data-wired', '1');
    close.addEventListener('click', function () { dockErrorDismiss(id); });
  }
  text.textContent = String(msg);
  var wasShowing = !panel.hidden && panel.classList.contains('show');
  dockErrorCancel(st);
  panel.hidden = false;
  panel.classList.remove('hide');
  if (!wasShowing) { panel.classList.remove('show'); void panel.offsetWidth; panel.classList.add('show'); }
  var lead = wasShowing ? 0 : BANNER_IN_MS;
  try {
    panel.style.setProperty('--banner-in', BANNER_IN_MS + 'ms');
    panel.style.setProperty('--banner-out', BANNER_OUT_MS + 'ms');
    panel.style.setProperty('--banner-dwell', BANNER_DWELL_MS + 'ms');
    panel.style.setProperty('--banner-lead', lead + 'ms');
  } catch (e) { /* ignore */ }
  panel.classList.remove('run');
  void panel.offsetWidth; // restart the bar animation
  panel.classList.add('run');
  st.timer = setTimeout(function () { dockErrorDismiss(id); }, lead + BANNER_DWELL_MS);
}

// Markup for the sticky submit dock with its rising error panel.
function dockMarkup(errorId, label, buttonId, buttonType) {
  return '<div class="t-dock">' +
    '<div id="' + errorId + '" class="t-err" role="alert" aria-live="assertive" hidden>' +
    '<div class="t-err-row"><p id="' + errorId + '-text" class="banner-error t-err-text"></p>' +
    '<button type="button" id="' + errorId + '-close" class="t-err-close" aria-label="Dismiss this message">✕</button></div>' +
    '<div class="t-err-progress"><div class="t-err-bar"></div></div></div>' +
    '<button class="primary" type="' + (buttonType || 'submit') + '"' + (buttonId ? ' id="' + buttonId + '"' : '') + '>' + label + '</button></div>';
}

// Empty mandatory fields turn red (instead of the browser's own bubble) and
// the first one is focused; typing or choosing a value clears its highlight.
var MISSING_FIELDS_MESSAGE = 'Fill all mandatory fields above first';

function clearInvalidFields(form) {
  if (!form) return;
  Array.prototype.forEach.call(form.querySelectorAll('.fld-invalid'), function (el) {
    el.classList.remove('fld-invalid');
    el.removeAttribute('aria-invalid');
  });
}

function flagMissingFields(form) {
  if (!form) return false;
  if (!form.getAttribute('data-invalid-wired')) {
    form.setAttribute('data-invalid-wired', '1');
    var unflag = function (event) {
      var el = event && event.target;
      if (el && el.classList && el.classList.contains('fld-invalid')) {
        el.classList.remove('fld-invalid');
        el.removeAttribute('aria-invalid');
      }
    };
    form.addEventListener('input', unflag);
    form.addEventListener('change', unflag);
  }
  var first = null;
  Array.prototype.forEach.call(form.querySelectorAll('[required]'), function (el) {
    if (el.disabled) return;
    var empty = !String(el.value || '').trim();
    el.classList.toggle('fld-invalid', empty);
    if (empty) {
      el.setAttribute('aria-invalid', 'true');
      if (!first) first = el;
    } else {
      el.removeAttribute('aria-invalid');
    }
  });
  if (first) { try { first.focus(); } catch (e) { /* ignore */ } }
  return !!first;
}

function dockError(id, message) {
  if (message) dockErrorShow(id, message);
  else dockErrorClear(id);
}
