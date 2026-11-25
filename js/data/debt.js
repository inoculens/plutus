'use strict';
// Debt positions: manual reported-balance snapshots on an account.
// Validation, normalization and point-in-time balances. No interest math.

// A snapshot is the lender's total reported outstanding balance. There is
// deliberately no interest, APR, accrual, interpolation or event arithmetic.
function isValidDebtTimestamp(value) {
  // Persisted debt timestamps are ISO date-times, not Date.parse's permissive
  // free-form input. Reject impossible dates instead of normalizing Feb 30.
  if (typeof value !== 'string') return false;
  var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  var hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  var days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > days) return false;
  if (match[8] !== 'Z') {
    var offsetHour = Number(match[8].slice(1, 3));
    var offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return isFinite(Date.parse(value));
}

function isValidDebtId(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 128;
}

function isValidDebtSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  var allowed = Object.assign(Object.create(null), { id: true, amount: true, reportedAt: true, enteredAt: true, note: true });
  if (Object.keys(snapshot).some(function (key) { return !allowed[key]; })) return false;
  if (!isValidDebtId(snapshot.id) || typeof snapshot.amount !== 'number' ||
      !isFinite(snapshot.amount) || snapshot.amount < 0) return false;
  if (!isValidDebtTimestamp(snapshot.reportedAt) || !isValidDebtTimestamp(snapshot.enteredAt)) return false;
  if (snapshot.note !== undefined && snapshot.note !== null &&
      (typeof snapshot.note !== 'string' || snapshot.note.length > 280)) return false;
  return true;
}

function isValidDebtPosition(position, owningAccount, accounts) {
  if (!position || typeof position !== 'object' || Array.isArray(position)) return false;
  var allowed = Object.assign(Object.create(null), { id: true, name: true, assetKind: true, assetTicker: true, createdAt: true, balanceSnapshots: true, collateral: true, notes: true });
  if (Object.keys(position).some(function (key) { return !allowed[key]; })) return false;
  // Both identity fields absent identifies a legacy position; a partial pair is damage.
  var hasAssetKind = position.assetKind !== undefined && position.assetKind !== null;
  var hasAssetTicker = position.assetTicker !== undefined && position.assetTicker !== null;
  if (hasAssetKind !== hasAssetTicker) return false;
  if (hasAssetKind) {
    var assetKind = String(position.assetKind).trim().toLowerCase();
    var assetTicker = String(position.assetTicker).trim().toUpperCase();
    if (['crypto', 'stock', 'commodity', 'cash', 'custom'].indexOf(assetKind) === -1 || !/^[A-Z0-9._-]{1,12}$/.test(assetTicker)) return false;
  }
  if (!isValidDebtId(position.id) || typeof position.name !== 'string' ||
      position.name.trim() === '' || position.name.length > 120 ||
      !isValidDebtTimestamp(position.createdAt)) return false;
  if (!Array.isArray(position.balanceSnapshots) || position.balanceSnapshots.length < 1 ||
      position.balanceSnapshots.length > 5000) return false;
  var snapshotIds = Object.create(null);
  for (var si = 0; si < position.balanceSnapshots.length; si++) {
    var snapshot = position.balanceSnapshots[si];
    if (!isValidDebtSnapshot(snapshot) || snapshotIds[snapshot.id]) return false;
    snapshotIds[snapshot.id] = true;
  }
  if (position.notes !== undefined && position.notes !== null &&
      (typeof position.notes !== 'string' || position.notes.length > 280)) return false;
  if (position.collateral !== undefined && position.collateral !== null) {
    if (!Array.isArray(position.collateral) || position.collateral.length > 100) return false;
    var accountList = Array.isArray(accounts) ? accounts : (owningAccount ? [owningAccount] : []);
    var known = Object.create(null);
    accountList.forEach(function (account) {
      if (account && typeof account.id === 'string') known[account.id] = true;
    });
    var sourceIds = Object.create(null);
    for (var ci = 0; ci < position.collateral.length; ci++) {
      var allocation = position.collateral[ci];
      if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) return false;
      var allocationKeys = Object.keys(allocation);
      if (allocationKeys.some(function (key) { return key !== 'accountId' && key !== 'quantity'; })) return false;
      if (!isValidDebtId(allocation.accountId) || !known[allocation.accountId] ||
          sourceIds[allocation.accountId] || typeof allocation.quantity !== 'number' ||
          !isFinite(allocation.quantity) || allocation.quantity <= 0) return false;
      sourceIds[allocation.accountId] = true;
    }
  }
  return true;
}

function isValidDebtPositions(account, accounts) {
  if (!account || typeof account !== 'object') return false;
  if (account.debtPositions === undefined || account.debtPositions === null) return true;
  if (!Array.isArray(account.debtPositions) || account.debtPositions.length > 500) return false;
  var ids = Object.create(null);
  for (var i = 0; i < account.debtPositions.length; i++) {
    var position = account.debtPositions[i];
    if (!isValidDebtPosition(position, account, accounts) || ids[position.id]) return false;
    ids[position.id] = true;
  }
  return true;
}

function normalizeDebtPosition(position, owningAccount) {
  var snapshots = position.balanceSnapshots.map(function (snapshot, index) {
    return {
      id: snapshot.id,
      amount: Number(snapshot.amount),
      reportedAt: snapshot.reportedAt,
      enteredAt: snapshot.enteredAt,
      note: (typeof snapshot.note === 'string' && snapshot.note !== '') ? snapshot.note : undefined,
      _order: index
    };
  });
  snapshots.sort(function (a, b) {
    var delta = Date.parse(a.reportedAt) - Date.parse(b.reportedAt);
    return delta || a._order - b._order;
  });
  snapshots = snapshots.map(function (snapshot) {
    return {
      id: snapshot.id,
      amount: snapshot.amount,
      reportedAt: snapshot.reportedAt,
      enteredAt: snapshot.enteredAt,
      note: snapshot.note
    };
  });
  var out = {
    id: position.id,
    name: position.name.trim(),
    assetKind: String(position.assetKind || (owningAccount && owningAccount.kind) || 'crypto').trim().toLowerCase(),
    assetTicker: String(position.assetTicker || (owningAccount && owningAccount.ticker) || '').trim().toUpperCase(),
    createdAt: position.createdAt,
    balanceSnapshots: snapshots
  };
  if (Array.isArray(position.collateral) && position.collateral.length) {
    out.collateral = position.collateral.map(function (allocation) {
      return { accountId: allocation.accountId, quantity: Number(allocation.quantity) };
    });
  }
  if (typeof position.notes === 'string' && position.notes !== '') out.notes = position.notes;
  return out;
}

function latestDebtBalanceSnapshot(position, asOf) {
  if (!position || !Array.isArray(position.balanceSnapshots)) return null;
  var cutoff = (asOf === undefined || asOf === null) ? Infinity :
    (typeof asOf === 'number' ? asOf : Date.parse(asOf));
  if (!isFinite(cutoff) && cutoff !== Infinity) return null;
  var latest = null;
  var latestAt = -Infinity;
  position.balanceSnapshots.forEach(function (snapshot, index) {
    if (!snapshot || !isValidDebtTimestamp(snapshot.reportedAt)) return;
    var at = Date.parse(snapshot.reportedAt);
    if (at <= cutoff && (at > latestAt || at === latestAt)) {
      latest = snapshot;
      latestAt = at;
    }
  });
  return latest;
}

function debtPositionBalanceAt(position, asOf) {
  var snapshot = latestDebtBalanceSnapshot(position, asOf);
  return snapshot ? { amount: Number(snapshot.amount), snapshot: snapshot } : null;
}

function accountDebtBalanceAt(account, asOf, assetKind, assetTicker) {
  var total = 0;
  var identities = Object.create(null);
  var positions = accountDebtPositions(account);
  positions.forEach(function (position) {
    var kind = String(position.assetKind || (account && account.kind) || 'crypto').trim().toLowerCase();
    var ticker = String(position.assetTicker || (account && account.ticker) || '').trim().toUpperCase();
    if (assetKind && kind !== String(assetKind).trim().toLowerCase()) return;
    if (assetTicker && ticker !== String(assetTicker).trim().toUpperCase()) return;
    identities[kind + ':' + ticker] = true;
    var result = debtPositionBalanceAt(position, asOf);
    if (result && isFinite(result.amount)) total += result.amount;
  });
  if (Object.keys(identities).length > 1) return null;
  return total;
}

function formatDebtPositionAmount(amount, position) {
  var ticker = String(position && position.assetTicker || '').trim().toUpperCase();
  var kind = String(position && position.assetKind || 'crypto').trim().toLowerCase();
  return isCashKind(kind) ? fmtMoney(amount, ticker) : fmtQty(amount, ticker) + ' ' + ticker;
}

function accountDebtPositions(account) {
  return (account && Array.isArray(account.debtPositions)) ? account.debtPositions : [];
}

// Debt dependency guard for every account-delete path (single and bulk).
// Returns '' when the ids may be deleted, else the calm banner sentence.
// An account that owns debt positions, or that an open position references
// as collateral, is never deleted: a dangling collateral id would make the
// owner's whole debtPositions list invalid on the next load.
function debtAccountDeleteBlock(st, ids) {
  var deleting = Object.create(null);
  (ids || []).forEach(function (accountId) {
    if (typeof accountId === 'string' && accountId !== '') deleting[accountId] = true;
  });
  var accounts = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  var ownsDebt = accounts.some(function (owner) {
    return !!owner && deleting[owner.id] === true && accountDebtPositions(owner).length > 0;
  });
  if (ownsDebt) {
    return 'This account still owns debt positions. Remove or resolve them before deleting the account.';
  }
  var referenced = accounts.some(function (owner) {
    return accountDebtPositions(owner).some(function (position) {
      return Array.isArray(position.collateral) && position.collateral.some(function (allocation) {
        return !!allocation && deleting[allocation.accountId] === true;
      });
    });
  });
  if (referenced) {
    return 'This account is referenced as collateral by an open debt position. Remove that collateral reference before deleting the account.';
  }
  return '';
}
