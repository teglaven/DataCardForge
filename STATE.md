# STATE — 一页项目状态
<!-- 只保留最新状态；历史进 docs/docs/log/。由 agent 维护，人只读。 -->

## 现在是什么
B 方案：C++/Eigen 后端持计算，浏览器只是交互表面；函数卡接口已稳定，交互还没收口。

## 上次收工点
- HEAD: b7f797c（本次三条提交：状态闸门 / 性能门禁 / 性能决策）
- 时间: 2026-10-29T16:56:41Z
- 在做: 刚给「变慢了」装上尺子——引擎层 12 例性能门禁 + STATE.md 状态闸门；引擎代码零改动

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
1. 函数卡：参数表单未按签名渲染；K>1 无输出选择器
2. 前端 `web/src/core/stats.ts`（437 行：分位/直方图/KDE/回归/Pearson）仍在算统计，越界，待搬后端
3. 性能门禁只有引擎层这一版：HTTP 层、缓存命中/冷启动、CI 触发都未覆盖（opt-in，CI 仍不跑）
4. 连线 hover / 断线编辑未做
5. 未提交：15 个已改文件（`backend/src/http_server.{cpp,h}`、`web/src/**` 属「结果预览 / 稠密帧」lane）
   + 3 个未跟踪（`web/src/probe.ts`、`web/tests/zz-cascade.probe.test.ts` 两份临时探针待清理；
   `docs/docs/decisions/2026-10-29-result-preview.md` 是该 lane 的决策草案）

## 下次开工第一件事（RESUME）
先跑 `bash scripts/state-check.sh` 与 `DC_RUN_BENCH=1 ctest --test-dir backend/build -R perf_gate`
确认闸门与基线还在，再从缺口 top 1 起手：`web/src/ui/components/FormulaCard.tsx` 的参数表单按签名渲染。
