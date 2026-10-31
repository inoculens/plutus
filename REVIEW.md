# Code review log

Running list of review findings. Anything here is **not yet fixed** — items
accumulate over time and get scheduled when (and if) they matter. Nothing in
this file changes app behavior; it is notes only.

## 2026-10-13 — Extensive review: math, logic, sync, UI

**Verdict: clean — no bugs found.** Checked by execution under a real JS
engine (parse + loaded run + assertions), not just by reading. Method and
limits at the bottom.

### Verified clean (executed)

- **Ledger math.** 30 randomized multi-account, multi-symbol portfolios
  (buys/sells/income/expenses/transfers) through both cost methods:
  fully-closed books agree on lifetime realized P&L every trial; FIFO lot
  gains always sum exactly to FIFO realized; transfer basis conservation
  holds in both methods (moved cost pro-rata minus fee, qty minus fee);
  `buyId` survives cross-account moves; no negative inventory anywhere,
  including clamped oversells.
- **Recent FIFO id-threading.** Lot gains identical before/after; no test
  does exact-shape lot assertions, so the additive `buyId`/`sellId`/`kind`
  fields are safe.
- **Sync state machine.** No overwrite path constructible: every divergence
  resolves to adopt-if-clean, explicit prompt, or stand-down; direction is
  recomputed from fresh hashes at each decision so races converge;
  `syncPendingRemote` lifecycle consistent across push/pull/adopt/cancel/load.
- **Validators & invariants.** Plain buy/sell import accepted; storage stays
  ISO (`dd/mm/yyyy` rejected at import); envelope keys exact
  `{app,version,exportedAt,settings,accounts,trades,priceOverrides}`;
  ISO→display→ISO date round-trips; leap/future rejects; page clamping;
  `tradeDisplayId` shape/stability/robustness on hostile inputs (never throws).
- **Prices & totals.** `fetchLivePrice`/`refreshAllPrices` shapes unchanged;
  unknown live prices stay `null`; grand totals sum per-account runs;
  swap legs atomic with pair-aware delete.

### Parked observations (non-bugs, ranked)

1. **Transfer-moved basis not annotated buy-side (UX gap, rare).**
   A buy moved out by transfer shows "Consumed · partially" counting only
   fee slices — the moved remainder isn't linked, so a reader may wonder
   where the rest went. Factually true, just incomplete (transfers move
   basis; they don't close lots). Fix needs transfer-matching design, not
   just lots: correlate the transfer-out record (same account/symbol) with
   the moved `buyId` slices in the destination queue, then render a
   "moved X to <account>" line. Proposed wording keeps FIFO-only.
2. **Dead linkage button for legacy id-less closers (cosmetic, rare).**
   A slice whose closer has no id renders a button with no target (click is
   a guarded no-op). Fix: skip the button (or render a non-clickable span)
   when there is no target id.
3. **`var pulledAt` declared twice in `syncPushFlow` (tidiness, invisible).**
   Legal JS — declarations merge, branches are exclusive, zero behavioral
   effect. Fix: rename one. Lowest priority of the four.
4. **Cross-page flash could land on a transfer-twin card (cosmetic,
   near-impossible).** If the user switches accounts within the 60ms
   post-render window, the delayed flash query could match the same trade id
   in the other account's list (transfers appear in both). Fix: capture the
   host element at click time and check `el.isConnected` before flashing.

### Method & limits (2026-10-13 review)

- Headless verification only: standalone Python + esprima (parse) + Duktape
  (load + pure-logic assertions). No browser was available for that review,
  so real-browser interaction, a live two-machine sync scenario, and visual
  review of the new pills/linkage rows/flash were not performed.
