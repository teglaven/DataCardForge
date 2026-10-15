# Data Workbench — 项目笔记库

> 本目录是一个 [Obsidian](https://obsidian.md) vault，用于记录项目的设计决策、架构权衡与踩坑经验。
> 打开方式：Obsidian → "Open folder as vault" → 选择本 `docs/` 目录。

## 导航

- 📌 **决策记录** (`decisions/`) — 已经拍板、影响后续的方向性结论
  - [[2026-10-15-max-headroom-principle|兜底原则（最大余量）]] ← **核心架构原则**
  - [[2026-10-15-qt-implementation-removed|彻底移除 Qt 实现]] ← **当前仓库形态**
  - [[2026-10-14-frontend-web-chosen|前端选型定为 Web]] ← **当前前端方案**
  - [[2026-10-14-chart-library-audit|图表库保持 ECharts]] ← 统计图型与矢量导出审计
  - [[2026-08-07-backend-first-frontend-paused|后端先行，前端搁置]]（其中"前端暂停"部分已被上面取代）
  - [[2026-08-07-connection-subordination|连线从属原则]]
- ⚖️ **架构权衡** (`architecture/`) — 尚未拍板、需要继续论证的对比
  - [[frontend-imgui-vs-web|前端选型：ImGui vs Web]]（权重已反转，见 10-14 决策）
- 🕳️ **踩坑记录** (`lessons/`) — 实测中遇到的坑与规避方法
  - [[implot-v1.1-api|ImPlot v1.1 API 大改]]
  - [[imgui-docking-pushstylecolor|ImGui Docking 下 PushStyleColor 的坑]]
- 📅 **开发日志** (`log/`) — 按日期记录进展
  - [[2026-10-15|2026-10-15]]（仓库治理 + 移除 Qt + 修复 A/B/D/E/F）
  - [[2026-10-14|2026-10-14]]（前端定为 Web + `web/` 实现落地）
  - [[2026-08-07|2026-08-07]]

## 重要约定

1. **权威文档**是仓库根目录的 `README.zh-CN.md`；本 vault 记录的是"为什么"和"思考过程"，README 记录"是什么"。
2. **先用户视角，再技术方案**：任何架构讨论都先从"用户怎么想"出发，技术分析居后（[[2026-08-07-backend-first-frontend-paused|决策背景]]）。
3. 所有决策记录应包含：背景 → 选项 → 结论 → 关联模块 → 未来影响。
4. **只写可公开的内容**：设计记录面向读者，与个人工作方式相关的笔记不写进本目录。
5. **行为规则的出处**：Qt 实现已于 2026-10-15 从工作区删除（见 [[2026-10-15-qt-implementation-removed|决策]]）。
   此前"文档须指明对应 `src/widgets/` 文件"的约定随之废止——现在连线几何、红蓝灰配色、关闭保护等规则的
   **唯一权威定义是 TypeScript 源码与其测试**。历史文档中残留的 C++ 文件名不再指向可打开的文件，
   只作为"这条规则从哪来"的出处标注保留。
