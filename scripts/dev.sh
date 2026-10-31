#!/usr/bin/env bash
# One-command dev: starts the C++ compute backend + vite dev server.
# Ctrl-C kills both. Usage: ./scripts/dev.sh [backend-port]
set -euo pipefail

BACKEND_PORT="${1:-37811}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# A fresh clone has no web/node_modules: `npx vite` would either download a random vite or
# fail late, after the backend build. Say it plainly instead.
if [ ! -d "$ROOT/web/node_modules" ]; then
  echo "[dev] web/node_modules is missing — run 'cd web && npm install' once first." >&2
  exit 1
fi

cleanup() {
  echo "[dev] shutting down…"
  kill "$BACKEND_PID" "$VITE_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  wait "$VITE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[dev] building backend…"
cmake -S "$ROOT/backend" -B "$ROOT/backend/build" -G Ninja >/dev/null 2>&1
cmake --build "$ROOT/backend/build" >/dev/null 2>&1

echo "[dev] starting backend on http://127.0.0.1:$BACKEND_PORT"
"$ROOT/backend/build/dc_backend" --port "$BACKEND_PORT" &
BACKEND_PID=$!

echo "[dev] starting vite dev server (proxy /api → backend :$BACKEND_PORT)"
cd "$ROOT/web"
# vite.config.ts binds loopback by default: the backend has no authentication, so exposing
# the dev server to the LAN has to be a deliberate act — VITE_HOST=0.0.0.0 ./scripts/dev.sh.
# The port argument is passed through so the /api proxy follows it (vite.config.ts reads
# DC_BACKEND_PORT) instead of always pointing at 37811.
export DC_BACKEND_PORT="$BACKEND_PORT"
npx vite ${VITE_HOST:+--host "$VITE_HOST"} &
VITE_PID=$!

echo "[dev] ready — press Ctrl-C to stop both"
wait
