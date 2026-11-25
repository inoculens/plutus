'use strict';
// Calendar dates: ISO validation, "future" checks, the user's display format
// (DD/MM/YYYY presets) and conversion between display text and stored ISO.

var DEFAULT_DATE_FORMAT = 'DD/MM/YYYY';
var DATE_FORMAT_PRESETS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY/MM/DD', 'YYYY-MM-DD'];
var activeDateFormat = DEFAULT_DATE_FORMAT;

function isValidDateFormat(format) {
  if (typeof format !== 'string') return false;
  var tokens = format.match(/YYYY|DD|MM|D|M/g);
  if (!tokens || tokens.length !== 3) return false;
  var seen = {};
  tokens.forEach(function (token) {
    var part = token === 'D' || token === 'DD' ? 'day' : (token === 'M' || token === 'MM' ? 'month' : 'year');
    seen[part] = (seen[part] || 0) + 1;
  });
  if (seen.day !== 1 || seen.month !== 1 || seen.year !== 1) return false;
  var separators = format.split(/YYYY|DD|MM|D|M/g);
  if (separators.length !== 4 || separators[0] !== '' || separators[3] !== '') return false;
  return separators[1].length === 1 && separators[2].length === 1 &&
    /^[./ -]$/.test(separators[1]) && /^[./ -]$/.test(separators[2]);
}

function normalizeDateFormat(format) {
  return isValidDateFormat(format) ? format : DEFAULT_DATE_FORMAT;
}

// Pure and called for every record on every paint (ledger runs, holding
// periods, price lookups), so answers are memoized (bounded).
var validDateMemo = new Map();

function isValidDateStr(d) {
  if (typeof d !== 'string') return false;
  var known = validDateMemo.get(d);
  if (known !== undefined) return known;
  var ok = checkDateStr(d);
  if (validDateMemo.size >= 4096) validDateMemo.clear();
  validDateMemo.set(d, ok);
  return ok;
}

function checkDateStr(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  var p = d.slice(0, 10).split('-');
  var y = Number(p[0]);
  var m = Number(p[1]);
  var day = Number(p[2]);
  if (!isFinite(y) || !isFinite(m) || !isFinite(day)) return false;
  if (m < 1 || m > 12 || day < 1 || day > 31) return false;
  var t = Date.UTC(y, m - 1, day);
  if (!isFinite(t)) return false;
  var chk = new Date(t);
  return chk.getUTCFullYear() === y && (chk.getUTCMonth() + 1) === m && chk.getUTCDate() === day;
}

function isFutureDateStr(d) {
  if (!isValidDateStr(d)) return false;
  var n = new Date();
  var mm = n.getMonth() + 1;
  var dd = n.getDate();
  var today = n.getFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
  return d.slice(0, 10) > today;
}

// Persisted records are stored with the calendar date of the device that
// created them. A device in a timezone behind that one sees the same date as
// "tomorrow", so the strict local check above must never gate stored,
// imported, exported or synced data. A date is rejected there only when it is
// later than today in UTC+14, the furthest-ahead timezone on Earth (the
// latest calendar date that exists anywhere right now). The strict
// isFutureDateStr stays in use for dates typed into the record form.
// Called once per record during validation, so the answer is memoized until
// the exact instant it changes (the next UTC midnight in UTC+14).
var maxDateAnywhereMemo = { value: '', until: 0 };
function maxCalendarDateAnywhere() {
  var shifted = Date.now() + 14 * 3600000;
  if (shifted >= maxDateAnywhereMemo.until || shifted < maxDateAnywhereMemo.until - 86400000) {
    maxDateAnywhereMemo.value = new Date(shifted).toISOString().slice(0, 10);
    maxDateAnywhereMemo.until = (Math.floor(shifted / 86400000) + 1) * 86400000;
  }
  return maxDateAnywhereMemo.value;
}

function isFutureEverywhereDateStr(d) {
  if (!isValidDateStr(d)) return false;
  return d.slice(0, 10) > maxCalendarDateAnywhere();
}

function todayStr() {
  // Local calendar date (user-facing default + date max), matching the
  // local-based download filename. Pure FX calendar math (fxShiftDate,
  // ledgerHoldingDays) intentionally stays on UTC date arithmetic.
  var n = new Date();
  var m = n.getMonth() + 1;
  var d = n.getDate();
  return n.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

// Storage stays ISO YYYY-MM-DD. User-visible dates follow the saved format,
// independent of the device locale.
function fmtDateDmy(d) {
  if (d === undefined || d === null) return '';
  var s = String(d).trim();
  if (!s) return '';
  var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!iso) {
    var parsed = parseDateInput(s);
    if (!parsed) return s;
    iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parsed);
  }
  var values = { YYYY: iso[1], MM: iso[2], M: String(Number(iso[2])), DD: iso[3], D: String(Number(iso[3])) };
  return normalizeDateFormat(activeDateFormat).replace(/YYYY|DD|MM|D|M/g, function (token) { return values[token]; });
}

function parseDateInput(s) {
  if (typeof s !== 'string') return null;
  var v = s.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return isValidDateStr(v) ? v : null;
  var format = normalizeDateFormat(activeDateFormat);
  var tokens = format.match(/YYYY|DD|MM|D|M/g);
  var separators = format.split(/YYYY|DD|MM|D|M/g);
  var pattern = '^';
  tokens.forEach(function (token, i) {
    pattern += '(' + (token === 'YYYY' ? '\\d{4}' : '\\d{1,2}') + ')';
    if (i < separators.length - 1) pattern += separators[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  pattern += '$';
  var match = new RegExp(pattern).exec(v);
  if (!match && tokens.every(function (token) { return token !== 'D' && token !== 'M'; })) {
    var compactPattern = '^' + tokens.map(function (token) {
      return '(\\d{' + (token === 'YYYY' ? '4' : '2') + '})';
    }).join('') + '$';
    match = new RegExp(compactPattern).exec(v);
  }
  if (!match) return null;
  var values = {};
  tokens.forEach(function (token, i) { values[token] = match[i + 1]; });
  var month = String(values.MM || values.M);
  var day = String(values.DD || values.D);
  if (month.length < 2) month = '0' + month;
  if (day.length < 2) day = '0' + day;
  var iso = values.YYYY + '-' + month + '-' + day;
  return isValidDateStr(iso) ? iso : null;
}

function todayDmy() {
  return fmtDateDmy(todayStr());
}

function fmtDateTimeDmy(iso) {
  try {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return String(iso);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    var day = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
    return fmtDateDmy(day) +
      ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' UTC';
  } catch (e) { return String(iso); }
}
