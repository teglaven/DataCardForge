# 图型截图

本目录是**人工目视复核**用的截图，由 headless Chromium 实际渲染导出（非示意图）。
每张图都是把一个图表卡片放大后截图，使用的是带相关性的演示数据
（正弦信号 + 高斯噪声，含一个双峰列）。

> 为什么需要这个目录：单测与冒烟测试只能断言"画出了 N 条 path"，
> **无法判断图形是否画对**。本轮开发中小提琴图两次通过断言但图形明显不对
> （先撑满卡片、后被拉伸），最终靠看图才发现。详见
> [`docs/log/2026-10-14.md`](../../../docs/log/2026-10-14.md)。

| 文件 | 图型 | 看点 |
|------|------|------|
| [`hero.png`](hero.png) | 整屏 | 数据卡 + 相关性热力图卡 + 卡片级连线（README 头图） |
| [`scatter.png`](scatter.png) | 散点图 | 两列配对 (X, Y) + 最小二乘线；列 dock 里的勾选顺序即配对顺序 |
| [`bar.png`](bar.png) | 柱状图 | 8 个类别 × 3 组的分组柱；行数一多就会退化成"噪声带"，柱状图只适合少类别 |
| [`line.png`](line.png) | 折线图 | 多列叠加、图例、缩放/平移 |
| [`histogram.png`](histogram.png) | 直方图 | Sturges 自动分箱、箱边界描边 |
| [`boxplot.png`](boxplot.png) | 箱线图 | 中位数 / 四分位 / 须线 / Tukey 离群点 |
| [`violin.png`](violin.png) | 小提琴图 | **KDE 轮廓 + 四分位线；双峰列一眼可见** |
| [`errorbar.png`](errorbar.png) | 均值±误差棒 | 均值点 + 须线 + 帽（SD / SE / 95% CI） |
| [`regression.png`](regression.png) | 回归图 | 散点 + OLS 直线，图例含斜率与 R² |
| [`correlation-heatmap.png`](correlation-heatmap.png) | 相关性热力图 | 两两 Pearson 系数、发散配色、单元格数值 |

复现方式：

```bash
node scripts/smoke.mjs http://127.0.0.1:4173   # 需要先 npm run preview
```
