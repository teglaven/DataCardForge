# 踩坑：ImGui Docking 下 PushStyleColor 的坑

- **标签**：`#踩坑 #ImGui #Docking`
- **环境**：ImGui docking 分支（现已在 master 合并）

## 现象

`imguitest/` 一启动就崩溃，控制台输出：
```
Assertion failed: (0) && "Calling PopStyleColor() too many times!"
```
窗口一闪而过。

## 定位过程

1. 二分排查：Dockspace + 空窗口正常 → 加入表格正常 → 加入 `PushStyleColor` 后崩溃
2. 确认与 ImPlot 无关（禁用后仍崩）
3. 最终定位：在 `ImGui::Begin()` **之前**调用 `PushStyleColor(ImGuiCol_TitleBgActive, ...)`，配合 docking 分支对 TitleBar 颜色的内部处理，导致 Pop 计数错位

## 规避

- **不在 `Begin()` 前 push TitleBar 颜色**
- 选中高亮改用**标题前缀**（如 `"> "`）或其他非颜色手段
- 如需改标题栏颜色，确保 Push/Pop 严格对称且都落在 Begin/End 之外

## 附加坑

- `ImGui::Begin()` 返回 false 时**不应调用** `ImGui::End()`（否则同样引发状态错位）

## 关联

- 项目：`imguitest/`
- [[frontend-imgui-vs-web|前端选型：ImGui vs Web]]
