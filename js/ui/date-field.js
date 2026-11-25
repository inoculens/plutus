'use strict';
// Segmented date typing (record form and interval filter): caret-aware
// editing, arrow-key bumps and format-aware layout.

// Typing helpers for the date fields (record form + interval filter). The
// fields are plain text inputs (locale-proof, see above), so these reproduce
// the native date control's segment flow for whichever date format is saved
// in settings: click a segment and type — the caret advances to the next
// segment by itself; Up/Down bump the focused segment. Values are the field's
// own text, partial states included; storage stays ISO and submit still goes
// through parseDateInput.
function dateSpecOf(format) {
  var f = normalizeDateFormat(format === undefined ? activeDateFormat : format);
  var names = f.match(/YYYY|DD|MM|D|M/g);
  var seps = f.split(/YYYY|DD|MM|D|M/g).slice(1, 3);
  var tokens = names.map(function (n) {
    return {
      kind: n === 'YYYY' ? 'year' : (n === 'DD' || n === 'D' ? 'day' : 'month'),
      cap: n === 'YYYY' ? 4 : 2,
      flex: n === 'D' || n === 'M' // single-letter tokens take 1 or 2 digits
    };
  });
  return { format: f, tokens: tokens, seps: seps };
}

function dateSepKey(key, spec) {
  return typeof key === 'string' && key.length === 1 &&
    (key === spec.seps[0] || key === spec.seps[1] || key === '/' || key === '.' || key === '-');
}

// A segment is done when it is full — or, for the 1-or-2 digit D / M tokens,
// when its first digit already rules out a second one (day 4-9, month 2-9).
function dateSegDone(token, text) {
  if (text.length >= token.cap) return true;
  if (!token.flex || text.length !== 1) return false;
  var n = Number(text);
  return token.kind === 'day' ? n > 3 : (token.kind === 'month' ? n > 1 : false);
}

function dateFieldParts(value, spec) {
  var s = String(value === undefined || value === null ? '' : value).trim();
  var esc = function (c) { return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var t = spec.tokens;
  var re = new RegExp('^(\\d{0,' + t[0].cap + '})(?:' + esc(spec.seps[0]) +
    '(\\d{0,' + t[1].cap + '})(?:' + esc(spec.seps[1]) + '(\\d{0,' + t[2].cap + '}))?)?$');
  var m = re.exec(s);
  if (m) {
    var out = [(m[1] || '').slice(0, t[0].cap), (m[2] || '').slice(0, t[1].cap), (m[3] || '').slice(0, t[2].cap)];
    out.segs = m[3] !== undefined ? 3 : (m[2] !== undefined ? 2 : 1); // a typed trailing separator counts
    return out;
  }
  var total = t[0].cap + t[1].cap + t[2].cap;
  if (new RegExp('^\\d{1,' + total + '}$').test(s)) {
    return [s.slice(0, t[0].cap), s.slice(t[0].cap, t[0].cap + t[1].cap), s.slice(t[0].cap + t[1].cap, total)];
  }
  return null;
}

function dateFieldLayout(parts, spec) {
  var last = 0;
  for (var i = 0; i < 3; i++) if (parts[i]) last = i;
  if (!parts[0] && !parts[1] && !parts[2]) return { text: '', ranges: [[0, 0], [0, 0], [0, 0]] };
  last = Math.max(last, (parts.segs || 1) - 1);
  var text = '';
  var ranges = [];
  for (var j = 0; j <= last; j++) {
    ranges.push([text.length, text.length + parts[j].length]);
    text += parts[j];
    if (j < last) text += spec.seps[j];
  }
  while (ranges.length < 3) ranges.push([text.length, text.length]);
  return { text: text, ranges: ranges };
}

// Caret position → segment: inside a segment it stays there; exactly at a
// segment's end it moves on once that segment is done.
function dateSegmentAt(parts, ranges, pos, spec) {
  for (var i = 0; i < 3; i++) {
    if (pos < ranges[i][1]) return i;
    if (pos === ranges[i][1]) return dateSegDone(spec.tokens[i], parts[i]) ? Math.min(i + 1, 2) : i;
  }
  return 2;
}

function dateSegmentRange(value, pos, spec) {
  spec = spec || dateSpecOf();
  var parts = dateFieldParts(value, spec);
  if (!parts) return null;
  var layout = dateFieldLayout(parts, spec);
  var p = Math.max(0, Math.min(layout.text.length, Number(pos) || 0));
  var r = layout.ranges[dateSegmentAt(parts, layout.ranges, p, spec)];
  return { start: r[0], end: r[1] };
}

function dateFieldEdit(value, selStart, selEnd, key, spec) {
  spec = spec || dateSpecOf();
  if (typeof key !== 'string' || key === '') return null;
  var parts = dateFieldParts(value, spec);
  if (!parts) {
    // Non-date text: only a full selection + a digit can restart the field.
    var whole = String(value === undefined || value === null ? '' : value);
    if (/^\d$/.test(key) && Number(selStart) === 0 && Number(selEnd) === whole.length) {
      return { value: key, start: 1, end: 1 };
    }
    return null;
  }
  var layout = dateFieldLayout(parts, spec);
  var len = layout.text.length;
  var s = Math.max(0, Math.min(len, Number(selStart) || 0));
  var e = Math.max(0, Math.min(len, Number(selEnd) || 0));
  if (e < s) { var tmp = s; s = e; e = tmp; }
  var seg = dateSegmentAt(parts, layout.ranges, s, spec);
  var range = layout.ranges[seg];

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    var hop = key === 'ArrowRight' ? Math.min(seg + 1, 2) : Math.max(seg - 1, 0);
    var hr = layout.ranges[hop];
    return { value: layout.text, start: hr[0], end: hr[1] };
  }
  if (dateSepKey(key, spec)) {
    // The separator finishes the segment: it is spelled out in the text so
    // the next digit lands in the next segment, even after a single digit.
    var nextSeg = Math.min(seg + 1, 2);
    if (seg < 2 && parts[seg]) {
      parts.segs = Math.max(parts.segs || 1, nextSeg + 1);
      layout = dateFieldLayout(parts, spec);
    }
    var sr = layout.ranges[nextSeg];
    return { value: layout.text, start: sr[0], end: sr[1] };
  }
  if (key === 'Backspace' || key === 'Delete') {
    if (s === 0 && e === len && len > 0) { // select-all clears the whole field
      var lAll = dateFieldLayout(['', '', ''], spec);
      return { value: lAll.text, start: 0, end: 0 };
    }
    var cur = parts[seg];
    if (e > s) { // clear the selected span inside this segment
      var fSel = Math.max(0, s - range[0]);
      var tSel = Math.max(fSel, Math.min(cur.length, e - range[0]));
      parts[seg] = cur.slice(0, fSel) + cur.slice(tSel);
      var lSel = dateFieldLayout(parts, spec);
      var cSel = lSel.ranges[seg][0] + Math.min(fSel, parts[seg].length);
      return { value: lSel.text, start: cSel, end: cSel };
    }
    var off = Math.max(0, Math.min(cur.length, s - range[0]));
    if (key === 'Backspace') {
      if (off === 0) { // hop back a segment, never eat a separator
        var pb = layout.ranges[Math.max(seg - 1, 0)];
        return { value: layout.text, start: pb[0], end: pb[1] };
      }
      parts[seg] = cur.slice(0, off - 1) + cur.slice(off);
      var lB = dateFieldLayout(parts, spec);
      var cB = lB.ranges[seg][0] + (off - 1);
      return { value: lB.text, start: cB, end: cB };
    }
    if (off < cur.length) {
      parts[seg] = cur.slice(0, off) + cur.slice(off + 1);
      var lD = dateFieldLayout(parts, spec);
      var cD = lD.ranges[seg][0] + off;
      return { value: lD.text, start: cD, end: cD };
    }
    var pn = layout.ranges[Math.min(seg + 1, 2)];
    return { value: layout.text, start: pn[0], end: pn[1] };
  }
  if (!/^\d$/.test(key)) return null;

  // A typed digit replaces the selected span, or inserts at the caret; an
  // already-full segment starts over (native per-segment buffer). Finishing a
  // segment selects the next one, so typing just flows through the date.
  if (s === 0 && e === len && len > 0) {
    parts = ['', '', ''];
    layout = dateFieldLayout(parts, spec);
    seg = 0;
    s = 0;
    e = 0;
  }
  range = layout.ranges[seg];
  var token = spec.tokens[seg];
  var segText = parts[seg];
  var from = Math.max(0, Math.min(segText.length, s - range[0]));
  var to = Math.max(from, Math.min(segText.length, e - range[0]));
  var next;
  if (segText.length >= token.cap && from >= segText.length) next = key;
  else {
    next = segText.slice(0, from) + key + segText.slice(to);
    if (next.length > token.cap) next = next.slice(0, token.cap);
  }
  parts[seg] = next;
  var nl = dateFieldLayout(parts, spec);
  if (dateSegDone(token, next) && seg < 2) {
    var adv = nl.ranges[seg + 1];
    return { value: nl.text, start: adv[0], end: adv[1] };
  }
  var caret = nl.ranges[seg][0] + Math.min(from + 1, next.length);
  return { value: nl.text, start: caret, end: caret };
}

function dateDayMax(parts, spec) {
  var mm = NaN;
  var yy = NaN;
  var yLen = 0;
  spec.tokens.forEach(function (t, i) {
    if (t.kind === 'month') mm = parseInt(parts[i], 10);
    if (t.kind === 'year') { yy = parseInt(parts[i], 10); yLen = parts[i].length; }
  });
  if (mm >= 1 && mm <= 12 && yLen === 4 && !isNaN(yy)) {
    return new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  }
  return 31;
}

function dateFieldBump(value, selStart, selEnd, delta, spec) {
  spec = spec || dateSpecOf();
  var parts = dateFieldParts(value, spec);
  if (!parts || (delta !== 1 && delta !== -1)) return null;
  var layout = dateFieldLayout(parts, spec);
  var len = layout.text.length;
  var s = Math.max(0, Math.min(len, Number(selStart) || 0));
  var e = Math.max(0, Math.min(len, Number(selEnd) || 0));
  if (e < s) { var tmp = s; s = e; e = tmp; }
  var seg = dateSegmentAt(parts, layout.ranges, s, spec);
  var token = spec.tokens[seg];
  var cur = parseInt(parts[seg], 10);
  if (isNaN(cur)) cur = 0;
  var val;
  if (token.kind === 'day') val = Math.max(1, Math.min(dateDayMax(parts, spec), cur + delta));
  else if (token.kind === 'month') val = Math.max(1, Math.min(12, cur + delta));
  else if (!parts[seg].length) val = parseInt(todayStr().slice(0, 4), 10);
  else val = Math.max(1000, Math.min(9999, cur + delta));
  var pad = String(val);
  if (!token.flex) while (pad.length < token.cap) pad = '0' + pad;
  parts[seg] = pad;
  var nl = dateFieldLayout(parts, spec);
  var r = nl.ranges[seg];
  return { value: nl.text, start: r[0], end: r[1] };
}

// --- Date typing flow (record form + interval filter) ---
// The date fields are text inputs to stay locale-proof, so this restores what
// the native date control used to do: a click selects the segment under the
// pointer, typing fills it and advances to the next segment, arrows hop
// segments, Up/Down bump them, only digits and the format's separators are
// accepted, blur pads/normalises, and paste is normalised. The segment order
// and separators follow the saved date format; storage and submit stay ISO.
function wireDateInput(el) {
  if (!el || el.getAttribute('data-date-wired') === '1') return;
  el.setAttribute('data-date-wired', '1');
  function apply(out) {
    el.value = out.value;
    try { el.setSelectionRange(out.start, out.end); } catch (err) { /* ignore */ }
    // Programmatic edits fire no input event; listeners (the interval filter
    // draft) still need to see the new text.
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (err) { /* ignore */ }
  }
  function selectSegmentAt(pos) {
    var seg = dateSegmentRange(el.value, pos, dateSpecOf());
    if (seg) { try { el.setSelectionRange(seg.start, seg.end); } catch (err) { /* ignore */ } }
  }
  el.addEventListener('click', function () {
    selectSegmentAt(el.selectionStart === null || el.selectionStart === undefined ? 0 : el.selectionStart);
  });
  el.addEventListener('focus', function () {
    selectSegmentAt(el.selectionStart === null || el.selectionStart === undefined ? 0 : el.selectionStart);
  });
  el.addEventListener('keydown', function (ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var start = el.selectionStart;
    var end = el.selectionEnd;
    if (start === null || start === undefined || end === null || end === undefined) return;
    var spec = dateSpecOf();
    var key = ev.key;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      var b = dateFieldBump(el.value, start, end, key === 'ArrowUp' ? 1 : -1, spec);
      if (b) { ev.preventDefault(); apply(b); }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (ev.shiftKey) return; // keep native selection extension
      var h = dateFieldEdit(el.value, start, end, key, spec);
      if (h) { ev.preventDefault(); apply(h); }
      return;
    }
    if (key === 'Backspace' || key === 'Delete') {
      var d = dateFieldEdit(el.value, start, end, key, spec);
      if (d) { ev.preventDefault(); apply(d); }
      return;
    }
    if (key.length === 1) {
      if (/^\d$/.test(key) || dateSepKey(key, spec)) {
        var out = dateFieldEdit(el.value, start, end, key, spec);
        if (out) { ev.preventDefault(); apply(out); }
      } else if (!ev.isComposing) {
        ev.preventDefault(); // the date field takes digits and separators only
      }
    }
  });
  // Soft keyboards often report key as 'Unidentified' on keydown; beforeinput
  // still carries the real text and the deletion intent.
  el.addEventListener('beforeinput', function (ev) {
    var it = ev.inputType || '';
    var key = null;
    var spec = dateSpecOf();
    if (it === 'insertText') {
      if (typeof ev.data !== 'string' || ev.data === '') return;
      if (!/^\d$/.test(ev.data) && !dateSepKey(ev.data, spec)) { ev.preventDefault(); return; }
      key = ev.data;
    } else if (it === 'deleteContentBackward') key = 'Backspace';
    else if (it === 'deleteContentForward') key = 'Delete';
    else return;
    var start = el.selectionStart;
    var end = el.selectionEnd;
    if (start === null || start === undefined) return;
    var out = dateFieldEdit(el.value, start, end, key, spec);
    if (out) { ev.preventDefault(); apply(out); }
  });
  el.addEventListener('paste', function (ev) {
    var text = '';
    try { text = (ev.clipboardData && ev.clipboardData.getData) ? ev.clipboardData.getData('text') : ''; } catch (err) { text = ''; }
    var iso = parseDateInput(text);
    if (!iso) return;
    ev.preventDefault();
    el.value = fmtDateDmy(iso);
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (err) { /* ignore */ }
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (err) { /* ignore */ }
  });
  el.addEventListener('blur', function () {
    var iso = parseDateInput(el.value);
    if (iso) el.value = fmtDateDmy(iso);
  });
}

function syncDateFormatInputs() {
  var format = normalizeDateFormat(activeDateFormat);
  var input = document.getElementById('t-date');
  if (input) input.placeholder = format;
  var hint = document.getElementById('t-date-hint');
  if (hint) {
    if (hint.classList && hint.classList.contains('info-pill')) {
      hint.setAttribute('data-info', 'Format ' + format + '.');
      hint.setAttribute('aria-label', 'Format ' + format + '.');
    } else {
      hint.textContent = 'Format ' + format + '.';
    }
  }
  var from = document.querySelector('[data-date-filter-from]');
  var to = document.querySelector('[data-date-filter-to]');
  if (from) from.placeholder = format;
  if (to) to.placeholder = format;
}
