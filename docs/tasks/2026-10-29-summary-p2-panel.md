# 任务书：摘要面板（P2，前端）

- **日期**：2026-10-29
- **状态**：✅ 已完成（2026-10-31，P2 已合入；验收口径按下方「验收」第 3 条）
- **上游决策**：[摘要（`builtin:summary`）v1](../decisions/2026-10-27-summary-builtin.md)（P1 已实施）
- **后续**：P3 —— 前端统计对账（把「用户会读的数字」全部改成读后端），另案

---

## 前置条件（不满足就别开工）

1. **在途 lane 必须先合入**：工作区当前有 18 个改动文件 + 4 个未跟踪文件，属于「结果预览 / 稠密帧」
   那条 lane（决策草案 `2026-10-29-result-preview.md`），它动了 `workspaceStore.ts`、`types.ts`、
   `i18n.ts`、`client.ts`、`styles.css`、`FormulaCard.tsx`、`http_server.cpp` —— **几乎全是 P2 要动的文件**。
   按 AGENTS.md 的 lane 互斥规则，两个 lane 不得同时改同一批文件。
2. **清理临时探针**：`web/tests/zz-cascade.probe.test.ts`（未跟踪，当前 180s 超时失败）、
   `web/src/probe.ts`（未跟踪）。要么提交它们并让门禁变绿，要么删掉——探针长期留在 tree 里，
   会让下一个人的 `npx vitest run` 每次多等 3 分钟并且红着。
3. **基线自检**（开工第一件事）：

```bash
cd web && npx vitest run          # 必须全绿；当前因在途改动有 2 个失败，属上一条
cd backend && ctest --test-dir build --output-on-failure
# 三个服务（前端 / 后端 / 构建）保持 active
```

## 目标（一句话）

在数据卡与函数卡上，提供一个**卡内可折叠的「摘要」面板**：点一次才算，算完显示
「统计量 × 变量」的表格，可导出 CSV；上游变化后显式变成「待重算」，而不是偷偷显示旧数字。

## 已经做完的部分（P1，不要重做）

| 能力 | 落点 |
|---|---|
| 签名 `builtin:summary`（1 个矩阵端口，K=1，`explicitCompute = true`） | `backend/src/signature.cpp` |
| 统计量目录 `n, nan, mean, sd, var, min, q1, median, q3, max, iqr, sem`（顺序即输出行顺序） | `backend/src/signature.cpp` 的 `summaryStatCatalog()` |
| 求值实现 | `backend/src/summary.cpp` |
| 唯一触发入口 `POST /api/nodes/{id}/compute` | `backend/src/http_server.cpp` |
| `GET /api/signatures` 宣告 `compute: "auto" \| "explicit"` | 同上 |
| 客户端方法 `createNode()` / `computeNode()` | `web/src/backend/client.ts`（约 267 / 331 行） |
| 卡片夹具（`afterCreate` / `trigger` 字段）+ 真后端集成用例 | `web/tests/fixtures/cards/`、`web/tests/backendIntegration.test.ts` |
| 决策记录 | `docs/decisions/2026-10-27-summary-builtin.md` |

## P2 范围

### 1. 面板放在哪

- 数据卡（`kind: 'matrix'`）与函数卡（`kind: 'formula'`）的**卡片底部折叠条**；
  交互形态参考列 dock（`ColumnDock.tsx`）但**不复用它的状态**——列 dock 管"画哪些列"，
  摘要面板管"算哪些统计量"，两者是独立意图。
- 图表卡不在范围内（图表卡的数字是图形指标，另案）。

### 2. 四个可见状态（必须一眼可区分）

| 状态 | 依据 | 界面 |
|---|---|---|
| 未请求 | `state: dirty` + `reason: notRequested` | 灰条 + 「计算」按钮 + 一句说明（这个面板默认不算） |
| 计算中 | `computing` | 黄条 + 进度（沿用既有四态灯的色） |
| 有结果 | `done` | 绿条 + 结果表 + 计算时间 + 「重算」「导出 CSV」 |
| 待重算 | `dirty` + `reason: upstreamChanged` / `definitionChanged` | 黄条 + 原因文案（「上游已变」/「参数已改」）+ 「重算」 |

**注意**：过期时后端已经把结果矩阵**清空**（决策 §4），所以前端拿到的是空矩阵，
必须显示"待重算"而不是渲染一张 0 行表，也**不能**显示 `0`。

### 3. 结果表

- 行 = 选中的统计量，**按目录顺序**，行名直接渲染目录 id 原文（`n` / `nan` / `mean` / …）。
  决策 §7 已把"行标签不可传输 / 不做 i18n"列为明示缺口——**P2 不要自己发明中文行名**，
  否则行身份会分裂成两套。
- 列 = 选中的输入变量，列名继承源列标签（`Pos.1 A` 这种）。
- 数值格式化**复用虚拟表格已有的格式化函数**，不要新造一套（两套格式化 = 两套四舍五入）。

### 4. 节点生命周期（P2 唯一需要新决定的地方，须在计划里说明）

<写清楚你选哪个，并给出理由>

- **方案 A（推荐）**：首次点「计算」时才创建 `builtin:summary` 节点。
  理由：避免"每张卡都长一个节点"；创建即 dirty 的节点如果一张卡一个，节点表会翻倍。
- **方案 B**：卡片创建时就建节点但不触发。理由：状态更好读；代价是节点冗余。
- 无论哪个方案：**同一张卡只有一个 summary 节点**，重算走 `computeNode`，不要重复创建。

### 5. 参数（可选做，别顺手扩）

- `params.stats`：只允许**筛子集**，不允许重排（决策 §1 已把顺序定死）。
- `params.columns`：默认全部列。
- 空数组是错误（`badSignatureParams`），不是"空表"。

### 6. 持久化

v1 **不做持久化**：面板开合、选中的统计量都是会话内状态，不写进工作区快照。
理由：`kind` 与卡片模型一旦加字段就要升 schema v3 + 迁移 + 夹具，这一片不值得。
如果将来要持久化，先补决策记录。

## 契约红线（不得违反）

- **不得在前端计算任何统计量**（B 方案）。所有数字来自后端。
- **不得新增第二个入口**：不许开 `/api/summary`，不许在 `GET .../result` 里隐式触发（决策 §4 已否决）。
- **不得新增第五态**；`dirty + reason` 是既定表达，原因字段是纯增量，旧客户端忽略即可。
- **不得改后端协议**。若确实要改（例如行标签入帧），先开决策记录，再动代码。
- **不得碰在途 lane 的文件**（见前置条件第 1 条），除非它已合入并与作者确认。
- 文档里的数字必须来自命令输出，**禁止凭记忆写**（本仓库已因此踩过两次）。

## 验收

```bash
cd web && npx vitest run                                   # 全绿（新增 DOM 测试）
cd backend && cmake --build build && ctest --test-dir build --output-on-failure
cd web && node scripts/smoke.mjs http://127.0.0.1:4173      # 需先 npm run preview；新增下列检查
# 三个服务（前端 / 后端 / 构建）保持 active
```

`smoke.mjs` 必须新增（端到端，真实后端）：

1. 摘要面板展开后显示「未请求」且**没有**任何数字；
2. 点「计算」→ 出现 12 行结果，行名是目录 id；
3. 改上游：**原地编辑一格** → 面板变「待重算」（后端推 `dirty` + `upstreamChanged`），表格为空；
   **切文件 / 换文件** → 面板回到「未请求」，一个数字都不显示。
   > 记：原稿把「切文件」也算成待重算，实现时作者明确接受此偏差并给了理由——数据卡的摘要绑的是它
   > **当前活动文件**的矩阵，换一张表就是另一个问题，所以宁可释放节点、回到未请求，也不把上一张表
   > 的数字留在屏上；只有原地改格子才走 `dirty`。
4. 再点「计算」→ 结果回来，且时间戳更新；
5. 导出 CSV → 文件头是 12 行 × N 列。

## 提交切分（建议）

1. `feat(web): 摘要面板骨架与四态`（面板组件 + 状态映射 + i18n）
2. `feat(web): 摘要计算触发与结果表`（创建节点 / computeNode / 渲染）
3. `feat(web): 摘要导出 CSV`
4. `test(e2e): smoke 覆盖摘要面板的未请求→计算→待重算→重算`
5. `docs: 任务书状态更新`（本文件第 2 行）

## 完成后请回复

1. 改动文件清单
2. 四条门的实际输出
3. 节点生命周期的选择（方案 A 还是 B）与理由
4. 仍未定 / 需作者裁决的问题（最多 5 条）
