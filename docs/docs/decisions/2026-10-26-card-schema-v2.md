# 决策：卡片数据结构 v2 —— 依赖升为信封一等公民，函数卡 = 单节点 K 输出

- **日期**：2026-10-26
- **状态**：🔒 规格已锁定（方向已定；**代码迁移未开始**，是后续独立任务）
- **标签**：`#架构 #卡片模型 #持久化 #函数卡`
- **基线**：本决策实施前的回滚点为 `0d839c9`。
- **配套文档**：[端口语义规格 v1](../architecture/port-semantics-v1.md)。本决策定义“卡片长什么样”，
  那份定义“端口是什么意思”。未来插件 C 头只是这两份文件的投影，**本次不冻结**。

## 核心表述

> **卡片接口数据结构自 v2 起锁定。** 依赖（`inputs[]`）从各卡种载荷散落的状态升为
> `CardBase` 信封上的一等公民，成为**唯一**的依赖表示；函数卡从“每列一个节点”改为
> “一个节点、K 个输出”；数据引用指向**显式矩阵**而非“卡片 + 隐式 activeSource”。
> 插件 C ABI 只锁语义内核（端口身份、缺失语义、K 由签名固定、单一入口），字节布局延后。

## 背景

十轮插件 ABI 推演（.so/.dll + Eigen 矩阵接口）的最终结论：**每个 ABI 问题都是卡片模型的投影，
而卡片模型本身有三处结构缺陷**，且每一处都已经挡着一个发生过的产品缺陷或计划中的功能。

| # | 缺陷 | 实证 | 后果 |
|---|---|---|---|
| 1 | 依赖不在信封上，每种卡各自表述 | `web/src/ui/types.ts:27-34`（`CardBase` 无 inputs）；`formula.sourceCardId`（:107）、`chart.config.sources[]`、`matrix.sources[]` 各一套 | 依赖重建只能逐 kind 手写 → **公式卡依赖重载后静默丢失**（[max-headroom-principle.md:87](2026-10-15-max-headroom-principle.md)、history.md:189）的根因 |
| 2 | 引用指向“卡片”而非“矩阵” | `sourceCardId: number` 单值；数据实际挂在 `sources[activeSource]` 上 | 多端口不可表达（函数卡 N-in 的路障）；切换数据卡内文件会**静默改掉**公式的输入 |
| 3 | 函数卡 = N 个节点（每输出列一个） | `types.ts:127` `nodes[]` 与 `formulas[]` 索引对齐；`backend/src/nodes.cpp:319` 每个结果包成单列 `"Pos.1"` | 只能表达同型列输出；K 个节点重复 gather 同一份输入 K 次；SVD 类异构 K 输出不可表达 |

同时，端口的三份定义互不一致，且**没有任何跨层裁判**：

- 前端卡片模型：无端口概念；
- 前端 DTO `web/src/backend/client.ts:75-80` `PortBindingDto`：`varName/mode/sourceMatrixId/sourceNodeId`；
- 后端 `backend/src/nodes.h:27-32` `PortBinding`：与 DTO 同构，但注释明写
  “ordered; **index == port index**”——按位置定位端口；且无输出引用（K 输出在后端同样不可表达）。

对照：表达式引擎已有跨层裁判（`web/tests/fixtures/xlayer/expression.v1.json`，46 例差分夹具，
TS `xlayerFixtures.test.ts` 与 C++ `fixture_runner.cpp` 双边消费 + `DC_RUN_FUZZ` 随机对拍），
而卡片模型一个夹具都没有——两侧各自演化的风险随函数卡开工只会放大。

**持久化面**：工作区快照是**用户手里的文件**（下载/上传，`web/src/ui/fileActions.ts:170-183`，
`version !== 1` 直接拒绝）。每多导出一份工作区，未来迁移面就扩大一分。这是“现在锁定”的直接理由。

## 选项

| 选项 | 内容 | 判定 |
|---|---|---|
| A. 锁定 v2 结构（本决策） | inputs 升信封 + 显式矩阵引用 + 单节点 K 输出；C 头只锁语义 | ✅ **采纳** |
| B. 维持现状，逐 kind 修补 | 继续“每张卡各写各的依赖” | ❌ 否：静默丢依赖的根因原样保留 |
| C. 同时冻结 `dc_plugin.h` 字节布局 | 现在把 C ABI 定死 | ❌ 否：`FunctionSignature` 尚不存在，C 头只是它的投影——先锁投影等于在没有单一事实源时锁死下游；且事实上排除 WASM 层用 Rust `repr(C)` 干净实现的可能 |

## 决策内容

### 1. v2 卡片结构（TypeScript 侧权威定义）

```ts
// ── 信封（所有卡种共用；依赖的唯一权威表示）──
export interface CardBase extends CardBounds {
  id: number;
  kind: CardKind;          // 'matrix' | 'chart' | 'formula'（判别值不变，避免无谓迁移）
  title: string;
  z: number;
  createdAt: number;
  /** 一等公民：这张卡读了谁。依赖图重建 = 遍历此数组，零 kind 知识。 */
  inputs: PortConnection[];
}

/** 一条数据依赖。portId 是稳定身份；显示名改名不得改 portId。 */
export interface PortConnection {
  portId: string;
  target:
    | { type: 'matrix'; cardId: number; matrixId: number }                            // 整矩阵
    | { type: 'cell';   cardId: number; matrixId: number; column: number; row?: number }; // 单列/单格
}

// ── 函数卡载荷（v2）──
export interface FunctionCardModel extends CardBase {
  kind: 'formula';
  /** 引用函数签名注册表；内置函数与未来插件共用同一签名机制（见端口语义规格）。 */
  signatureId: string;
  /** 参数与数据分离：标量/配置走这里，绝不进 inputs[]。 */
  params: Record<string, unknown>;
  /** K 个输出 = 一个节点。K 由签名固定，永不由数据决定。 */
  outputs: Array<{ outputId: string; resultMatrixId: number }>;
  /** 单个后端 compute 节点；注册未完成或后端不可达时为 null（四态灯语义不变）。 */
  node: NodeStatus | null;
}
```

其余卡种的不变量：

- **矩阵卡**：`inputs` 恒为 `[]`（它是数据源，不依赖任何卡）；`sources[]` 保留——那是“内容”不是“依赖”。
- **图表卡**：`config.sources[]` 降级为**显示层视图**；权威依赖边 1:1 写入 `inputs[]`。
  依赖重建从此**只读 inputs，不读任何载荷**。

### 2. 后端同构体（`backend/src/nodes.h` 目标形态）

```cpp
struct PortBinding {              // v2：与 TS PortConnection 同构
  std::string portId;             // 稳定身份；废除 "index == port index" 位置约定
  std::string mode;               // "cell" | "matrix"（语义不变）
  int64_t sourceMatrixId = -1;
  int64_t sourceNodeId = -1;
  int32_t sourceOutputIndex = 0;  // ← 新增：K 输出节点的哪个输出（v1 数据恒为 0）
};

struct ComputeNode {
  // id / kind / state / errorCode / errorParams 不变
  std::vector<PortBinding> inputs;      // 不再按位置定位
  std::vector<int64_t> resultMatrixIds; // ← 原单值 resultMatrixId；按签名输出序索引
};
```

`resultOwner_`（`nodes.h:128`）相应扩展为 `matrixKey(result) → (nodeId, outputIndex)`——
结果矩阵继续作为图的中间边，多输出只是边上多一个序号。

### 3. 持久化与迁移（`WorkspaceSnapshot.version: 2`）

- `readWorkspace` 接受 `version: 1 | 2`；v1 经**纯函数、确定性**的 `migrateV1toV2` 升为 v2 后进入 store；
  写出永远是 v2。
- 迁移规则：
  - 矩阵卡：补 `inputs: []`；
  - 图表卡：由 `config.sources[]` 1:1 生成 `inputs[]`（portId 派生规则实现期定，必须确定性）；
  - 公式卡：
    - `sourceCardId` + 列绑定 → `inputs[]`，其中 `matrixId` **在迁移时刻解析固化**为当时的
      `sources[activeSource].matrixId`。⚠️ 这是**有意的行为变更**：v2 函数卡的输入是显式矩阵，
      切换数据卡内文件不再静默改函数输入；重新指向是一次显式操作（重连线）。
    - `formulas[]` + `nodes[]` → 单节点：`signatureId = 'builtin:expression-columns'`，
      `params.formulas = formulas`，`outputs = [{ outputId: 'result', resultMatrixId: 卡级结果矩阵 }]`；
      `node` = 原 `nodes[]` 状态归并（任一 error → error；任一 computing → computing；
      全 done → done；存在 null → null）。
    - 删除 `nodes[]`、`sourceCardId`。
- **无双字段过渡期**：`inputs[]` 与 `sourceCardId` 不并存，迁移一次性完成
  （并存会让“逐 kind 手写依赖”的根因换个形态复活）。
- 迁移函数带夹具：输入 v1 快照 JSON → 期望 v2 快照 JSON，vitest 消费。

### 4. 跨层裁判（卡片层夹具）

照抄 `xlayer` 模式，新建 `web/tests/fixtures/cards/`：同一份 JSON，TS 解析成 `CardModel`、
C++ 解析成 `ComputeNode` + 边集，输出**规范化图**逐字段对拍。首批至少覆盖：
三种 target 形态（matrix / cell / node 输出引用）+ 一个 v1→v2 迁移用例。
（夹具格式细则属实现任务，本决策只立“必须有裁判”这条。）

## 原因

**斟酌时间按“改起来多贵”分配，不按话题复杂度分配。**

| 层 | 被什么固化 | 改动成本 | 本决策处置 |
|---|---|---|---|
| 卡片 schema | 持久化文件（用户手里）+ 每卡种 UI 组件 + 协议（缓存/DCM1/事件流） | **最高，且随每份导出快照递增** | 🔒 现在锁定 |
| 端口语义 | FunctionSignature 的单一事实源地位 | 中（下游全是投影） | 🔒 语义锁定（配套文档） |
| 插件 C 字节布局 | 零依赖者，无人链接 | **最低，随时可推翻** | ⏸ 只记录，不冻结 |

十轮 ABI 推演没有白做：它产出的全部约束（K 输出、端口身份、缺失语义、数据面分离、单一入口）
的正确归宿是这份卡片模板和端口语义规格，而不是那个 `.h`。

## 明确不做（本轮范围外）

1. ❌ 不写 `include/dc_plugin.h`，不冻结 `abi_version` / `struct_size` 校验策略 / arena 分配接口签名。
2. ❌ 不改 `types.ts` / `client.ts` / `nodes.h` 任何现有代码——本决策只是规格；代码迁移是下一个独立任务。
3. ❌ 不重构图表卡载荷内部结构（只加“inputs 是唯一权威依赖”的不变量）。
4. ❌ 不允许 `inputs[]` 与旧 `sourceCardId` 并存过渡。

## C 头冻结的重访触发条件（任一满足即启动）

1. 第一个外部贡献者出现；或
2. 某个函数因“需要重编译后端”而被实际跳过或延期。

冻结前必须先解决两个未决语义（见[端口语义规格 §未决](../architecture/port-semantics-v1.md)）：
ABSENT 在 C 边界的编码方式；params 进入 C 边界的形态。

## 相关已知风险（记录，不在本轮处理）

- `nodes.cpp:361-366`：`recomputeSubtree` 持 `mu_` 调 `evaluateNode`——慢函数卡上线前必须改为
  不持锁求值，否则违反 [max-headroom 原则](2026-10-15-max-headroom-principle.md)。
- `matrix_store.h`：逐列独立分配（`vector<Column>`）无法给出 `(data, ld)` 连续视图；
  `patchCells` 原地改与 pull 模型要求的不可变快照冲突。存储层连续性是数据面拉取的前置，属实现阶段第一优先。
