#!/bin/sh
# Deploy-time stamping (Netlify build, see netlify.toml):
# - APP_VERSION in js/app.js gets the exact commit id + commit count;
# - every local .js/.css cache-buster in index.html (?v=...) gets the commit
#   id, so each deploy ships fresh URLs and the assets can be cached forever.
# Manual pre-writing is impossible (the id only exists after committing), so
# the build does it. Never fails the deploy: without git it leaves the
# checked-in fallback values untouched.
if ! command -v git >/dev/null 2>&1; then exit 0; fi
H=$(git rev-parse --short HEAD 2>/dev/null) || exit 0
git fetch --unshallow >/dev/null 2>&1 || true
N=$(git rev-list --count HEAD 2>/dev/null) || exit 0
sed -i "s/^var APP_VERSION = '.*';$/var APP_VERSION = '$H (#$N)';/" js/app.js
grep "^var APP_VERSION" js/app.js
sed -i -E "s#((src|href)=\"/[^\"?]+\.(js|css))\?v=[A-Za-z0-9]+\"#\1?v=$H\"#g" index.html
echo "stamped $(grep -cE "\.(js|css)\?v=$H\"" index.html) asset URLs with ?v=$H"
