# 项目来源与权属记录 · Provenance

给用户与贡献者的速览：谁写的、能不能用、样本数据哪来的。

## 一、权属
| 项 | 值 |
|---|---|
| 项目名 | Data Workbench（仓库名 `DataCardForge`） |
| 作者 / 著作权人 | **teglaven** `<57093716+teglaven@users.noreply.github.com>` |
| GitHub | <https://github.com/teglaven> |
| 许可证 | GPL-3.0（见 [`LICENSE`](LICENSE)） |
| 项目起点 | 2026-07 原型 → 2026-08-07 Qt/C++ 单体版 → 2026-10-14 改制 web-first |

## 二、数据来源
`docs/sampleData/` 的样本数据是**合成数据**，由
[`docs/sampleData/generate_matrix.py`](docs/sampleData/generate_matrix.py) 生成（`math.sin(r)` 叠加
`random.uniform(-1, 1)` 噪声），不含任何外部或专有数据；`python3 docs/sampleData/generate_matrix.py` 可复现。

## 三、AI 使用说明
实现过程中使用了 AI 编程助手（DeepSeek Harness / Claude 类工具，早期另有 GitHub Copilot）。作者负责
需求定义、架构决策（见 [`docs/decisions/`](docs/decisions/)）、验收标准与测试门禁，以及每一处
「否决方案及理由」的裁量；工具负责在这些约束下产出实现草稿与文档初稿。
因此本项目的评价标准不是「谁敲的字」，而是**每个功能声明能否被测试复现**——测试数量以
`cd web && npx vitest run` 与 `ctest --test-dir backend/build` 的实际输出为准，本文件不缓存数字。

## 四、贡献
采用 **DCO 1.1**，不要求 CLA：提交时用 `git commit -s`，提交信息末尾加 `Signed-off-by: 姓名 <邮箱>`，
表示你有权提交该贡献并同意它按本项目的 GPL-3.0 分发；贡献者的著作权由各贡献者保留。
全文见 <https://developercertificate.org>。
