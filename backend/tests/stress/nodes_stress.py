#!/usr/bin/env python3
"""Node-registry concurrency stress (opt-in).

Why this exists: on 2026-10-27 node evaluation stopped holding the registry lock (so a slow
function no longer freezes every other card). That trade is only safe if concurrent
create / params-update / recompute / delete never deadlocks, never crashes the process and
never publishes a result while its definition is being replaced. The malformed-request
stress (`stress_test.py`) exercises the HTTP parser, not this.

The run is deliberately adversarial about TIMING, not about correctness of numbers: each
worker creates a node, rewrites its params from another thread's point of view, reads the
result window and deletes the node, while other workers hammer the same matrix. At the end
the script asserts the server is still alive and one freshly built node still computes the
right numbers (a consistency check after the churn).

Exit codes: 0 pass, 1 fail, 101 skipped (when DC_RUN_STRESS is not set, ctest records it
as skipped rather than a silent pass).
"""
import argparse
import json
import os
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ALLOWED = {200, 201, 400, 404, 409}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, port: int) -> None:
        self.base = f"http://127.0.0.1:{port}/api"

    def call(self, method: str, path: str, body=None, timeout=10.0):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {}
            return e.code, parsed
        except Exception as e:  # noqa: BLE001 - transport failures count as a failure
            return 0, {"transport": str(e)}


def wait_for_hello(client: Client, deadline_s: float = 15.0) -> bool:
    end = time.time() + deadline_s
    while time.time() < end:
        status, _ = client.call("GET", "/hello")
        if status == 200:
            return True
        time.sleep(0.05)
    return False


def worker(client: Client, matrix_id: int, rounds: int, errors: list) -> None:
    for i in range(rounds):
        expr = random.choice(["A * 2", "A + 1", "A * A", "AVG(A)", "A - 3"])
        status, created = client.call(
            "POST", "/nodes",
            {
                "signatureId": "builtin:expression-columns",
                "inputs": [{"portId": "src", "mode": "matrix", "sourceMatrixId": matrix_id}],
                "params": {"formulas": [{"name": "f", "expression": expr}]},
            },
        )
        if status not in ALLOWED:
            errors.append(f"create -> {status} {created}")
            continue
        node_id = created.get("nodeId")
        if not node_id:
            errors.append(f"create gave no node id: {created}")
            continue
        # Rewrite the definition while other threads are reading/committing.
        client.call("PATCH", f"/nodes/{node_id}",
                    {"params": {"formulas": [{"name": "f", "expression": "A * 3"}]}})
        result_ids = created.get("resultMatrixIds") or []
        if result_ids:
            client.call("GET", f"/matrices/{result_ids[0]}/window?start=0&count=100")
        status, _ = client.call("GET", f"/nodes/{node_id}")
        if status not in ALLOWED:
            errors.append(f"status -> {status}")
        if i % 2 == 0:
            client.call("DELETE", f"/nodes/{node_id}")
        time.sleep(random.uniform(0, 0.01))


def main() -> int:
    if os.environ.get("DC_RUN_STRESS") != "1":
        print("skipped: set DC_RUN_STRESS=1 to run the node concurrency stress")
        return 101

    ap = argparse.ArgumentParser()
    ap.add_argument("--binary", required=True)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--rounds", type=int, default=25)
    args = ap.parse_args()

    port = free_port()
    tmp = tempfile.mkdtemp(prefix="dc_nodes_stress_")
    # The backend keeps matrices in memory only, so `tmp` is just a unique working dir.
    proc = subprocess.Popen(
        [args.binary, "--port", str(port)],
        cwd=tmp, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    client = Client(port)
    try:
        if not wait_for_hello(client):
            print("FAIL: backend did not answer /hello")
            return 1

        status, matrix = client.call(
            "POST", "/matrices",
            {"name": "stress", "columns": [
                {"posName": "Pos.1", "annotation": "A", "data": list(range(1, 101))}
            ]},
        )
        if status != 200:
            print(f"FAIL: matrix registration -> {status} {matrix}")
            return 1
        matrix_id = matrix["matrixId"]

        errors: list = []
        threads = [
            threading.Thread(target=worker, args=(client, matrix_id, args.rounds, errors))
            for _ in range(args.threads)
        ]
        started = time.time()
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        elapsed = time.time() - started

        # 1. the process survived
        if proc.poll() is not None:
            print(f"FAIL: backend died during the run (exit {proc.poll()})")
            print(proc.stderr.read().decode()[-2000:])
            return 1
        # 2. it still answers
        status, _ = client.call("GET", "/hello")
        if status != 200:
            print(f"FAIL: backend stopped answering (status {status})")
            return 1
        # 3. no unexpected statuses
        if errors:
            print(f"FAIL: {len(errors)} unexpected results, first 5:")
            for line in errors[:5]:
                print("  -", line)
            return 1
        # 4. a freshly built node still computes the right numbers after the churn
        status, created = client.call(
            "POST", "/nodes",
            {
                "signatureId": "builtin:expression-columns",
                "inputs": [{"portId": "src", "mode": "matrix", "sourceMatrixId": matrix_id}],
                "params": {"formulas": [{"name": "double", "expression": "A * 2"}]},
            },
        )
        if status != 200 or created.get("state") != "done":
            print(f"FAIL: post-churn node -> {status} {created}")
            return 1
        result_id = (created.get("resultMatrixIds") or [None])[0]
        window = urllib.request.urlopen(
            f"{client.base}/matrices/{result_id}/window?start=0&count=100", timeout=10
        ).read()
        # DCM2: magic, rows, cols, namesLen, totalRows, totalCols, then column-major
        # doubles. (DCM1 was the same without the two totals; the header grew so a window
        # can advertise the full table shape.)
        import struct
        magic, rows, cols, _names = struct.unpack_from("<IIII", window, 0)
        header = 24 if magic == 0x44434D32 else 16
        values = struct.unpack_from(f"<{rows * cols}d", window, header)
        first = values[0:min(rows, 3)]
        if rows != 100 or cols != 1 or list(first) != [2.0, 4.0, 6.0]:
            print(f"FAIL: post-churn numbers wrong (rows={rows} cols={cols} first={first})")
            return 1

        print(
            f"PASS: node concurrency stress  threads={args.threads} rounds={args.rounds} "
            f"elapsed={elapsed:.2f}s  result=100x1 [2,4,6]"
        )
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
