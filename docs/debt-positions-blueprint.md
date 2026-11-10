# INOCULENS PLUTUS — Debt Positions & Liabilities Blueprint

**Status:** Corrected implementation blueprint  
**Target branch:** developing only  
**Scope:** Account-scoped liabilities, manual balance snapshots, multi-account collateral references, and net-worth integration.

> **Core correction:** Plutus does not calculate or accrue interest. The user enters the total outstanding balance reported by the lender/protocol at a particular point in time. Plutus keeps displaying that last reported amount until another snapshot is entered. A stale balance is preferable to an invented estimate.

## 1. Product decisions and invariants

### 1.1 Ownership and denomination are separate
- Accounts remain single-asset containers. A debt position is nested under an owning account for organization, account-detail display, grouping, filtering, and ownership; it does **not** inherit that account's asset denomination.
- Every new debt position stores its own `assetKind` and `assetTicker`, selected independently from the owning account. The supported kinds are `crypto`, `stock`, `commodity`, `cash` (fiat), and `custom`.
- The default for a new position may be the owner's kind and ticker for convenience, but the user can choose any other supported kind/ticker. Examples: EUR or USD debt in a BTC account; BTC debt in an EUR account; gold debt in a stock account; stock debt in a fiat account.
- The denomination is immutable after creation because every snapshot amount is expressed in that unit. To track a different denomination, create a separate position rather than reinterpreting existing snapshots.
- Holdings/trades and liabilities remain separate. An account may have no holdings and still own debt.
- Never introduce mixed-asset accounts, placeholder parent accounts, or synthetic debt subaccounts.

### 1.2 Collateral is a reference, not another liability
- One debt position may reference multiple collateral-source accounts, including accounts of different asset kinds.
- Each allocation identifies its source account and, where tracked, the quantity pledged in that account's own units.
- Collateral remains owned in its source account and remains included in gross assets/net worth. A pledge must not reduce source quantity, market value, FIFO lots, or cost basis.
- The liability is counted exactly once, in the account that owns the debt position.
- Collateral links are informational. This feature does not lock, move, liquidate, or enforce collateral.

### 1.3 The balance is always manually reported
- The user enters the total outstanding balance shown by the lender/protocol, plus the date and time that balance was observed.
- The current debt is the latest reported snapshot. It remains unchanged until another snapshot is entered.
- Plutus must not calculate, accrue, estimate, interpolate, compound, forecast, or otherwise derive interest or an in-between balance.
- There is no APR field, rate history, per-minute timer, synthetic interest transaction, or automatic balance growth.
- AAVE example: if the user enters 1,000.00 USDC at 10:00, Plutus still shows 1,000.00 at 10:01 even if AAVE now reports 1,000.01. If the user later enters 1,001.40 at noon, that new snapshot becomes current.
- Increases and decreases are both new total-balance snapshots. Their cause (interest, new borrowing, repayment, correction, etc.) may be written in an optional note, but Plutus does not interpret the note or calculate a delta.
- Always show the latest snapshot's reported-at timestamp. Do not invent a stale threshold or silently adjust the amount.

## 2. User experience

### 2.1 Account detail
Add a collapsible **Debt positions** section immediately after the existing main account panel and before ledgers/records.
- Show positions owned by the account. For grouped views, show member-owned positions under their real owning account and count each only once.
- Each position shows its name, last reported outstanding balance in the position's own asset/fiat unit, and reported-at timestamp.
- Make clear that the amount is the last reported value, not a continuously updated estimate.
- Expand to show balance-snapshot history, notes, and linked collateral accounts/pledged quantities.
- Provide actions to add a position and enter a new balance snapshot.
- Each balance-history entry can be corrected in place or removed on its own; a position always keeps at least one report. Correcting or removing one entry never rewrites the position's other snapshots or its denomination.
- Preserve history when the balance reaches zero; do not silently delete paid-off positions.
- Creating a position captures a name, denomination (`assetKind` + `assetTicker`), and initial reported balance/time. The denomination defaults to the owner but is selectable independently. Collateral is optional and may include multiple accounts.
- When updating a position, preserve its denomination; only the name, snapshot, notes, and collateral may change.
- Updating a position asks for the new total outstanding balance, not a repayment/interest delta. The user may also set the observation time and add a note.

### 2.2 Account and home values
- Account net value reflects gross assets less the value of every liability position owned by that account, with each liability converted from its own denomination into the selected main currency.
- Show gross holdings, debt, and net value as distinct concepts in account detail.
- Account cards may show net worth and a subtle debt indicator while keeping the home structure minimal.
- Debt-only accounts remain visible even without trades or holdings.
- Negative net worth is valid and must not be clamped to zero.
- Portfolio totals are the sum of per-account net-worth results. Collateral accounts retain their gross asset values.

### 2.3 Precision and freshness
- Use the debt position's own asset precision/formatting, based on `assetKind` + `assetTicker`.
- Show the latest snapshot's reported-at timestamp; optionally also show when it was entered into Plutus, without confusing the two.
- Do not display APR, interest estimates, projected balances, or fabricated precision.
- A zero snapshot is valid and represents a paid-off position; retain its history.

## 3. Data model

Store positions as an optional nested property of their owning account so ownership and liability identity are unambiguous and the existing top-level export envelope remains unchanged.

Illustrative shape:

    account.debtPositions = [{
      id: 'debt_<stable-id>',
      name: 'AAVE USDC borrow',
      assetKind: 'crypto',
      assetTicker: 'USDC',
      createdAt: '2026-11-10T08:00:00.000Z',
      balanceSnapshots: [{
        id: 'snapshot_<stable-id>',
        amount: 1000,
        reportedAt: '2026-11-10T08:00:00.000Z',
        enteredAt: '2026-11-10T08:02:00.000Z',
        note: 'AAVE app balance'
      }],
      collateral: [
        { accountId: 'btc-account-id', quantity: 0.05 },
        { accountId: 'xau-account-id', quantity: 2 }
      ],
      notes: ''
    }];

Rules:
- The owning account ID is the source of truth for ownership and scope. Each position's `assetKind` + `assetTicker` are the source of truth for its liability denomination.
- Every new position must contain both `assetKind` and `assetTicker`. For backward compatibility, a legacy position with neither field is normalized once using its current owning account's kind/ticker; a partial or malformed identity is rejected. Existing snapshot amounts are never converted or rewritten during this migration.
- Snapshot amount is the total balance reported by the lender in that position's asset/fiat unit, not an amount to add/subtract. It must be finite and non-negative; zero is valid.
- A new position requires an initial snapshot; never assume an unknown opening balance.
- reportedAt is when the external amount was observed. enteredAt is when it was saved in Plutus. Historical net worth uses reportedAt.
- Snapshot IDs are stable and unique; timestamps must be valid. Sort effective snapshots by reportedAt and use stable stored order as a tie-breaker for equal timestamps.
- Notes are optional bounded strings and never affect calculations.
- Collateral IDs must resolve to existing accounts. Pledged quantities are positive, finite, and in the referenced account's units. Multiple sources and unsecured positions are allowed.
- Do not store a duplicate current balance, APR, rate history, computed accrual, or event deltas.
- Never mutate holdings or trade records when recording debt.

Current outstanding amount is a pure lookup: return the latest snapshot with reportedAt at or before the requested as-of time. Before the first snapshot, the liability is absent; between snapshots, the previous reported amount remains unchanged. No interpolation or accrual occurs.

## 4. Calculation and valuation architecture

Add a standalone deterministic debt snapshot layer with pure helpers such as:
- validate/normalize a debt position against its owning account and the full account list;
- return the latest snapshot at or before a requested timestamp;
- return the exact reported amount and timestamp, or no liability before the first report;
- sum positions in their owning account's native units.

Valuation stays separate from trade accounting:
- Reuse existing market-price identity logic for all supported asset kinds.
- Reuse existing fiat/FX conversion paths for fiat liabilities.
- Resolve market prices and fiat FX using each position's `(assetKind, assetTicker)` identity, never the owner's identity or ticker alone where kinds collide.
- Unknown liability prices/FX remain unknown (null). Never coerce them to zero or claim a complete net worth when a liability cannot be valued.
- Account net value = gross asset value - liability value when both are known. If liability valuation is unavailable, use the app's established incomplete/missing-price behavior rather than fabricating a number.
- Do not alter computePositions, computeAverage, computeFifo, or the joint computePortfolio trade semantics. Compose debt at the account/net-worth boundary.

## 5. Historical net worth

For each historical chart timestamp:
1. Reconstruct gross holdings through the existing trade engine unchanged.
2. Select the latest manual snapshot whose reportedAt is at or before that timestamp.
3. Do not apply interest growth, rate curves, event replay, interpolation, or future snapshots.
4. Value that reported amount using historical price/FX for the position's own `(assetKind, assetTicker)` at that chart date.
5. Subtract the liability once from its owning account and aggregate per-account net worth.

Before the first debt snapshot, the position contributes no historical liability. Between snapshots it contributes the last reported amount unchanged. A backdated snapshot may revise historical points at and after its reportedAt time; this is expected.

Explicitly update the history source signature/cache version so old cached data cannot be reused as if debt had already been included. Preserve the existing day-boundary sampling and unknown-price/gap behavior. Debt-only accounts must be represented in history even without trades; include the first relevant debt snapshot in history-start logic and request prices for assets needed solely to value debt.

## 6. Persistence, import/export, recovery, and sync

The export envelope remains exactly:
{app, version, exportedAt, settings, accounts, trades, priceOverrides}

Debt lives inside accounts[].debtPositions. Do not add a top-level envelope key or change the export version without an explicit compatibility need.

Update account normalization/validation, nested-field damage reporting, local load/save, import validation/normalization, export round-trip, account duplication/deletion/identity edits, and encrypted sync serialization/restoration/conflict handling.

Backward compatibility:
- Accounts/exports without debtPositions remain valid and behave as before.
- New snapshots round-trip without loss.
- Malformed debt data must never be silently stripped. Preserve the raw original through existing storage-recovery safeguards and report the damage. Imports fail clearly and atomically if debt data is malformed or collateral references a nonexistent account.

Account lifecycle:
- Prevent deleting an account that owns debt positions until they are deliberately resolved or removed through an explicit flow.
- Prevent deleting or changing the asset identity of an account referenced as collateral while references remain, unless those references are deliberately updated/cleared.
- Duplicating an account must not duplicate real debt positions by default or silently rewrite collateral references.
- Grouped accounts retain individual debt ownership; group summaries include each liability exactly once.

## 7. Tests and acceptance criteria

### Balance snapshots
- A reported 1,000.00 remains exactly 1,000.00 one minute, one day, or one year later until another snapshot exists; clock passage causes no storage write.
- Adding 1,001.40 makes exactly 1,001.40 current and preserves the earlier 1,000.00 snapshot.
- Interest, borrowing, repayment and corrections are all represented as new total-balance snapshots; notes do not affect math.
- Historical lookup is correct before, between and after snapshots; future snapshots never leak backward.
- Zero is accepted; negative, NaN, Infinity, malformed timestamps, duplicate IDs and malformed nested records are rejected.

### Accounts and collateral
- A debt position can be denominated in any supported kind/ticker, independently of the owning account (e.g. a EUR liability owned by a BTC account or a gold liability owned by an EUR account).
- Each liability denomination is valued independently; collateral references can point to multiple BTC/ETH/XAU/stock/fiat accounts.
- Collateral never changes source quantity, cost basis, market value or net worth.
- Debt is deducted exactly once; multiple positions sum correctly; debt-only accounts remain visible and can be negative.
- Grouping and filters never omit or double-count liabilities.
- Referenced accounts cannot be deleted or have identity changed without resolving dependencies.

### Regression and integrity
- Existing trade/FIFO/average/transfer/portfolio behavior remains unchanged.
- Unknown prices remain null; ticker collisions use the correct account kind.
- Grand net worth is the sum of per-account results.
- Export keys remain exact; legacy imports work; new nested data round-trips.
- Storage recovery preserves malformed debt data; encrypted sync preserves positions/snapshots.
- Historical values use the correct snapshot and invalidate the legacy cache signature.

### UI
- Add positions, enter new total-balance snapshots, review prior snapshots, and manage multiple collateral sources.
- Section appears between main account panel and ledgers/records.
- Latest report timestamp is visible; no APR, accrual, projected balance, or generated transactions appear.
- Home remains minimal, debt-only accounts are visible, and mobile forms/history fit existing constraints.

## 8. Implementation and delivery sequence

All work is on developing; never commit, push, or merge to main.

1. **Blueprint commit first:** replace the APR/accrual design with this manual-snapshot design before source changes.
2. **Pure debt snapshot engine + tests:** validation, normalization, as-of lookup, aggregation helpers; no interest arithmetic.
3. **Persistence/integrity:** account nesting, recovery, strict import, export round-trip, sync, account dependency guards.
4. **Account-detail UI:** collapsible section, create position, add snapshot, snapshot history/notes, collateral-source management, reported-at timestamp.
5. **Valuation/summaries:** account and home net values, debt-only accounts, group/filter correctness, missing-price behavior.
6. **Historical net worth:** as-of snapshot lookup, historical liability valuation, cache invalidation/versioning, regression tests.
7. **Hardening:** mobile/accessibility, full tests, browser smoke test, and cache-buster increments for every changed asset.

Push each completed and verified commit to developing immediately. Each commit body ends with a concise technical overview and the signature line: Commit made with GPT-6. Git author and committer remain sebaptcd <dev@sebastian.ghiveci.com>. Commits are unsigned and contain no AI co-author trailers.

## 9. Repository invariants

- Accounts remain single-asset containers; positions remain nested under their owning account but carry an independent, immutable liability denomination.
- Snapshots are manual total balances; Plutus never estimates or accrues interest.
- Collateral links do not move, lock, subtract, or double-count assets.
- The export envelope is unchanged.
- Established computePositions/computeAverage/computeFifo and computePortfolio trade behavior is unchanged.
- Unknown live/historical prices remain unknown, never zero.
- Grand totals remain sums of per-account results.
- fetchLivePrice and refreshAllPrices contracts are not reshaped.
- APP_VERSION retains its exact single-quoted line shape; stamp-version.sh remains Git mode 100755.
- Bump stylesheet and script cache-busters in index.html on every change.
- Before every push, syntax-check app.js, run relevant tests, smoke-test UI when feasible, and verify stamp-version.sh executable mode.
