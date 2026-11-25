'use strict';
// Record form, attachment field: pending file, removal and what to save.

// Pending attachment for the open trade dialog: a newly picked File, a
// remove flag, and the metadata of the record being edited (if any).
var pendingAttachFile = null;
var pendingAttachRemove = false;
var currentAttachMeta = null;
var pendingAttachResolved = 'keep'; // 'keep' | null | {name,mime,size,hash}
function attUiSync() {
  try {
    var cur = document.getElementById('t-attach-cur');
    var rm = document.getElementById('t-attach-remove');
    var label = '';
    var removed = !pendingAttachFile && pendingAttachRemove;
    if (pendingAttachFile) label = 'New file: ' + pendingAttachFile.name;
    else if (removed) label = '✓ Removed — press "Save changes" to confirm.';
    else if (currentAttachMeta) label = 'Attached: ' + currentAttachMeta.name;
    if (cur) {
      cur.textContent = label;
      cur.hidden = !label;
      try { cur.style.color = removed ? 'var(--gain)' : ''; } catch (e) { /* ignore */ }
    }
    if (rm) rm.hidden = !(pendingAttachFile || currentAttachMeta);
  } catch (e) { /* never block the form */ }
}
function attReset(meta) {
  pendingAttachFile = null;
  pendingAttachRemove = false;
  currentAttachMeta = (meta && isValidAttachment(meta)) ? meta : null;
  pendingAttachResolved = 'keep';
  try { var inp = document.getElementById('t-attach'); if (inp) inp.value = ''; } catch (e) { /* ignore */ }
  attUiSync();
}
// Resolves the dialog attachment plan into metadata for the trade being
// saved: cb(err, meta|'keep'|null). New files are hashed + stored in
// IndexedDB first; removals delete best-effort; 'keep' preserves edits.
function attResolveForSave(cb) {
  if (pendingAttachFile) {
    var f = pendingAttachFile;
    if (ATTACH_MIMES.indexOf(f.type) === -1) { cb('Only PDF, PNG or JPG files can be attached.'); return; }
    if (!f.size || f.size > ATTACH_MAX_BYTES) { cb('File is too large — up to 10 MB.'); return; }
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var buf = rd.result;
        attHashBytes(buf).then(function (hash) {
          var meta = { name: String(f.name).slice(0, 120), mime: f.type, size: f.size, hash: hash };
          attPut(hash, new Blob([buf], { type: f.type }), meta).then(function (ok) {
            if (!ok) { cb('Could not store the file on this device — record was not saved.'); return; }
            cb(null, meta);
          });
        }, function () { cb('Could not read the file — record was not saved.'); });
      } catch (e) { cb('Could not read the file — record was not saved.'); }
    };
    rd.onerror = function () { cb('Could not read the file — record was not saved.'); };
    try { rd.readAsArrayBuffer(f); } catch (e) { cb('Could not read the file — record was not saved.'); }
    return;
  }
  if (pendingAttachRemove && currentAttachMeta) {
    // The blob is released by saveState() once the record is saved without it
    // (and only if no other record still uses the same file).
    cb(null, null);
    return;
  }
  cb(null, 'keep');
}
