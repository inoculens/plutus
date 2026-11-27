'use strict';
// Inline rename of accounts and ledger labels.

function startInlineRename(accId, headEl, nameEl) {
  var st = loadState();
  var acc = accountById(st, accId);
  if (!acc || !headEl || !nameEl) return;
  if (headEl.querySelector('[data-rename-input]')) return;
  var input = document.createElement('input');
  input.setAttribute('data-rename-input', '1');
  input.value = acc.name;
  input.setAttribute('aria-label', 'New name for ' + acc.name);
  headEl.insertBefore(input, nameEl);
  headEl.removeChild(nameEl);
  try { input.focus(); input.select(); } catch (e) { /* ignore */ }
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    renameAccount(accId, input.value);
  }
  function cancel() {
    if (done) return;
    done = true;
    render();
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

// Label (stored as `address`): capped, with a characters-left counter.
function startInlineLabelEdit(accId) {
  startInlineMetaEdit(accId, {
    field: 'address',
    rowLabel: 'Label',
    max: ACCOUNT_LABEL_MAX,
    rows: 3,
    inputAttr: 'data-label-input',
    ariaPrefix: 'Label for ',
    placeholder: function (acc) { return accountKindExample(acc.kind, 'label'); }
  });
}

// Description: uncapped free text about the account.
function startInlineDescriptionEdit(accId) {
  startInlineMetaEdit(accId, {
    field: 'description',
    rowLabel: 'Description',
    max: 0,
    rows: 6,
    inputAttr: 'data-description-input',
    ariaPrefix: 'Description for ',
    placeholder: function () { return 'Anything worth knowing about this account: what it is for, where it is held, who manages it…'; }
  });
}

// Edits one free-text account field in place of its row in the header's
// meta block (other rows stay visible). cfg.max > 0 caps the text and shows
// the counter; 0 means no cap.
function startInlineMetaEdit(accId, cfg) {
  var st = loadState();
  var acc = accountById(st, accId);
  if (!acc) return;
  var host = document.getElementById('account-detail');
  if (!host || !host.querySelector) return;
  var block = host.querySelector('.detail-meta-block');
  var headEl = host.querySelector('.detail-head');
  if (!block && headEl) {
    block = document.createElement('div');
    block.className = 'detail-meta-block';
    headEl.appendChild(block);
  }
  if (!block || block.querySelector('[data-meta-editor]')) return;
  var editor = document.createElement('div');
  editor.className = 'meta-editor';
  editor.setAttribute('data-meta-editor', cfg.field);
  var input = document.createElement('textarea');
  input.setAttribute(cfg.inputAttr, '1');
  input.value = typeof acc[cfg.field] === 'string' ? acc[cfg.field] : '';
  input.setAttribute('aria-label', cfg.ariaPrefix + acc.name);
  if (cfg.max > 0) input.setAttribute('maxlength', String(cfg.max));
  input.setAttribute('rows', String(cfg.rows));
  input.setAttribute('placeholder', cfg.placeholder(acc));
  input.setAttribute('autocomplete', 'off');
  var row = document.createElement('div');
  row.className = 'label-edit-row';
  var save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Save';
  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  row.appendChild(save);
  row.appendChild(cancelBtn);
  // Characters left, post-composer style, at the end of the action row.
  if (cfg.max > 0) row.appendChild(attachCharCounter(input, cfg.max).el);
  editor.appendChild(input);
  editor.appendChild(row);
  // Take the field's own row; a new field sits in display order
  // (Label, Description, Note).
  var own = block.querySelector('.detail-meta[data-label="' + cfg.rowLabel + '"]');
  if (own) block.replaceChild(editor, own);
  else {
    var next = cfg.field === 'address' ? block.firstChild
      : block.querySelector('.detail-meta[data-label="Note"]');
    block.insertBefore(editor, next || null);
  }
  try { input.focus(); input.select(); } catch (e) { /* ignore */ }
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    var s2 = loadState();
    var a2 = accountById(s2, accId);
    if (!a2) return;
    var v = String(input.value === undefined || input.value === null ? '' : input.value).trim();
    if (cfg.max > 0) v = v.slice(0, cfg.max);
    if (v) a2[cfg.field] = v;
    else {
      try {
        delete a2[cfg.field];
      } catch (e) {
        a2[cfg.field] = undefined;
      }
    }
    if (!saveStateGuarded(s2)) { done = false; return; }
    clearBanner();
    render();
  }
  function cancelFn() {
    if (done) return;
    done = true;
    render();
  }
  save.addEventListener('click', commit);
  // Mousedown first: keep focus so blur-commit doesn't fire before Cancel.
  cancelBtn.addEventListener('mousedown', function (e) { if (e && e.preventDefault) e.preventDefault(); });
  cancelBtn.addEventListener('click', cancelFn);
  input.addEventListener('keydown', function (e) {
    // Plain Enter inserts a newline (multi-line text); Ctrl/Cmd+Enter saves.
    if ((e.key === 'Enter') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') cancelFn();
  });
  input.addEventListener('blur', commit);
}
