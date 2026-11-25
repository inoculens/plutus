'use strict';
// Group dialog: put accounts under a main account.

// Group dialog: pick the main account for the selected accounts, or create
// a new one (full account creation, grouped on success via pendingGroupIds).
var groupDialogIds = null;
var pendingGroupIds = null;

function buildGroupDialog() {
  var host = document.getElementById('group-dialog-body');
  if (!host || document.getElementById('g-save')) return;
  wireDialog('group-dialog');
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<p class="muted" id="g-count"></p>' +
    '<label for="g-target">Main account</label>' +
    '<select id="g-target"></select>' +
    dockMarkup('g-error', 'Group', 'g-save', 'button');
  host.appendChild(wrap);
  document.getElementById('g-save').addEventListener('click', function () {
    function fail(msg) { dockError('g-error', msg); }
    dockError('g-error', '');
    var target = uiVal('g-target', '');
    if (!target) { fail('Pick a main account.'); return; }
    if (target === '__new') {
      pendingGroupIds = (groupDialogIds || []).slice();
      groupDialogIds = null;
      closeDialog('group-dialog');
      openAccountDialog();
      return;
    }
    var st = loadState();
    var gerr = assignGroup(st, groupDialogIds || [], target);
    if (gerr) { fail(gerr); return; }
    if (!saveStateGuarded(st)) { fail('Storage unavailable — accounts were not grouped.'); return; }
    groupDialogIds = null;
    selectedAccounts = {};
    selectionMode = false;
    closeDialog('group-dialog');
    clearBanner();
    navTo(target);
    render();
  });
}

function openGroupDialog(ids) {
  groupDialogIds = (ids || []).slice();
  buildGroupDialog();
  var st = loadState();
  var inSel = {};
  groupDialogIds.forEach(function (id) { inSel[id] = true; });
  var sel = document.getElementById('g-target');
  if (sel) {
    sel.innerHTML = '';
    (st.accounts || []).forEach(function (a) {
      if (!a || !a.id || inSel[a.id]) return;
      if (groupMainOf(st, a.id)) return; // grouped members can't be mains
      var op = document.createElement('option');
      op.value = a.id;
      op.textContent = a.name + ' (' + String(a.ticker).toUpperCase() + ')';
      sel.appendChild(op);
    });
    var nw = document.createElement('option');
    nw.value = '__new';
    nw.textContent = '＋ Create new main account';
    sel.appendChild(nw);
    sel.value = sel.options.length > 1 ? sel.options[0].value : '__new';
  }
  var count = document.getElementById('g-count');
  if (count) count.textContent = 'Group ' + groupDialogIds.length + ' account' + (groupDialogIds.length === 1 ? '' : 's') + ' under:';
  dockError('g-error', '');
  openDialog('group-dialog');
}
