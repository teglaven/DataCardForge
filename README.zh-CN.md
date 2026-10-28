# Data Workbench — 数据矩阵工作台

[![CI](https://github.com/teglaven/DataCardForge/actions/workflows/ci.yml/badge.svg)](https://github.com/teglaven/DataCardForge/actions/workflows/ci.yml)
[![Pages 演示](https://img.shields.io/badge/%E6%BC%94%E7%A4%BA-%E5%89%8D%E7%AB%AF%E5%9C%A8%E7%BA%BF-2ea44f)](https://teglaven.github.io/DataCardForge/)
[![许可证](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![测试](https://img.shields.io/badge/tests-493%20unit%20%C2%B7%2079%20e2e-brightgreen)](web/tests)

**[English](README.md) | [中文](README.zh-CN.md)**

一个面向工业/科研场景的轻量级**数据矩阵批处理工作台**。

> ⚠️ **早期试验项目**：截至 2026 年 10 月，本项目仍处于**早期试验阶段**，可用来体验功能、测试使用流程，但**强烈不建议**用于生产环境或正式的科研用途。

<p align="center">
  <img src="web/docs/screenshots/hero.png" width="92%" alt="Data Workbench：10000×10 测量文件作为数据卡，下游接一张相关性热力图卡">
</p>

**作者与权属**：`teglaven` · GPL-3.0 · 身份、时间线与提交锚点见 [`PROVENANCE.md`](PROVENANCE.md)。
**当前实测状态**（2026-10-28 实测）：前端 489 个单元测试（14 个 opt-in 跳过）· 后端 7 个 ctest（3 个 opt-in）· 端到端 73 项检查，全绿。
**尚未完成**：函数卡是半成品；端口级连线已修复，hover/断线编辑仍在路上——两者都在
[状态与已知缺口](#状态与已知缺口)里写清楚了。

## 试一下

**浏览器里直接玩（无需安装）**——<https://teglaven.github.io/DataCardForge/> 是前端的静态部署。把
[`docs/sampleData/1.txt`](docs/sampleData/1.txt) 拖进画布，右键列头 →「画图」即可。文件加载与 9 种图表
在那里都能用；C++ 计算服务不在静态托管上，函数卡会显示「后端不可达」横幅——这是设计里的可见降级，不是故障。

**本地跑完整版（含计算后端）**——一条命令编译后端并起两个服务：

```bash
./scripts/dev.sh          # 后端 :37811，Vite :5173
```

前置：Node 22+、CMake 3.24+、C++17 编译器、Eigen 3.4 头文件
（`sudo apt install build-essential cmake ninja-build libeigen3-dev`）。

## 设计理念

- **卡片模型**：所有东西都是卡片 —— 数据卡(文件) → 函数卡(变换) → 输出卡(绘图/导出)
- **严格分离**：数据与行为分离，表永不改写，一切处理产出新卡片
- **连线从属**：连线仅为数据依赖的可视化，常态低调（背景层），不干扰卡片布局与交互；卡片为主角，连线为配角
- **后端持有计算（B 方案）**：所有数值/统计/矩阵计算在 **C++/Eigen 后端**执行；浏览器是**纯交互界面**（渲染、输入、布局）。后端不可达是**带重试按钮的可见状态**，绝不静默。这取代了早期的 T1 浏览器基线分层表，同时保留[兜底原则](docs/docs/decisions/2026-10-15-max-headroom-principle.md)三条契约：可见降级、跨层语义一致（差分夹具）、最坏情况有界。完整论证见 [决策记录](docs/docs/decisions/2026-10-17-backend-owns-compute.md)
- **列式矩阵**：行=样本(No.N)，列=变量(Pos.N)，连续内存存储，高性能
- **可扩展**：算子系统 + 适配器接口，社区可贡献长尾功能

## 架构

```
┌─────────────────────────────────────────────────────┐
│                   浏览器（Web）                      │
│  React 19 · ECharts 6 · zustand · VirtualTable      │
│  卡片布局 · 端口 · 连线 · 状态指示灯                  │
│  纯交互——不做任何数值计算                            │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP + JSON + DCM1 二进制帧
                       ▼
┌─────────────────────────────────────────────────────┐
│              计算后端（C++17）                        │
│  Eigen 3.4 · 表达式引擎 · 依赖图                     │
│  矩阵存储 · 节点调度器 · 事件总线                     │
│  所有数值/统计/矩阵计算                              │
└─────────────────────────────────────────────────────┘
```

前端使用[协议 v1](docs/docs/architecture/backend-protocol-v1.md)：HTTP 上的 JSON 控制消息 + DCM1 二进制矩阵帧。长轮询事件流推送节点状态变更（dirty → computing → done | error），驱动四态指示灯。

## 已实现功能

### 文件加载
- 菜单 **文件 → 打开数据文件**、**右键空白区域**，或把文件直接**拖入画布**
- 多文件只创建**一个卡片**，卡片顶部下拉框切换当前显示的文件
- 支持 TXT / CSV / TSV / DAT / XLSX；CSV 支持引号转义与分隔符自动嗅探
- **标题行自动识别**：首行非纯数字时，作为每列标题（annotation）而非数据
- 文件来源的表格默认**只读**，卡片文件行上的锁按钮可切换为可编辑；无法解析的单元格显示 `—`（不再静默变 0），非数值输入会被拒绝并给出提示而不是静默丢弃
- 解析在 **Web Worker** 中进行，拖入万行文件不再冻结界面（无 Worker 环境自动回退到主线程）
- 重新打开同一文件仅在**字节一致**（`size` + `lastModified`）时复用解析结果；同名但内容不同的文件会重新解析——绝不让旧测量数据顶着新标签出现
- 加载的矩阵**自动注册到计算后端**（fire-and-forget，UI 不因网络阻塞）

### 绘图（ChartCard）
- 右键列头 → **直接选图型**（从该列起列数不够的图型置灰，并在悬浮提示里说明还差几列）
- **9 种科研/统计常用图型**，全部以 SVG 渲染、**全部可导出真矢量**：
  - 折线图、散点图、**回归图**（OLS + 斜率 + **R²** + n）
  - 柱状图（分组/堆叠）、**直方图**（Sturges 自动分箱或指定）
  - **箱线图**（中位数/四分位/须线 + **Tukey 离群点**）
  - **小提琴图**（KDE 密度轮廓 + 四分位线，能看出**双峰**）
  - **均值±误差棒**（**SD / SE / 95% CI**，帽宽可调）
  - **相关性热力图**（两两 **Pearson** 系数矩阵，发散配色）
- 图型可随时在卡片内切换；一个图表可挂**多列**（散点/回归按 (X,Y) 配对）
- 对数 Y 轴 / 次坐标轴 / 拟合线 / X 轴来源 / 重置缩放 等选项按图型自动提供
- 底部**平滑控件**：滑动平均 / 指数平滑 / 中值滤波 / Savitzky–Golay，改变时实时重绘，设置在切换数据源时保持不变
- **导出**：**SVG（真矢量，活 DOM 序列化、无内嵌位图）** / PNG（1×/2×/4×）/ PDF（位图封装，UI 明确标注非矢量）
- 文件切换时所有依赖图表自动更新；列不存在时保留旧数据
- 缩放 / 平移、图例（拟合线名不入图例）

> 统计量实现在 `core/stats.ts`，纯函数、40 个单元测试，数值约定与 NumPy/R 一致
> （线性插值分位数、Bessel 校正方差、Silverman 带宽、t 分布置信区间、Tukey 离群点）。

### 计算后端（C++/Eigen）

后端持有所有数据、依赖图和计算定义的**权威副本**。浏览器仅保留按 revision 键控的只读显示缓存。

- **表达式引擎**：TS 参考实现的逐语义移植（`expression.ts`）——81 个表达式夹具 + 14 个矩阵夹具 + 随机差分 fuzz（`DC_RUN_FUZZ=1`）保证结果一致。支持算术、比较、聚合（SUM/AVG/MIN/MAX/MEDIAN/STD，NaN 跳过 + Bessel 校正 STD）、逐元素数学函数（ABS/SQRT/LOG/LN/LOG10/EXP/POW/ROUND/FLOOR/CEIL/SIGN）、滑动窗口（MOV/EMA）、条件（IF）
  - **列引用写法**（2026-10-28）：`Pos.1`/`pos.1`（大小写不敏感）、裸注解名（`时间_秒`）、
    方括号逐字引用（`[地面速度_μm/s]`，名字含 `/`、空格、括号时唯一写法）、多输入端口限定
    （`A.pos.1`、`src.时间_秒`、`A.[…]`）；全角标点（`（）`/`，`/`×`/`／`/`－`）按 ASCII 等价物处理。
    见[决策](docs/docs/decisions/2026-10-28-expression-reference-syntax.md)
- **矩阵模式求值**：当任一输入变量声明为矩阵模式时，`*` 变为矩阵乘法；新增函数：`TRANSPOSE`、`DET`、`INV`、`SOLVE`、`MMUL`（显式矩阵乘）、`EMUL`（显式逐元素乘）。形状不匹配产生结构化 `shapeMismatch` 错误——绝不静默产出垃圾结果
- **依赖图**：按端口的边、原子成环拒绝（N 条边要么全加要么全不加）、经 `resultOwner_` 映射的结果矩阵感知级联
- **节点状态机**：dirty → computing → done | error，通过单调递增 seq 的事件流推送
- **协议 v1**：HTTP/1.1 + JSON 控制面 + DCM1 二进制矩阵帧 + 长轮询事件。连接时版本握手；不匹配 → 可见横幅

> 跨层测试夹具（`web/tests/fixtures/xlayer/`）是唯一裁判格式。
> TS 参考实现和 C++ 引擎必须通过同一份 JSON——CI 强制执行。

### 连线可视化（ConnectionLayer）
- **一条依赖边一根线**：表→函数卡、函数卡→函数卡、表/函数卡→图表都画（schema v2 之后函数卡也是图节点）
- 端点优先落在**端口**上（`portId` 是身份，永不按位置）；卡片没渲染该端口时退回朝向对方的卡片边缘
- 红色 = 源卡片被选中；蓝色 = 目标卡片被选中；灰色 = 都未选中；每根线目标端有箭头示向
- 选中卡片时，它的连线中点标出携带的 `portId`（多端口折叠显示 `+N`）
- 卡片移动、缩放时连线实时跟踪（布局版本号驱动，非定时器轮询）；**表格滚动不移动连线**
- 连线层 `pointer-events: none`，永不抢事件、不参与布局（**连线从属原则**天然满足）
- 线宽用 `non-scaling-stroke`，10%–300% 缩放下屏幕粗细一致（不会缩到看不见）

### UI / 交互
- 主题统一，浅/深色自动适配
- **无边界画布 + 整体缩放**：卡片平面随工作流生长，不再被一屏限制
  - **滚轮＝放大缩小整个工作台**（卡片、表格文字、图表、连线一起缩放，围绕光标，10%–300%）；
    指针在卡片上时滚轮仍归卡片（表格滚动、图表缩放），**按住 Ctrl/⌘ 同样可缩放**，触控板捏合亦可
  - **平移**：中键拖动、**空格+左键拖动**、空白处左键拖动
  - 菜单 **视图 → 回到卡片** 一键适应内容（自动缩放并居中）；**平铺 / 层叠** 在可见区域内排布
  - 详见[决策](docs/docs/decisions/2026-10-21-infinite-canvas.md)
- 卡片自由拖拽、缩放、层叠，另有**平铺 / 层叠 / 关闭全部**
- 有下游依赖的表格/卡片**拒绝关闭**并提示，同时闪烁其连线
- 运行时**中英切换**；**工作区持久化**（保存/恢复布局 + 依赖 + 数据）；表格导出 CSV
- **后端可用性横幅**：当计算后端不可达或版本不匹配时，显示带重试按钮的警告条——绝不白屏

### 函数卡（schema v2，2026-10-27）
- **依赖在信封上**：`inputs[]` 是唯一依赖表示，依赖图重建一次遍历、零卡种知识
  （v1 只从图表卡重建，公式卡依赖曾静默丢失）
- **一节点 K 输出**：签名（`FunctionSignature`）声明端口与输出数；`builtin:expression-columns`
  用一个节点算出一张宽表，取代 v1 的「每公式列一个节点、重复求值」
- **输入是显式矩阵**：切数据卡里的文件不再静默改变函数卡的输入；改用**卡片级待处理提示**
  + 列差异预览 + 一次确认（含批量），确认才写图。提示框是**黄底渐变 + 闪烁**（原先的淡蓝底
  和选中态同色，用户当成装饰扫过去了）：只有渐变位置与外侧光晕在动，文字不闪，
  开启「减少动态效果」时停闪、黄底与光环保留
- **列数契约**：命名输出列即锁宽度；上游宽度漂移由后端 `columnContractViolation` 断流并清空
  旧结果（下游呈「失效」），自编辑走「扩展契约 / 解除锁定」
- **结果可再流动**：右键函数卡结果列头 → 建图或「新建公式卡…」。函数卡的输出是普通矩阵，
  所以既能画图、也能喂给下一张函数卡（A → B 链式），重算后下游自动更新——数据流闭环
- **求值不持锁**：慢函数不会冻结整个节点注册表（最大余量原则）
- **签名可以完全不像公式卡**：`builtin:linear-regression` 是双单列端口、无表达式参数、
  输出形状由签名固定的函数（1 行 × 5 列：slope/intercept/r/r2/n），右键数据列
  「新建回归卡…」即可。参数区按签名渲染：有 `formulas` 才是编辑器，没有就直说
- **跨层裁判**：`web/tests/fixtures/cards/*.json` 同一份 JSON 由 TS 与 C++ 双边跑；
  `DC_RUN_INTEGRATION=1` 时还有一条真后端集成门禁
- **说明就在界面里**（2026-10-28）：左上角**帮助**菜单与公式卡「计算公式」区标题上的 `?`
  打开同一份说明（函数速查 / 列引用写法 / 示例 / 常见报错）；「可用列」是可点芯片，点一下
  在光标处插入 `Pos.N`；悬停静止 1 s 就在**指针位置**给出提示（不用原生 `title`，快速划过不弹）。
  说明内容与引擎函数表同源，测试断言两者的函数集合相等，说明书不会与引擎漂移

## 截图

下面每张图都是生产构建在 headless Chromium 里的真实输出，不是示意图（更多见
[`web/docs/screenshots/`](web/docs/screenshots/)，由 `web/scripts/smoke.mjs` 可复现生成）。

| | | |
|---|---|---|
| ![折线图](web/docs/screenshots/line.png) | ![散点图](web/docs/screenshots/scatter.png) | ![回归图](web/docs/screenshots/regression.png) |
| **折线图**——一列或多列按行号展开，可缩放/对数轴/平滑 | **散点图**——两列配对 (X, Y)，可叠加最小二乘线 | **回归图**——散点 + OLS 拟合，标注斜率与 R² |
| ![直方图](web/docs/screenshots/histogram.png) | ![箱线图](web/docs/screenshots/boxplot.png) | ![小提琴图](web/docs/screenshots/violin.png) |
| **直方图**——Sturges 自动分箱或显式指定箱数 | **箱线图**——中位数/四分位/须线/Tukey 离群点 | **小提琴图**——KDE 轮廓 + 四分位线，双峰一眼可见 |
| ![柱状图](web/docs/screenshots/bar.png) | ![均值±误差](web/docs/screenshots/errorbar.png) | ![相关性热力图](web/docs/screenshots/correlation-heatmap.png) |
| **柱状图**——分组/堆叠，按行号展开 | **均值±误差**——每列均值 + SD/SE/95% CI | **相关性热力图**——两两 Pearson 矩阵 |

## 适用范围与限制

- 内部数据采用 **IEEE 754 double**（约 15~17 位有效数字）存储，与 Excel 原生数值模型一致
- 适用于传感器、测量、实验等**浮点数值**数据的批量处理与可视化
- > ⚠️ **不适用**于需要十进制精确运算（如金融/会计金额）或任意精度计算的场景——此类需求 Excel 与多数同类工具同样无法满足
- 计算后端是**必需依赖**——没有它时文件加载和图表渲染仍可本地工作，但公式求值和矩阵运算不可用（带可见横幅提示）

## 状态与已知缺口

这个仓库对「什么算做完了」是明说的：数据卡与图表链路已完整并有门禁，卡片图这一层还在收尾。

| 维度 | 状态 |
|---|---|
| 数据卡、虚拟滚动表格、9 种图表、导出、中英切换、工作区持久化 | **已完成**，有单元 + 端到端门禁 |
| 计算后端（表达式引擎、矩阵算子、依赖图、调度） | **已完成**这两条签名（`builtin:expr`、`builtin:linear-regression`） |
| **函数卡** | **半成品（进行中）**——见下 |
| **端口级连线** | **2026-10-28 已修复**（边带 portId + 端口锚点 + 方向箭头）——见下 |

### 函数卡仍是半成品

已经能用的：从列或工具栏新建函数卡、按输出行编辑表达式、三区布局（输入端口 / 公式区 / 结果表）、
函数卡串接成链、函数卡结果可绘图、端口绑定单列（`mode: "cell"`）、列数契约及违约后的两条出路。

**2026-10-28 收口的两件事**：列引用写法（此前带表头文件的列**一个名字都引用不了**，连 `Pos.N`
退路都是坏的）与界面说明（帮助菜单 / 卡上 `?` / 悬停提示 / 可点列芯片）；顺带修好「一旦算出
结果，公式区被结果网格挤成 11 px、表达式行消失」的布局塌陷。详见
[日志](docs/docs/log/2026-10-28.md)与[语法决策](docs/docs/decisions/2026-10-28-expression-reference-syntax.md)。

仍然缺的，也是它不能算「完成」的原因：

- **按签名渲染的参数表单**——参数区目前只认 `params.formulas`（公式列表）。参数不是公式列表的签名
  （比如置信水平、窗口大小），卡片只会用陈述句说明输入由端口决定，没有控件可渲染。
- **多输出选择器（K > 1）**——卡片模型只有一个显示缓存，K > 1 的签名暂时只能看到第 0 个输出的表。
- 三区之间的布局、间距、状态等交互细节。

数据模型与契约是定死的（见 [`docs/docs/decisions/2026-10-27-card-contracts.md`](docs/docs/decisions/2026-10-27-card-contracts.md)、
[`2026-10-26-card-schema-v2.md`](docs/docs/decisions/2026-10-26-card-schema-v2.md)），缺的是它上面的 UI。
请把函数卡当成**接口稳定、交互未收口**。

### 端口级连线（2026-10-28 已修复）

schema v2 把依赖升成信封、把绑定挪到端口之后，连线一度退回卡片级：几何与交互都读不到 `portId`。
现在依赖图的边**携带 portId**，函数卡的输入端口与输出行都注册为锚点，连线端点按「端口 → 朝向卡片
的边缘」两级解析，选中卡片时线上标出端口身份。

仍然没做的：hover/点选单条线、删除单条线（断线等于改数据，需要撤回路，另立一项）、拖拽建线。
详见[决策记录](docs/docs/decisions/2026-10-28-port-level-connections.md)。

## 技术栈

| 组件 | 用途 | 备注 |
|------|------|------|
| React 19 + Vite 8 | UI 框架与构建 | TypeScript 7 `strict` |
| ECharts 6 | 统计图表 | **SVG renderer**，矢量导出 |
| react-rnd | 卡片拖拽/缩放 | |
| zustand | 状态管理（卡片表 + 依赖图） | |
| @e965/xlsx | Excel 读写 | 按需加载 |
| 自研虚拟滚动 | 大表渲染 | 无第三方依赖 |
| Web Worker（`src/loaders/parse.worker.ts`） | 解析离开主线程 | 大文件加载时界面不冻结 |
| **C++17 / g++ 15** | 计算后端语言 | CMake 4 + Ninja |
| **Eigen 3.4** | 线性代数/矩阵运算 | Header-only，`/usr/include/eigen3` |
| POSIX sockets | 后端 HTTP 服务 | 零第三方网络依赖 |

## 构建与运行

### 前置依赖

**前端**（Node.js 22+）：
```bash
cd web && npm install
```

**后端**（Ubuntu / Debian）：
```bash
sudo apt-get install build-essential cmake ninja-build libeigen3-dev
```

> 其他平台：任何 C++17 编译器 + CMake 3.24+ + Eigen 3.4 头文件均可。
> 已在 Ubuntu 26.04（g++ 15.2、cmake 4.2、ninja 1.13）上验证。

### 一键开发

```bash
./scripts/dev.sh          # 构建后端 + 同时启动两个服务
```

该脚本执行 `cmake --build backend/build`，在 37811 端口启动 `dc_backend`，并启动 `vite dev`（`/api` 代理到后端）。Ctrl-C 同时终止两者。

### 手动步骤

```bash
# 后端
cmake -S backend -B backend/build -G Ninja
cmake --build backend/build
./backend/build/dc_backend --port 37811

# 前端（另一个终端）
cd web
npm run dev               # 开发服务器 http://localhost:5173
npm run build             # 类型检查 + 生产构建 → web/dist/
npm test                  # 单元测试（vitest，含跨层夹具）
```

### 测试

```bash
# 前端：typecheck + 489 个单元测试（含 81 个跨层差分夹具）
cd web && npm run typecheck && npm test

# 后端：7 个 ctest 用例（跨层夹具、矩阵算子、节点注册表、卡片夹具；另有 3 个按需门控，默认 Skipped）
cd backend && ctest --test-dir build --output-on-failure

# 按需门控：差分 fuzz（随机表达式 TS↔C++ 对拍）与 HTTP 畸形报文压测
DC_RUN_FUZZ=1 ctest --test-dir build -R diff_fuzz --output-on-failure
DC_RUN_STRESS=1 ctest --test-dir build -R http_stress --output-on-failure

# 端到端冒烟（需先 npm run preview）
node web/scripts/smoke.mjs http://127.0.0.1:4173
```

### CI

GitHub Actions 在每次 push/PR 时运行三个 job：
1. **typecheck-and-test**：`npm ci` → typecheck → vitest → production build
2. **backend-test**：`apt install toolchain` → cmake build → ctest（跨层夹具 + 节点注册表）
3. **e2e-smoke**：Playwright Chromium 对 `vite preview` 做冒烟测试

## 架构扩展点

- `backend/src/expression.cpp` → 表达式引擎（cell 模式 + 矩阵模式评估器）
- `backend/src/matrix_value.h` → MatVal 类型，封装 Eigen::MatrixXd 并强制形状检查
- `backend/src/nodes.cpp` → 计算节点注册表、依赖图、调度器
- `backend/src/http_server.cpp` → 协议 v1 HTTP 端点
- `web/src/backend/client.ts` → 前端传输客户端（协议 v1）
- `web/src/loaders/` → 新文件格式适配器（`FileLoader`）
- `web/src/core/MatrixData.ts` → 客户端数据模型（B 方案下为显示缓存）
- `web/src/ui/ConnectionLayer.tsx` → 连线可视化
- `web/tests/fixtures/xlayer/` → 跨层差分测试夹具（唯一裁判格式）

## 短期目标

- [x] **前端方案决策** → **Web 确定**（2026-10-14）
- [x] **彻底移除 Qt UI 实现** → 仓库收敛为 web-first（2026-10-15）
- [x] **依赖环检测** → `DependencyGraph` 拒绝成环并去除重复边（2026-10-15）
- [x] **兜底原则确立** → 可见降级契约（2026-10-15）
- [x] **B 方案拍板** → 后端持有计算，浏览器纯交互（2026-10-17）
- [x] **跨层差分夹具** → 81 个表达式用例，单一 JSON 裁判格式（2026-10-17；2026-10-21、2026-10-28 扩充）
- [x] **差分 fuzz 门禁** → 随机表达式 TS↔C++ 对拍（含错误码/位置），种子可复现（2026-10-21）
- [x] **C++/Eigen 计算后端骨架** → 表达式引擎移植、节点注册表、HTTP API、协议 v1（2026-10-17）
- [x] **前端传输客户端** → 后端握手、矩阵注册、事件轮询、可见离线横幅（2026-10-17）
- [x] **一键开发 + CI 门禁** → `scripts/dev.sh`、vite proxy、GitHub Actions backend-test job（2026-10-17）
- [x] **Eigen 矩阵算子** → matmul/transpose/det/inv/solve + 矩阵模式表达式评估器 + 14 个矩阵夹具（2026-10-17）
- [ ] **函数卡 UI（三区布局）**——*部分完成*：左「输入」（端口 id + 模式徽章 + 显式矩阵文件名与形状）／公式区／结果表三区骨架已可用，表达式与线性回归两种签名、卡间串接、「结果可绘图」均已通；仍缺按签名的参数表单、K > 1 的输出选择器与交互打磨（端口锚点已于 2026-10-28 落地，详见「状态与已知缺口」）
- [x] **无边界画布（平移）** → 平面随卡片增长，四种平移手势，视图 → 回到卡片（2026-10-21）
- [x] **画布整体缩放** → 滚轮围绕光标缩放 10%–300%，卡片/字体/图表/连线一起缩放（2026-10-21）
- [ ] **画布小地图 / 缩放快捷键**：总览与键盘缩放（入口已清晰：复用 resetView 的取景计算）
- [ ] **VirtualTable 窗口化数据源**：大矩阵按可视行窗口取数，不再整包加载
- [x] **端口锚点**：`cardMetrics` + `ConnectionLayer` 支持 per-port 连线端点（2026-10-28）
- [x] **端口级逻辑连接提示**（2026-10-28 修复，见[状态与已知缺口](#状态与已知缺口)）
- [x] **四态指示灯** → 由节点状态事件驱动（灰/黄/绿/红），上游失败另呈灰色「失效」→ 2026-10-27
- [ ] 数据**编辑**能力（非文件来源卡片，双击编辑 + 公式求值）
- [x] 连线箭头指向目标端（2026-10-28）；红蓝双向高亮：单条线只会是其中一色，双向高亮仍待做
- [ ] **美化 card**：统一卡片样式、间距、配色与排版

## 长期规划

> 以下内容仅为方向性设想，可能随时变动；如有建议，欢迎提 [issue](https://github.com/teglaven/DataCardForge/issues)。

- [ ] **条件筛选卡**：按行/列谓词切割矩阵后再喂入函数卡
- [ ] **扩展卡（ExtensionCard）**：专用于服务特定卡片的**快速参数设置 + 实时预览**面板，只能通过父卡片创建并视其为父窗口、随父卡关闭；解决"卡片一多、参数设置分散"的瓶颈（支持滚轮快速调参 + 实时预览，如分段拟合项数、平滑窗口等）。
- [ ] **摘要面板（`builtin:summary`，名称待定）**——任意卡片上的描述性统计，**只在点名要的时候才算**。卡内可折叠面板；载荷是一张普通矩阵（行 = 统计量，列 = 变量），因此直接继承 CSV 导出、虚拟滚动表格，将来还能物化成真正的卡片去喂图表。首批 12 项：`n · nan · mean · sd · var · min · q1 · median · q3 · max · iqr · sem`；口径写死（样本 ddof = n−1、分位数线性插值、NaN 跳过但计数），统计量**在后端算**，保证全仓只有一份定义；失效沿用既有的定义版本守卫，`dirty` 带原因（`unrequested` 与 `upstream-changed` 分开），让「还没算」不会被读成「坏了」。
- [ ] **隐式方程求解**：从 A=B 关系中提取无法解析隔离的 B（当前单公式设计的已知限制）
- [ ] 平滑算法的更多模式，平滑算法考虑支持公式卡或者函数卡
- [ ] **多函数卡并行执行**：后端调度器 + job ID + 取消 + 乱序完成
- [ ] **WebSocket 升级**：用持久连接替代长轮询以降低状态推送延迟
- [x] **多语言（i18n）**：中/英文界面切换（Web 版已实现）
- [x] 工作区**持久化**（Web 版已实现卡片布局 + 依赖 + 数据的保存/恢复）

## 致谢

本项目由 **AI 编程助手**辅助开发（DeepSeek Harness / Claude 等 agent 工具，以及早期的 GitHub Copilot）。由作者完成的部分：需求定义、架构决策（见 [`docs/docs/decisions/`](docs/docs/decisions/)）、验收标准与测试门禁。本仓库不对「谁敲的字」作保证，只对**可复现性**负责——上面每一条功能声明都有对应的单元测试 / ctest / 端到端检查背书（见「测试」一节）。权属与时间线见 [`PROVENANCE.md`](PROVENANCE.md)。

## 许可证

Data Workbench 是自由软件：您可以依据自由软件基金会（Free Software Foundation）发布的 **GNU 通用公共许可证第 3 版（GPL-3.0）** 之条款，重新分发和/或修改本软件。

完整许可文本见 [LICENSE](LICENSE) 文件。

### 第三方依赖许可证

| 依赖 | 许可证 | 备注 |
|------|--------|------|
| React / Vite / ECharts / zustand / react-rnd | MIT / Apache-2.0 | Web 前端依赖 |
| @e965/xlsx | Apache-2.0 | SheetJS 社区构建 |
| Eigen 3.4 | MPL-2.0 | Header-only 线性代数（后端） |

*（Qt 时代的依赖——Qt 6、QCustomPlot、OpenXLSX、fast_float——已随 Qt UI 代码树于 2026-10-15 一并移除，
本项目不再分发或链接它们。2026-10-17 引入的 C++ 计算后端仅使用 Eigen 和标准库。）*
