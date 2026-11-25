'use strict';
// Sync: small pure codecs (no atob/TextEncoder dependency).

var SYNC_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function syncB64encode(bytes) {
  var s = '';
  var i, a, b, c;
  for (i = 0; i < bytes.length; i += 3) {
    a = bytes[i] & 255;
    b = (i + 1 < bytes.length) ? (bytes[i + 1] & 255) : 0;
    c = (i + 2 < bytes.length) ? (bytes[i + 2] & 255) : 0;
    s += SYNC_B64.charAt(a >> 2);
    s += SYNC_B64.charAt(((a & 3) << 4) | (b >> 4));
    s += (i + 1 < bytes.length) ? SYNC_B64.charAt(((b & 15) << 2) | (c >> 6)) : '=';
    s += (i + 2 < bytes.length) ? SYNC_B64.charAt(c & 63) : '=';
  }
  return s;
}

function syncB64decode(str) {
  var clean = String(str).replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0) throw new Error('sync failed: bad base64 length.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('sync failed: bad base64 data.');
  var padAt = clean.indexOf('=');
  if (padAt !== -1 && padAt < clean.length - 2) throw new Error('sync failed: bad base64 padding.');
  var out = [];
  var i, e1, e2, e3, e4, triple;
  var c3, c4;
  for (i = 0; i < clean.length; i += 4) {
    e1 = SYNC_B64.indexOf(clean.charAt(i));
    e2 = SYNC_B64.indexOf(clean.charAt(i + 1));
    c3 = clean.charAt(i + 2);
    c4 = clean.charAt(i + 3);
    e3 = (c3 === '=') ? -1 : SYNC_B64.indexOf(c3);
    e4 = (c4 === '=') ? -1 : SYNC_B64.indexOf(c4);
    if (e1 < 0 || e2 < 0 || (c3 !== '=' && e3 < 0) || (c4 !== '=' && e4 < 0)) {
      throw new Error('sync failed: bad base64 data.');
    }
    triple = (e1 << 18) | (e2 << 12) | ((e3 < 0 ? 0 : e3) << 6) | (e4 < 0 ? 0 : e4);
    out.push((triple >> 16) & 255);
    if (e3 >= 0) out.push((triple >> 8) & 255);
    if (e4 >= 0) out.push(triple & 255);
  }
  return new Uint8Array(out);
}

function syncB64UrlEncode(bytes) {
  return syncB64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function syncHex(bytes) {
  var s = '';
  var i;
  for (i = 0; i < bytes.length; i++) {
    s += (bytes[i] < 16 ? '0' : '') + (bytes[i] & 255).toString(16);
  }
  return s;
}

function syncUtf8Encode(str) {
  var s = String(str);
  var out = [];
  var i, c, lo, cp;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      lo = s.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        cp = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
        continue;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function syncUtf8Decode(bytes) {
  var s = '';
  var i = 0;
  var b1, b2, b3, b4, cp;
  while (i < bytes.length) {
    b1 = bytes[i++] & 255;
    if (b1 < 0x80) {
      s += String.fromCharCode(b1);
    } else if ((b1 & 0xE0) === 0xC0) {
      b2 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      s += String.fromCharCode(((b1 & 31) << 6) | (b2 & 63));
    } else if ((b1 & 0xF0) === 0xE0) {
      b2 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      b3 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      s += String.fromCharCode(((b1 & 15) << 12) | ((b2 & 63) << 6) | (b3 & 63));
    } else {
      b2 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      b3 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      b4 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      cp = (((b1 & 7) << 18) | ((b2 & 63) << 12) | ((b3 & 63) << 6) | (b4 & 63)) - 0x10000;
      s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
    }
  }
  return s;
}
