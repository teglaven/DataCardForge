# docs/ — 设计记录（Obsidian vault）

本目录是项目的**设计记录**，不是产品文档的入口。它记录"为什么"和"想过的路"，产品说明记录"是什么"：

- 产品说明与快速开始：仓库根 [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md)
- 权属、数据来源与 AI 使用说明：[`PROVENANCE.md`](../PROVENANCE.md)

> 打开方式（可选）：Obsidian → "Open folder as vault" → 选择本 `docs/` 目录。

## 导航

- 🧭 **项目演进史** (`history.md`) — 把决策/日志/踩坑/审计按因果链串成一条历史，含四个时代、四条螺旋线、教训清单与文档不一致盘点
  - [项目演进史（Data Workbench / DataCardForge）](history.md) ← **先读这篇再进各分册**
- 📌 **决策记录** (`decisions/`) — 已经拍板、影响后续的方向性结论
  - [回归卡改名「关系枚举」：选列变成端口绑定，列头带上 X : Y](decisions/2026-10-31-relation-enum-card.md) ← **最新：卡片终于能选列，表格横向滚动对齐也修了**
  - [数据卡可以换文件：换数据自动跟随，切文件仍显式重指向](decisions/2026-10-31-file-replacement.md) ← **保存的工作区终于能当模板复用**
  - [引擎层性能门禁：12 个用例、p50×3 预算、1.3× 回归护栏](decisions/2026-10-29-perf-gate.md) ← 把「变慢了」变成一个可执行的数字
  - [表达式列引用语法：名称可写、能带限定、全角可用](decisions/2026-10-28-expression-reference-syntax.md) ← 公式卡对带表头文件恢复可用
  - [端口级连线：边带 portId、端点落端口](decisions/2026-10-28-port-level-connections.md) ← 连线恢复为完整的依赖可视化（同日）
  - [摘要（`builtin:summary`）v1：统计量目录、惰性求值、数字归后端](decisions/2026-10-27-summary-builtin.md) ← 第一个惰性签名 + 目录即行序
  - [函数卡的三个契约（列数 · 参数归属 · 单列端口）](decisions/2026-10-27-card-contracts.md) ← 函数卡实现期把三处含糊定死了
  - [卡片数据结构 v2（依赖升信封，函数卡=单节点 K 输出）](decisions/2026-10-26-card-schema-v2.md) ← **已实施**，函数卡的地基
  - [画布改为无边界平面（平移，不含缩放）](decisions/2026-10-21-infinite-canvas.md) ← **当前视图模型：工作流不再被一屏限制**
  - [后端持有数据与计算（B 方案）](decisions/2026-10-17-backend-owns-compute.md) ← 当前分层裁定：浏览器纯交互，修订 T1 基线
  - [兜底原则（最大余量）](decisions/2026-10-15-max-headroom-principle.md) ← **核心架构原则**（分层表已被 10-17 决策修订，契约仍有效）
  - [彻底移除 Qt 实现](decisions/2026-10-15-qt-implementation-removed.md) ← **当前仓库形态**
  - [前端选型定为 Web](decisions/2026-10-14-frontend-web-chosen.md) ← **当前前端方案**
  - [图表库保持 ECharts](decisions/2026-10-14-chart-library-audit.md) ← 统计图型与矢量导出审计
  - [后端先行，前端搁置](decisions/2026-08-07-backend-first-frontend-paused.md)（其中"前端暂停"部分已被上面取代；"后端先行"部分被 10-17 决策复活并扩展）
  - [连线从属原则](decisions/2026-08-07-connection-subordination.md)
- 📐 **规范** (`architecture/`) — 已定稿、实现必须服从的契约（改它 = 改代码前先改这里）
  - [后端协议 v1](architecture/backend-protocol-v1.md) ← B 方案的传输/资源/错误/夹具契约；阶段 1–2 已按此实现，端点与帧格式以本文为准
- ⚖️ **架构权衡** (`architecture/`) — 历史对比文档，结论多数已被决策追记取代；仅当想理解"为什么不选另一头"时阅读
  - [前端选型：ImGui vs Web](architecture/frontend-imgui-vs-web.md)（✅ 已收敛 → 选 Web，见 10-14 决策；对比表仍可复用）
- 🕳️ **踩坑记录** (`lessons/`) — 实测中遇到的坑与规避方法
  - [ImPlot v1.1 API 大改](lessons/implot-v1.1-api.md)
  - [ImGui Docking 下 PushStyleColor 的坑](lessons/imgui-docking-pushstylecolor.md)
- 🧾 **任务书** (`tasks/`) — 一次会话可完成的执行切片：前置条件、契约红线、验收命令
  - [摘要面板 P2（前端）](tasks/2026-10-29-summary-p2-panel.md) ← 待开工，被「结果预览 / 稠密帧」阻塞
- 📅 **开发日志** (`log/`) — 按日期记录进展
  - [2026-10-31](log/2026-10-31.md)（数据卡换文件落地：换数据自动跟随 · 409 顺序问题 · closeAllCards 释放后端）
  - [2026-10-28](log/2026-10-28.md)（用户报障两句 → 三个真缺陷：指针捕获吞 click · 带表头列没有可用的列名 · 公式区被结果表挤成 0）
  - [2026-10-27](log/2026-10-27.md)（函数卡从规格到能跑：v2 落地 · 重指向确认 · 列数契约 · 结果可绘图/可链式 · 回归签名反证通用性）
  - [2026-10-21](log/2026-10-21.md)（阶段 3：公式卡计算权威切到后端 · 差分 fuzz 门禁 · 画布改为无边界平面）
  - [2026-10-17](log/2026-10-17.md)（B 方案拍板 + 工具链核实 + 阶段 0：决策/协议/跨层夹具）
  - [2026-10-15](log/2026-10-15.md)（仓库治理 + 移除 Qt + 修复 A/B/D/E/F）
  - [2026-10-14](log/2026-10-14.md)（前端定为 Web + `web/` 实现落地）
  - [2026-08-07](log/2026-08-07.md)

## 重要约定

1. **权威文档**是仓库根目录的 `README.zh-CN.md`；本目录记录的是"为什么"和"思考过程"，README 记录"是什么"。
2. **先用户视角，再技术方案**：任何架构讨论都先从"用户怎么想"出发，技术分析居后（[决策背景](decisions/2026-08-07-backend-first-frontend-paused.md)）。
3. 所有决策记录应包含：背景 → 选项 → 结论 → 关联模块 → 未来影响。
4. **只写可公开的内容**：设计记录面向读者，与个人工作方式相关的笔记不写进本目录。
5. **行为规则的出处**：Qt 实现已于 2026-10-15 从工作区删除（见 [决策](decisions/2026-10-15-qt-implementation-removed.md)）。
   此前"文档须指明对应 `src/widgets/` 文件"的约定随之废止——现在连线几何、红蓝灰配色、关闭保护等规则的
   **唯一权威定义是 TypeScript 源码与其测试**。历史文档中残留的 C++ 文件名不再指向可打开的文件，
   只作为"这条规则从哪来"的出处标注保留。
