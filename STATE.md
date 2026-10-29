# STATE — 一页项目状态
<!-- 只保留最新状态；历史进 docs/docs/log/。由 agent 维护，人只读。 -->

## 现在是什么
B 方案：C++/Eigen 后端持计算，浏览器只是交互表面；函数卡接口已稳定，交互还没收口。

## 上次收工点
- HEAD: 1c5a215（chore(state): 收工点 30d9837 —— 路线补间入账）
- 时间: 2026-10-29T18:44:16Z
- 在做: 仓库卫生 + 权属文档。PROVENANCE 补齐三处：时间线（2026-07 原型 → 08-07 Qt → 10-14 web）、
  数据来源（合成数据 + `generate_matrix.py` 可复现）、测试口径（删硬编码数字，改「以命令输出为准」——
  此前 394/489/507 三处漂移）。`AGENTS.md` 与 `web/src/probe.ts` 等临时探针移出追踪，文件仍在磁盘。

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
1. **探针依赖，阻塞发布**：`web/src/ui/workspaceStore.ts:18` 仍 `import { probeLog, probeNow, probeOrigin }
   from '../probe.ts'`，而 probe.ts 已按仓库卫生出库。这批 lane 文件一提交即为坏构建（克隆后
   `Cannot find module '../probe.ts'`）。二选一：清掉探针调用，或把 probe.ts 正式化并恢复追踪。
2. `tPullStart` 越出作用域（定义在 workspaceStore.ts:836 的函数内，885 处使用）→ 测试
   **549 passed / 2 failed / 14 skipped**。冒烟「Ctrl+滚轮缩放」那条也红，已 stash 验证与本轮无关。
3. 函数卡：参数表单未按签名渲染；K>1 无输出选择器
4. 前端 `web/src/core/stats.ts`（437 行：分位/直方图/KDE/回归/Pearson）仍在算统计，越界，待搬后端
5. 性能门禁只有引擎层：HTTP 层、缓存命中/冷启动、CI 触发都未覆盖（opt-in，CI 仍不跑）；
   连线 hover / 断线编辑未做（要先裁决「连线不拦截鼠标」这条锁定项）

## 下次开工第一件事（RESUME）
先跑 `bash scripts/state-check.sh`。工作区仍压着「结果预览 / 稠密帧」lane 的 15 个改动：先解缺口 1
的探针依赖，再修 `tPullStart` 作用域让 2 条用例转绿，然后才提交该 lane。切 GitHub Public 排在
这个 lane 收口之后（发布不可逆，见 PROVENANCE 第四节）。
