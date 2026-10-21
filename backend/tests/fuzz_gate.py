#!/usr/bin/env python3
"""ctest gate for the TS↔C++ differential fuzz (opt-in, like stress_test.py).

Without DC_RUN_FUZZ=1 this exits 101 so ctest records "Not Run" — CI stays fast and
deterministic. With it, runs the Node driver (web/scripts/diff_fuzz.mjs), which imports
the REAL web/src/core/expression.ts as the TS authority side and compares against
dc_diff_run over seeded random cases. Any divergence fails the test with the minimal
repro printed by the driver; never widen the comparison to make this green.
"""
import argparse
import os
import subprocess
import sys

SKIP = 101


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", required=True, help="diff_fuzz.mjs path")
    ap.add_argument("--cpp-bin", required=True, help="dc_diff_run path")
    ap.add_argument("--iters", default="2000")
    ap.add_argument("--seed", default=None, help="default: env DC_FUZZ_SEED or 12345")
    args = ap.parse_args()

    if os.environ.get("DC_RUN_FUZZ") != "1":
        print("SKIP diff_fuzz: set DC_RUN_FUZZ=1 to enable (opt-in, keeps CI fast)")
        return SKIP

    seed = args.seed or os.environ.get("DC_FUZZ_SEED", "12345")
    cmd = [
        "node", "--experimental-transform-types", args.script,
        "--cpp-bin", args.cpp_bin, "--iters", args.iters, "--seed", seed,
    ]
    proc = subprocess.run(cmd)
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
