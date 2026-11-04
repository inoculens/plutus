# PLUTUS — instructions for AI agents (and humans)

Local-first portfolio tracker. Static site: `index.html`, `app.js`,
`js/net-worth-history.js`, `styles.css`, `netlify.toml`, and
`stamp-version.sh`.
No framework, no bundler. Pushed to `main`, Netlify redeploys automatically.

## Branches — mandatory for every agent
- Make ALL changes on the `dev` branch. Commit and push to `dev` only.
- The owner reviews and merges `dev` into `main`. Agents never do.
- Never commit to, push to, or merge into `main` unless the owner
  explicitly tells you to.

## Session start — always work on latest
- Before ANY work: `git fetch origin`, switch to `dev`, then compare `HEAD`
  vs `origin/dev` (`git rev-parse HEAD`, `git rev-parse origin/dev`,
  or `git status -sb`).
- If the local files are not up to date with the remote `dev` branch
  (behind `origin/dev`, or no local `dev` yet): FIRST sync with `dev` on a
  clean tree (`git checkout dev`, then `git pull --ff-only origin dev`),
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
- DO NOT reformat the `var APP_VERSION = '...';` line in `app.js`
  (single quotes, exact shape) — the stamp script's sed anchors on
  `^var APP_VERSION = '.*';$`. Reformatting it silently breaks stamping and
  the footer will show a stale version forever.
- Keep a sane fallback value on that line for local/`file://` use.
- Bump the `?v=` cache-busters on the stylesheet + script tags in
  `index.html` on EVERY change, so deployed users load fresh assets.
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
- Syntax-check `app.js` with any available JS runtime
  (`node --check app.js`, QuickJS, or equivalent).
- Smoke-test the app in a browser when changing user-facing behavior.
- Verify `stamp-version.sh` is committed as mode `100755` (see above).

## Push cadence — mandatory for every agent
- Push each commit to `dev` as soon as it is finished and verified, with its
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
- Commit each change separately with a clear message and push to `dev`
  (never `main`; see Branches).

## Push replies — mandatory for every agent, no prompting needed
- Every reply that reports a push must START with the confirmation line
  `Pushed to <branch> #<short-hash>`, e.g. `Pushed to dev #f993f82`.
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
- Pull request titles and descriptions carry no agent attribution.

## Commit signing — agent commits are unsigned
- Agent commits are NOT signed. Every agent commit already on `dev` is
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
- A commit that was signed by mistake is not fixed by rewriting `dev` or
  `main`. Tell the owner; they can re-sign locally with their own key if
  they want that.
