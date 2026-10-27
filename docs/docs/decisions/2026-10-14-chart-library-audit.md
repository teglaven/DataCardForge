# 决策：图表库保持 ECharts，以补齐统计图型满足需求

- **日期**：2026-10-14
- **状态**：✅ 已确定
- **标签**：`#架构 #绘图 #矢量导出 #决策`

## 背景

新需求提出两点：

1. 图标（图表）**能否导出更多科研领域常用样式**；若不能，**挑一个并切换**；
2. 需要实现**各种常见的统计图**，并能**导出为矢量图格式**并保存或下载。

因此先去审计现有图表库的能力，再决定是否换库。

## 审计结论（对照已安装的 ECharts 6.1.0）

**两项能力均已具备，无需换库**——依据来自对 `node_modules/echarts` 的实地核对，而非文档印象：

### 1. 矢量导出：原生能力

```ts
echarts.init(el, null, { renderer: 'svg' })      // 类型定义: RendererType = 'canvas' | 'svg'
chart.getSvgDataURL(): string                     // 返回矢量串
chart.getDataURL({ type: 'svg' | 'png' | 'jpeg' })// 类型定义中明确列出 'svg'
```

由 `node_modules/echarts/types/dist/shared.d.ts:6948` 与 `echarts.d.ts:9108-9115` 确认。
**SVG renderer 输出的就是活 DOM 树**，导出即序列化，无光栅化环节。

### 2. 图型覆盖：常见统计图基本内置

`node_modules/echarts/lib/chart/` 实际含：
`bar, boxplot, candlestick, chord, custom, effectScatter, funnel, gauge, graph, heatmap, lines, map, parallel, pie, radar, sankey, scatter, sunburst, themeRiver, tree, treemap`

映射到科研需求：

| 需求 | ECharts | 结论 |
|------|---------|------|
| 折线 / 散点 / 柱状 | `line` `scatter` `bar` | ✅ 原生 |
| 直方图 | 自算分箱 + `bar` | ✅ 可行 |
| 箱线图（含离群点） | `boxplot` | ✅ 原生 |
| 相关性热力图 | `heatmap` + `visualMap` | ✅ 原生 |
| 误差棒 | 无原生 | ⚠️ 需自绘 |
| 小提琴图 | 无原生 | ⚠️ 需自绘 |
| 回归 + 置信带 | `line` + 自算 OLS | ✅ 可行 |

**唯一的两个缺口是「误差棒」与「小提琴图」**，二者用 ECharts 真正的 `custom` series 实现
（矢量图元，非 canvas 覆盖层），因此**没有牺牲矢量导出能力**。

> 踩坑记录：`Extract<SeriesOption, { type: 'custom' }>` 在 ECharts 6 里解析为 `never`
> （联合成员的判别属性是可选），会让类型断言**静默退化为 `any`**。正确做法是从包根直接
> 导入 `CustomSeriesOption` / `CustomSeriesRenderItem` / `CustomSeriesRenderItemAPI`。

## 结论

**保持 ECharts，不换库**，把工作投入在补齐图型与导出管线上。

新增 9 种图型：折线 / 散点 / 回归 / 柱状 / 直方图 / 箱线图 / 小提琴图 / 均值±误差棒 / 相关性热力图。

## 为什么换库解决不了问题

评估过的替代方案：Plotly.js、Observable Plot、Vega-Lite、D3。

1. **它们在缺口上的覆盖并不更好**。Plotly 有 violin/box，但误差棒仍需自绘、回归置信带需自算；
   Observable Plot 与 Vega-Lite 同样缺误差棒原生支持。
2. **包体更大、SVG 导出更绕**。Plotly 为 3 MB+ 级别且以 canvas 为主，取矢量要额外走
   `toImage`/kaleido 路径。
3. **唯一真正的短板换库也解决不了**。需求中隐含「期刊投稿」场景，而其中部分期刊要 **EPS**；
   浏览器端没有可行的 PostScript 生成路径（EPS 是 PostScript 程序）。这是**平台约束**，
   不是库的问题。务实做法是 SVG + 本地转换（`inkscape --export-type=eps`）。
4. **换库会丢掉已投入验证的资产**：连线层几何、卡片坐标系、`chartMetrics` 的 DOM 测量、
   按需加载策略。收益不足以覆盖损失。

## 代价与诚实标注

- **PDF 是位图封装**，不是矢量 PDF。浏览器里要生成真矢量 PDF 需把 SVG 路径/文字几何完整
  翻译成 PDF 绘图算子，工作量大且保真风险高；本项目改为**手写一个无依赖的极简 PDF 生成器**
  （解析 canvas 输出的 PNG、拆 RGB/alpha、按需生成 `/SMask`、包成 `XObject`）。
  **UI 明确标注 PDF 非矢量**，避免误当矢量图投稿。
- **不提供 EPS**，理由见上。已写入 README 的已知限制。

## 与既有决策的关系

本次决策**强化**了 [前端选型定为 Web](2026-10-14-frontend-web-chosen.md) 的核心论据：
「矢量导出是硬需求」。审计确认该能力是 ECharts 原生提供的，因此选型逻辑成立，
且**不需要为了矢量导出而额外更换绘图库**。

## 验证

- `npm test` → **154 个单元测试**（其中 `tests/stats.test.ts` 40 个、
  `tests/charts.test.ts` 40 个）
- `node scripts/smoke.mjs` → **headless Chromium 58 项检查全通过**，其中包含：
  - 9 种图型逐一渲染并核对 SVG 图元（小提琴→polygon、误差棒→线+圆、热力图→格）
  - SVG / PNG / PDF 三种导出**真实触发下载**并校验文件（SVG 含 `<path>`/`<text>` 且**无内嵌位图**；
    PNG 签名 + IHDR 尺寸；PDF 头尾 + `/Page` + `/Subtype /Image`）
  - 另用独立脚本从 PDF 中反解出内嵌图像并重建 PNG，确认码流完整

## 关联

- 决策：[前端选型定为 Web](2026-10-14-frontend-web-chosen.md)（矢量导出为核心论据）
- 模块：`web/src/charts/`、`web/src/core/stats.ts`
- 文档：[`web/README.md`](../../../web/README.md)（图型表与导出说明）
