#!/bin/sh
# Deploy-time stamping (Netlify build, see netlify.toml). Never fails the deploy.
# - APP_VERSION in js/app.js gets the exact commit id + commit count (needs
#   git; without it the checked-in fallback value stays).
# - Every local .js/.css cache-buster in index.html (?v=...) gets a checksum
#   of that file's own content, so a deploy changes exactly the URLs of the
#   files that changed and the assets can be cached forever. This runs with or
#   without git, after APP_VERSION is stamped.
if command -v git >/dev/null 2>&1 && H=$(git rev-parse --short HEAD 2>/dev/null); then
  git fetch --unshallow >/dev/null 2>&1 || true
  if N=$(git rev-list --count HEAD 2>/dev/null); then
    sed -i "s/^var APP_VERSION = '.*';$/var APP_VERSION = '$H (#$N)';/" js/app.js
    grep "^var APP_VERSION" js/app.js
  fi
fi
n=0
for f in $(grep -oE '(src|href)="/[^"?]+\.(js|css)\?v=' index.html | sed -E 's#^(src|href)="/##; s#\?v=$##'); do
  [ -f "$f" ] || continue
  v=$(cksum < "$f" | cut -d' ' -f1)
  p=$(printf '%s' "$f" | sed 's#[.]#\\.#g')
  sed -i -E "s#((src|href)=\"/$p)\?v=[A-Za-z0-9]+\"#\1?v=$v\"#" index.html
  n=$((n + 1))
done
echo "stamped $n asset URLs with content checksums"
exit 0
