# STATE — 一页项目状态
<!-- 只保留最新状态；历史进 docs/log/。由 agent 维护，人只读。 -->

## 现在是什么
B 方案：C++/Eigen 后端持计算，浏览器只是交互表面；函数卡接口已稳定，交互还没收口。
数据卡可换数据文件（「替换文件…」/ 拖到卡上），保存的工作区能当模板复用。
「关系枚举」卡（签名仍是 `builtin:linear-regression`）能自选 x/y 两列，列头带 `X : Y`。
**首发整理已提交（2026-10-31）**：AGENTS.md 出历史（123 提交、SHA 全变）、docs 双层拆平、
README 数字对齐、dev server 默认回环、摘要面板 P2 合入、版本统一为 0.1.0（tag `v0.1.0`）。
**尚未建仓库/推送。**

## 上次收工点
- HEAD: de4c47c（摘要面板 P2 + 发布整理 + 中英社区文件）· 时间: 2026-10-31
- 在做: 摘要面板 P2 与发布准备（已提交）。闸门：tsc 干净、vitest 581 passed / 14 skipped、
  ctest 8/8（4 opt-in 跳过）、e2e 102/102。tag `v0.1.0` 在 706716a；回滚包 `work/pre-rewrite-history.bundle`。

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
- 性能门禁阈值（3× / 1.3× 是首测拍的，见 decisions/2026-10-29-perf-gate.md）
- 多列对枚举（`builtin:relation-matrix`：行=列对、列=统计量，explicit）；行标签无传输通道

## 已知缺口（top 5）
1. 函数卡：参数表单未按签名渲染；K>1 无输出选择器
2. 前端 `web/src/core/stats.ts` 仍在算统计，待搬后端
3. 性能门禁只盖引擎层；HTTP 层、缓存命中/冷启动、CI 触发未覆盖
4. 多文件卡只能「换」不能追加/删除单个文件；全局无撤销栈；连线 hover / 断线编辑未做
5. Windows 版不在 Linux 交叉编译：发布后在 Windows 上编译，作为 Release 资产上传

## 下次开工第一件事（RESUME）
先跑 `bash scripts/state-check.sh`；建 GitHub 仓库、开 Pages，只推 main + `v0.1.0`（不要
--mirror）；Windows 版在发布后到原生 Windows 机器上编。摘要面板已收口，别再当在途 lane。
