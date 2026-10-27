# 项目来源与权属记录 · Provenance

本文件用于**可核验地**记录这个仓库的作者、时间线与身份变更，供任何第三方（或未来的自己）核对。
它不是法律文件；它把可验证的事实集中到一处，方便对齐。

## 一、权属

| 项 | 值 |
|---|---|
| 项目名 | Data Workbench（仓库名 `DataCardForge`） |
| 作者 / 著作权人 | **teglaven** `<141315067@qq.com>` |
| GitHub | <https://github.com/teglaven> |
| 许可证 | GPL-3.0（见 [`LICENSE`](LICENSE)） |
| 项目起始 | 2026-08-07（Qt/C++ 单体版） |
| 本仓库提交历史起点 | 2026-10-14 16:15:39 +0000（仓库改制为 web-first 后重建的提交历史） |
| 首次公开推送 | 见下方「时间戳」一节 |

## 二、身份统一记录（公开前）

首次公开推送前，全仓库 63 个提交的 **author / committer 已统一为**
`teglaven <141315067@qq.com>`，两个注解 tag 的 tagger 同样统一。

提交作者串及数量：

| 作者 | 提交数 | 说明 |
|---|---|---|
| `teglaven <141315067@qq.com>` | 3 | 本身就是作者本人 |
| `DataCardForge Dev <dev@datacardforge.local>` | 57 | 本地工具身份，`.local` 域不可认领、无法与任何 GitHub 账号关联 |
| `DataCardForge audit <agent@local>` | 3 | 自动审计脚本使用的工具身份 |

**未改动的内容**：作者日期、提交日期、提交信息、树内容（tree）。

**可自行验证**（重写后的仓库里执行）：

```bash
git log --format='%an <%ae> / %cn <%ce>' | sort -u    # 只有一行
git log --format='%ad' --date=iso | sort | wc -l       # 63
git rev-parse HEAD^{tree}                              # 见下方锚点
```

打包前后的树哈希一致（`7d4f6d64e6a0157231b5def61dc871fd8602ad9b`），
即**代码内容一个字节都没有变**，只改了元数据。

## 三、锚点（首次公开时的快照）

| 锚点 | 值 |
|---|---|
| 首次提交 | `36695cdc61a2fc4930cba74c3f4bb79b9453f3c8`（2026-10-14） |
| 首次公开点 | annotated tag `publish-2026-10-27`（指向本文件所在提交，公开推送时创建） |
| 打包前 HEAD 树哈希 | `7d4f6d64e6a0157231b5def61dc871fd8602ad9b` |
| tag `v1.0.0` | `ff9a0802ae86c40c2665ba096c1aabf62bb40c32`（2026-10-16） |
| tag `pre-stage3-baseline` | `2b87dc2696db16360955239112a52f7ef9482a02`（2026-10-21） |

核对命令：

```bash
git cat-file -t 36695cdc61a2fc4930cba74c3f4bb79b9453f3c8   # 首次提交
git tag -l --format='%(refname:short) %(*objectname)'        # 各 tag 的指向
git log --format='%an <%ae>' | sort -u                       # 只有一个身份
```

## 四、时间戳（第三方见证）

git 里的 commit date 是**作者自报**的，任何人克隆后都能原样重放，单靠自己写的日期证明力有限。
真正不能回溯伪造的是**第三方收到它的时间**。按成本从低到高：

1. **GitHub 推送记录**：首次 push 的服务器接收时间，本仓库公开后即生效（成本 0）。
2. **Software Heritage 存档**：提交 `https://archive.softwareheritage.org/save/` 或
   「Save code now」填仓库 URL，会返回一个不可变的 SWHID + 存档时间，独立于 GitHub。
3. **OpenTimestamps**：`ots stamp` 把提交哈希锚定到比特币链，不依赖任何单一服务。
4. **软件著作权登记**（若真需要在境内主张权利）：中国版权保护中心登记源码 + 文档，
   git 历史作为辅助证据链提交。这是唯一可执行的行政/司法路径，其余只是「先到」证明。

> 原则：**先公开、后完善**。公开时间只会往前，不会往后；README 写得完不完美，可以第二天再补。

## 五、AI 使用说明

本项目在实现过程中使用了 AI 编程助手（DeepSeek Harness / Claude 类 agent 工具，早期另有 GitHub Copilot）。
作者负责的部分：需求定义、架构决策（见 [`docs/docs/decisions/`](docs/docs/decisions/)）、
验收标准、测试门禁、以及每一处「否决方案及理由」的裁量。
工具负责的部分：在这些约束下产出实现草稿与文档初稿。

因此本仓库的自我评价标准不是「谁敲的字」，而是**每个功能声明能否被测试复现**：
`394 个前端单元测试 + 7 个后端 ctest（3 个 opt-in）+ 端到端 65 项冒烟检查`，
失败即为缺陷，见 [`README.md`](README.md#tests)。

## 六、变更规则

- 公开推送后**不再重写历史**。若将来必须重写，须在此文件追加一段说明（日期、原因、新旧 SHA）。
- 新增提交一律使用 `teglaven <141315067@qq.com>`（已在仓库 `git config --local` 固定）。
- 本文件自身的历史即证据：它随仓库一起提交。
