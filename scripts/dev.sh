#!/usr/bin/env bash
# One-command dev: starts the C++ compute backend + vite dev server.
# Ctrl-C kills both. Usage: ./scripts/dev.sh [backend-port]
set -euo pipefail

BACKEND_PORT="${1:-37811}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

echo "[dev] starting vite dev server (proxy /api → backend)"
cd "$ROOT/web"
npx vite --host 127.0.0.1 &
VITE_PID=$!

echo "[dev] ready — press Ctrl-C to stop both"
wait
