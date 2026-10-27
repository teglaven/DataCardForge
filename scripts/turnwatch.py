#!/usr/bin/env python3
"""Turn watchdog — periodic supervision of a long agent session.

The judgement is deterministic on purpose. Everything that actually predicted the
2026-10-27 quota loss is arithmetic on three cheap sources:

  1. `~/.dsh/.dshw-usage.json` — one settlement per turn (ts / cost / tokens / model);
  2. `git log -1` in the repo — when did anything get produced;
  3. optionally the session transcript — how many tool calls, and is the same file being
     read over and over (the fingerprint of "reading instead of working").

A local model is deliberately NOT in the decision path: it is the least reliable component
in the chain, its mistakes are silent, and to judge productivity it has to read the
transcript — i.e. it re-creates the very context growth being watched. Use one only as a
narrator (see `--deep` output), never as the gate.

Calibration from the 2026-10-27 night (all times CST):
  healthy implementation turn :  0.35–1.1 元,   4.6–28M tokens, >=1 commit / 15 min
  runaway turn (quota loss)   :  4.79   元, 190.1M tokens, 736 calls, 0 commits / 40 min
  closing turn (same disease) :  5.03   元, 171.5M tokens

Usage:
  turnwatch.py                  # one line, exit 0 green / 1 yellow / 2 red
  turnwatch.py --deep           # + last-10-min call count and hot files
  turnwatch.py --json           # machine-readable, for a notifier
  turnwatch.py --loop 300       # supervise continuously (prints on state change)

Environment: DC_USAGE_FILE, DC_REPO, DC_SESSION_DIR override the defaults.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import subprocess
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
USAGE = os.path.expanduser(os.environ.get("DC_USAGE_FILE", "~/.dsh/.dshw-usage.json"))
REPO = os.environ.get("DC_REPO", os.path.expanduser("~/DataCardForge"))
SESSIONS = os.path.expanduser(
    os.environ.get("DC_SESSION_DIR", "~/.dsh/sessions/--home-teg_vm-DataCardForge--")
)

# Thresholds. Deliberately conservative: a YELLOW costs the operator one question, a missed
# RED costs a month of quota.
TURN_TOKENS_YELLOW = 8_000_000
TURN_TOKENS_RED = 20_000_000
TURN_COST_YELLOW = 0.8
TURN_COST_RED = 1.5
COMMIT_AGE_YELLOW_MIN = 15
COMMIT_AGE_RED_MIN = 30
# A session with no settlement for this long is IDLE, not stuck: chat turns settle every few
# minutes, so silence means nobody is running. Judging "no commit for 886 min" as RED at
# 21:31 (the first run of this script) was exactly the false positive to avoid.
IDLE_MIN = 30
# Only judge "working without producing" when tool calls are dense AND nothing is committed:
# the quota-losing turn made 736 calls in 40 min (≈180 per 10 min) with zero commits, while a
# design-discussion turn makes a handful of calls and no commits — those must not alarm.
CALLS_10MIN_YELLOW = 60
CALLS_10MIN_RED = 100


def fmt_ts(ms: float) -> str:
    return datetime.datetime.fromtimestamp(ms / 1000, TZ).strftime("%H:%M")


def age_min(seconds: float) -> float:
    return round(seconds / 60.0, 1)


def read_usage() -> dict:
    try:
        with open(USAGE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return {"error": str(exc)}


def last_commit_age_min() -> float | None:
    try:
        out = subprocess.run(
            ["git", "-C", REPO, "log", "-1", "--format=%ct"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        if not out:
            return None
        return age_min(datetime.datetime.now(datetime.timezone.utc).timestamp() - int(out))
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def latest_session_file() -> str | None:
    try:
        files = [
            os.path.join(SESSIONS, d, "session.v4.jsonl.zstd")
            for d in os.listdir(SESSIONS)
            if os.path.isdir(os.path.join(SESSIONS, d))
        ]
        files = [f for f in files if os.path.exists(f)]
        return max(files, key=os.path.getmtime) if files else None
    except OSError:
        return None


def deep_stats(window_min: int = 10) -> dict:
    """Tool-call density and repeated reads inside the recent window.

    This is the deterministic half of "is it stuck in reconnaissance": call count without
    file writes, and the same path appearing again and again.
    """
    path = latest_session_file()
    if not path:
        return {"available": False}
    try:
        raw = subprocess.run(
            ["zstd", "-dc", path], capture_output=True, timeout=120
        ).stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return {"available": False}

    cutoff = (
        datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=window_min)
    ).timestamp() * 1000
    calls = 0
    targets: collections.Counter[str] = collections.Counter()
    for line in raw.splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") != "job/registered":
            continue
        when = entry.get("time") or entry.get("ts") or 0
        if not isinstance(when, (int, float)) or when < cutoff:
            continue
        calls += 1
        label = str((entry.get("data") or {}).get("label") or "")
        # The trailing path-ish token of a shell command is the closest thing to "what did
        # it touch"; enough to spot the same file being read 5 times.
        tokens = [t.strip(";|&()\"'") for t in label.split()]
        for token in reversed(tokens):
            if "/" in token and not token.startswith("-"):
                targets[token] += 1
                break
    return {
        "available": True,
        "windowMin": window_min,
        "calls": calls,
        "callsPerMin": round(calls / window_min, 1),
        "hotPaths": targets.most_common(3),
    }


def verdict(
    turn_tokens: int,
    turn_cost: float,
    commit_age: float | None,
    calls_10min: int | None,
) -> tuple[str, list[str]]:
    reasons: list[str] = []
    level = 0  # 0 green, 1 yellow, 2 red
    if turn_tokens >= TURN_TOKENS_RED:
        level = 2
        reasons.append(f"last turn {turn_tokens/1e6:.1f}M tokens >= {TURN_TOKENS_RED/1e6:.0f}M")
    elif turn_tokens >= TURN_TOKENS_YELLOW:
        level = max(level, 1)
        reasons.append(f"last turn {turn_tokens/1e6:.1f}M tokens")
    if turn_cost >= TURN_COST_RED:
        level = 2
        reasons.append(f"last turn {turn_cost:.2f} CNY >= {TURN_COST_RED}")
    elif turn_cost >= TURN_COST_YELLOW:
        level = max(level, 1)
        reasons.append(f"last turn {turn_cost:.2f} CNY")
    # "Busy but producing nothing" — the shape of the run that ate the month's quota.
    if calls_10min is not None and commit_age is not None:
        if calls_10min >= CALLS_10MIN_RED and commit_age >= COMMIT_AGE_RED_MIN:
            level = 2
            reasons.append(
                f"{calls_10min} calls/10min with no commit for {commit_age:.0f} min"
            )
        elif calls_10min >= CALLS_10MIN_YELLOW and commit_age >= COMMIT_AGE_YELLOW_MIN:
            level = max(level, 1)
            reasons.append(
                f"{calls_10min} calls/10min with no commit for {commit_age:.0f} min"
            )
    return {0: "GREEN", 1: "YELLOW", 2: "RED"}[level], reasons


def snapshot(deep: bool) -> dict:
    usage = read_usage()
    if "error" in usage:
        return {"level": "UNKNOWN", "error": usage["error"]}
    events = usage.get("events") or []
    last = events[-1] if events else {}
    prev = events[-2] if len(events) > 1 else {}
    turn_tokens = int(last.get("tokens") or 0)
    turn_cost = float(last.get("cost") or 0)
    commit_age = last_commit_age_min()
    now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    settle_age = round((now_ms - last["ts"]) / 60000, 1) if last else None
    deep = deep_stats() if deep else None
    calls_10min = deep["calls"] if deep and deep.get("available") else None
    level, reasons = verdict(turn_tokens, turn_cost, commit_age, calls_10min)
    if settle_age is not None and settle_age > IDLE_MIN:
        level, reasons = "IDLE", [f"no settlement for {settle_age:.0f} min"]
    data = {
        "level": level,
        "reasons": reasons,
        "lastTurn": {
            "settledAt": fmt_ts(last["ts"]) if last else None,
            "model": last.get("model"),
            "tokens": turn_tokens,
            "cost": round(turn_cost, 3),
            "sincePrevSettlementMin": (
                round((last["ts"] - prev["ts"]) / 60000, 1) if last and prev else None
            ),
        },
        "today": {"spent": usage.get("todayUsage"), "balance": usage.get("lastBalance")},
        "repo": {"path": REPO, "lastCommitAgeMin": commit_age},
        "settleAgeMin": settle_age,
    }
    if deep is not None:
        data["deep"] = deep
    return data


def line(data: dict) -> str:
    if "error" in data:
        return f"[UNKNOWN] usage ledger unreadable: {data['error']}"
    t = data["lastTurn"]
    today = data["today"]
    bits = [
        f"[{data['level']}]",
        f"last turn @{t['settledAt']} {t['model']} {t['tokens']/1e6:.1f}M / {t['cost']:.2f}CNY",
        f"today {today['spent']}CNY left {today['balance']}CNY",
        f"settled {data.get('settleAgeMin')} min ago",
        f"commit {data['repo']['lastCommitAgeMin']}min ago",
    ]
    if t.get("sincePrevSettlementMin") is not None:
        bits.append(f"settlement gap {t['sincePrevSettlementMin']}min")
    if data.get("deep", {}).get("available"):
        d = data["deep"]
        hot = ", ".join(f"{p}x{n}" for p, n in d["hotPaths"]) or "none"
        bits.append(f"calls/10min {d['calls']} ({d['callsPerMin']}/min) hot: {hot}")
    if data["reasons"]:
        bits.append("why: " + "; ".join(data["reasons"]))
    return " | ".join(bits)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deep", action="store_true", help="also measure call density + hot files")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--loop", type=int, metavar="SECONDS", help="supervise continuously")
    args = ap.parse_args()

    if args.loop:
        seen = None
        while True:
            data = snapshot(args.deep)
            text = line(data)
            if text != seen:  # print on change only: a log of transitions, not noise
                print(datetime.datetime.now(TZ).strftime("%H:%M:%S"), text, flush=True)
                seen = text
            import time

            time.sleep(args.loop)

    data = snapshot(args.deep)
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print(line(data))
    return {"GREEN": 0, "IDLE": 0, "YELLOW": 1, "RED": 2}.get(data.get("level"), 0)


if __name__ == "__main__":
    sys.exit(main())
