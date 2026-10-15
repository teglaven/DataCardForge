# Data Workbench — Web Frontend

卡片式**数据矩阵批处理工作台**的 Web 前端（React + Vite + TypeScript）。

> 这是项目的**主实现**（自 2026-10-14 起）。前端选型结论与理由见
> [`docs/decisions/2026-10-14-frontend-web-chosen.md`](../docs/docs/decisions/2026-10-14-frontend-web-chosen.md)。
> 原先作为行为参照的 Qt Widgets 版本已于 2026-10-15 **彻底移除**，见
> [`2026-10-15-qt-implementation-removed.md`](../docs/docs/decisions/2026-10-15-qt-implementation-removed.md)：
> 本目录下不再有并行实现需要同步，语义的唯一权威来源是本目录的源码与 `tests/`。

## 快速开始

```bash
cd web
npm install

npm run dev        # 开发服务器（默认 http://localhost:5173）
npm run build      # 类型检查 + 生产构建 → dist/
npm run preview    # 预览生产构建
npm test           # 171 个单元测试（vitest）
npm run typecheck  # 仅类型检查
```

端到端冒烟测试（61 项检查，需要先起 `npm run preview`）：

```bash
node scripts/smoke.mjs http://127.0.0.1:4173
```

## 统计图表

支持 **9 种**科研/统计常用图型，全部用 ECharts 的 **SVG renderer** 渲染，
因此**全部可导出为真矢量**。图型可随时在图表卡片内切换（不用重建卡片）。

| 图型 | 说明 | 实现 |
|------|------|------|
| **折线图** | 按行号绘制一个或多个列，支持对数 Y 轴、次坐标轴 | ECharts `line`（LTTB 降采样） |
| **散点图** | 两列配对为 (X, Y)，可叠加拟合线 | ECharts `scatter` |
| **回归图** | 散点 + 最小二乘拟合直线，标注斜率与 **R²**、样本数 n | `scatter` + `line`（自算 OLS） |
| **柱状图** | 按行号，支持分组 / 堆叠 | ECharts `bar`（large 模式） |
| **直方图** | 单列分箱频数分布，分箱数可自动（Sturges）或指定 | 自算分箱 + `bar` |
| **箱线图** | 每列一个箱体：中位数、四分位数、须线、**Tukey 离群点** | ECharts `boxplot` + `scatter` |
| **小提琴图** | **KDE 密度轮廓** + 四分位线，能看出双峰分布 | `custom` series（ECharts 无原生小提琴） |
| **均值±误差棒** | 每列均值与离散度：**SD / SE / 95% CI**，帽宽可调 | `custom` series（ECharts 无原生误差棒） |
| **相关性热力图** | 多列两两 **Pearson 相关系数**矩阵，发散配色 | ECharts `heatmap` + `visualMap` |

![小提琴图](docs/screenshots/violin.png)

> 小提琴图揭示了数据的**双峰**结构——这正是它在科研场景中比箱线图更有价值的地方。
> 图中还能看到四分位虚线、中位实线，以及 KDE 曲线随样本范围延伸的镜像边缘。

![相关性热力图](docs/screenshots/correlation-heatmap.png)

![回归图](docs/screenshots/regression.png)

### 统计量

`src/core/stats.ts` 全部为纯函数，独立可测（40 个单元测试），数值约定与 NumPy/R 一致：

- 分位数用**线性插值**（NumPy 默认 / R type 7），Bessel 校正样本方差
- 直方图：Sturges 规则自动分箱；最大值归入最后一个箱；等值数据不退化为除零
- KDE：**Silverman 经验带宽**；常数样本有有限带宽兜底
- 线性回归：OLS + **t 分布** 95% 置信区间（小样本用 t 而非正态，避免低估）
- 相关系数：常数序列返回 `NaN`（相关性**未定义**），而不是谎报 0
- 离群点：Tukey 1.5×IQR

## 导出（矢量优先）

导出是图表卡片工具栏的**一级控件**，不是藏在图表工具箱里的小图标。

| 格式 | 是否矢量 | 说明 |
|------|:--:|------|
| **SVG** | ✅ **真矢量** | 图表本身就以 SVG 渲染，导出的是**活的 DOM 树**序列化结果，曲线仍是曲线、文字仍是文字、无内嵌位图。期刊投稿用这个。 |
| **PNG** | ❌ 位图 | 可选 1× / 2× / 4× 分辨率（4× 用于印刷） |
| **PDF** | ❌ 位图封装 | 单页 PDF，内嵌高分辨率位图（见下） |

**为什么 PDF 不是矢量的**：浏览器里要生成真矢量 PDF，需要把 SVG 的路径/文字几何完整翻译成
PDF 绘图算子，工作量大且保真度风险高。本项目**手写了一个极简 PDF 生成器**
（`src/charts/pdf.ts`，无第三方依赖）——它解析 canvas 出的 PNG、拆出 RGB 与 alpha 通道、
必要时生成 `/SMask` 保留透明，再包成 `XObject`。**UI 会明确标注 PDF 不是矢量格式**，
避免误当矢量图投稿。

**关于 EPS**：浏览器端没有可行的 PostScript 生成路径（EPS 是 PostScript 程序，不是几何格式），
因此**不提供**。需要 EPS 的期刊投稿流程建议 SVG → `inkscape --export-type=eps` 或
`rsvg-convert -f eps`。

**导出实现的两点考量**：

1. SVG 导出会**内联计算样式**——ECharts 用 CSS class 设置部分属性，不内联的话
   离开本应用样式表后图会渲染错。
2. 散点类图型**默认截断到 5 000 点**：ECharts 为每个散点生成一条 SVG path，
   10 000 点会产出 ~1 MB 的 SVG；5 000 点保留了点云的形状，同时是可发表的体积。
   截断是确定性的（等距抽取，保留首尾）。

## 功能

| 功能 | 说明 |
|------|------|
| 卡片工作台 | 卡片可拖拽、缩放、层叠；右键空白 → 打开数据文件；支持把文件直接拖入画布 |
| 多文件卡片 | 一个卡片装多个文件，顶部下拉切换；**切换文件会联动所有依赖它的图表** |
| 多列图表 | 图表可挂多列（点「+ 添加列」），配合「图型」下拉切换；散点/回归按 (X,Y) 配对 |
| 大表虚拟滚动 | 只渲染可见行（实测 10 000 行 → 23 个行节点） |
| 右键列头出图 | 列头右键直接选图型（列数不够的图型会置灰） |
| 平滑 | 滑动平均 / 指数 / 中值 / Savitzky–Golay（移植时与已删除的 C++ `Smoothing.cpp` 逐行对照，现由 18 个测试锁定） |
| 连接线 | 贝塞尔曲线；源卡片激活=红、目标激活=蓝、都未激活=灰（背景层）；拖拽/缩放/**表格滚动**均实时跟随 |
| 解析离开主线程 | 文件解析在 Web Worker 中进行，无 Worker 环境自动回退内联执行 |
| 内容寻址缓存 | 按 `size`+`lastModified` 复用解析结果；同名不同内容的文件不会被当成同一个 |
| 依赖保护 | 有图表依赖的表格拒绝关闭，连线闪烁提示 |
| 表格导出 | 当前表格导出 CSV |
| 工作区持久化 | 保存/恢复工作区（卡片布局 + 图型配置 + 依赖 + 已解析数据）为 JSON |
| 视图整理 | 平铺 / 层叠 / 关闭全部 |
| 中英切换 | 运行时切换 UI 语言（含图表轴标题与图例） |

## 技术选型

| 关注点 | 选型 |
|--------|------|
| 构建 | Vite 8 |
| 语言 | TypeScript 7（`strict`, `noUnusedLocals`） |
| 视图 | React 19 |
| 卡片窗口 | 自研 `CardShell` + react-rnd |
| 绘图 | ECharts 6（**SVG renderer**） |
| 状态 | zustand |
| 表格 | 自研虚拟滚动（无第三方） |
| 测试 | vitest + Playwright（冒烟） |

### 为什么留在 ECharts 而不是换库

需求是「常见统计图 + 矢量导出」。审计结论（对照已安装的 ECharts 6.1.0）：

- **矢量导出**：`echarts.init(el, null, { renderer: 'svg' })` 是原生能力，
  `getDataURL({type:'svg'})` / `getSvgDataURL()` 直接给出矢量串。**不需要换库。**
- **图型覆盖**：`bar` / `line` / `scatter` / `boxplot` / `heatmap` / `candlestick` /
  `custom` 等均已内置（见 `node_modules/echarts/lib/chart/`）。
- 只有 **小提琴图** 与 **误差棒** 没有原生类型，二者用 ECharts 真正的
  `custom` series（矢量图元）实现，因此**没有牺牲矢量导出**。

对比过的替代方案：Plotly.js / Observable Plot / Vega-Lite 在「小提琴、误差棒、回归拟合线」
上的覆盖并没有更好，而包体更大、SVG 导出更绕；换库无法解决唯一真正的短板（EPS），
却会丢掉已经验证过的连线层与卡片几何。**故保留 ECharts，把工作投入在补齐图型上。**

## 目录结构

```
src/
├── core/                    # 与前端框架无关的数据层（对应 C++ 的 core/）
│   ├── MatrixData.ts        #   列式矩阵：Pos.N 列 + annotation + number[]
│   ├── FileLoader.ts        #   加载器抽象 + 首行标题识别 + 文本解码
│   ├── DependencyGraph.ts   #   卡片依赖图（dependent → dependsOn）+ 环检测 + 边去重
│   ├── Smoothing.ts         #   4 种平滑算法 + SG 系数求解
│   ├── stats.ts             #   统计量：分位数/KDE/直方图/OLS/相关/离群点
│   └── numeric.ts           #   严格数字解析（fast_float 的替代）
├── charts/                  # 图表层（与 React 无关，可单测）
│   ├── chartTypes.ts        #   图型注册表 + 导出格式声明
│   ├── chartModel.ts        #   图表配置：图型 + 数据列 + 呈现选项
│   ├── chartOptions.ts      #   每种图型 → ECharts option（含 custom series）
│   ├── export.ts            #   SVG / PNG / PDF 导出管线
│   ├── pdf.ts               #   无依赖的极简 PDF 生成器
│   └── palette.ts           #   色盲友好调色板（Okabe–Ito）
├── loaders/                 # 具体格式解析
│   ├── parse.worker.ts      #   worker 入口：解析并回传 ColumnPayload[]
│   ├── parseWorker.ts       #   主线程侧客户端 + 无 worker 时的内联回退
│   └── parseTypes.ts        #   两侧共享的线格式（独立模块，避免 import 期访问 self）
├── ui/
│   ├── App.tsx              #   根组件：菜单动作、文件摄取、导入导出
│   ├── workspaceStore.ts    #   卡片状态 + 依赖图 + 关闭规则
│   ├── cardMetrics.ts       #   DOM 测量 → 连接线锚点坐标
│   ├── ConnectionLayer.tsx  #   SVG 连线层（= ConnectionOverlay）
│   ├── i18n.ts              #   中英词典
│   ├── fileActions.ts       #   文件选择 / 下载 / 工作区读写
│   └── components/          #   CardCanvas / CardShell / MatrixCard / ChartCard …
scripts/smoke.mjs            # headless Chromium 端到端冒烟（61 项检查）
tests/                       # vitest：171 个用例（*.dom.test.tsx 走 jsdom）
docs/screenshots/            # 文档配图
```

## 移植来源：C++ → TypeScript 映射

> ⚠️ **下表左侧的 C++ 路径已于 2026-10-15 从仓库删除**，它们不再指向可打开的文件，
> 只保留作为"每个模块当初是从哪里移植来"的出处记录。恢复方式见
> [`2026-10-15-qt-implementation-removed.md`](../docs/docs/decisions/2026-10-15-qt-implementation-removed.md)。

| C++（已删除） | TypeScript | 说明 |
|-----|-----------|------|
| `core/MatrixData.*` | `core/MatrixData.ts` | 语义一致；`cell()` 越界返回 `NaN` |
| `core/FileLoader.*` | `core/FileLoader.ts` + `loaders/*` | 由路径改为 `File`；删除 `split_row` 的 `0` 兜底 |
| `core/DependencyGraph.*` | `core/DependencyGraph.ts` | 原语义一致；Web 侧另补了环检测与边去重 |
| `core/algorithm/Smoothing.*` | `core/Smoothing.ts` | 四种算法逐行对照 |
| （无） | `core/stats.ts` | **新增**：为统计图型补齐统计量 |
| `widgets/MainWindow.*` | `ui/App.tsx` + `ui/components/CardCanvas.tsx` | |
| `widgets/CardRegistry.*` | `ui/workspaceStore.ts` | 依赖改为挂在**卡片**上，见下 |
| `widgets/ConnectionOverlay.*` | `ui/ConnectionLayer.tsx` | 颜色/贝塞尔控制点原样保留 |
| `widgets/MatrixCard.*` | `ui/components/MatrixCard.tsx` + `VirtualTable.tsx` | 列头右键改为选图型 |
| `widgets/ChartCard.*` | `ui/components/ChartCard.tsx` + `charts/*` | QCustomPlot → ECharts，单图型 → 9 图型 |

### 当年相对 Qt 版的**有意**差异

这些差异是移植时主动做出的选择；Qt 版现已删除，
本节保留是为了说明**为什么 Web 版的语义与历史文档中的 C++ 描述不同**。

1. **无法解析的单元格记为 `NaN`（显示 `—`），不再兜底为 `0`。**
   C++ 的 `TxtLoader` 在 `from_chars` 失败时写入 `0.0`，会静默污染测量数据。
2. **依赖挂在「矩阵卡片」而非「矩阵 id」上。**
   Qt 版 `ChartCard::SourceRef` 记录 `matrixId`，而一个卡片装多个文件时每个文件是**不同的
   矩阵 id**——于是「切换文件 → 图表联动」这条规则在 Qt 版**实际无法生效**。Web 版把依赖记为
   `图表卡片 → 矩阵卡片`，切换文件时把依赖图表重新指向新激活的矩阵；该行为有单元测试覆盖。
3. **常数序列的相关系数返回 `NaN` 而非 0。** 相关性在数学上未定义，报 0 会谎称「不相关」。
4. **小提琴图不报密度值当 Y 轴。** 曲线沿**数值轴**绘制，宽度编码密度（与 Matplotlib/Seaborn
   一致）；最初误把密度峰值当 Y 轴范围，导致图形被拉伸，已修正并有测试锁定。

## 构建产物

```
dist/index.html                  0.42 kB │ gzip   0.32 kB
dist/assets/index-*.css         11.9  kB │ gzip   2.8  kB
dist/assets/index-*.js         341    kB │ gzip 107    kB   ← 首屏
dist/assets/echarts-*.js     1 124    kB │ gzip 374    kB   ← 首开图表时加载
dist/assets/xlsx-*.js          492    kB │ gzip 160    kB   ← 首次打开 xlsx 时加载
```

## 已知限制

- 未实现逐元素公式计算；线性代数后端尚未立项（原「Eigen 集成」条目已随 Qt 代码删除而失去载体，见下）。
- 工作区保存的是**已解析数据**而非文件引用，大文件会得到很大的 JSON。
- 缺少少数进阶图型：等高线/密度二维图；带/带状误差（confidence band）**并未实现**，
  但**箱线图未支持凹口（notched）**、**未支持分组箱线图布局**。
- PDF 导出为位图封装（详见上文「导出」），不是矢量 PDF。
- 未提供 EPS（浏览器端无可行路径，见上文）。
- 表格单元格可编辑（矩阵卡文件行的锁按钮切换），公式卡可对源矩阵求值并实时预览；
  但**公式结果还不能作为图表的数据源**（`addChartCard` 目前要求源卡片是矩阵卡）。

## 许可证

与主仓库一致：**GPL-3.0**。
