# PLUTUS — instructions for AI agents (and humans)

Local-first portfolio tracker. Static site: `index.html`, the scripts under
`js/` (`js/app.js` boots the app), the stylesheets under `css/`, `netlify.toml`, and
`stamp-version.sh`.
No framework, no bundler. Pushed to `main`, Netlify redeploys automatically.

## Code layout — how the scripts fit together
- The app is a set of classic scripts sharing ONE global scope, listed in
  `index.html` (deferred, executed in order) and grouped by folder:
  `js/core` (generic helpers, dates), `js/data` (state model, validation,
  storage, backup), `js/fx`, `js/ledger` (pure accounting engine),
  `js/prices`, `js/ui` (views, dialogs, record form, render loop),
  `js/sync`, `js/analytics`. `js/app.js` loads last: version + boot.
  `js/boot/` holds the two scripts that run during parsing (consent default,
  startup loader); they are not deferred.
- Function declarations are only hoisted within their own file. Code that
  runs at load time (top-level `var x = f()`, IIFEs, listener wiring) may
  only use what its own file or an EARLIER file declares. Everything else
  runs after boot, so files call each other freely.
- One feature per file. A new file goes into the `index.html` script list
  in its folder group; tests read that list, so nothing else needs to know.
  `tests/script-order.test.js` loads every file on its own, in order, and
  fails on load-order mistakes, orphan files and a global name declared in
  two files.
- Tests load the app with `require('./app-source').appSource()` (and the
  styles with `cssSource()`), never by reading one file.
- Styles live in `css/`, one area per file, linked by `index.html` in
  cascade order: later files override earlier ones, so a rule's file
  position matters. `responsive.css` holds the phone redesign; the files
  after it are later refinements that intentionally win over it. Add a
  rule to the file of its area; if it has to override a rule that sits in a
  later file, change that rule there (or raise specificity). Never reorder
  the links casually.
- State reads: `loadState()` returns a private copy (safe to mutate, then
  `saveState`); `peekState()` returns the shared validated copy for
  read-only hot paths. Both are cached on the exact stored text: never
  bypass them by parsing `localStorage` yourself.

## Performance — keep large ledgers snappy
- Owners keep hundreds to thousands of records. Anything that runs per
  paint must stay linear in the record count: no `loadState()` (a full
  copy) inside per-record loops or per-record helpers — use
  `peekState()` or pass the state in.
- Background fills that run on every paint (FX rates, historical prices)
  must share in-flight requests and back off after a failure (see
  `fxFillRate`, `histBlocked`); user actions such as saving a record may
  always hit the network.
- The startup intro animates only `transform` / `opacity` (compositor
  only) and closes when both the app is ready and the intro has finished
  (`js/boot/startup-loader.js`). Don't drive it with fixed timers or
  animate `filter`.

## Branches — mandatory for every agent
- Make ALL changes on the `developing` branch. Commit and push to `developing` only.
- The owner reviews and merges `developing` into `main`. Agents never do.
- Never commit to, push to, or merge into `main` unless the owner
  explicitly tells you to.

## Session start — always work on latest
- Before ANY work: `git fetch origin`, switch to `developing`, then compare `HEAD`
  vs `origin/developing` (`git rev-parse HEAD`, `git rev-parse origin/developing`,
  or `git status -sb`).
- If the local files are not up to date with the remote `developing` branch
  (behind `origin/developing`, or no local `developing` yet): FIRST sync with `developing` on a
  clean tree (`git checkout developing`, then `git pull --ff-only origin developing`),
  re-verify, and only then start editing. Never sync from or base work on
  `main`.
- If the tree is dirty or the pull would overwrite local work: STOP and
  ask the owner before touching anything.
- Windows exception: a mode-only worktree difference on `stamp-version.sh`
  is expected when Git tracks it as `100755` but the local filesystem reports
  it as non-executable. Confirm `git diff -- stamp-version.sh` shows no
  content changes and `git ls-files -s stamp-version.sh` still shows `100755`;
  preserve the tracked executable mode and proceed without staging or
  otherwise changing the script. Any content difference or other dirty file
  still requires asking the owner.
- This applies to every new session and every new agent with no prompting
  needed.

## Versioning — mandatory on EVERY change
- The footer shows `<short-hash> (#<count>)`, e.g. `c493d6f (#111)`.
- A commit id only exists AFTER committing, so never hand-write it: the
  Netlify build runs `stamp-version.sh`, which stamps the exact id + count
  into `APP_VERSION` at deploy time.
- DO NOT reformat the `var APP_VERSION = '...';` line in `js/app.js`
  (single quotes, exact shape) — the stamp script's sed anchors on
  `^var APP_VERSION = '.*';$`. Reformatting it silently breaks stamping and
  the footer will show a stale version forever.
- Keep a sane fallback value on that line for local/`file://` use.
- Cache-busters: every local script and stylesheet tag in `index.html` has a
  `?v=` cache-buster. The same build step stamps each one with a checksum of
  that file's own content (git not needed), so a deploy changes exactly the
  URLs of the files that changed, and Netlify caches `/js/*` and `/css/*` as
  immutable. Never hand-bump them; keep the checked-in fallback values as
  they are. New tags must carry `?v=` too (`tests/stamp-version.test.js`).
- The footer renders the version automatically (`#app-ver`); users only ever
  see that string, never these notes.

## Netlify build script permissions — mandatory
- `stamp-version.sh` must remain executable in Git (`100755`): `netlify.toml`
  invokes it directly, and a missing executable bit fails the deploy with
  `Permission denied` (exit code 126).
- Before committing or pushing, verify the committed mode with
  `git ls-tree HEAD stamp-version.sh` (expect `100755 blob`). On Windows,
  filesystem permissions may not preserve the executable bit; if needed,
  set it in Git's index with `git update-index --chmod=+x stamp-version.sh`,
  stage the change, then verify the staged mode with
  `git ls-files -s stamp-version.sh` (expect `100755`).
- Never commit a mode change that makes this script non-executable. Do not
  rely on `chmod` or the Windows worktree mode as proof; Git's index/commit
  mode is what Netlify receives.

## Verify before every push
- Syntax-check every script with any available JS runtime
  (`node --check` each file under `js/`, e.g.
  `find js -name '*.js' -exec node --check {} \;`).
- Run the tests: `for t in tests/*.test.js; do node "$t" || { echo "FAILED: $t"; exit 1; }; done`
  (the `browser-*` tests need `npm ci --prefix tests` and Chromium; without
  them they print `SKIP` locally, and CI never skips them).
- Smoke-test the app in a browser when changing user-facing behavior.
- Verify `stamp-version.sh` is committed as mode `100755` (see above).

## Push cadence — mandatory for every agent
- Push each commit to `developing` as soon as it is finished and verified, with its
  complete message and technical overview (see Commit messages), even while
  the overall implementation is still in progress.
- Never keep finished commits local until the end of the task or reply and
  then push them all at once.
- Every push still follows "Verify before every push" and "Push replies".

## Invariants — do not break
- `isValidImportTrade` must keep accepting plain buy/sell trades; export
  envelope keys stay exactly
  `{app,version,exportedAt,settings,accounts,trades,priceOverrides}`.
- Unknown live prices stay `null` (never coerce to `0` — that fabricates
  a -100% loss).
- Grand totals = SUM of the per-account runs, never a blended global run.
- `computePositions` / `computeAverage` / `computeFifo` buy/sell math must
  preserve their established behavior.
- `fetchLivePrice` single-symbol behavior and `refreshAllPrices` return
  shape are established contracts — extend, don't reshape.
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
- Account list: 6 cards per page; the pager shows at most 3 numbers —
  first, current, last, with ellipses for the gaps (1 2 … 4, 1 … 50 … 100,
  1 … 99 100). The per-account records pager uses the same compact shape.
  Pagers wrap, never scroll horizontally; dice-grip reorder and bulk
  selection persist across pages; totals always cover every visible
  (filtered) account, never just the page.
- Accounts carry optional `color` (validated hex, avatar + border tint);
  bulk Change color offers presets, custom picker/hex, and reset.
- Layout is fixed, content is fluid: boxes never resize with values —
  truncate, fit, or reserve space instead (hero panel is the reference).
- `main` must never create a stacking context (`position: relative` only,
  no `z-index`): the fixed mobile bottom-sheet menus (`.filter-panel`) must
  paint above the footer and the FAB.
- Commit each change separately with a clear message and push to `developing`
  (never `main`; see Branches).

## Push replies — mandatory for every agent, no prompting needed
- Every reply that reports a push must START with the confirmation line
  `Pushed to <branch> #<short-hash>`, e.g. `Pushed to developing #f993f82`.
  Nothing before it: no greeting, no preamble.
- The owner must never have to ask for this format again; AGENTS.md carries
  it, and coding agents load this file automatically.

## Commit messages — required format
- Every commit body must end with a technical overview of the changes made,
  concise and free of filler: what was changed, where, and why.
- The commit body must end with an agent signature line:
  `Commit made with <agent> <version (if relevant)>`.
- When creating a multi-line commit message in PowerShell, use actual line
  breaks (for example, multiple `-m` arguments or a here-string); never use
  literal `\n` escape sequences, which Git stores verbatim. Inspect the
  resulting message with `git show -s --format=%B HEAD` before pushing.
- The git author/committer must always be the human owner
  (`sebaptcd <dev@sebastian.ghiveci.com>`). No `Co-authored-by` trailers
  naming an AI assistant; agents must not appear as author or committer.
- Strip any agent co-author trailers before pushing; history must show only
  human authorship.
- This applies to every agent (Claude, Copilot, Codex, Cursor, or any
  other). Besides the signature line above, add no agent attribution to
  commits: no session-ID lines, no "Generated with <tool>" footers.
- Pull request titles carry no agent attribution.
- Every pull request description ends with one plain-text signature line in
  the same shape as the commit signature:
  `PR made with <agent> <version (if relevant)>`
  No emojis, no links, no session URLs, no other attribution.

## Commit signing — agent commits are unsigned
- Agent commits are NOT signed. Every agent commit already on `developing` is
  unsigned; verification comes from GitHub, which signs the merge commit
  when the owner merges (shown as Verified).
- Agent sandboxes can ship a global git config with `commit.gpgsign=true`
  and a sandbox-only SSH key. GitHub does not know that key, so every such
  commit shows "Unverified" (`unknown_key`) — worse than unsigned. Before
  the first commit of a session run `git config --local commit.gpgsign false`
  and confirm `git config --get commit.gpgsign` prints `false`.
- After committing, confirm there is no signature:
  `git cat-file -p HEAD | grep -c '^gpgsig'` must print `0`. Do not trust
  `git log --format=%G?` for this: without an allowed-signers file it
  prints `N` for signed SSH commits too.
- Never register an agent or sandbox key as a signing key on the owner's
  GitHub account, and never create, copy or import the owner's private key.
- A commit that was signed by mistake is not fixed by rewriting `developing` or
  `main`. Tell the owner; they can re-sign locally with their own key if
  they want that.
