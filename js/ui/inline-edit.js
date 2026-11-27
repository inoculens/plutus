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

function startInlineLabelEdit(accId) {
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
  if (!block || block.querySelector('[data-label-input]')) return;
  block.innerHTML = '';
  var input = document.createElement('textarea');
  input.setAttribute('data-label-input', '1');
  input.value = acc.address || '';
  input.setAttribute('aria-label', 'Label for ' + acc.name);
  input.setAttribute('maxlength', String(ACCOUNT_LABEL_MAX));
  input.setAttribute('rows', '3');
  input.setAttribute('placeholder', accountKindExample(acc.kind, 'label'));
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
  row.appendChild(attachCharCounter(input, ACCOUNT_LABEL_MAX).el);
  block.appendChild(input);
  block.appendChild(row);
  try { input.focus(); input.select(); } catch (e) { /* ignore */ }
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    var s2 = loadState();
    var a2 = accountById(s2, accId);
    if (!a2) return;
    var v = String(input.value === undefined || input.value === null ? '' : input.value).trim().slice(0, ACCOUNT_LABEL_MAX);
    if (v) a2.address = v;
    else {
      try {
        delete a2.address;
      } catch (e) {
        a2.address = undefined;
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
    // Plain Enter inserts a newline (multi-line label); Ctrl/Cmd+Enter saves.
    if ((e.key === 'Enter') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') cancelFn();
  });
  input.addEventListener('blur', commit);
}
