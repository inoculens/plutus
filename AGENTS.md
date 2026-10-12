# PLUTUS — instructions for AI agents (and humans)

Local-first portfolio tracker. Static site: `index.html`, `app.js`,
`styles.css` (+ `tests.html` harness, `netlify.toml`, `stamp-version.sh`).
No framework, no bundler. Pushed to `main`, Netlify redeploys automatically.

## Versioning — mandatory on EVERY change
- The footer shows `<short-hash> (#<count>)`, e.g. `c493d6f (#111)`.
- A commit id only exists AFTER committing, so never hand-write it: the
  Netlify build runs `stamp-version.sh`, which stamps the exact id + count
  into `APP_VERSION` at deploy time.
- DO NOT reformat the `var APP_VERSION = '...';` line in `app.js`
  (single quotes, exact shape) — the stamp script's sed anchors on
  `^var APP_VERSION = '.*';$`. Reformatting it silently breaks stamping and
  the footer will show a stale version forever.
- Keep a sane fallback value on that line for local/`file://` use.
- Bump the `?v=` cache-busters on the stylesheet + script tags in
  `index.html` on EVERY change, so deployed users load fresh assets.
- The footer renders the version automatically (`#app-ver`); users only ever
  see that string, never these notes.

## Verify before every push
- Syntax-check `app.js` with any available JS runtime
  (`node --check app.js`, QuickJS, or equivalent).
- Open `tests.html` in a browser — everything must be green.

## Invariants — do not break
- `isValidImportTrade` must keep accepting plain buy/sell trades; export
  envelope keys stay exactly
  `{app,version,exportedAt,settings,accounts,trades,priceOverrides}`.
- Unknown live prices stay `null` (never coerce to `0` — that fabricates
  a -100% loss).
- Grand totals = SUM of the per-account runs, never a blended global run.
- `computePositions` / `computeAverage` / `computeFifo` buy/sell math must
  keep matching the spec fixtures in `tests.html`.
- `fetchLivePrice` single-symbol behavior and `refreshAllPrices` return
  shape are asserted by tests — extend, don't reshape.
- New price APIs need a `SYMBOL_MAP` entry (verified against CoinGecko),
  a `connect-src` host in the `index.html` CSP, and a manual-override
  fallback path.

## UX rules established with the owner
- Home stays minimal: totals + account cards only; details live in account
  views, fees/income on detail cards, trade history per account.
- Entry points live with their lists (section-level buttons); no duplicate
  top-bar action buttons.
- Errors: one calm banner line + "More details" popup; never dump ticker
  lists into the banner.
- National currencies are always called "fiat" in UI copy.
- Account list: 6 cards per page with sliding 6-number pager; dice-grip
  reorder and bulk selection persist across pages; totals always cover every
  visible (filtered) account, never just the page.
- Accounts carry optional `color` (validated hex, avatar + border tint);
  bulk Change color offers presets, custom picker/hex, and reset.
- Layout is fixed, content is fluid: boxes never resize with values —
  truncate, fit, or reserve space instead (hero panel is the reference).
- Commit each change separately with a clear message and push to `main`.

## Push replies — mandatory for every agent, no prompting needed
- Every reply that reports a push must START with the confirmation line
  `Pushed to <branch> #<short-hash>`, e.g. `Pushed to main #f993f82`.
  Nothing before it: no greeting, no preamble.
- The owner must never have to ask for this format again; AGENTS.md carries
  it, and coding agents load this file automatically.
