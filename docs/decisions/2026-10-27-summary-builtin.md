# 决策：摘要（`builtin:summary`）v1 —— 统计量目录、惰性求值、数字归后端

- **日期**：2026-10-27
- **状态**：✅ 已实施（P1：后端能力 + 跨层夹具；前端面板 P2、统计对账 P3 另案）
- **标签**：`#架构 #函数卡 #签名 #统计 #惰性求值`
- **配套文档**：[端口语义规格 v1](../architecture/port-semantics-v1.md)、
  [后端协议 v1](../architecture/backend-protocol-v1.md)、
  [卡片数据结构 v2](./2026-10-26-card-schema-v2.md)、[函数卡的三个契约](./2026-10-27-card-contracts.md)
- **基线**：本决策实施前打过一次本地分支快照作为回滚点（快照名不入库）。

## 核心表述

> **摘要 = 统计量目录 × 输入变量。**每一行是一条统计量（身份是目录里的 id），每一列是输入
> 表的一个变量（身份、标签都继承源列）。算术只有一处实现（表达式引擎），本能力只是把
> 目录里的 id 映射成表达式，再排成一张表。
>
> 它是**第一个惰性签名**：创建只登记形状，不计算；唯一触发是
> `POST /api/nodes/{id}/compute`。未请求（`notRequested`）与上游已变（`upstreamChanged`）
> 用同一个 `dirty` 态 + `reason` 字段区分——**不新增第五态**。

## 一、统计量目录（statistic catalog）

目录的**顺序即输出行顺序**，id 是稳定身份（发布后永不改名、永不复用，规则同 `portId`）。
表在 `backend/src/signature.cpp` 的 `summaryStatCatalog()`，`params.stats` 只能从这个目录里
**筛子集**，不能重排——行的身份一旦取决于用户输入顺序，"第几行是什么"就退化成位置依赖，
这与本仓库锁定的 `portId` 规则直接冲突。

| 行 | id | 口径 |
|---|---|---|
| 1 | `n` | 有限值个数（NaN 与 ±Inf 都不计） |
| 2 | `nan` | **只数 NaN**（±Inf 不计） |
| 3 | `mean` | 有限值均值（n=0 ⇒ NaN） |
| 4 | `sd` | 样本标准差，ddof = n−1；n=1 ⇒ 0；**n=0 ⇒ NaN** |
| 5 | `var` | 与 `stats.ts variance()` 同原语 `ss/(n−1)`（= sd²，与 `sd*sd` 可能差 1 ulp） |
| 6 | `min` | 有限值最小值（n=0 ⇒ NaN） |
| 7 | `q1` | `QUANTILE(A, 0.25)`，R-7 线性插值 |
| 8 | `median` | `QUANTILE(A, 0.5)` |
| 9 | `q3` | `QUANTILE(A, 0.75)` |
| 10 | `max` | 有限值最大值（n=0 ⇒ NaN） |
| 11 | `iqr` | `q3 − q1` |
| 12 | `sem` | `sd/√n`；**n<2 ⇒ 0** |

R-7 的定义与 `web/src/core/stats.ts:81` 的 `quantile()` 逐位一致：`pos=(n−1)·q`、
`lower=floor(pos)`、`fraction=pos−lower`、在 `data[lower]` 与 `data[upper]` 之间线性插值；
q 越界按参考实现 **clamp 到 [0,1]**，q 非有限 ⇒ NaN（参考实现会算出 `data[NaN] → undefined`，
本侧显式挡掉，两侧都由 `xlayer` 夹具钉住）。

## 二、为什么 `nan` 不把 ±Inf 一起数

±Inf 与 NaN 是**不同的数据缺陷**（除零 vs 0/0），混成一个数就再也分不出来。目录保持 12 项、
`nan` 只数 NaN，代价是"只有 ±Inf 的列"呈现为 `n=0, nan=0, 其余 NaN`——这一条**明示为已知缺口**，
而不是静默行为。加第 13 项 `inf` 是一次目录成员变更，按本文件 §七 的流程走。

## 三、输出形状与行身份

- **K = 1**：一个输出表。K 由签名固定，统计量个数**不参与 K**。
- **行数 = 选中目录项个数**（默认 12），**列数 = 选中输入变量个数**。两者都是数据（与
  `builtin:expression-columns` 的"列数随表达式个数变、K 恒为 1"同一条逻辑）。
- **行身份靠隐含顺序**：传输层没有行标签通道（`Matrix` 只有列 `annotation`，DCM1 帧的
  `names` 只装列标签）。行 `i` ⇔ 目录第 `i` 项，由本文件 + 夹具的逐值比对共同守卫
  （顺序错位则数值对不上，`ctest card_fixtures` 变红）。
- **列标签原样继承源列的 `(posName, annotation)`**：有表头的源列 → 标签仍是 `Pos.1 A`；
  无表头的源列 → 标签是 `Pos.7`，**绝不发明 A/B/…/BA 这类字母名**（字母在第 27 列之后既说不清
  位置也说不清顺序，而 `Pos.N` 无上限且与装载器一致）。代价：输出矩阵的 `posName` 表示
  "源矩阵的第 N 列"，不是"本矩阵的第 N 列"——本仓库没有任何逻辑依赖 `posName` 的本矩阵序号
  （它只被 `Matrix::label()` 用来拼显示标签，而 DCM1 帧传的就是 label）。

## 四、惰性求值：为什么是签名属性，为什么只有一个触发入口

摘要可能是全仓最贵的一次计算（宽表 × 12 项），用户改一下参数不该立刻付代价；而"创建即算"
的既有签名不能跟着改（`builtin:expression-columns` / `builtin:linear-regression` 的行为是
v2 已发布契约）。因此惰性是**签名属性** `explicitCompute`，经 `GET /api/signatures` 的
`compute: "auto" | "explicit"` 对外宣告。

状态机（四态不变）：

| 事件 | 结果 | `reason` |
|---|---|---|
| 创建 | `dirty`，结果矩阵空 | `notRequested` |
| `POST /api/nodes/{id}/compute` | `computing → done` | — |
| 上游矩阵/节点变化 | `dirty`，结果矩阵**清空** | `upstreamChanged` |
| `PATCH` 参数/连线 | `dirty`，结果矩阵**清空** | `definitionChanged` |
| 求值失败 | `error`，结果清空（既有规则） | — |

- **唯一触发入口** `POST /api/nodes/{id}/compute`。否决把触发塞进 `GET .../result`（读路径
  不得有副作用：重连、长轮询、恢复工作区都会读它）、否决复用 `PATCH`（"改定义"与"要求计算"
  是两个意图，压成一条消息会让"改完参数就自动付钱"变成默认）、否决新增 `/api/summary` 旁路
  （一能力一入口；摘要就是一张函数卡）。
- **过期即清空**，不是"保留旧数 + 状态标志"：`dirty` 的含义必须是"这里的数字不描述现在的输入"，
  与 error 路径同一条规则（审计：下游读到旧数却显示 done）。
- **不新增第五态**：`dirty` 已经表示"数字不新鲜"，灯的语义（灰/黄/绿/红）不该为一类原因分叉。
  `reason` 是纯增量字段，旧客户端忽略即可；`POST /api/nodes` 与 `GET /api/nodes/{id}` 在
  `state == "dirty"` 时携带它。
- **用户原因优先**：`notRequested` 与 `definitionChanged` 不会被后续的上游变化覆盖——"你还没
  让我算"和"你刚改了参数"是用户需要看到的行动，`upstreamChanged` 是事件。
- **下游不评估**：待重算节点的下游被标脏（`upstreamChanged`）而不是拿空矩阵去算——"还没算"
  不是"数据坏了"，后者会让用户去修根本不存在的问题。

## 五、参数（`params`，不属于数据流）

| 参数 | 形态 | 默认 | 非法 |
|---|---|---|---|
| `stats` | `string[]`，目录 id | 全目录 | 目录外 id / 非数组 / 空数组 ⇒ `badSignatureParams{name}` |
| `columns` | `string[]`，与列 `annotation` 大小写不敏感匹配；无表头列用 `posName` 匹配 | 全部列 | 未知名 ⇒ `unknownColumn{name}`；空数组 ⇒ `badSignatureParams{name:"columns"}` |

- `params.columns: []` 是错误而不是"0 列空表"：0 列矩阵在下游绑不上（端口解析直接
  `unknownColumn`），与其让错误在下游伪装成"输入缺失"，不如在源头拒绝。
- 端口 `src` 声明为矩阵（整表）。若客户端把它绑成 `mode:"cell"`（只绑一列），摘要就是"单变量
  摘要"——接受，这是语义的退化情形，不是错误。

## 六、被否决的方案

| 方案 | 否决理由 |
|---|---|
| **复用 `builtin:expression-columns`**（把 12 个表达式塞进一张宽表） | 那张表的列是"每个表达式一列"，语义是"逐行计算"；摘要的列是"每个变量一列"、行是统计量，两者是**转置关系**，塞进去要么污染宽表语义，要么让 K 随统计量个数变（违反 K 由签名固定）。而且它没有惰性：每次建卡都会算。 |
| **前端计算** | 违反 [B 方案](./2026-10-17-backend-owns-compute.md)：数字归后端。同一个统计量两份实现必然漂移，而漂移只能靠长期差分测试维持——本决策把"唯一实现"作为前提。 |
| **`GET .../result?compute=1` 隐式触发** | 读路径带副作用；重连/轮询/恢复工作区都会读它。 |
| **`PATCH` 兼作触发** | 改定义 ≠ 要求计算；且会让"改参数"默认付费。 |
| **新增第五态 `notRequested`** | 灯的语义分叉；`dirty + reason` 已足够表达，且纯增量。 |
| **行标签进 DCM1 帧** | 协议级改动（`Matrix`、`matrix_store`、`window`、前端解码、既有 `matrix.v1.json` 夹具），本片不含；若 P2 证实不可接受，另开决策。 |
| **字母列名（A/B/…/AA/BA）** | 第 27 列之后既不能表达位置也不能表达顺序；与装载器的 `Pos.N` 约定冲突。 |

## 七、已知缺口（明示，不是静默）

1. **行标签不可传输**：行身份只有"目录顺序"一条腿，P2 直接渲染目录 id 原文（不做
   `formula.row.<id>` 那层 i18n）。
2. **`columns` 重名列取首个匹配**：源矩阵两列同名 `A` 时，`params.columns:["A"]` 选第一列。
3. **矩阵模式的 `QUANTILE` 无定义**（与 `MOV`/`EMA` 同类的既有缺口：矩阵模式下落到恒等）。
   摘要走列模式，不受影响。
4. **签名参数元数据未宣告**：`/api/signatures` 目前不描述 `params` 的形状；P2 需要表单时
   三条签名一起补（届时属参数元数据变更，不是新签名）。
5. **`STD` 的 n=0 行为在本片内被修正为 NaN**：原本 `n ≤ 1 ⇒ 0`，与口径表（n=0 ⇒ NaN）和
   `stats.ts stdDev()`（n=0 ⇒ NaN）都不符。修正后 n=1 仍为 0。此变更由
   `xlayer` 夹具的 `sem-over-std-is-one-over-sqrt-n` 与摘要卡片夹具的空列表用例共同守卫。
6. **±Inf 不单列**（见 §二）。

## 八、与会改变这些决定的信号

- 需要**按变量分组/多表联合**的摘要 → `columns` 语义升级，可能要 `params.groupBy`。
- P2 证实"隐含行序"不可用（例如需要导出带行名的 CSV）→ 行标签进协议，走新决策。
- 出现**需要自定义顺序**的产品诉求 → `stats` 从"筛选"升级为"排序 + 筛选"，届时行身份必须
  改为参数携带，且本文件 §一 的"顺序即身份"作废。
- 摘要足够贵以至于需要进度/取消 → 接 `traits.progress` / `/cancel`（既有契约，不用改协议）。
