'use strict';
// Date-time fields wear the select chevron (css/dialogs.css). Chromium opens
// its picker from an invisible native button laid over the chevron; engines
// without that button (Safari) would draw a chevron that does nothing, so a
// click on it opens the picker here. Firefox draws its own calendar button,
// which works, and gets no chevron at all (the CSS leaves it out there).
var dateTimePickersWired = false;

function dateTimePickerOpen(input) {
  try { return input.matches(':open'); } catch (e) { return false; }
}

// Delegated, so it covers every datetime-local field, including the ones
// dialogs build later.
function wireDateTimePickers() {
  if (dateTimePickersWired || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  dateTimePickersWired = true;
  document.addEventListener('click', function (e) {
    var input = e && e.target;
    if (!input || input.tagName !== 'INPUT' || input.type !== 'datetime-local' || input.disabled || input.readOnly) return;
    if (typeof input.showPicker !== 'function' || typeof getComputedStyle !== 'function') return;
    var style = getComputedStyle(input);
    // Only where the chevron is drawn (not Firefox), and only on it.
    if (!style.backgroundImage || style.backgroundImage === 'none') return;
    var zone = Math.max(parseFloat(style.paddingRight) || 0, 24);
    if (e.clientX < input.getBoundingClientRect().right - zone) return;
    if (dateTimePickerOpen(input)) return; // Chromium's own button already opened it
    try { input.showPicker(); } catch (err) { try { input.focus(); } catch (e2) { /* ignore */ } }
  });
}
