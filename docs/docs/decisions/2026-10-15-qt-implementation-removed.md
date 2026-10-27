# 决策：彻底移除 Qt 实现（不再保留为参照）

- **日期**：2026-10-15
- **状态**：✅ 已执行（不可逆，工作树层面）
- **标签**：`#架构 #清理 #qt #决策`
- **取代**：[前端选型定为 Web](2026-10-14-frontend-web-chosen.md) 中"存量 Qt 前端保留不清除"的处置结论

## 背景

2026-10-14 定下"前端 = Web"时，Qt 版被标记为 legacy / 行为参照实现并**明确决定保留**，当时的三条理由是：

1. 它是唯一可对照的行为参照（连线几何、颜色、关闭规则以它为准）；
2. `imguitest/` 与 Qt 版共同构成"两条路线的实测记录"；
3. 删除不可逆，而它不影响 Web 构建。

同一天遗留的开放问题里已经写了："**当前决定保留**（不可逆操作 + 它是有价值的对照基准），但需要在卡片模型稳定后再审一次。"本次就是那次复审。

## 触发复审的事实

审查仓库时发现，"保留作为参照"的前提已经不成立，而且保留的代价是实际的：

| 原以为的收益 | 实际情况（2026-10-15） |
|---|---|
| 行为参照有价值 | Web 侧已有 **154 个单元测试 + 58 项端到端检查**覆盖这些规则。参照物从"C++ 源码"变成了"测试断言"——后者更精确，且能自动验证 |
| 不影响 Web 构建 | 它**影响了仓库本身**：`web/`（约 4900 行主实现源码 + 1571 行测试）**完全不在版本控制内**，只存在于单机磁盘；GitHub 首页展示的却是这份已停止演进的 C++ 代码 |
| 保留成本为零 | 实际成本：仓库 221 MB 中约 **215 MB 属于 Qt 侧**（`third_party/` 55 MB + `build/` 79 MB + `imguitest/` 81 MB），另有 44 个文件被 Windows 编辑器整体改写成 CRLF，使工作区 diff 虚增到 23775 行 |

另外两个具体的坑：

- `third_party/eigen` 只是一个 gitlink，**没有 `.gitmodules`**，`git submodule status` 直接报 fatal。任何人 clone 后该目录都是空的——所谓"Eigen 已在后端就绪"从来就不成立。
- `CMakeLists.txt` 里没有任何 Eigen 引用，`grep -rn Eigen src/` 零命中。README 却把 Eigen 列为"下一步优先"。

## 决策内容

从工作区彻底删除：

```
data-workbench/src/          # core/ + loaders/ + widgets/（C++ 实现）
data-workbench/ui/           # .ui 文件
data-workbench/i18n/         # Qt .ts 翻译文件
data-workbench/imguitest/    # ImGui 实验工程
data-workbench/third_party/  # eigen(gitlink) / OpenXLSX / QXlsx / fast_float / qcustomplot
data-workbench/build/        # CMake 构建树
data-workbench/resources/
data-workbench/CMakeLists.txt
data-workbench/.qtcreator/  .vscode/
```

**保留**：`README*.md`、`LICENSE`、`docs/`（含全部决策与日志）、`sampleData/`（Web 冒烟测试仍在使用）。

同时把仓库形态改为 monorepo：根目录一个 Git 仓库，`web/` 为主实现，`data-workbench/` 退化为"文档 + 样例数据"。

## 为什么这次敢删，上次不敢

上次的顾虑是"删除不可逆"。这次的做法是把不可逆变成可逆：

1. 删除前先复制 `.git` 对象库到 `.pre-qt-removal-backup/repo.git`（已验证 18 个提交可读，最后一个提交 `27276fd`）；
2. 该备份目录写入根 `.gitignore`，不进公开仓库；
3. 新仓库的第一个提交就包含完整的 `web/` 源码，因此**在删除发生之前，主实现已经先被保护起来了**。

顺序很重要：**先让要留下的东西进版本控制，再删要扔掉的东西。**

## 影响

- ✅ 仓库体积 221 MB → 约 6.7 MB（不含 `node_modules`）
- ✅ GitHub 首页从此展示的是主实现
- ⚠️ 历史文档（`docs/log/2026-08-07.md`、`docs/lessons/*`、本决策引用的旧约定）中的 C++ 文件名成为**悬空引用**。处理原则见 [docs/README](../README.md) 第 5 条：保留文字作为出处标注，不去改写历史
- ⚠️ `docs/lessons/implot-v1.1-api.md`、`imgui-docking-pushstylecolor.md` 记录的坑不再有代码对应。它们属于"当时为什么犹豫"的资产，继续保留
- 🔒 若将来要做 WYSIWYG / SVG 编辑，按 10-14 决策的追记：**在 Web 侧扩展，不回头捡 Qt**

## 如何恢复（如果真需要）

```bash
# 备份是可用的 git 对象库，直接把某个提交的树取出来
git --git-dir=.pre-qt-removal-backup/repo.git show 27276fd:src/core/MatrixData.cpp
git --git-dir=.pre-qt-removal-backup/repo.git archive 27276fd src ui i18n | tar -x -C /tmp/qt-recovery
```

注意：`third_party/eigen` 在旧仓库里只是 gitlink（一个 commit 号），其内容从未被旧仓库跟踪；
`third_party/OpenXLSX` 则有 152 个文件被跟踪，可用同样方式取出。

## 关联

- 被取代：[前端选型定为 Web](2026-10-14-frontend-web-chosen.md) §存量 Qt 前端的处置
- 相关：[后端先行，前端搁置](2026-08-07-backend-first-frontend-paused.md)（其中"后端"载体即本次删除的 C++ 代码）
- 后续：Eigen / 公式计算路线需重新立项，见 [2026-10-15 日志](../log/2026-10-15.md)
