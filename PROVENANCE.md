# 项目来源与权属记录 · Provenance

本文件用于**可核验地**记录这个仓库的作者、时间线与身份变更，供任何第三方（或未来的自己）核对。
它不是法律文件；它把可验证的事实集中到一处，方便对齐。

## 一、权属

| 项 | 值 |
|---|---|
| 项目名 | Data Workbench（仓库名 `DataCardForge`） |
| 作者 / 著作权人 | **teglaven** `<57093716+teglaven@users.noreply.github.com>`（GitHub 账号 57093716） |
| GitHub | <https://github.com/teglaven> |
| 许可证 | GPL-3.0（见 [`LICENSE`](LICENSE)） |
| 项目起始 | 2026-07（原型，提交于个人账号的私有仓库；见第六节，锚点待补） |
| 架构定型 | 2026-08-07（Qt/C++ 单体版；见 `docs/docs/decisions/2026-08-07-*.md`） |
| 本仓库提交历史起点 | 2026-10-14 16:15:39 +0000（仓库改制为 web-first 后重建的提交历史） |
| 许可证沿革 | 原型阶段即为 GPL-3.0（原型仓库提交 `change GPL announcement`） |
| 首次公开推送 | 尚未公开；见第四节「时间戳」 |

## 二、身份统一记录（公开前）

身份统一时覆盖了当时的全部 63 个提交，**author / committer 统一为**
`teglaven <57093716+teglaven@users.noreply.github.com>`——即 GitHub 账号 `teglaven`（id 57093716）的 noreply 地址，
GitHub 会把这些提交直接归到该账号名下；三个注解 tag 的 tagger 同样统一。

选用 noreply 而非真实邮箱，是为了让**公开历史不暴露个人邮箱**，同时归属仍然成立：
noreply 地址由账号 id + 用户名构成，只有该账号的持有者能使用它。

提交作者串及数量：

| 作者 | 提交数 | 说明 |
|---|---|---|
| `teglaven <邮箱>` | 3 | 作者本人 |
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

> **现状：尚未公开，下列四项全部未生效。** 本节记录的是待办清单，不是既成事实。

1. **GitHub 推送记录**：首次 push 的服务器接收时间，本仓库公开后即生效（成本 0）。
2. **Software Heritage 存档**：提交 `https://archive.softwareheritage.org/save/` 或
   「Save code now」填仓库 URL，会返回一个不可变的 SWHID + 存档时间，独立于 GitHub。
3. **OpenTimestamps**：`ots stamp` 把提交哈希锚定到比特币链，不依赖任何单一服务。
4. **软件著作权登记**（若真需要在境内主张权利）：中国版权保护中心登记源码 + 文档，
   git 历史作为辅助证据链提交。这是唯一可执行的行政/司法路径，其余只是「先到」证明。

> 原则：**先公开、后完善**。公开时间只会往前，不会往后；README 写得完不完美，可以第二天再补。
> 但公开本身**不可逆**（GPL 授权一旦发出无法收回），所以「先公开」只适用于清理已完成的仓库，
> 不适用于还没决定许可证与贡献协议的项目。

**已记录的取舍（2026-10-30）**：不对私有原型仓库单独做 OpenTimestamps 锚定。
理由是随后即公开，公开时点足以锚定；代价是**原型阶段（2026-07 起）缺少独立的第三方时间见证**，
只能靠私有仓库的提交历史自证。若将来需要补强，再对该仓库 HEAD 做 `ots stamp`（不影响已公开的内容）。

## 五、AI 使用说明

本项目在实现过程中使用了 AI 编程助手（DeepSeek Harness / Claude 类 agent 工具，早期另有 GitHub Copilot）。
作者负责的部分：需求定义、架构决策（见 [`docs/docs/decisions/`](docs/docs/decisions/)）、
验收标准、测试门禁、以及每一处「否决方案及理由」的裁量。
工具负责的部分：在这些约束下产出实现草稿与文档初稿。

因此本仓库的自我评价标准不是「谁敲的字」，而是**每个功能声明能否被测试复现**。
失败即为缺陷，见 [`README.md`](README.md#tests)。

> 测试数量的口径**不写进本文件**：以命令的实际输出为准。
> 理由是历史上这里写过 394、README 写过 489、AGENTS.md 写过 507，三处各自漂移——
> 一个被当作证据用的文件，最不该出现的就是自相矛盾的数字。

## 六、原型与数据来源

### 6.1 原型（2026-07 起，个人账号的私有仓库）

- 位置：GitHub 个人账号 `teglaven` 下的**私有**仓库，未公开，无第三方存档。
- 规模：18 个提交（Qt6 / QCustomPlot / QXlsx / OpenXLSX；C++ 91.9% / CMake 7% / Python 1.1%）。
- 里程碑提交：`Initial commit: DataCardForge — 数据矩阵批处理工作台`、
  `Add OpenXLSX library and UI components`、`change GPL announcement`。
- **已知的证明力上限**：私有仓库的提交历史可被 force push 重写，且 `0 watching / 0 fork`
  无任何第三方见证。因此它目前只能证明「作者主张在该时间点已有此项目」，不能独立锚定时间。
  补强方式见第四节。

### 6.2 数据来源

`docs/sampleData/` 下的样本数据为**合成数据**，由
[`docs/sampleData/generate_matrix.py`](docs/sampleData/generate_matrix.py) 生成
（`math.sin(r)` 叠加 `random.uniform(-1, 1)` 噪声），**不含任何外部或专有数据**。

复现：

```bash
python3 docs/sampleData/generate_matrix.py
```

这一条的意义在于：数据来源不是一句声明，而是**一段任何人重跑都能得到同样结果的脚本**。

## 七、变更规则

- 公开推送后**不再重写历史**。若将来必须重写，须在此文件追加一段说明（日期、原因、新旧 SHA）。
- 新增提交一律使用 `teglaven <57093716+teglaven@users.noreply.github.com>`（已在仓库 `git config --local` 固定）。
- 本文件自身的历史即证据：它随仓库一起提交。
