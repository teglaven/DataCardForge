# 任务书：状态闸门（STATE.md）+ 引擎层性能门禁

- **日期**：2026-10-29
- **状态**：🚧 执行中（本文件先落盘，之后按本文件执行；聊天里的内容只作口头说明）
- **产物**：`STATE.md`、`scripts/state-check.sh`、`AGENTS.md §0`、
  `backend/bench/bench_engine.cpp`、`backend/bench/budgets.json`、`backend/bench/baseline.json`、
  `backend/CMakeLists.txt`、`docs/decisions/2026-10-29-perf-gate.md`
- **一句话**：给「下一步」留一份可信的起点（STATE.md + 可执行闸门），
  给「变慢了」留一个可执行的数字（引擎层 p50/p95 性能门禁）。**不优化任何引擎代码。**

---

## 0. 边界（违反即停）

1. 工作区已有未提交改动（15 个已修改 + 3 个未跟踪，属于「结果预览 / 稠密帧」lane）。
   **禁止** `git add -A`、`git commit -a`、`git stash`、`git checkout --`、删除或还原这些文件。
   它们不是本任务的。
2. 编译只用 `cmake --build backend/build --target dc_bench`；**不整仓构建**、
   **不重启前后端服务**、**不碰** `backend/src/http_server.cpp`、`backend/src/nodes.cpp`、`web/**`。
3. 只允许改/建这 8 个路径（外加 `docs/README.md` 的 decisions 列表最多一行导航）：
   `STATE.md`、`scripts/state-check.sh`、`AGENTS.md`、`backend/bench/bench_engine.cpp`、
   `backend/bench/budgets.json`、`backend/CMakeLists.txt`、`backend/bench/baseline.json`（生成物）、
   `docs/decisions/2026-10-29-perf-gate.md`。
4. 与清单冲突的现状（`evaluate` 签名已变、函数名不存在、CMake 已有同名目标）：
   **停下，贴现状 + 建议，等裁决**，不自行改方案。

## 1. 编译前置检查（缺一即停）

```bash
git status --short backend/src
```

若 `expression / nodes / matrix_value / matrix_store / json / signature / summary` 的 `.cpp` / `.h`
出现在未提交列表里 → 报告「dc_core 正在被另一个会话修改」，**不编译、不跑基准**。

## 2. 第一件产物：`STATE.md`（根目录，≤40 行）

小节名一字不改：`## 现在是什么` / `## 上次收工点` / `## 已冻结契约（改它要新决策）` /
`## 探索中（可推翻，别当承诺）` / `## 已知缺口（top 5）` / `## 下次开工第一件事（RESUME）`。
所有值（HEAD、UTC 时间、未提交文件）必须取自仓库实况，不许编。

## 3. `scripts/state-check.sh`

bash，`set -uo pipefail`，可执行，仓库根执行，单文件、≤60 行、不引 jq/python：

| 情形 | 输出 | 退出码 |
|---|---|---|
| `STATE.md` 不存在 | 提示 | 2 |
| 缺小节（逐个 grep） | 打出缺哪个 | 2 |
| 落后提交数 ≥ 阈值 | "落后 N 个提交" | 1 |
| 否则 | "STATE.md 新鲜（落后 N 个提交，阈值 N）" | 0 |

阈值默认 10；`--max-commits N` 或 `DC_STATE_MAX_COMMITS` 可调。

## 4. `AGENTS.md` 新增 §0「状态闸门」

- **开工**：读 `STATE.md` → 口述三问（现在是什么 / 上次为什么停 / 这次要验证什么）→ 才动第一个文件。
- **大动作**四条定义：架构/契约改动、跨层改动、发布/公开动作、会话收尾。
- **收工四条**：更新 STATE.md 四字段 → 提交正文加 `RESUME: <…>` → 跑 `scripts/state-check.sh`，
  非 0 不许收工 → 回复里给出三问答案。
- 硬规则：STATE.md 只留最新状态（历史进 `docs/log/`），文档与代码不同步时以 STATE.md 为当前真相。
- §0 末尾附可直接粘给任意 agent 的提示词代码块。

## 5. 性能门禁：`backend/bench/bench_engine.cpp`

自包含 C++17、零第三方依赖（`<chrono>` 计时）、链接 `dc_core`，直接调 `ExprEngine::evaluate`
与 `ExprEngine::evaluateMatrix`，**不过 HTTP**。

- 数据：`mt19937` 固定种子 12345，列名 `a..f`，矩阵变量 `A/B/C`；**输入不许出现 NaN/Inf/denormal**。
- 计时：每例 warmup 3 次，再测 N 次（逐元素 15，矩阵 5），报 **p50 / p95**（ms，两位小数），不报平均值。
- 输出：一张表 + 可选 `--json <path>`；`--case <name>` 过滤；`--update-baseline` 写基线；
  未给 `--update-baseline` 时读 `backend/bench/baseline.json` 做回归比对。
- 退出码：0 全绿 / 1 超预算或回归 / 2 参数或数据错误。
- 扩展：加算法 = 用例表加一行 + `budgets.json` 加一个 `max_ms`，**不改框架**（文件头注释写明）。

| name | 类 | 尺寸 | 公式 |
|---|---|---|---|
| `elem.add` | 逐元素 | 6×100000 | `a + b * 2` |
| `elem.sqrt` | 逐元素 | 6×100000 | `sqrt(a*a + b*b)` |
| `elem.branch` | 逐元素 | 6×100000 | `IF(a > 0, a, -a)` |
| `elem.aggregate` | 逐元素 | 6×100000 | `a / MEAN(a)` |
| `elem.window` | 逐元素 | 6×100000 | `MOV(a, 5)` |
| `elem.k5` | 逐元素 | 6×100000 | 依次 5 条（真实路径：每条都重做 tokenize/列映射/解析/编译） |
| `mx.transpose` | 矩阵 | 6×100000 | `TRANSPOSE(A)` |
| `mx.mixed` | 混合 | 6×100000 | `A * TRANSPOSE(A)` → 6×6 |
| `mx.matmul` | 方阵 | 512×512 | `B * B` |
| `mx.inv` | 方阵 | 512×512 | `INV(B)` |
| `mx.det` | 方阵 | 512×512 | `DET(B)` |
| `mx.solve` | 方阵 | 512×512 | `SOLVE(B, C)` |

## 6. 阈值策略（两遍跑）

1. 第一遍不定卡：`--update-baseline` → `baseline.json`（`machine` = `lscpu` Model name、
   `git` = short HEAD、`taken_at`、每例 `p50_ms`/`p95_ms`）。
2. 生成 `budgets.json`：每例 `max_ms` = 首测 p50 × 3，向上取到 0.1 ms；`regression_ratio: 1.3`；
   注明 `generated_from` 与日期。**不许拍脑袋填数字**。
3. 第二遍带卡跑，必须全绿（退出码 0）。
4. 任何一例超预算 → 贴数字，**不当场优化引擎**，等裁决。

## 7. `backend/CMakeLists.txt`

`add_executable(dc_bench bench/bench_engine.cpp)` + `target_link_libraries(dc_bench PRIVATE dc_core)`；
`add_test(NAME perf_gate COMMAND dc_bench)` + `SKIP_RETURN_CODE 101`；`dc_bench` 未设
`DC_RUN_BENCH=1` 时 `return 101`。**不改** `.github/workflows/ci.yml`。

## 8. 决策记录 `docs/decisions/2026-10-29-perf-gate.md`

写清三件事：① 为什么是这 12 个用例（6×100000 是目标数据形状、512² 是 O(n³) 那一档、
为什么先引擎层后 HTTP 层）；② 阈值来源（首测 p50×3 + 1.3× 相对护栏，机器噪声为什么用相对阈值）；
③ 扩展方式与已知局限（未覆盖 HTTP 层、缓存命中/冷启动差异、CI 不跑）。

## 9. 验收（原样贴输出）

```bash
cmake --build backend/build --target dc_bench
./backend/build/dc_bench --update-baseline      # 第一遍：取基线
./backend/build/dc_bench                        # 第二遍：必须退出码 0
ctest --test-dir backend/build -R perf_gate     # 未设 DC_RUN_BENCH → SKIP
DC_RUN_BENCH=1 ctest --test-dir backend/build -R perf_gate   # PASS
bash scripts/state-check.sh; echo "exit=$?"     # exit=0
nproc; lscpu | grep 'Model name'
git status --short                              # 只多出本任务负责的路径
```

## 10. 提交

三条，中文 conventional commits，**显式列路径**（禁 `-A`）：

1. `chore(state): STATE.md + state-check 闸门 + AGENTS §0 状态协议`
2. `feat(bench): 引擎层性能门禁 —— 12 个用例 + p50/p95 基线`
3. `docs(decision): 性能门禁的用例选择与阈值来源`

提交前逐条核对 `git diff --cached --name-only` 只有上述路径。

## 11. 执行注记（实现时对本文书的两处对账）

1. **§7 与 §9 互斥**：§7 要求「未设 `DC_RUN_BENCH=1` 时 dc_bench 直接 `return 101`」，
   而 §9 要求「`./backend/build/dc_bench`（不带环境变量）退出码 0」——同一条命令不可能既是 101 又是 0。
   本任务按 §7 实现（与本仓库 `fuzz_gate.py` / `nodes_stress.py` 的 opt-in 套路一致），
   §9 的两条直跑命令补 `DC_RUN_BENCH=1` 前缀；不带前缀的裸跑保留为「门禁有效」的证据（exit 101）。
   若裁决要求 §9 字面成立，唯一改法是把跳过逻辑绑到 ctest 调用点（`add_test` 加 `ENVIRONMENT`）。
2. **`STATE.md`「已知缺口」里的行数**：任务口述为「stats.ts 约 1,800 行」，
   仓库实况是 `web/src/core/stats.ts` = 437 行（含直方图 / KDE / 回归 / Pearson）。
   按「值必须来自仓库实况」写 437。
3. **计时卫生（不改用例、尺寸、次数）**：p95 用线性插值而不是「最近秩的最大值」；
   测量前用 `sched_setaffinity` 把进程钉在它当前所在的那颗 CPU 上。后者是实测必要的：
   不钉时调度器会在测量中途迁核，`elem.add`（0.19 ms 这一档）在 0.19 / 0.23 之间跳 21%，
   正好压着 1.3× 回归护栏，门禁会假红；钉住后同一颗核上读数稳定在 1% 内。
   两者都只影响「怎么读表」，不影响「测什么」。基线是在钉核之后取的。
