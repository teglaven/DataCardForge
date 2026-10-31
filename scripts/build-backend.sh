#!/usr/bin/env bash
# Build the compute backend for a persistent (long-running) deployment.
# Typically invoked at boot by the deployment; can also be run manually:
#   ./scripts/build-backend.sh
# Idempotent: cmake/ninja only rebuild what changed. Never deletes the existing
# binary — if the build fails, the previous dc_backend stays in place so the
# service can still start with it (and Restart= keeps it alive).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cmake -S "$ROOT/backend" -B "$ROOT/backend/build" -G Ninja >/dev/null
cmake --build "$ROOT/backend/build" >/dev/null

# Print a version line WITHOUT executing the binary: `dc_backend` ignores unknown
# flags and starts listening anyway (verified 2026-10-21), so probing it with
# `--help` would hang this oneshot forever. The build embeds the git sha; read it
# from git directly instead.
SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "[build-backend] ok: $ROOT/backend/build/dc_backend (build=$SHA)"
