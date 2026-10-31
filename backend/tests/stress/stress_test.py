#!/usr/bin/env python3
"""并发健壮性压测（2026-10-18 审计的回归防线）。

背景：旧构建在 detached thread 里用 std::stoul 解析数字，畸形 HTTP 请求触发
std::invalid_argument/out_of_range 逃逸线程边界 → std::terminate 杀死整个进程。
本脚本自起一个 dc_backend（绝不触碰常驻后端服务），用多线程轰炸畸形/半合法
报文，再验证：
  1. GET /api/hello 仍然存活（服务未死）；
  2. 进程退出码为 None（未被 terminate 杀死）。
每轮独立拉起一个新的 dc_backend 实例（干净状态）。

运行方式：
  python3 backend/tests/stress/stress_test.py [--binary path/to/dc_backend] [--port 37911]
默认相对定位到 <repo>/backend/build/dc_backend（即本文件所在目录的上两级）。
强度可用环境变量覆盖（ctest 用低强度默认值，手动全量更狠）：
  DC_STRESS_THREADS / DC_STRESS_REQUESTS / DC_STRESS_ROUNDS

ctest 集成：backend/CMakeLists.txt 以环境变量 DC_RUN_STRESS=1 门控该用例
（默认 SKIP_RETURN_CODE 101 跳过），避免每次 ctest 都拖慢 CI。
手动跑：DC_RUN_STRESS=1 ctest -R stress --output-on-failure

已知环境噪声：本机 loopback 偶发 TIME_WAIT/临时端口耗尽（其它长连接进程 churn），
会让新建 connect 报 EADDRINUSE——与后端进程存活无关，故 start()/alive() 均带退避重试。
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time


def default_binary() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "build", "dc_backend"))


def _env_int(name: str, fallback: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except ValueError:
        return fallback


class Target:
    """一个被管理的 dc_backend 实例 + 对它发请求的辅助函数。"""

    def __init__(self, binary: str, port: int):
        self.binary = binary
        self.port = port

    def start(self) -> subprocess.Popen:
        last_exc = None
        # 压测自身制造的海量 TIME_WAIT（客户端侧临时端口占用）可能让 bind/listen 短暂
        # EADDRINUSE，重试几次；绝不 pkill 同名进程——37811 上有常驻后端服务。
        for _ in range(10):
            p = subprocess.Popen(
                [self.binary, "--port", str(self.port)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            deadline = time.time() + 5.0
            up = False
            while time.time() < deadline:
                if p.poll() is not None:
                    break  # bind 失败进程即退出
                try:
                    s = socket.create_connection(("127.0.0.1", self.port), timeout=0.5)
                    s.close()
                    up = True
                    break
                except OSError as exc:
                    if exc.errno == 98:  # EADDRINUSE：TIME_WAIT 占位，等一会再试
                        break
                    time.sleep(0.1)
            if up:
                return p
            if p.poll() is None:
                p.kill()
            last_exc = RuntimeError(f"dc_backend failed to come up on port {self.port}")
            time.sleep(1.0)
        raise last_exc or RuntimeError("dc_backend did not open its port in time")

    def alive(self, proc: subprocess.Popen) -> bool:
        """GET /api/hello 仍返回带 protocol 字段的响应 ⇒ 服务活着。

        TIME_WAIT/临时端口耗尽可能让 connect 偶发 EADDRINUSE（本机实测），
        与进程存活无关，故带退避重试：最多 30s；但每轮先 poll()——
        进程若已退出则立即判死，不浪费重试。
        """
        for _ in range(30):
            if proc.poll() is not None:
                return False
            try:
                s = socket.create_connection(("127.0.0.1", self.port), timeout=2)
                s.sendall(b"GET /api/hello HTTP/1.1\r\nHost: x\r\n\r\n")
                s.settimeout(2)
                d = s.recv(400)
                s.close()
                if b"protocol" in d:
                    return True
            except OSError:
                pass
            time.sleep(1.0)
        return False

    def send(self, payload: bytes, retries: int = 3) -> None:
        """连上、发完、读到首段响应即关连接；EADDRINUSE（本机临时端口耗尽）退避重试。

        服务端每连接回一个响应后保持 keep-alive，所以这里不能“读到 EOF”——
        那只会等到超时；正确姿势是收到首段响应就断开（压测只关心进程存活，
        不校验每个畸形请求的状态码）。
        """
        for _ in range(retries):
            try:
                s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
                s.sendall(payload)
                s.settimeout(5)
                try:
                    s.recv(65536)
                except OSError:
                    pass
                s.close()
                return
            except OSError as exc:
                if getattr(exc, "errno", None) == 98:  # EADDRINUSE：等 TIME_WAIT 回收
                    time.sleep(0.2)
                    continue
                return  # 拒连/断链等：视为“被拒绝”，不是失败
            # 成功路径已 return；此处不会到达

    def send_half_closed(self, payload: bytes, retries: int = 3) -> None:
        """发出残缺报文后 shutdown(SHUT_WR)：逼服务端从“等 body”转为“连接关闭”。

        注意：不发 FIN 的纯截断会让 readRequest 里的 recv 永久阻塞（占用该连接线程），
        这是已知行为而非本测试要修的缺陷——压测必须用半关闭模拟真实的中断客户端。
        """
        for _ in range(retries):
            try:
                s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
                s.sendall(payload)
                s.shutdown(socket.SHUT_WR)
                s.settimeout(5)
                try:
                    while s.recv(65536):
                        pass
                except OSError:
                    pass
                s.close()
                return
            except OSError as exc:
                if getattr(exc, "errno", None) == 98:
                    time.sleep(0.2)
                    continue
                return

    def post_matrix(self) -> None:
        d = json.dumps({"name": "x", "columns": [{"posName": "Pos.1", "data": [1, 2, 3]}]}).encode()
        self.send(
            ("POST /api/matrices HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
             "Content-Length: %d\r\n\r\n" % len(d)).encode() + d
        )

    def patch_out_of_range(self) -> None:
        body = b'{"cells":[{"row":99,"col":99,"value":1}]}'
        self.send(
            b"PATCH /api/matrices/1 HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        )

    def malformed_requests(self) -> None:
        """畸形报文集合：全部命中旧代码里 std::stoul 会抛异常而炸进程的路径。"""
        # 非法十六进制 id（chunked 尺寸解析曾走 stoul base16 → invalid_argument）
        self.send(b"GET /api/matrices/zzz HTTP/1.1\r\nHost: x\r\n\r\n")
        # 超 64 位范围的十进制 id（stoul 抛 out_of_range）
        self.send(b"GET /api/matrices/99999999999999999999999 HTTP/1.1\r\nHost: x\r\n\r\n")
        # 负数 id
        self.send(b"DELETE /api/matrices/-1 HTTP/1.1\r\nHost: x\r\n\r\n")
        # Content-Length 非数字（曾走 stoul）
        self.send(b"POST /api/matrices HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n{}")
        # Content-Length 超大但不会真发 body（协议层须拒绝而非分配；带空行保证帧头完整）
        self.send(b"POST /api/matrices HTTP/1.1\r\nHost: x\r\nContent-Length: 99999999999999\r\n\r\n")
        # chunked 尺寸字段是非法十六进制（parseHexSize → from_chars base16 路径）
        self.send(b"POST /api/matrices HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n"
                      b"\r\nzz\r\nbody\r\n0\r\n\r\n")
        # PATCH 越界单元格（应整批拒绝，落盘数据不变）
        self.patch_out_of_range()
        # 截断的报文：半关闭让服务端收到 EOF
        self.send_half_closed(b"GET /api/hello HT")
        # 声明大 Content-Length 却只发一点就关闭写端
        self.send_half_closed(b"POST /api/matrices HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n{")
        # 垃圾字节：服务端读循环把它当未完成的请求头，回 EOF 前不响应——用半关闭
        # 逼出 EOF（实测纯一发不关会白等 5s 超时；这是读取循环的既有行为，非缺陷）
        self.send_half_closed(b"\x00\x01\x02\xff")

    def hammer(self, nthreads: int, n: int) -> None:
        """nthreads 个线程并发混合发送合法 POST 与畸形报文。"""
        def worker(i: int):
            for k in range(n):
                if (i + k) % 3 == 0:
                    self.post_matrix()
                else:
                    self.malformed_requests()
        ts = [threading.Thread(target=worker, args=(i,)) for i in range(nthreads)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--binary", default=default_binary(), help="dc_backend 可执行文件路径")
    ap.add_argument("--port", type=int, default=37911,
                    help="临时监听端口（默认 37911；避开常驻服务的 37811）")
    ap.add_argument("--threads", type=int, default=_env_int("DC_STRESS_THREADS", 40))
    ap.add_argument("--requests", type=int, default=_env_int("DC_STRESS_REQUESTS", 10),
                    help="每线程请求数")
    ap.add_argument("--rounds", type=int, default=_env_int("DC_STRESS_ROUNDS", 3))
    args = ap.parse_args()

    if os.environ.get("DC_RUN_STRESS") != "1":
        # ctest 门控：未显式开启一律跳过（SKIP_RETURN_CODE 101 会被 ctest 记为 Not Run）。
        print("SKIP: set DC_RUN_STRESS=1 to run the stress test")
        return 101

    if not os.path.exists(args.binary):
        print(f"SKIP: binary not found: {args.binary}")
        return 101

    target = Target(args.binary, args.port)
    failures = []
    for r in range(args.rounds):
        p = target.start()
        try:
            target.hammer(args.threads, args.requests)
            time.sleep(0.3)
            rc = p.poll()
            ok = target.alive(p)
        finally:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
        print(f"round {r}: alive: {ok} exitcode: {rc}", flush=True)
        if not ok or rc is not None:
            failures.append((r, ok, rc))

    if failures:
        print("STRESS FAILED:", failures)
        return 1
    print(f"STRESS PASSED: {args.rounds} rounds x {args.threads} threads, service survived")
    return 0


if __name__ == "__main__":
    sys.exit(main())
