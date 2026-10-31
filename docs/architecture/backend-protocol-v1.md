# 后端协议 v1（backend-protocol-v1）

- **日期**：2026-10-17 · **状态**：**v1 规范（阶段 1–2 已按此实现）**；改实现先改本文，端点与帧格式以本文为准
- **出处**：[B 方案决策](../decisions/2026-10-17-backend-owns-compute.md)
- **原则**：服务端只发结构化数据与错误码；文案、布局、渲染全在浏览器。

## 传输形态

- **HTTP/1.1，`127.0.0.1` 上的本地服务**（默认端口 37811，可配置）。
- 控制消息 = JSON（`application/json`）；矩阵载荷 = 二进制帧（见下）。
- 节点状态推送 = 长轮询 `GET /api/events?since=<seq>`（服务端挂起至有新事件或超时 25 s）。
  WebSocket 升级留待需要更低延迟时再做，**不改变消息语义**。
- 无鉴权（本机单用户工具）。跨机部署前必须先补 token，属已知缺口。

## 握手与版本

```
GET /api/hello
→ { "protocol": 1, "build": "<git-sha>",
    "capabilities": ["expr.v1", "matrix.v1", "signature.v1", "card.v2"],
    "limits": { "maxWindowRows": 5000 } }
```

前端在页面加载时调用。**protocol 不匹配 ⇒ 显式横幅"后端版本不兼容"，拒绝进入工作区**；
连接失败 ⇒ 显式横幅"计算后端不可达 + 重试按钮"，绝不空白（契约 1 的具体化）。

## 资源模型

| 资源 | 权威 | 说明 |
|---|---|---|
| Matrix | 服务端 | `{id, revision, rows, cols, columns:[{name,annotation}]}`；revision 每次内容变更 +1 |
| Node | 服务端 | 计算节点：`{id, kind:"function", inputs:[{varName, mode:"cell"\|"matrix", source:{matrixId}\|{nodeId}}], formula, resultMatrixId, state}` |
| Card | 浏览器 | 几何/层叠/标题，以 `nodeId` 对齐 Node |
| Event | 服务端 | 单调递增 `seq` 的状态流 |

`mode` 由变量声明决定（默认按首字母大小写初始化，UI 可见可改——A/a 显示细节仍商榷中，
协议只保证 mode 是显式字段，永不靠猜）。

## 端点

### 矩阵
- `POST /api/matrices` （JSON：列名+数据，小表/上传解析结果入库）→ `{matrixId, revision}`
- `POST /api/matrices/raw` （二进制帧，见"载荷编码"）→ 同上
- `GET /api/matrices/{id}/window?start=&count=` → 二进制帧（可视行窗口）
- `PATCH /api/matrices/{id}` `{cells:[{row, col, value}]}` → `{matrixId, revision}`
  - 浏览器单元格编辑落盘（`value` 同样接受 `"NaN"|"Infinity"|"-Infinity"` 哨兵）。
  - 任一坐标越界 ⇒ `400 {code:"shapeMismatch"}`，**整批不写入**（不会半更新）。
- `DELETE /api/matrices/{id}` — 仍有节点读取、或本身就是某节点的结果矩阵时
  ⇒ `409 {code:"hasDependents"}`；成功 ⇒ `{deleted: id}`

### 节点
- `POST /api/nodes` `{kind, inputs, formula}` → `{nodeId, resultMatrixId}`
  - 输入绑定成环 ⇒ `409 {code:"cycle", path:[...]}`，**整批原子拒绝**（N 条边要么全加要么全不加）。
- `GET /api/nodes/{id}` → `{nodeId, state, resultMatrixId, code?, params?, reason?}`
  - 阶段 3 新增：读单个节点的权威状态快照。事件流是有界且瞬时的，重连或恢复工作区后前端靠它
    重建四态指示灯与错误码，无需回放历史事件。`state === "error"` 时附带结构化 `code`+`params`。
  - `state === "dirty"` 时附带 `reason`（2026-10-27，纯增量）：
    `notRequested`（建了还没要求计算）/ `upstreamChanged`（上游矩阵或节点变了）/
    `definitionChanged`（参数或连线被改过）。四态灯不变；`reason` 让两种"灰"可区分。
- `GET /api/nodes` → `{nodes: [id, …]}`
  - 阶段 3 新增：列出服务端当前全部计算节点 id，供前端把恢复出的公式卡与服务端权威集合对齐。
- `PATCH /api/nodes/{id}` `{formula?, inputs?}` → 触发重算调度
  - 2026-10-27：对 `explicitCompute` 签名（`builtin:summary`），PATCH **只标脏不计算**
    （`definitionChanged`），旧结果被清空——"改定义"不是"要求计算"。
- `POST /api/nodes/{id}/compute` → `{nodeId, state, resultMatrixIds, code?, params?}`
  - 2026-10-27 新增。`explicitCompute` 签名的**唯一**触发入口；对普通节点等价于"现在就重算一次"。
    不折叠进 `PATCH`（改定义≠要求计算），也绝不进 `GET`（读路径不得有副作用：重连/轮询/
    恢复工作区都会读）。
- `DELETE /api/nodes/{id}` — 有依赖者时 `409 {code:"hasDependents"}`（关闭保护的服务端侧）
  - 成功时一并释放该节点的结果矩阵（前端关卡即回收其显示缓存对应的服务端副本）。
- `POST /api/nodes/{id}/cancel` — 长任务取消

### 事件
- `GET /api/events?since=<seq>&timeout=25` → `[{seq, nodeId?, matrixId?, state, code?, params?}]`
  - `state ∈ dirty | computing | done | error`（前端指示灯：灰/黄/绿/红）

## 载荷编码（二进制帧 · 稠密矩阵显示协议）

矩阵显示只有一种帧格式。`GET /api/matrices/{id}/window`、`GET /api/nodes/{id}/result` 与
`POST /api/matrices/raw` 的请求体都是它——数据文件、函数卡结果没有第二套。

```
magic      u32 = 0x44434D32 ("DCM2")
rows       u32                    本次窗口的行数
cols       u32                    列数
namesLen   u32                    names JSON 的字节数
totalRows  u32                    该矩阵的总行数（与窗口无关）
totalCols  u32                    该矩阵的总列数
data       f64[rows*cols]         column-major，小端
names      namesLen 字节的 JSON 数组（UTF-8），元素是 "Pos.1 annotation" 形式的标签
```
帧长恒为 `24 + rows*cols*8 + namesLen`；小端。`rows`/`cols` 描述**窗口**，
`totalRows`/`totalCols` 描述**整张矩阵**——这是「只取前 100 行却知道表有 165 000 行」的唯一来源，
前端因此可以在不下载全表的前提下显示「显示前 100 行 · 共 165 000 行」。

旧帧 `DCM1`（magic `0x44434D31`、16 字节头、无 total 字段）仍然**被接收**：
`POST /api/matrices/raw` 两个 magic 都认，`total*` 缺省等于窗口大小。服务端只发 DCM2。

`POST /api/matrices/raw` 的请求体就是这一帧（不带 HTTP 分块），服务端解码后与 JSON 端点等价入库。
NaN 原样传输（IEEE 754），前端渲染为 `—` 的既有约定不变。

**响应写回**：服务端对每个连接开 `TCP_NODELAY`，且头与体合并为**一次** `send`。
分两次写会让 Nagle 把第二段压到对端的延迟 ACK 之后——探针实测每个请求固定多出 40 ms，
而函数卡结果是要按窗口分页拉的，这个停顿会乘以页数（见
[结果预览决策](../decisions/2026-10-29-result-preview.md)）。

## v2 增量（卡片 schema v2 / 函数签名）

以下字段全部**纯增量**：只发 `varName` 的 v1 客户端行为不变。

- `PortBinding` 增加 `portId`（稳定身份，缺省回退为 `varName`）与 `sourceOutputIndex`
  （引用 K 输出节点的第几个输出，v1 数据恒为 0）。
- `POST /api/nodes` 增加 `signatureId` + `params`（对象）：

  ```json
  { "signatureId": "builtin:expression-columns",
    "inputs": [{ "portId": "src", "varName": "src", "mode": "matrix", "sourceMatrixId": 7 }],
    "params": { "formulas": [{ "name": "double", "expression": "A * 2" }] } }
  ```

  未知签名 ⇒ `400 {code:"unknownSignature"}`；签名参数缺失/非法 ⇒ 节点进入 error，
  `code:"badSignatureParams"`。`params` 不产生也不删除任何边（参数不是数据流）。
- 节点响应（`POST` / `GET /api/nodes/{id}`）增加 `resultMatrixIds`（按签名输出序的数组，
  K 由签名固定）；单值 `resultMatrixId` 保留为输出 0，向后兼容。
- `PATCH /api/nodes/{id}` 接受 `params`（替换整个参数包并置 dirty）。
- `builtin:expression-columns`：一节点、一宽表输出，每表达式一列（列名作 annotation）；
  取代 v1 的「每公式列一个节点」。列数随表达式个数变化属于**数据**，K 仍为 1。
- **端口绑定 `mode`**：`"matrix"` 绑整张表；`"cell"` + `columnIndex` 只绑该列（越界 ⇒
  `unknownColumn`）。v1 里 `mode` 是装饰字段——标了 `cell` 其实仍绑整表，双输入签名需要的
  正是「端口=一列」，所以它现在真的有语义。
- `builtin:linear-regression`：端口 `x` / `y`（各一列），无参数，输出 `fit` 为签名固定的
  1 行 × 5 列（slope/intercept/r/r2/n）。它不是表达式形状——存在的意义是证明签名模型通用。
- `builtin:summary`（2026-10-27）：端口 `src`（**矩阵**），输出 `result`。形状
  **行 = 统计量目录、列 = 输入变量**；行序是目录序（`backend/src/signature.cpp`
  的 `summaryStatCatalog()`），行身份不随数据变；列标签原样继承源列（无表头列是 `Pos.N`）。
  参数：`params.stats`（目录 id 子集，只筛不排）、`params.columns`（按列名选变量）。
  语义与口径见[决策记录](../decisions/2026-10-27-summary-builtin.md)。
  **它是第一个惰性签名**（`compute: "explicit"`）：创建不算，`POST /api/nodes/{id}/compute`
  是唯一触发；上游变化 ⇒ `dirty` + `reason:"upstreamChanged"` 且结果矩阵被清空。
- `GET /api/signatures` → `{signatures:[{id, version, displayName, compute, inputs:[{portId,
  displayName, required}], outputs:[{outputId}]}]}`：后端能求值的全部函数签名。
  `compute` 取 `"auto"`（建完即算）或 `"explicit"`（须显式触发）。
  前端当前只建一种卡，但这是**函数选择器与插件工具**的发现接口——按端口语义规格，
  内置函数与插件注册进同一张表。
- **能力协商**：`signature.v1` / `card.v2` 是 v2 客户端**必需**的能力。协议号仍是 1
  （字段全增量），但一个不认 `signatureId` 的旧后端会忽略它并求值空 `formula`——
  看起来活着、其实什么都没算。缺能力 ⇒ 前端走既有的「后端版本不兼容」横幅，拒绝进入工作区。

## 结构化错误

```
HTTP 4xx/5xx + { "code": "...", "params": {...}, "position"?: number }
```

沿用 `expression.ts` 现有码表并扩展：
`unexpectedChar unknownFunction expectedCloseAfterArgs badArgCount unknownColumn
expectedClose unexpectedToken trailingToken shapeMismatch singular matrixRequired
notImplemented backendUnavailable hasDependents cycle badFrame payloadTooLarge
internalError upstreamError`

**服务端永不发送面向用户的句子**；前端用 i18n key `formula.error.<code>` /
`backend.error.<code>` 渲染。未知 code ⇒ 前端显示通用兜底句 + 原始 code（可见，不静默）。

## 差分测试契约

`web/tests/fixtures/xlayer/*.json` 是唯一裁判格式，TS 参考实现与 C++ 引擎必须跑同一套：

```json
{ "name": "zscore", "columns": [{"name":"A","data":[1,2,3,4]}],
  "expression": "(A - AVG(A)) / STD(A)",
  "expect": [-1.3416407865, -0.4472135955, 0.4472135955, 1.3416407865],
  "tol": 1e-9 }
```

错误用例用 `"error": {"code": "...", "position": N}` 替代 `expect`。
CI 门禁：夹具在两侧必须同时全绿。
