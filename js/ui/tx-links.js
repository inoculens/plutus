'use strict';
// Transaction hashes on records: explorer links, short display and copy button.

function txExplorerUrl(txid) {
  return 'https://mempool.space/tx/' + encodeURIComponent(String(txid).trim());
}

function shortTxid(txid) {
  var s = String(txid).trim();
  if (s.length <= 20) return s;
  return s.slice(0, 8) + '…' + s.slice(-6);
}

// --- Copy to clipboard (tx hash copy on records) ---
// The async clipboard API first (https), a hidden textarea + execCommand
// fallback for file:// or locked-down contexts. Resolves true when the
// value was written, false when both paths fail.
function copyToClipLegacy(txt) {
  var s = String(txt);
  try {
    var ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}
function copyToClip(txt) {
  var s = String(txt);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(s).then(function () { return true; }, function () { return copyToClipLegacy(s); });
    }
  } catch (e) { /* fall through to legacy */ }
  return Promise.resolve(copyToClipLegacy(s));
}

// Circled copy glyph (feather-style rects) as an inline SVG: no asset, it
// dims next to the value and brightens on hover / for the copied ack.
var TX_COPY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function txCopyButton(txFull) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tx-copy';
  btn.title = 'Copy transaction ID';
  btn.setAttribute('aria-label', 'Copy transaction ID');
  btn.setAttribute('data-copy', txFull);
  btn.innerHTML = TX_COPY_SVG;
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var b = btn;
    Promise.resolve(copyToClip(txFull)).then(function (ok) {
      b.classList.add(ok ? 'copied' : 'copy-fail');
      b.title = ok ? 'Copied!' : 'Copy failed — select and copy the hash manually';
      setTimeout(function () {
        b.classList.remove('copied', 'copy-fail');
        b.title = 'Copy transaction ID';
      }, 1400);
    });
  });
  return btn;
}
