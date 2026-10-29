# 决策：函数卡输出是可绑定的数据源 —— 派生矩阵走「回退查询 + 补绑」

- **日期**：2026-10-28
- **状态**：✅ 已实施（`backendMatrixIdFor` 回退解析、两处补绑、合并式去重、关卡孤儿清理、空态可见性）
- **标签**：`#架构 #前端 #函数卡 #数据流`
- **上游决策**：[卡片数据结构 v2](2026-10-26-card-schema-v2.md)、
  [端口级连线](2026-10-28-port-level-connections.md)、
  [后端拥有计算](2026-10-17-backend-owns-compute.md)

## 核心表述

> **函数卡的输出表在浏览器里只是显示缓存（`displayMatrixId`，本地 id），它的权威副本是后端的
> 结果矩阵（`outputs[].resultMatrixId`）。** 绑定 resolver 先查「本地 → 后端」映射表，查不到再
> 按 `displayMatrixId` 找到拥有它的公式卡，回退到那张卡的结果矩阵 id。绑定失败不是错误状态，
> 而是「待补绑」；补绑由三个时点收口。

## 背景（这一轮修的是什么）

用户报「无法从函数卡的结果，正常创建图像和子函数卡」。实测拆开是三件事：

| 症状 | 位置 | 根因 |
|---|---|---|
| 链式子卡建出来后永远「No result yet」 | `addFormulaCard` 把输入写成 `matrixId: 父卡.displayMatrixId`（`workspaceStore.ts:1564-1567`） | `displayMatrixId` 是本地 id，从未进 `backendMatrixIds`（只有上传表 `:1093` 与 restore `:2210` 写入，且 `:2196-2200` 明确排除派生表）；`portBindingsFor` 返回 `null`，`syncFunctionCard` 静默 `return` |
| 打开文件后立刻建卡，卡永久 idle | `addMatrixCard` 的上传是 fire-and-forget（`:1086-1094`） | 上传完成时没有任何人重试绑定 |
| 「建图像」也不好用 | `FormulaCard` 只在 `cols > 0` 时渲染结果表（`:606`） | 结果表为空 ⇒ 表头不存在 ⇒ 右键入口（图像 + 子函数卡）整体消失。图像本身在有结果时是好的 |

同时顺带证实两个既有缺陷：`syncFunctionCard` 没有并发去重（编辑落在 create 在飞 → 两个 node，
输的那个成为服务端孤儿）；`syncFunctionCard` 在关卡竞态下同样会留下孤儿 node。

## 决策内容

1. **回退查询，不往映射表写派生 id。** 新增 `backendMatrixIdFor(localId)`：先查
   `backendMatrixIds`，未命中再按 `displayMatrixId` 找到公式卡并取 `outputs[0].resultMatrixId`
   （`> 0` 才算数）。理由：派生矩阵的权威 server id 本来就在 `outputs[]` 上；写第二张可变表要多付
   `removeCard` / `reset` / `restore` 三份生命周期税，而映射表今天只有 `portBindingsFor`
   一个消费者（`bindings.ts` 保持纯函数，卡片 fixture 与它共用同一约定）。
   后端侧无需改动：`nodes.cpp:401-414` 本来就把结果矩阵当合法 `sourceMatrixId`（并可继承上游 error）。

2. **补绑三个时点。** ① 本卡 push 成功后 `syncUnboundDependents(cardId)`：依赖它的未绑定公式卡补跑，
   覆盖「上游还在算 / 还没有 node 时先建了下游」；② 矩阵注册成功回调里
   `syncUnboundReadersOfMatrix(matrixId)`：覆盖上传竞态；③ restore 时逐卡 `syncFunctionCard`，
   派生表按既有约束**不**重新注册为源表，结果 id 由 `outputs` 清零后重新创建，靠 ① 收口。

3. **合并式去重，不丢弃编辑。** `syncFunctionCard` 拆成「去重外壳 + `pushFunctionCard`」：
   同一张卡 push 在飞时，后来者只记 `resyncRequested`，push 结束（`finally`）后再跑一次。
   丢弃会丢用户最后一次表达式编辑；不合并会重复建 node。`reset()` / `loadSnapshot` 递增模块级
   `workspaceEpoch` 并清空两张簿记：卡 id 在 reset 后从 1 重排，上一代 workspace 的迟到响应不得
   把 node 绑到继承同 id 的新卡上。

4. **关卡竞态清理。** create 落地后复查卡是否仍是当初发起的那张（按 id + `createdAt`）；已被关闭则
   `DELETE /api/nodes/{id}`，否则孤儿 node 与其结果矩阵会永久留在服务端（`removeCard` 只能删它知道的 node）。

5. **PATCH 不覆盖输出 id。** create 响应带 `resultMatrixIds`，PATCH 只回 `nodeId + state`
   （`http_server.cpp:652-654`），所以空列表不写 `outputs[]`；旧值保留。

6. **失败必须可见。** 空态按状态分支：`computing/dirty` → 等待；`error/stale` → 「计算失败 — 原因见上方」；
   `node === null` → 「尚未绑定后端计算节点」+「重算」（直连 `store.recomputeFormula`，不新增 prop 透传）；
   `done` 但 0 列 → 「暂无结果」。旧文案「输入表达式以计算派生列」在表达式明明存在时是误导，已删。
   单列结果下的菜单项灰置保留（尾随列不足是事实），但补一行说明；结果列在菜单打开期间变少时自动关菜单，
   标题越界走防御分支而不是抛 `TypeError`（`MatrixData.column()` 无边界检查）。

## 测试锁定

- 链式绑定：**2 次 POST**、下游 payload 的 `sourceMatrixId === 上游 outputs[0].resultMatrixId`、
  下游 `node.nodeId > 0`——旧的 `:1385` 用例只有本地 id 与依赖边断言，node 从未创建也能绿。
- 新增：上游在建时建下游、上传注册竞态、编辑落在 create 在飞（只 1 次 POST + 最后一次表达式）、
  restore 重绑、关卡孤儿清理（DELETE 恰 1 次）、reset 换代（迟到的 node 被释放、不绑定新卡）。
- stub 的 PATCH 与真服务器对齐（只回 `nodeId + state`），否则「空列表不覆盖输出 id」的守卫不可测。
- DOM：空态三支 + 重算回调、错误态、单列灰置 + 提示、缩列不崩且菜单自关、表头右键不冒泡到 document。
- e2e：`smoke.mjs` 11d——结果列建图、链式子卡出自己的结果、按依赖顺序清理。
- 变异验证：去掉 resolver / 注册补绑 / 依赖补绑 / 孤儿清理 / 回滚组件，各自都有用例变红。

## 遗留（后续，不在本轮范围）

- **页面刷新而后端仍活时会泄漏旧 node**：`normalizeRestoredCards` 清零后强制重建，旧 node 无人回收；
  `client.getNode` / `listNodes` 定义了但从未在 store 里使用。建议 restore 时先对账（复用或删除）。
- `closeAllCards` 只清状态，不释放服务端矩阵 / node，也不清两张同步簿记（既有泄漏），建议日后与
  `reset()` 对齐。
- `addChartCard` 的若干 `null` 分支（`:1143/:1145/:1166`）在 UI 上不可达（菜单已按 `minimumColumns`
  禁用），保持静默、未加 toast；若将来从其他入口调用需补提示。
