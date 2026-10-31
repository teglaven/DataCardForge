# 决策：前端选型定为 Web（React + Vite + TypeScript）

- **日期**：2026-10-14
- **状态**：✅ 已确定（取代 [后端先行，前端搁置](2026-08-07-backend-first-frontend-paused.md) 中"前端选型暂停"部分）
- **标签**：`#架构 #前端选型 #决策 #web`

## 背景

8 月 7 日的决策把前端选型（ImGui / Web）**暂停**，理由是"前端能展示什么受限于后端能算什么"，先在 Qt Widgets 上凑合、优先做后端。

2026-10-14 重新启动该决策：前端确定为 **Web**，并要求给出可运行的实现，而不是继续停留在对比表上。

## 结论

**前端 = Web（浏览器应用）**，技术栈：

| 关注点 | 选型 | 理由 |
|--------|------|------|
| 构建 | Vite 8 | 冷启动 <1s，产物按需分块 |
| 语言 | TypeScript 7（`strict`） | 列式数据模型与依赖图有明确契约，类型即文档 |
| 视图 | React 19 | 卡片是动态列表 + 依赖关系，声明式 diff 最贴合；生态最厚 |
| 卡片窗口 | 自研 `CardShell`（react-rnd） | 需要"连线从属"所需的**精确几何**：卡片位置即数据，不能藏在布局引擎里 |
| 绘图 | ECharts 6（**SVG renderer**） | 矢量导出是选 Web 的首要理由 |
| 状态 | zustand | 卡片表 + 依赖图是一棵小状态树，无需重框架 |
| 表格 | 自研虚拟滚动 | 10⁵ 行量级只需窗口化渲染 |

**为什么是 React 而不是 Vue/Svelte**：本项目真正吃力的不是"渲染"，而是**卡片间关系**（依赖图、连线高亮、关闭保护、"切文件→图表联动"）。这类问题的生态成熟度上，React 有压倒性的可参考资料与可组合原语；Vue/Svelte 在纯表单/看板场景更省心，但不构成对本项目的优势。

## 为什么 Web 终于胜出

8 月的权衡表里，Web 已经赢在"矢量导出 / SVG / WYSIWYG / 中文 IME"，输在"大数据表 + 高频图表性能"。当时把性能放在高权重、把矢量导出视作"可能的需求"。

重新评估后权重反转：

1. **矢量导出是硬需求，不是"可能"**。科研/工业场景的终点是出图进报告、进论文。ImGui 路线要自建导出管线（ImPlot 明确无导出），而 Web 选中 SVG renderer 后**导出免费且是真矢量**——已实测：图表工具箱一键导出 SVG。
2. **中文 IME 在 ImGui 里是持续的坑**，在 Web 里是浏览器免费能力。本项目面向中文用户。
3. **性能顾虑被证伪或可解**：
   - 表格：虚拟滚动后 10 000 行只需 **23 个 DOM 行节点**（实测）。
   - 图表：ECharts 对 10⁵ 点序列有 LTTB 降采样，且渲染在 SVG/Canvas 两条路上都成熟。
   - 8 月担心的"WebView 嵌入 ImGui"复杂度（见 [旧权衡文档](../architecture/frontend-imgui-vs-web.md)）**直接消失**——不再有宿主，浏览器就是宿主。
4. **连线从属原则天然满足**：连线是一层 `pointer-events: none` 的 SVG 覆盖层，永远不抢事件、不参与布局。Qt 版要两个 overlay + 20ms 定时器轮询，Web 版由布局版本号驱动，实测无掉帧。

## 代价（明确记录）

1. **放弃原生 C++ 复用**。本机无 C++ 工具链，Qt 前端也不可移植；`core/` 的算法在 `web/src/core/` **重写为 TypeScript**，语义对齐靠测试而非共享二进制。若将来要把 Eigen 计算搬到前端，需走 Emscripten/WASM 单独立项。
2. **Eigen / 公式计算仍未落地**。本次只做前端迁移，后端优先级不变。
3. **包体**：首屏 ~96 KB gzip；ECharts（374 KB gzip）与 xlsx 解析（160 KB gzip）按需加载，不进首屏。

## 落地与验证

`web/` 目录（见 [web/README.md](../../web/README.md)）：

- `src/core/` ← 对齐 `MatrixData`、`Smoothing`、`DependencyGraph`（Qt-free，逐算法对照移植）
- `src/loaders/` ← TxtLoader / CsvLoader / XlsxLoader + 工厂
- `src/ui/` ← 卡片层：`CardCanvas`（= QMdiArea）、`CardShell`（= QMdiSubWindow）、`ConnectionLayer`（= ConnectionOverlay）、`VirtualTable`（= QTableView）、`ChartCard`（= QCustomPlot）

验证手段（全部可复跑）：

- `npm test` — 74 个 vitest 用例，覆盖移植语义
- `npm run build` — `tsc --noEmit` + 产物构建
- `node scripts/smoke.mjs` — headless Chromium 端到端 **31 项检查全通过**（含 10 000 行虚拟滚动、右键列头出图、连线红/蓝/灰配色、依赖保护、切文件联动、中英切换）

## 存量 Qt 前端的处置

`src/widgets/`、`ui/`、`i18n/` 与 `CMakeLists.txt` 的 Qt 目标**保留不清除**，理由：

- 它是唯一可对照的**行为参照实现**（连线几何、颜色、关闭规则都以它为准）；
- `imguitest/` 与 Qt 版共同构成"两条路线的实测记录"，对后来者有价值；
- 删除是不可逆操作，而它不影响 Web 构建。

但 README 的"权威实现"指向 Web，Qt 版标记为 **legacy / reference**。

## 关联

- 被取代：[后端先行，前端搁置](2026-08-07-backend-first-frontend-paused.md)（前端暂停部分）
- 已论证：[前端选型：ImGui vs Web](../architecture/frontend-imgui-vs-web.md)（权重已反转）
- 原则：[连线从属原则](2026-08-07-connection-subordination.md)（Web 实现天然满足）
- 模块：`web/src/core`、`web/src/loaders`、`web/src/ui`
