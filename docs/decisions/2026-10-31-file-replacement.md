# 决策：数据卡可以换文件 —— 换数据自动跟随，切文件仍显式重指向

- **日期**：2026-10-31
- **状态**：✅ 已实施（卡上「替换文件…」+ 拖放到卡；store `replaceCardSources`；下游自动跟随；后端同步释放）
- **标签**：`#前端 #数据卡 #模板复用 #依赖语义`
- **上游决策**：[卡片数据结构 v2](2026-10-26-card-schema-v2.md)（函数卡输入冻结为显式矩阵）、
  [后端持有数据与计算](2026-10-17-backend-owns-compute.md)（计算权威在后端）

## 核心表述

> **换文件是数据变更，切文件是视图变更。** 换文件 = 给槽位一个**新矩阵 id**（copy-on-write），
> 图卡与公式卡一起改读新矩阵并重算；切文件（多文件卡的下拉）仍是 v2 的「黄色重指向条 + 用户点应用」。

## 背景

数据卡从「打开数据文件…」或拖放创建之后，前端没有任何入口能改它显示的文件：

- 卡内只有文件选择框和锁；拖到卡上会冒泡到画布的 `onDrop`，照样新建一张卡；
- store 只有 `addMatrixCard`。保存的工作区（`loadSnapshot`）把矩阵一起写进 JSON，
  恢复出来的模板数据被冻结在文件里。

于是 `保存工作区 → 打开工作区` 只能"看"，不能换一套新数据继续用——`FileIdentity` 的注释
（"传感器导出覆盖 `today.csv`"）描述了真实工作方式，但载入新版本后只能再建一张卡、手工重连。
这是「工作区模板无法复用」的具体形态。

## 决策内容

1. **换文件 = 数据变更，不是视图变更。** 新动作 `replaceCardSources(cardId, entries[, index])`：
   `index` 只换当前活动槽位（卡上按钮），不传则整组替换（拖放）。卡片 id、位置、z、`readOnly`、
   `inputs` 一律不动；快照仍是 `version: 2`，旧模板可继续打开。
2. **copy-on-write，绝不原地改写。** `addMatrixCard` 的身份缓存允许两张卡共用同一 `matrixId`
   （测试锁定）；原地写 `matrices[matrixId]` 会连带改掉另一张卡的数字。因此换文件总是给槽位分配
   **新 id**，并把本卡下游的引用搬到新 id 上。旧矩阵在「无人引用」时释放（本地 + `DELETE /api/matrices`）。
3. **下游自动跟随，且只跟随"同一个槽位"。**
   - 图卡是视图：`refreshDependentsOf(cardId, retiredIds)` 重指向新的活动矩阵并按新数据重绘；
   - 公式卡的输入是本卡某一份文件的显式矩阵：把它改到**对应槽位的新矩阵**（整组替换按槽位序配对，
     新集合更短时未配对的槽位指向新集合第一个文件），注册完成后一次 PATCH 重算，**不产生 `RepointOffer`**；
   - 只改「本卡 → 本卡」的引用：别的卡的公式不会被顺带改掉。
4. **切文件不动。** 多文件卡的下拉仍是 `setActiveSource` + 黄色重指向条（v2 锁定）。两种操作语义不同，
   共用一套 UI 会让人分不清"我换的是数据还是视角"。
5. **两个入口，一个语义。** 卡上「替换文件…」按钮（`pickFiles(false)`，换当前文件）与把文件拖到数据卡上
   （命中 `.card--matrix[data-card-id]`，整组替换）；拖到空白画布仍是新建卡。拖拽时命中的卡高亮，
   提示条改成「松开即可用这些文件替换「X」的数据」。
6. **解析失败整体中止。** 任何文件解析失败 ⇒ 逐条 toast，卡片原数据与连线一动不动（没有撤销栈，
   不允许"换了一半"）。
7. **后端不许留孤儿。** `closeAllCards` 以前只清浏览器，节点与上传的矩阵全留在后端；
   重开模板后旧节点仍读旧矩阵，反过来让换文件时的 `DELETE /api/matrices` 被拒（409）。
   现在关闭全部卡片会先删节点、再删上传矩阵；换文件释放旧矩阵放在「读者已重新绑定之后」
   （`waitForCardPushes`），避免 409。
8. **离线不静默。** 换文件在本地照常生效；注册失败时既有 banner 可见，重连时
   `ensureUploadedMatricesRegistered` 补注册并重推公式卡（此前"离线时新建的表"也永远不补）。

## 选项与权衡

| 方案 | 结论 | 理由 |
|---|---|---|
| 显式重指向条（与切文件一致） | 否 | 模板复用的意图就是"换一套数据"，每张公式卡再点一次"应用"违背意图；且要为新动作复制一套提议机制 |
| 原地改写 `matrices[matrixId]` | 否 | 共享解析的别名会被写穿（改一张卡会改到另一张）；v2 的"冻结引用"也因此名存实亡 |
| 新矩阵 + 本卡引用搬迁（本决策） | ✅ | 数据语义直白、别名安全、旧矩阵可回收；蓝图不必改 schema |

## 关联模块

`web/src/ui/workspaceStore.ts`（`replaceCardSources` / `refreshDependentsOf` / `repointReadersOf` /
`pruneMatrixIfUnreferenced` / `registerUploadedMatrix` / `closeAllCards`）、
`web/src/ui/components/{MatrixCard,CardShell,CardCanvas}.tsx`、`web/src/ui/App.tsx`、`i18n.ts`、
`styles.css`、`web/tests/workspaceStore.test.ts`、`web/tests/InfiniteCanvas.dom.test.tsx`、
`web/scripts/smoke.mjs`。

## 未来影响（已知限制，不是缺陷）

- **没有撤销栈**：换错文件时把旧文件再换回来即恢复（文件在磁盘上）；状态行与表头始终暴露当前文件。
- 图卡对**已消失的列**沿用既有规则（保留旧曲线），换文件时同样成立；形状漂移由
  `params.columnContract` 硬拦（红字断流 + 扩展/解除两条出路）。
- 本轮只做「换」：往多文件卡**追加**单个文件、**删除**某个文件仍未提供。
- 换文件不动 `readOnly`：文件表依旧默认只读，锁按钮语义不变。
