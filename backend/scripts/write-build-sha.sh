#!/usr/bin/env sh
# Write the commit the binary is being BUILT from into a generated header.
#
# Why not bake it at configure time: `execute_process(git rev-parse …)` runs once, when the
# build tree is first configured, so the id reported by /api/hello froze at whatever HEAD was
# that day. It then answers "is the fix deployed?" with the wrong commit — which is exactly
# how a stale `build=c7f01b6` was read as "the new engine is not live" while it was.
#
# Usage: write-build-sha.sh <repo-root> <output-header>
set -eu

repo="$1"
out="$2"

sha="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo unknown)"
[ -n "$sha" ] || sha="unknown"

mkdir -p "$(dirname "$out")"
printf '#pragma once\n#define DC_BUILD_SHA "%s"\n' "$sha" > "$out"
