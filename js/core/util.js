'use strict';
// Small generic helpers shared by every layer (no DOM, no app state).

// Escape a value for use inside a double-quoted CSS attribute selector
// ([data-x="..."]). Stripping quotes changed the id (wrong match) and a
// backslash or newline could still break the selector.
function cssAttrValue(v) {
  return String(v).replace(/[\\"\n\r\f]/g, function (ch) {
    return ch === '\\' || ch === '"' ? '\\' + ch : '\\' + ch.charCodeAt(0).toString(16) + ' ';
  });
}

// Display-only cleanup for names that come from files, imports or sync:
// drops bidirectional overrides/isolates and control characters so a name
// cannot visually reorder itself (e.g. fake a file extension). Pure.
function safeDisplayName(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

// Prototype-less dictionary for maps keyed by user-controlled identifiers
// (account ids, trade ids, ledger codes). A plain {} resolves keys such as
// "__proto__", "constructor" or "toString" through Object.prototype, which
// silently drops entries and can write into the global prototype.
function dict() {
  return Object.create(null);
}

function cloneJson(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    var a = new Array(v.length);
    for (var i = 0; i < v.length; i++) a[i] = cloneJson(v[i]);
    return a;
  }
  var o = {};
  for (var k in v) {
    if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = cloneJson(v[k]);
  }
  return o;
}

function uid() {
  return 't' + Date.now().toString(36) + Math.floor(Math.random() * 0xffffff).toString(36);
}
