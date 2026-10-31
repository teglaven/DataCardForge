# STATE — 一页项目状态
<!-- 只保留最新状态；历史进 docs/docs/log/。由 agent 维护，人只读。 -->

## 现在是什么
B 方案：C++/Eigen 后端持计算，浏览器只是交互表面；函数卡接口已稳定，交互还没收口。
数据卡可换数据文件（「替换文件…」/ 拖到卡上），保存的工作区能当模板复用。
「关系枚举」卡（签名仍是 `builtin:linear-regression`）能自选 x/y 两列，列头带 `X : Y`。

## 上次收工点
- HEAD: b1238cd（chore(scripts): find-term.sh —— 按词定位坐标）
- 时间: 2026-10-31T15:18Z
- 在做: 关系枚举收口。改名只动人看的部分；选列做成端口绑定（`setPortColumn` → 一次 PATCH，
  同节点同边）；列头 = `<x> : <y> · 统计量`（slug→i18n 在前端）；顺带修掉表格横向滚动错位。
  闸门：tsc 干净、vitest 567 passed / 14 skipped、ctest 8/8、build 干净、三单元 active。

## 已冻结契约（改它要新决策）
- 端口 = 稳定身份 portId（不做位置语义）
- 列数契约 params.columnContract：宽度漂移即断流
- 参数属于签名，不属于卡片；选哪个列喂哪个端口是绑定，不是参数
- 计算权威在后端（B 方案），前端不再新增数值计算
- DCM2 帧：24 字节头，带整表形状
- 换文件是数据变更（下游自动跟随并重算）；切文件是视图变更（显式重指向条）
- 签名 id 发布后永不改（改名只动 displayName / i18n）

## 探索中（可推翻，别当承诺）
- 插件 C-ABI（C 头延后冻结）
- 摘要面板 P2 前端 UI
- 性能门禁阈值（3× / 1.3× 是首测拍的，见 decisions/2026-10-29-perf-gate.md）
- 多列对枚举（`builtin:relation-matrix`：行=列对、列=统计量，explicit）；行标签无传输通道

## 已知缺口（top 5）
1. 摘要面板 P2 未开工（tasks/2026-10-29-summary-p2-panel.md，现已解锁）
2. 函数卡：参数表单未按签名渲染；K>1 无输出选择器
3. 前端 `web/src/core/stats.ts`（437 行）仍在算统计，待搬后端
4. 性能门禁只有引擎层：HTTP 层、缓存命中/冷启动、CI 触发都未覆盖
5. 多文件卡只能「换」不能追加/删除单个文件；全局无撤销栈；连线 hover / 断线编辑未做

## 下次开工第一件事（RESUME）
先跑 `bash scripts/state-check.sh`，再按 tasks/2026-10-29-summary-p2-panel.md 开工摘要面板 P2。
要「暴力枚举」多列对则先落 decisions/2026-10-31-relation-enum-card.md 的 `builtin:relation-matrix`。
