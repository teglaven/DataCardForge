# STATE — 一页项目状态
<!-- 只保留最新状态；历史进 docs/docs/log/。由 agent 维护，人只读。 -->

## 现在是什么
B 方案：C++/Eigen 后端持计算，浏览器只是交互表面；函数卡接口已稳定，交互还没收口。

## 上次收工点
- HEAD: 4ff4d51（docs(provenance): 补齐原型时间线与数据来源，AGENTS.md 与临时探针出库）
- 时间: 2026-10-29T18:52:00Z
- 在做: 删探针 + 文档收口。`web/src/probe.ts` 与 `zz-cascade.probe.test.ts` 已删除，
  `workspaceStore.ts` 的 import 与 17 处 probe 调用一并清掉；顺带修掉 `tPullStart` 越界
  （拉全量结果时误用了预览的计时变量）。前端 typecheck 通过，测试 550 passed / 14 skipped。

## 已冻结契约（改它要新决策）
- 端口 = 稳定身份 portId（不做位置语义）
- 列数契约 params.columnContract：宽度漂移即断流
- 参数属于签名，不属于卡片
- 计算权威在后端（B 方案），前端不再新增数值计算
- DCM2 帧：24 字节头，带整表形状

## 探索中（可推翻，别当承诺）
- 插件 C-ABI（C 头延后冻结）
- 摘要面板 P2 前端 UI
- 性能门禁阈值（本次新建，首版；3× / 1.3× 是首测拍的，见 docs/docs/decisions/2026-10-29-perf-gate.md）

## 已知缺口（top 5）
1. **result-preview / 稠密帧 lane 未收口**：15 个已改文件（`backend/src/http_server.{cpp,h}`、
   `nodes_stress.py`、`backend-protocol-v1.md`、`web/src/**`、`web/tests/**`）+ 1 个未跟踪决策草案。
   **不能拆开单独提交 `workspaceStore.ts`**——HEAD 会停在未经测试的中间态。
2. 函数卡：参数表单未按签名渲染；K>1 无输出选择器
3. 前端 `web/src/core/stats.ts`（437 行：分位/直方图/KDE/回归/Pearson）仍在算统计，越界，待搬后端
4. 性能门禁只有引擎层：HTTP 层、缓存命中/冷启动、CI 触发都未覆盖（opt-in，CI 仍不跑）
5. 连线 hover / 断线编辑未做（要先裁决「连线不拦截鼠标」这条锁定项）；极窄缝隙张力退化到近折线

## 下次开工第一件事（RESUME）
先跑 `bash scripts/state-check.sh`。「结果预览 / 稠密帧」lane 已全绿但未提交——整条 lane 一起提交
（含 `docs/docs/decisions/2026-10-29-result-preview.md`），不要拆 `workspaceStore.ts`。收口后再切
GitHub Public（发布不可逆，见 PROVENANCE 第四节）。
