# 参与贡献

[English](CONTRIBUTING.md) | **中文**

感谢你愿意看这个项目。Data Workbench（仓库名 `DataCardForge`）是一个由一个人维护的早期试验项目，
所以让改动被合入最快的方式是：**保持改动小，并且把门禁输出贴出来**。

## 基本规矩

- **许可证**：GPL-3.0-only（见 [LICENSE](LICENSE)）。提交改动即表示你同意它按该许可证分发；
  你保留自己贡献部分的著作权。
- **DCO 1.1，不要 CLA**。每个提交用 `git commit -s` 签名，正文末尾会多出一行
  `Signed-off-by: 你的名字 <you@example.com>`。这一行表示：这个改动是你写的（或你有权提交），
  且你同意它按 GPL-3.0 分发。全文见 <https://developercertificate.org>；
  本项目的权属说明在 [PROVENANCE.md](PROVENANCE.md) §4。
- **保持礼貌**。目前还没有行为准则文件，规矩就一句话：不人身攻击、不骚扰。对设计的分歧不仅允许，
  而且欢迎。
- **语言**：issue 和 PR 用中文或英文都可以。文档是双语的
  （[README.md](README.md) / [README.zh-CN.md](README.zh-CN.md)）；新增的界面文案**必须中英都写**。

## 什么样的贡献受欢迎

最受欢迎：带复现步骤的缺陷报告、文档修正、能暴露真实缺陷的测试、遵守下面契约的自包含功能。

不建议：顺手把大文件整体重排、"用某个框架重写一遍"、没有理由的依赖升级、改了行为却不加测试的 PR。

## 提 PR 之前请跑

```bash
cd web && npm install                 # 只需一次
cd web && npx tsc --noEmit            # 必须无输出
cd web && npx vitest run              # 必须全绿
cmake -S backend -B backend/build -G Ninja && cmake --build backend/build
ctest --test-dir backend/build --output-on-failure   # 必须全绿（opt-in 门控会跳过）
```

把 `vitest` 与 `ctest` 的尾部输出贴进 PR 描述。**不要在正文里凭记忆写测试数量**——本仓库已经
两次被"记忆里的数字"坑过；README 只在刚实测过时才引用数字。

可选、较慢，只有动到 HTTP 层时才需要：

```bash
cd web && npx playwright install chromium   # 只需一次
cd web && npm run build && npx vite preview --port 4173 &
node web/scripts/smoke.mjs http://127.0.0.1:4173   # 端到端，需要真后端在 :37811
```

CI 跑的就是同一套门禁（`.github/workflows/ci.yml`）。

## 不得破坏的契约

以下都是冻结的；要改，**先**补一条决策记录（[docs/decisions/](docs/decisions/)），再改代码。

1. **计算权威在后端**（B 方案）：所有数值/统计/矩阵结果都来自 C++/Eigen 后端。浏览器负责渲染与
   收集输入，不新增算术。
2. **签名 id 是发布后的身份**：`builtin:expression-columns`、`builtin:linear-regression`、
   `builtin:summary` 永不改 id。改名只是 `displayName` / i18n 的事。
3. **端口是身份，不是位置**；列是绑到端口上的，它不是卡片的参数。
4. **列数契约**（`params.columnContract`）：上游宽度漂移时后端会断流（`columnContractViolation`），
   绝不静默重解释。
5. **改传输协议**（端点、字段、DCM2 帧）必须先有决策记录，并为旧客户端留增量路径。
6. **架构或跨层改动**同样要一条决策记录。现有记录解释了项目为什么长成现在这样——提大改之前先读
   最近几条。

## 代码在哪

| 路径 | 是什么 |
|---|---|
| `web/src/core/` | 纯 TypeScript 参考实现（加载器、表达式引擎、统计、图表配置） |
| `web/src/ui/` | React 19 应用：卡片、画布、store、i18n |
| `web/src/backend/` | 计算服务的 HTTP 客户端（协议 v1） |
| `backend/src/` | C++/Eigen 计算服务：表达式引擎、节点注册表、摘要、HTTP |
| `backend/tests/` | 跨层夹具、压测与 fuzz 门禁 |
| `docs/` | 设计记录：决策、架构、日志、踩坑（中文） |
| `docs/architecture/` | 规范性协议/契约文档 |

## 安全

在报告任何看起来像漏洞的问题之前，请先读 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)——有若干看起来
意外的行为（无鉴权、只绑回环）是**明示的已知限制**，不是缺陷。
