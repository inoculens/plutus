#!/bin/sh
# Stamp the exact commit id + commit count into APP_VERSION at deploy time.
# Manual pre-writing is impossible (the id only exists after committing), so
# the build does it. Never fails the deploy: without git it leaves the
# checked-in fallback value untouched.
if ! command -v git >/dev/null 2>&1; then exit 0; fi
H=$(git rev-parse --short HEAD 2>/dev/null) || exit 0
git fetch --unshallow >/dev/null 2>&1 || true
N=$(git rev-list --count HEAD 2>/dev/null) || exit 0
sed -i "s/^var APP_VERSION = '.*';$/var APP_VERSION = '$H (#$N)';/" app.js
grep "^var APP_VERSION" app.js
