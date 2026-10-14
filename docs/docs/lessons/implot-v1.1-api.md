# 踩坑：ImPlot v1.1 API 大改

- **标签**：`#踩坑 #ImPlot #API`
- **环境**：ImPlot master（2026 年，v1.1 WIP）

## 现象

编译 `imguitest/` 时，ImPlot 升级到 v1.1 后大量旧 API 不可用。

## 具体变化

| 旧 API | 新 API |
|--------|--------|
| `ImPlot::SetNextLineStyle(color, weight)` | `ImPlotSpec(ImPlotProp_LineColor, col, ImPlotProp_LineWeight, w)` |
| `PlotLine(label, data, count)` | `PlotLine(label, data, count, xscale, xstart, ImPlotSpec)` ← 多了两个参数 |
| `Annotation(x, y, col, offset, clamp, fmt, ...)` | 纯位置标记，文字改用 `PlotText()` |

## 原因

ImPlot 2025 年交接维护者（Evan Pezent → Breno Cunha Queiroz），v1.1 是一次大 API 重写。

## 规避 / 建议

- **锁一个已知稳定的 commit**，避免 master 持续漂移影响代码
- 遇到"不是成员 / 无此枚举"先查 `implot.h`，v1.1 用 `ImPlotSpec` 结构体做样式
- 样式枚举也变了（如 `ImPlotCol_Line` 不存在，改用 `ImPlotProp_LineColor` 或 `ImPlotSpec` 字段）

## 关联

- [[frontend-imgui-vs-web|前端选型：ImGui vs Web]]
- 项目：`imguitest/`
