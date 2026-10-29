# 决策：连线是完整的依赖可视化 —— 边带 portId，端点落端口

- **日期**：2026-10-28
- **状态**：✅ 已实施（依赖图边携带 `portId`、函数卡端口/输出锚点、方向箭头、端口标签、所有边一律绘制）
- **标签**：`#架构 #前端 #连线 #端口`
- **上游决策**：[连线从属原则](2026-08-07-connection-subordination.md)、
  [卡片数据结构 v2](2026-10-26-card-schema-v2.md)、
  [端口语义规格 v1](../architecture/port-semantics-v1.md)

## 核心表述

> **连线的两个坐标都在数据模型里**：一条边是「哪张卡 → 哪张卡」，加上它携带的 `portId` 集合；
> 画出来的线必属于端口——端口没渲染时退到朝向对方的卡片边缘，而不是反过来让端口迁就线。

## 背景（这一轮修的是什么）

2026-10-24 的改判是「连线只对应卡片，不再对应某行某列」（[提交 `fb7b883`]）。它当时正确：
依赖只有「图表 ← 数据卡」一种，卡就是边的全部信息。

2026-10-26 的 schema v2 把这个前提改掉了：依赖升为信封上的 `inputs[]`，函数卡成为真正的图节点，
`portId` 成为**唯一**的端口身份（端口语义规格 §已锁定 1：*连线只认它，永不按位置*）。而渲染层
留在旧世界：

| 现状 | 位置 | 后果 |
|---|---|---|
| 只画「依赖方是图表卡」的边 | `ConnectionLayer.tsx` 的 `isChartCard(targetCard)` 过滤 | `表→函数卡`、`函数卡→函数卡` **一根线都没有**；`表→公式→图` 只看得见最后一跳 |
| 边只有两个卡号 | `DependencyGraph.edges()` | `portId` 在信封上，进图即丢——端口级提示不是「UI 没写」，是**数据面没有字段** |
| 两端都取卡片顶边中点 | `cardTopAnchor` | 目标在下方时线绕圈；无左右/上下方位，也没有方向 |
| 只被函数卡依赖的表拒绝关闭 | 拒绝关闭靠「闪线」反馈 | 那根线不存在 ⇒ 拒绝时**毫无反馈** |

## 决策内容

1. **边携带端口身份。** `DependencyGraph` 的内部结构从 `dependsOn -> Set<dependent>` 改为
   `dependsOn -> Map<dependent, Set<portId>>`；`edges()` 返回 `{dependsOn, dependent, ports}`。
   一对卡仍是**一条边**（10-24 的决定不变，测试 `keeps exactly one line …` 守着），
   端口进集合，`removeDependency(dependent, dependsOn, portId)` 可以只摘掉一个端口。

2. **端口锚点由卡片自己注册。** `cardMetrics.registerPort(cardId, portId, element, side)`
   / `portAnchor(cardId, portId)`：以元素矩形中心为准、除以 zoom 换算到平面坐标，**身份是 `portId`**。
   函数卡的输入端口 chip 与输出行在 ref 回调里注册并在卸载时注销。视图/卡片重置时一并清空。

3. **端点两级解析。** 先 `portAnchor`，再退回朝向对方的卡片边缘（源右侧 / 目标左侧）。
   曲线控制点沿锚点所在边的法向生长，**箭头画在目标锚点上**（三角形几何，不用 `<marker>`——
   `context-stroke` 跨浏览器不可靠；尺寸除以 zoom 保持屏幕上大小恒定）。

4. **一律绘制。** 去掉「只画进图表卡的边」这一过滤。由此拒绝关闭的提示对函数卡依赖也生效
   （线在闪 + toast 仍由 `reportCardClose` 负责）。

5. **提示按需出现。** 选中一张卡时，它的连线中点标出携带的 `portId`（超过两个折叠为 `+N`）。
   **不做 hover**：hover 需要给连线层开 `pointer-events`，而 `pointer-events: none` 是
   [连线从属原则](2026-08-07-connection-subordination.md)明确锁定的——宁可少一个交互，也不改锁定项。

6. **线宽不再随缩放塌掉。** `vector-effect: non-scaling-stroke`。视图范围是 10%–300%，
   1.5 平面 px 的线在 10% 下是 0.15 屏幕 px，等于消失。

## 修正（2026-10-29）

[连线端点落在卡片中心](2026-10-29-connection-center-anchors.md)（同日）取代了本决策的
**决策 3** 与**不变量 2**：

- 端点不再是「端口 → 朝向对方的卡片边缘」，而是**两张卡片窗口的中心**；卡片内那段由遮罩吞掉，
  可见段从边框开始。曲线也换成一整条三次贝塞尔（两个控制点按 |dx|/|dy| 权重混合）。
- `portId` 仍是**数据身份**与标签来源（决策 1、5 不变），但不再是几何锚点。
  `registerPort` / `portAnchor` 保留、`cardMetrics` 测量 API 不变，留给尚未落地的「端口标记兜底」。
- 决策 6 的 `vector-effect: non-scaling-stroke` 也一并撤掉：它只管线宽、管不到虚线段长，
  而选中线现在是流动虚线；线宽与段长改由组件按 `1/zoom` 计算，10%–300% 下屏幕尺寸恒定。

其余条目（边携带 portId、端口注册、一律绘制、K > 1 卡级绘制）继续有效。

## 不变量（改这块时不许破）

- 一对卡一条线；同一张表喂 5 列给同一张图仍是 **1** 根线，端口在标签里列出。
- ~~端点只在**端口确实被渲染**时才落在端口上；错位比缺失更糟，所以缺端口就退回卡片边缘。~~
  → **2026-10-29 起作废**：端点是卡片中心，端口只出现在标签里（见上方「修正」）。
- 连线层永不拦截指针（`pointer-events: none`），永不参与布局。
- K > 1 的输出在卡级绘制：`outputs[].resultMatrixId` 是服务端 id、`displayMatrixId` 是前端 id，
  两个 id 空间不可混用——只有一个输出时才敢断言端点是哪个端口。

## 门禁

- `web/tests/DependencyGraph.test.ts`：端口聚合、按端口摘除、拒绝成环时不记录端口。
- `web/tests/ConnectionAnchors.dom.test.tsx`：四边锚点、端口中心、zoom 换算、注销/重置。
- `web/tests/ConnectionLayer.dom.test.tsx`：每边一线、表→函数卡有线条、
  `表→公式→公式` 两跳都在、选中时标签带 portId。
  （2026-10-29 起：箭头落在目标**边框**、端点=两卡心、端口注册不再拉动端点 ——
  见 [卡心端点决策](2026-10-29-connection-center-anchors.md) 的门禁。）
- `web/scripts/smoke.mjs`：每根线恰好一个箭头；滚动表格不移动线。

## 未决（下一轮）

- **hover / 点选单条线**：要动「连线不拦截鼠标」这条锁定项，需先裁决是否只允许 `pointermove`
  命中（不给 `pointerdown`）。
- **删除一条线**（断线）：等于改数据（`inputs[]` 与后端 `PortBinding`），需要撤回路；不能做成纯视觉操作。
- **拖拽建线**：讨论里的理想态（「改接线要长得像改接线：拖一根线，看得见，可撤销」），
  目前仍由「列面板 / 重指向确认」代替。
- 端口圆点：08-07 决策里的「端口标记兜底」还没有画在卡片之上（需要第三层，且要处理遮挡）。

## 关联

- 代码：`web/src/core/DependencyGraph.ts`、`web/src/ui/cardMetrics.ts`、
  `web/src/ui/ConnectionLayer.tsx`、`web/src/ui/components/FormulaCard.tsx`
- 相关决策：[连线从属原则](2026-08-07-connection-subordination.md)、
  [卡片数据结构 v2](2026-10-26-card-schema-v2.md)、[无限画布](2026-10-21-infinite-canvas.md)
