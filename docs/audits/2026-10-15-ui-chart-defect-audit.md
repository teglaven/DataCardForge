# 前端 UI 与图表操作逻辑缺陷审查

- **日期**：2026-10-15
- **范围**：`web/src`（React 19 + Vite + ECharts 6 SVG 渲染器 + react-rnd）
- **方法**：静态通读全部前端源码 + 在 `http://127.0.0.1:4173` 的生产构建上用 headless Chromium（Playwright）做交互探测、逐像素取色、下载产物校验；另由独立审查复核 `styles.css` 与全部组件的交叉关系（含 WCAG 对比度计算、层叠上下文推导、最小尺寸算术）。探针脚本位于 `web/.probe/`（本地验证用，不入库）。
- **结论**：**2 个阻断级、11 个严重级、13 个中低级**缺陷。所有条目均给出复现步骤与实测证据。**全部条目已修复或已明确处置**，处置结果见每条的「状态」。

---

## 修复后的验证结果

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit` | 干净 |
| `vitest run` | **209 个测试通过**（9 个文件；新增「未定义相关系数标注」等断言） |
| `vite build` | 成功，无警告 |
| `scripts/smoke.mjs` | **全部 61+ 项端到端检查通过** |
| 逐像素复核 | 卡片内部的连线像素 **0**（修复前为可见蓝色）；最小尺寸下 9 种图型全部可达 |
| 独立复验（第二轮） | 阻断级 0；第一轮 4 个 MAJOR 全部复验通过，另发现 4 个新 MAJOR + 7 个 MINOR，**已全部修复并复验**（见文末「第二轮」） |

---

## 摘要

| # | 级别 | 问题 | 位置 | 状态 |
|---|---|---|---|---|
| 1 | 阻断 | 列头右键菜单错位，卡片离画布原点稍远即完全不可用 | `MatrixCard.tsx` + `.context-menu` | ✅ 已改 portal + 视口钳制 |
| 2 | 阻断 | 从靠右列建图会静默失败，同时谎报「已创建图表」 | `MatrixCard.tsx` | ✅ 按剩余列数禁用 + 仅在成功时提示 |
| 3 | 严重 | 连线绘制在卡片之上，横穿表格与标题栏 | `.connection-layer` | ✅ 图层降到卡片之下 + SVG 挖洞遮罩；源列高亮改由 DOM 承载 |
| 4 | 严重 | 每次渲染都重建 ECharts option 并对所有图表卡 `setOption` | `workspaceStore.ts` | ✅ translator 按 locale 缓存 |
| 5 | 严重 | 显式 X 轴是冻结快照，切换文件后 X 与 Y 来自不同文件 | `workspaceStore.ts` | ✅ 随源一同重指，列消失则回落行号 |
| 6 | 严重 | 热力图把「相关系数未定义」画成 `0` | `chartOptions.ts` | ✅ 保留 NaN，标签显示 `—` |
| 7 | 严重 | 公式卡结果不随源表切换文件刷新 | `workspaceStore.ts` | ✅ 依赖方中一并重算公式卡 |
| 7b | 严重 | 公式列无法绘图，但文档声称可以 | `FormulaCard.tsx` | ⚠️ 文档已改为如实描述（绘图仍未实现，见下） |
| 8 | 严重 | 状态栏泄漏字面量 `{size}` | `App.tsx` | ✅ `downloadText` 返回字节数并传入 |
| 9 | 严重 | 中文界面下多处字符串仍是硬编码英文 | 多处 | ✅ 新增 16 个 i18n 键，清除全部硬编码（含公式报错） |
| 10 | 严重 | 变更一个图表会让**所有**图表重建；公式输入逐键全量重算 | `ChartCard.tsx`、`FormulaCard.tsx` | ✅ 同 4；公式输入加 250ms 防抖 |
| 11 | 严重 | 「可编辑单元格」在 UI 上完全无法触达 | `workspaceStore.ts` | ✅ 矩阵卡新增锁定/编辑按钮 |
| 12 | 中 | react-rnd 四角缩放手柄被 `overflow: hidden` 裁掉 | `.card` | ✅ 裁剪下移到标题栏/正文；实测 560×400 → 290×250 |
| 13 | 中 | `xAxisSource` 失效后下拉框与图表实际轴不一致 | `ChartCard.tsx` | ✅ 值不在选项内即回落「行号」 |
| 14 | 中 | 可移除列到低于图型下限，图表变成空状态 | `workspaceStore.ts` | ✅ 以 `minimumColumns` 为下限；chip × 同条件隐藏 |
| 15 | 中 | 单元格编辑用 `Number()`：空串→0、`0x10`→16、`Infinity` 被写入 | `VirtualTable.tsx` | ✅ 改用 `isNumeric`/`parseNumeric`，非法输入报错 |
| 16 | 中 | 切换图型时补列从索引 0 起找，列的角色与预期相反 | `workspaceStore.ts` | ✅ 从已附列处向后取 |
| 17 | 中 | 工作区恢复后的状态栏把「矩阵数×卡片数」标成「行×列」 | `App.tsx` | ✅ 新增 `status.workspace` |
| 18 | 中 | CSV 导出无 BOM，Excel 打开中文表头乱码 | `fileActions.ts` | ✅ 加 UTF-8 BOM |
| 19 | 中 | 缩放无法重置 | `chartOptions.ts` | ✅ 坐标轴面板新增「重置缩放」（启用原本闲置的键） |
| 20 | 中 | 弹层在最小卡片尺寸下被裁掉（类型下拉只剩 5/9 项；长文件名把面板撑到 540px） | `.chart-card__popup` | ✅ portal + 视口钳制 + `max-width`；实测 9/9 可达 |
| 21 | 中 | 最小尺寸（280×180）下平滑行落在卡片外 80px，控件不可达 | `.chart-card__plot`、`MIN_CARD_HEIGHT` | ✅ 绘图区下限 80→48，卡片最小高度 180→240 |
| 22 | 中 | 深色模式 `#fff` on `--accent` = 2.90:1；`--danger` 未在深色块重声明 = 2.71:1 | `styles.css` | ✅ 新增 `--on-accent`/`--on-danger` 与深色 `--danger` |
| 23 | 中 | 状态栏消息被压到 0 宽，而提示占 293px | `.statusbar` | ✅ 提示可收缩，窄屏（<720px）隐藏 |
| 24 | 中 | 标题栏徽标把标题挤成 40px | `.card__badge` | ✅ 徽标可收缩且带省略号 |
| 25 | 中 | flex 容器上的 `text-overflow` 从不生效，标签被切在字形中间 | `.chart-card__chip`、`.vtable__colhead` | ✅ 标签改为独立 `<span>` 盒子 |
| 26 | 中 | 闲置连线灰色 2.27:1（低于 3:1） | `ConnectionLayer.tsx` | ✅ 改为 `rgb(107,114,128)`（≈4.6:1） |
| 27 | 低 | 空状态提示 `--text-dim` on `--bg` = 4.20:1 | `.empty-state` | ✅ 改用 `--text` |
| 28 | 低 | 全局没有 `:focus-visible` 规则 | `styles.css` | ✅ 新增一条通用焦点样式 |
| 29 | 低 | 多余列选择框无可访问名称 | `ChartCard.tsx` | ✅ 补 `aria-label`/`title` |
| 30 | 低 | 死代码与重复实现 | 多处 | ✅ 已删（见文末） |
| 31 | 低 | 「新建表格…」实际打开文件选择器 | `App.tsx` | ✅ 改名「打开数据文件…」，并修正空状态与就绪提示 |
| 32 | 低 | `.gitignore` 仍引用改名前的 `data-workbench/` 路径 | `.gitignore` | ✅ 已修 |
| 33 | 低 | 卡片边框对比度不足 3:1 | `--border` | ⚪ 保留（见文末「有意保留」） |
| 34 | 低 | 拖拽/缩放/编辑仍仅支持指针操作 | 多处 | ⚪ 部分处置（焦点样式 + aria），键鼠完整支持未做 |

---

## 阻断级

### [阻断] 1. 列头右键菜单错位，稍远即完全不可点击 ✅ 已修复

**类型**：UI 显示 / 交互（这是创建图表的**唯一**入口）

**机制**：`MatrixCard` 把 `ColumnContextMenu` 渲染在 `CardShell` 的 children 里，也就是渲染在 react-rnd 生成的卡片 `div` **内部**。该 `div` 带有 `transform: translate(Xpx, Ypx)`（react-draggable 4.7.2 的定位方式，实测 `card.outerHTML` 可见）。按 CSS Transforms 规范，`transform !== none` 的元素会成为后代中 `position: fixed` 元素的**包含块**。因此 `.context-menu { position: fixed }` 不再是相对视口定位，而是相对卡片定位；同时它又落在 `.card { overflow: hidden }` 的裁剪范围内。代码用的是 `left: event.clientX; top: event.clientY`（视口坐标），于是菜单被整体平移了「卡片相对画布的偏移量」。

**复现与实测**（探针 `web/.probe/ui-probe2.mjs`）：

| 卡片位置 | 右键处视口坐标 | 菜单实际渲染位置 | 偏移 | 结果 |
|---|---|---|---|---|
| (24, 58) | (388, 131) | (413, 189) | dx=25, dy=59 | 勉强可用 |
| (800, 454) | (1164, 527) | **(1965, 981)** | dx=801, dy=455 | **10/10 菜单项全在视口外** |

视口为 1440×900。菜单底线 1256、右边界 2135，全部溢出。截图 `web/.probe/shots/menu-card-at-900-520.png` 中**看不到任何菜单**。复制审查独立复现：卡片在页面 (404,308)、点击 (650,380.5) → 菜单盒 (1055,689)，`elementFromPoint(菜单中心)` 返回 `canvas`（即什么都没画出来）。

**影响**：把表格卡拖到画布中下部（或经过几次「层叠」）之后，用户右键列头将得不到任何可见反馈，无法创建图表、也无法创建公式卡。

**修复**：新增 `components/Popup.tsx` —— 用 `createPortal` 渲染到 `document.body`，保留 `position: fixed`，测量后按视口钳制，空间不足时向上翻转。菜单、坐标轴面板、导出面板与图表类型下拉全部改用它。

---

### [阻断] 2. 靠右列建图静默失败，却弹出「已创建图表」 ✅ 已修复

**类型**：图表逻辑 / 反馈正确性

**机制**：`addChartCard` 从被点击的列号开始往后取列，取不满 `minimumColumns(type)` 就 `return null`。而菜单项的禁用条件是 `minimumColumns(id) > columnCount`，**没有考虑起始列号**；`onSelect` 又无条件弹 toast。

**复现**：
1. 载入 `docs/sampleData/1.txt`（10 列）
2. 右键**最后一列**（Pos.10）列头 → 选「散点图」（需要 2 列）
3. 菜单项可点击，点击后……

**实测**：`cards before=1 after=1`（未创建任何卡片），状态栏却显示 `Created chart: Pos.10`。

**修复**：禁用条件改为 `columnIndex + minimumColumns(id) > columnCount`（并在 tooltip 里说明还差几列）；`onOpenChart` 返回新建卡 id，仅成功时弹成功提示，失败时弹 `status.needTrailingColumns`。

---

## 严重级

### [严重] 3. 连线绘制在卡片**之上**，横穿表格与标题栏

**类型**：UI 显示 / 与文档不变量矛盾

**机制**：`.connection-layer { z-index: 900 }`（`styles.css:197`），`.canvas__cards` 未设 z-index（`auto`，`styles.css:164-168`），卡片是它的子元素、内联 `z-index: 1..N`。两者同处 `.canvas` 这一层叠上下文，正 z-index 按升序绘制 → 卡片(1..N) 先画，SVG(900) 后画 = 连线在最上层。

这与代码自己声明的不变量相反：`ConnectionLayer.tsx:4-6` 写着「connections are a background visualization … they never take part in card layout」，`.connection-layer` 注释写着「Connections are a background visualization」。

**实测**（`ui-probe4.mjs`，逐像素 A/B）：

```
曲线取样点 (108,134) —— 落在矩阵卡内部：
  连线图层可见时：rgb(40, 120, 220)   ← 连线颜色
  连线图层隐藏时：rgb(246, 247, 249)  ← 卡片背景色
=> 连线几何绘制在卡片之上
```

**修复方向**：两种意图需要分开满足——*连线*应是背景（用 SVG `mask` 按各卡片矩形挖洞，使其只在卡片之外可见），而*源列高亮框*需要压在表格头上（保留在未遮罩的图层里）。或者把高亮框下沉为 DOM 上的列头样式类，整体图层降到卡片之下。

---

### [严重] 4. 每次渲染都重建 option，并对所有图表卡重设 ECharts

**类型**：图表逻辑 / 性能

**机制**：`useTranslator()` 在**每次渲染**都调用 `createTranslator(locale)` 并返回一层新的箭头函数（`workspaceStore.ts:931-935`），所以 `t` 的引用每次都变。`ChartCard` 的 `strings` useMemo 依赖 `[t, card.config.errorKind]`（`ChartCard.tsx:137`）→ 每次渲染失效 → `option` useMemo（`:139`）失效 → `useEffect([option])`（`:147`）每次都执行 `chart.setOption(option, { notMerge: true })`。

`CardCanvas` 的 `renderedCards` useMemo 依赖 `reportBlocked`/`handleClose`，而它们又依赖 `t`（`CardCanvas.tsx:67,91`），于是整个卡片树每次 store 变化都全量重渲染。

**实测**（`ui-probe4.mjs`，3 个图表卡）：

```
只改 图表#0 的平滑模式 → setOption 调用：{"0":1,"1":1,"2":1}   ← 另外两个图表无辜重建
拖动矩阵卡（本应与任何图表无关）→ setOption 调用：{"0":2,"1":2,"2":2}
```

**修复方向**：按 locale 缓存 translator，令 `t` 的引用稳定（一处修复同时解决本项与第 10 项）。

---

### [严重] 5. 显式 X 轴是冻结快照，切换文件后 X 与 Y 来自不同文件

**类型**：图表逻辑 / 数据正确性

**机制**：`ChartCard` 设置 X 轴时把 `col.data.slice()` 复制进 `config.xAxisSource.raw`（`ChartCard.tsx:337`）。`refreshDependentCharts` 只重新指向 `config.sources`（`workspaceStore.ts:209-225`），**完全没有处理 `xAxisSource`**。切换文件后源的 `raw` 更新、X 轴的 `raw` 保持旧值 → 曲线被画在错误的自变量上，且没有任何提示。

**实测**（`ui-probe5.mjs`，一个卡片内放 1.txt + 2.txt，用 Pos.2 作 X 轴后切换文件）：

```
切换前 X 值：[ -0.949978489554666, 0.852181561014621, 1.30557621680214 ]
切换后 X 值：[ -0.949978489554666, 0.852181561014621, 1.30557621680214 ]  ← 完全没变
切换后 Y 值：已正确变为 2.txt 的数据
=> X 值未跟随文件切换（旧文件的快照）
```

**修复方向**：`refreshDependentCharts` 中按与 sources 相同的规则重指 `config.xAxisSource`（含列不存在的兜底）。

---

### [严重] 6. 热力图把「相关系数未定义」画成 `0`

**类型**：图表逻辑 / 科学正确性

**机制**：`pearson()` 对常数列**故意**返回 `NaN`（并在 `stats.test.ts` 中断言），但绘图时被改写成 0：

```ts
// chartOptions.ts:568
const value = Number.isFinite(matrix[row][col]) ? matrix[row][col] : 0;
```

配合 `visualMap` 的 `-1..1` 双向色标，`0` 落在白色 = 「无相关」。于是「这一列的相关系数无法定义」被显示为「不相关」，并且单元格标签写成 `0.00`。

**实测**（`ui-probe4.mjs` 中热力图渲染；另见 `web/.probe/shots/`）：常数列单元格显示 `0.00` 而非缺失标记。

**修复方向**：保留 `NaN` 传给 ECharts（热力图会留空），标签对非有限值显示 `—`。

---

### [严重] 7. 公式卡结果不随源表刷新；公式列也无法绘图

**类型**：图表逻辑 / 数据正确性 + 文档与实现不符

**机制**：`refreshDependentCharts` 只处理 `isChartCard(card)`（`workspaceStore.ts:206`），公式卡虽然通过 `addDependency` 登记为依赖方（`:664`），但它的结果矩阵从不重算。同时 `FormulaCard` 渲染 `VirtualTable` 时**没有传 `onHeaderContextMenu`**（`FormulaCard.tsx:160-165`），而 `addChartCard` 又要求 owner 是 `MatrixCardModel`（`workspaceStore.ts:307`）——所以公式结果列无法派生图表。这与 `FormulaCard.tsx:8-10` 的注释直接矛盾：「The result matrix … **can be charted like any other matrix** — charts created from it automatically follow when the source file switches or the formula changes.」

**实测**（`ui-probe5.mjs`）：

```
公式卡标题：Formula — F2        ← 泄漏内部 card id
右键公式结果列头 → 上下文菜单是否出现：false
切换源文件前 公式第 1 行：0.557707
切换源文件后 公式第 1 行：0.557707   ← 未跟随（源矩阵已换成另一个文件）
```

**修复方向**：① 在 `refreshDependentCharts` 中同时重算公式依赖方；② 若要兑现注释，需要让 owner 支持公式卡、公式表暴露列头右键菜单、`ConnectionLayer` 的 owner 解析也纳入公式卡。③ 若暂不支持，应改掉注释与 `card.formula` 的命名。

---

### [严重] 8. 状态栏泄漏字面量 `{size}`

**类型**：UI 显示 / i18n

**机制**：`createTranslator` 只替换传入的参数（`i18n.ts:275-283`）。`status.exported` 的模板是 `'已导出 {name}（{size}）'`，但三处调用只传了 `name`：

- `App.tsx:102`（保存工作区）
- `App.tsx:142`（导出 CSV）
- `App.tsx:175`（批量导出图表 SVG）

**实测**（`ui-probe3.mjs`，英文界面）：

```
CSV 导出后状态栏："Exported 1.csv ({size})"
批量导出后状态栏："Exported 1 SVG(s) ({size})"
```

**修复方向**：让 `downloadBlob`/`downloadText` 返回字节数并传入 `size: formatBytes(bytes)`；或为这类无尺寸消息增加不含 `{size}` 的键。

---

### [严重] 9. 中文界面下多处硬编码英文

**类型**：i18n

| 位置 | 泄漏字符串 | 实测 |
|---|---|---|
| `ChartCard.tsx:124` | `rowIndex: 'No.'` | 轴名在中文界面仍为 `No.` |
| `ChartCard.tsx:127` | `density: 'Density'` | 小提琴图例 `Density` |
| `ChartCard.tsx:130` | `outliers: 'outliers'` | 箱线图图例 |
| `ChartCard.tsx:132` | `quartiles: 'IQR'` | 箱线图图例 |
| `ChartCard.tsx:492` | `vector` 徽标 | 导出菜单 `Export SVG (vector)vector` |
| `StatusBar.tsx:27` | `card` / `cards` | 中文界面状态栏尾部 `2 cards` |
| `chartOptions.ts:706` | 轴名写死 `'No.'`，`strings.rowIndex` **从未被使用** | 见上 |
| `ExpressionError`（`expression.ts:96,221-271`） | 全英文报错 | 公式卡错误提示 |
| `workspaceStore.ts:357,906` | 写死中文 toast（`循环依赖：…`、`工作区含 N 条循环依赖…`） | 英文界面下出现中文 |

**实测**（`ui-probe3.mjs`，切到中文后读取 SVG 文本）：

```
折线图：["数值","No.","-2","-1","0","1","2","0","2,000",…]
小提琴图：["数值","-2.312","-2","-1","0","1","2","2.308","Pos.1","Density"]
箱线图：["数值","-2.232","-2","-1","0","1","2","2.228","Pos.1","IQR"]
状态栏：["就绪 — …","2 cards","虚拟滚动 — 只渲染可见行"]
```

同时 `i18n.ts` 中 `chart.confidence`、`chart.resetZoom`、`chart.empty`、`status.needColumns`、`card.activate`、`table.editable`、`newMatrix.title` 共 7 个键**从未被引用**。

---

### [严重] 9b. 公式报错是英文原文 ✅ 已修复

`ExpressionError` 只带一句英文（`Unexpected token 'eof'`、`Unknown column 'X'`…），中文界面下直接显示原文。实测中文界面输入 `MOV(Pos.1)`、`NOPE(Pos.1)`、`XXX + 1`、`Pos.1 @ 2` 分别得到 `Unexpected ...` 系列英文。

**修复**：`ExpressionError` 增加结构化的 `code` + `params`（英文 `message` 保留给日志与测试），UI 侧按 `formula.error.<code>` 渲染本地化句子。复核（中文界面）：

```
"Pos.1 * 2 +"  -> 无法解析的记号「eof」
"NOPE(Pos.1)"  -> 未知函数「NOPE」
"XXX + 1"      -> 未知列名「XXX」
"MOV(Pos.1)"   -> 「MOV」需要 2 个参数，实际给了 1 个
"Pos.1 @ 2"    -> 无法识别的字符「@」（第 6 个字符）
```

同时把文档标题接上原本闲置的 `app.title`，状态栏卡片数改为 `status.cards`（中文「2 张卡片」）。

### [严重] 10. 选项改动波及所有图表；公式输入逐键全量重算

**类型**：性能 / 交互

- 前者与第 4 项同源，实测数据见上。
- 后者：`FormulaCard` 的输入框 `onChange` 直接调 `setFormula`（`FormulaCard.tsx:117-130`），而 `setFormula` 每次都会 `computeFormulaResult` 重算**整个**结果矩阵（`workspaceStore.ts:695`）并新建 `matrices` Map。输入 20 个字符的表达式 = 对 10000 行做 20 次完整求值 + 20 次全卡片树重渲染，且 `MOV/EMA` 这类窗口函数代价随窗口线性增长。

**修复方向**：输入本地 state + 250ms 防抖后再 `setFormula`。

---

### [严重] 11. 「可编辑单元格」在 UI 上完全无法触达

**类型**：功能可达性

**机制**：`workspaceStore.setEditable` 在整个代码库**没有任何调用者**（已用 grep 确认）。`addMatrixCard` 一律写 `readOnly: true`（`workspaceStore.ts:290`），而矩阵卡只可能由 `addMatrixCard` 产生。`VirtualTable` 的编辑分支要求 `!readOnly`（`VirtualTable.tsx:196,220`），因此永远走不到。

菜单「新建表格…」实际调用 `pickFiles(true)` 打开文件选择器（`App.tsx:92-95`），并不能创建空表。上一轮交付的「可编辑单元格」通路（`editCell` → `MatrixData.setCell` → `refreshDependentCharts`）只在单元测试里被调用过，UI 上无法触发。

**修复方向**：在矩阵卡文件行加入「只读 / 可编辑」切换（`setEditable`），或让文件表默认可编辑；并把「新建表格…」改名为名副其实的「打开数据文件…」。

---

## 中级

### [中] 12. react-rnd 缩放手柄被 `overflow: hidden` 裁掉，四角缩放失效

**类型**：UI 交互 / 可发现性

**机制**：`.card { overflow: hidden }`（`styles.css:225`）裁掉了 re-resizable 渲染的缩放手柄——它们是**无 class 的裸 `div`**，仅靠内联样式定位在卡片边框之外：

```
se-resize: width:20px; height:20px; right:-10px; bottom:-10px
col-resize(W): width:10px; height:100%; left:-5px
```

四角手柄的几何中心恰好落在卡片边框上，实测 `elementFromPoint` 在该点返回 `.canvas` 而非手柄本身，拖拽四角**完全没有反应**：

```
卡片 before: 640x420 → after: 640x420    => 未缩放
```

边缘手柄（`-5px` 偏移，内侧一半在卡片内）可用：图表卡南边拖拽 `560x400 → 560x448`。此外样式表**没有任何**针对手柄的规则，所以既无可见抓手也无 hover 反馈——缩放是一个不可发现的手势。

**修复方向**：把裁剪从 `.card` 下移到 `.card__titlebar` / `.card__body` 的圆角，令手柄露出；同时给手柄加可见样式。

### [中] 13. `xAxisSource` 失效后，下拉框显示与图表实际轴不一致

**类型**：UI 显示 / 状态一致性

`availableColumns` 只列出「当前源所属矩阵」的列（`ChartCard.tsx:214-236`）。当 X 轴源指向的矩阵不再属于该集合（典型场景：切换了文件，见第 5 项）时，`<select>` 的 `value` 找不到对应 `<option>`，浏览器回落到第一项「行号 (No.N)」，而图表仍在用旧矩阵的数据，轴名仍是旧列名。

**实测**（`ui-probe5.mjs`，切文件后）：

```
下拉框显示：{"value":"","text":"Row index (No.N)"}
SVG 中的轴名：… "Pos.2" …
=> 控件标签与实际图表互相矛盾
```

### [中] 14. 可以把列删到低于图型下限，图表变成空状态

**类型**：图表逻辑

`removeChartSource` 只保证「至少剩一列」（`workspaceStore.ts:619`），不看 `minimumColumns`。散点图/回归图需要 2 列，删到 1 列后 `drawable` 变 false，图表卡退化为「需要至少 2 列」的提示——用户把自己刚建好的图弄坏了，且该操作不可撤销。同时删空某矩阵的最后一列后，`dependencies` 里的边不会清理（UI 目前无法构造该场景，属潜在问题）。

### [中] 15. 单元格编辑用 `Number()` 解析

**类型**：数据正确性

`VirtualTable.tsx:204`：`const parsed = Number(event.target.value)`。

- 清空输入框 → `Number('') === 0` → 把缺失值写成 `0`
- `0x10` → 16；`1e3` → 1000
- `Infinity` → `Infinity`，写入矩阵后 `formatCell` 显示 `∞`，并污染统计量与图表
- `'abc'` → `NaN` → 静默丢弃用户的编辑，无任何提示
- Escape 分支先 `setEditing(null)` 使输入框卸载，`onBlur` 仍可能先触发提交

而显示侧走的是严格解析（`core/numeric.ts` 的 `isNumeric`/`parseNumeric`），两侧语义不一致。

### [中] 16. 切换图型补列时从索引 0 起找，列的角色与预期相反

**类型**：图表逻辑

`setChartType` 在需要更多列时，从 `index = 0` 开始补未使用的列（`workspaceStore.ts:549`）。以「1 列(line, 索引 5) → 散点图」为例：补进来的是索引 0，成为 `sources[1]`，而 `pairs` 语义是 `sources[0]` 为 X、`sources[1]` 为 Y。结果是 **X = 用户点的第 5 列，Y = 无关的第 0 列**，与 `addChartCard`「先点中的列、再后续列」的约定不一致。

### [中] 17. 工作区恢复后的状态栏把计数标错

**类型**：UI 显示

`App.tsx:116-120` 把 `snapshot.matrices.length` 当 `rows`、`snapshot.cards.length` 当 `cols` 传入 `status.loaded`，于是打开工作区后显示「已加载 x.json（3 行 × 5 列）」——实际是 3 个矩阵、5 张卡片。

### [中] 18. CSV 导出无 UTF-8 BOM

`fileActions.ts:141` 用 `downloadText(..., 'text/csv;charset=utf-8')` 且 `matrixToCsv` 不在首部写 BOM。中文表头（列标注）在 Excel 中会乱码。对一个中文优先的工具而言这是实际问题。

### [中] 19. 缩放无法重置

`chartOptions.ts:772-777` 无条件启用两个 `inside` 型 `dataZoom`（x 与 y、`filterMode: 'none'`）。鼠标滚轮悬停在图表上会缩放而不是滚动页面，且没有任何重置入口——`i18n.ts` 里已经准备好的 `chart.resetZoom`（重置缩放）从未被使用。

---

## 低级

| # | 问题 | 位置 |
|---|---|---|
| 20a | `echartsRasterDataUrl` 无任何调用者 | `charts/export.ts:216` |
| 20b | `useConnectionGeometry` 里构建了 `byId` 却只用 `void byId` 丢弃 | `ConnectionLayer.tsx:64,108` |
| 20c | `result.vector ? 'info' : 'info'` 两个分支相同 | `ChartCard.tsx:189` |
| 20d | `chartIsDrawable` 与 `chartModel.isDrawable` 逻辑重复，`ChartCard` 又内联了第三份 | `ChartCard.tsx:678`、`chartModel.ts:143`、`ChartCard.tsx:88` |
| 20e | 7 个 i18n 键从未使用（见第 9 项） | `i18n.ts` |
| 20f | 卡片徽标 `N × M points` 语义含糊；对 `single`/`matrix` 图型会把未参与绘制的列也计入 N | `ChartCard.tsx:238` |
| 20g | 误差帽宽滑块没有数值回显（α 与窗口有） | `ChartCard.tsx:443-452` |
| 20h | 多文件同时加载失败时，单个 toast 槽位互相覆盖，只能看到最后一个错误 | `workspaceStore.ts:810` |
| 20i | `toSnapshot` 直接存 `col.data` 引用，快照与实时矩阵共享数组 | `workspaceStore.ts:843` |
| 20j | `loadSnapshot` 无条件信任文件里的 `nextCardId`/`nextMatrixId`，手工编辑过的存档可造成 id 碰撞 | `workspaceStore.ts:897` |
| 20k | `removeCard` 只在 `isMatrixCard` 时清理 `matrices`，公式卡的 `resultMatrixId` 永久残留 | `workspaceStore.ts:390` |
| 20l | 拖拽文件经过非空画布时的提示文案复用了 `empty.hint`（「右键新建表格，或把文件拖到这里」） | `CardCanvas.tsx:230` |
| 21 | 「新建表格…」打开文件选择器；应用没有任何创建空表的路径 | `App.tsx:92`、`EmptyState.tsx:22` |
| 22 | `.gitignore` 仍引用改名前的 `data-workbench/docs/private/`、`data-workbench/docs/.obsidian/`，改名时漏改 | `.gitignore` |

---

## 补充发现（由 `styles.css` × 组件的交叉审查给出，均已实测）

以下条目由并行的样式审查发现，其中前三条是我的交互探测**未能复现**的（因为我无法把卡片缩到真正的最小尺寸——四角缩放手柄当时被裁掉了，见第 12 项），实测数据由该审查提供。

### [中] 20. 图表卡下拉面板在最小尺寸下被裁掉 ✅ 已修复

`.chart-card__popup` 原本是 `position: absolute; top: calc(100% + 4px); left: 0; max-height: 320px`，落在 `.card`/`.card__body` 的 `overflow: hidden` 之内：

- **底部**：卡片处于 280×180 时面板从 143 到 353，而正文底部是 261 → **溢出 92px**；类型下拉只剩 Line/Scatter/Regression/Bar/Histogram 可见，**Box plot / Violin plot / Mean ± error / Correlation heatmap 完全不可达**（`elementFromPoint` 在 5–9 项中心返回 `canvas`）。面板自身 `clientHeight == scrollHeight`，所以它自己的 `overflow-y: auto` 永远不会介入——裁剪来自卡片。
- **右侧**：280px 宽时坐标轴面板实测 **540px 宽**（其中 x 轴 `<select>` 单独 471px，被最长的选项文件名撑开）→ 溢出 328px，只有左边缘的一条可见可点。

**修复**：面板改走 `Popup` portal + 视口钳制 + 上下翻转；`.chart-card__popup` 增加 `max-width: min(320px, calc(100vw - 24px))`，`.chart-card__field` 内的 `select`/`input` 增加 `min-width: 0; max-width: 100%`。
**复核**：最小尺寸下类型下拉 **9/9 项全部在视口内**（`{count:9, allOnScreen:true}`）。

### [中] 21. 最小尺寸下卡片装不下自己的内容，平滑控件落在卡片外 ✅ 已修复

算术：正文 = 180 − 2 边框 − 30 标题栏 − 1 = 148px（实测 148）。固定行：工具栏 31 + 页脚（数据列 32 + 平滑 32 + 1 = 65；**宽度到 280px 时两行换行后为 117**）= 96…148。`148 − 31 − 65 = 52`，**小于** `.chart-card__plot` 的 80px 下限 → 最少溢出 28px（换行时实测溢出 80px）。实测 `.chart-card__controls` 顶部 279 vs 卡片底部 262 → **整行平滑控件在卡片外 80px，完全无法触达**。直接原因：`min-block-size: 80px` 覆盖了同一规则里的 `min-height: 0`（计算值确为 80px），所以「让绘图区收缩」的意图从未生效。

**修复**：`min-height: 0` 与 `min-block-size` 合并为一个 `min-height: 48px`；`MIN_CARD_HEIGHT` 由 180 提升到 240，并在注释里写清 31 + 48 + 117 + 33 的来源。
**复核**：把图表卡拖到 290×250 后 `controlsInsideCard: true`（控件底部 331 ≤ 卡片底部 332），绘图区仍有 92px。

### [中] 22. 深色模式对比度不足（`#fff` on accent；`--danger` 未在深色块重声明）✅ 已修复

- `.empty-state__button` 与 `.chart-card__vec` 使用硬编码 `#fff` 配 `var(--accent)`：深色下 `#ffffff` on `#5c9ae8` = **2.90:1**（低于 4.5:1）。
- 深色 `:root` 块从未重声明 `--danger`，于是错误文本/图标沿用浅色的 `#c83232` on `#262a31` = **2.71:1**。

**修复**：新增 `--on-accent` / `--on-danger` 变量并在深浅两套主题中分别取值；深色 `--danger` 改为 `#ff7b72`；五处硬编码白色全部改用变量。

### [中] 23. 状态栏消息被压到 0 宽，而静态提示占 293px ✅ 已修复

`.statusbar__message` 是唯一允许收缩的项（`flex: 1 1 auto` + `overflow: hidden` → 自动最小尺寸为 0），而 `.statusbar__meta`/`.statusbar__hint` 是 `flex: 0 0 auto`。视口 380px 时消息盒宽 **0px**（scrollWidth 123）→ 「无法关闭：其他卡片依赖它」这类错误提示完全不可见。另外 `.statusbar__hint` 的 `opacity: 0.7` 使 `--text-dim` 实测只有 **2.76:1**。

**修复**：提示改为可收缩并带省略号，`<720px` 时直接隐藏（消息优先）；`opacity: 0.7` 换成 `color: var(--text-dim)`。

### [中] 24. 标题栏徽标把标题挤成 40px ✅ 已修复

`.card__badge` 是 `flex: 0 0 auto` 且没有溢出处理。280px 宽时矩阵卡标题只剩 **40px**（487px 的字符串），而徽标「10000 rows · 10 cols · read-only」保留了完整 **184px**——被牺牲的恰好是识别信息。

**修复**：`flex: 0 1 auto; min-width: 0; max-width: 40%` + 省略号。

### [中] 25. flex 容器上的 `text-overflow: ellipsis` 从不生效 ✅ 已修复

`.chart-card__chip`（`inline-flex`）与 `.vtable__colhead`（`flex`）都声明了 `overflow: hidden; text-overflow: ellipsis`，但文本是**匿名 flex 项**（`overflow: visible` 的块盒），无法收缩到 min-content 以下，而省略号必须落在包含文本的盒子上。实测：芯片 `clientWidth 198 / scrollWidth 288` 无省略号；列头 `clientWidth 117 / scrollWidth 242` 且因 `justify-content: center` **两侧同时被切**。

**修复**：两者都把标签包进独立的 `<span class="chart-card__chip-label">` / `<span class="vtable__colhead-label">`，由该盒子承载省略号；`.vtable__colhead` 只保留 `overflow: hidden`。

### [中] 26. 闲置连线灰色 2.27:1 ✅ 已修复

`rgb(160,160,160)` 在画布 `#eceff3` 上 = **2.27:1**，在卡片白底上 = **2.61:1**（均低于非文本 3:1），再叠加 `.connection--bg { opacity: .75 }` 更低。红色 4.60、蓝色 3.79 通过。
**修复**：改为 `rgb(107,114,128)`（白底 ≈4.6:1），保持同一中性色相。

### [低] 27–29. 空状态对比度、焦点可见性、可访问名称 ✅ 已修复

- `.empty-state` 用 `--text-dim` on `--bg` = **4.20:1**（这是新用户读到的第一段文字）→ 改用 `--text`。
- 全表**没有任何** `:focus-visible`（且 `.formula-card__expr:focus` 直接 `outline: none`）→ 新增一条通用 `:where(button, input, select, textarea, [tabindex]):focus-visible` 规则。
- `.chart-card__add` 选择框实测 `labels: []`、无 `aria-label` → 补上 `aria-label`/`title`；文件选择框同理。

### [低] 30. 死代码与重复实现 ✅ 已清理

`echartsRasterDataUrl`（无调用者）、`ConnectionLayer` 里构建后 `void byId` 丢弃的 `byId`、`result.vector ? 'info' : 'info'`、`chartIsDrawable`（与 `chartModel.isDrawable` 重复，`ChartCard` 又内联了第三份）、`withAlpha`（移除 SVG 高亮框后不再使用）、以及 3 个从未引用的 i18n 键。另外修正了 `chartTypes.ts` 中「regression 的置信带用堆叠类目实现」这句不实注释。

### [低] 31–32. 「新建表格…」名不副实；`.gitignore` 残留改名前的路径 ✅ 已修复

- 菜单与空状态的按钮调用的是 `pickFiles(true)`（文件选择器），应用里**没有任何**创建空表的路径。已改名为「打开数据文件…／Open Data Files…」，并同步修正空状态提示与「就绪」提示文案。
- `.gitignore` 里 `data-workbench/docs/private/`、`data-workbench/docs/.obsidian/workspace*` 在目录改名为 `docs/` 时漏改。已修正。

### [低] 33–34. 有意保留 / 部分处置

- **卡片边框对比度**：`--border #d3d7de` on `#ffffff` = 1.44:1，`--border-strong` = 1.85:1，均低于 3:1。要达到 3:1 需把边框压到约 `#949aa5`，会让整个界面显得很重；卡片边界实际由 `box-shadow` 表达，活动态另有 accent 边框（对画布 4.23:1）。**保留现状**，作为设计取舍记录在此。
- **键鼠可达性**：标题栏的拖动/缩放、列头右键菜单、单元格双击编辑仍然只支持指针操作（已实测标题栏无 `role`/`tabIndex`）。本轮只补了焦点样式与可访问名称；完整的键盘支持（方向键移动卡片、列头可聚焦并回车打开菜单、编辑快捷键）未实现，列为后续工作。
- **公式列绘图**：仍未实现（见第 7 项）。`FormulaCard` 的注释已改为如实描述，不再声称结果矩阵可以像普通矩阵一样绘图。

---

## 检查后确认正常的部分

- **控制台零错误零警告**：全部探针脚本跑完全流程（导入 10000 行、9 种图型、导出、切语言、拖拽、缩放、编辑单元格），`console` 与 `pageerror` 全程干净。
- **矢量导出正确**：SVG 是真实矢量 DOM（10k 点折线 49 个节点；5000 点散点因 `large: true` 合并为 28 条 path，258.7 KB），导出耗时约 700 ms，无性能问题——原本怀疑的 `getComputedStyle` 逐节点内联在实测规模下不构成瓶颈。
- **热力图/箱线图/小提琴图/误差棒的几何**：轴范围、图例去重（误差棒不重复出条目）、离群点颜色均正确。
- **散点抽稀**：5000 点上限生效且抽样确定。
- **导出菜单的矢量标记**：SVG 行显示 `vector`，PDF/PNG 行显示 `raster`，符合「PDF 是栅格封装」的如实声明。
- **公式引擎**：单元测试与编辑器错误高亮工作正常，未知函数/列名报错定位到字符位。
- **虚拟滚动**：10000 行只渲染约 23 行 DOM。
- **依赖保护的正常路径**：有图表依赖的矩阵卡拒绝关闭并闪烁连线，关闭图表后即可关闭。
- **ECharts tooltip 不会被裁**：`confine: true` 把 tooltip 限制在 `.chart-card__plot` 内（3 个悬停位置实测均在绘图区与卡片内）。
- **指针事件没有陷阱**：`.canvas__cards` 的 `pointer-events: none` + 子元素 `auto`、`.connection-layer` 的 `none`、`.empty-state` 的 `none` + 按钮 `auto` 均已实测生效；没有吞掉点击的透明层。
- **`height: 100%` 链路成立**：`.chart-card__plot` 与 `.vtable__header-inner` 都在有确定高度的父盒内，实测非 0。
- **无死 CSS**：`styles.css` 中 98 个类选择器全部能对应到 `src/**/*.ts(x)` 中真实发出的类名。
- **`.card { display: flex !important }` 有效地压住了 react-rnd 的内联 `display: inline-block`**（计算值确为 flex）。

## 本轮引入并已修复的回归（记录用）

做第 4 项（translator 引用稳定）时暴露了两个潜伏缺陷，以及我自己引入的一个错误——都由端到端测试抓到：

1. **图表初次创建后是空的**。`setOption` 的 effect 依赖 `[option]`，而实例是异步创建的（ECharts 懒加载），`option` 在实例出现时并不会变。此前 `t` 每次渲染都换引用，导致 `option` 每次渲染都重建，**恰好**掩盖了这个依赖缺失。修复：实例移入 state，effect 依赖 `[chart, option]`。
2. **ECharts 实例创建与 option 应用的顺序**同上，一并由 1 的修复覆盖；同时删掉了因此变成冗余的「locale 变化时重绘」effect。
3. **点击工具条按钮会让整个应用白屏**。我把 `event.currentTarget.getBoundingClientRect()` 写进了 `setPanel(current => ...)` 的更新函数里，而 React 会在事件处理函数返回后把 `currentTarget` 置空 → `Cannot read properties of null` → 全树卸载（无错误边界）。修复：在调度更新前读取几何。这也被并行的浏览器审查独立复现并报告（`index-DsajaG-h.js`）。

## 未能复现 / 已排除（避免误报）

- **弹层被裁剪**曾被我误判为「不可复现」：我的探针无法把卡片缩到真正的最小尺寸（四角手柄被裁），而交叉审查用可命中边缘手柄的方式测到了 280×180 下的真实溢出。已按后者修复并复核。
- **连线在卡片上方的 z-index 是否「设计如此」**：代码注释与实现自相矛盾（注释说不变量是背景层，实现却在上层）。按「与自身文档矛盾」记录。修复时保留了源列标记的可见性——但改为在 **DOM** 上标记列头（`.vtable__colhead--source`），因为 SVG 图层现在在卡片之下，画在里面的高亮框会被卡片遮住。这是本轮唯一的可见行为变更。
- **跨卡片混列**：图表无法把另一张表格卡的列加进来（`availableColumns` 限定在已喂给该图的矩阵）。实测发现切换文件后新矩阵的列会出现，这是「图表跟随卡片当前文件」的预期行为，**不是缺陷**。


---

# 第二轮：独立复验发现的问题

修复后由独立的浏览器复验复核（生产构建，260 张截图）。它确认第一轮的 8 组修复全部生效（含逐像素证明连线不再跨越卡片、四角缩放 560×400 → 285×245 → 1205×785、最小尺寸 9/9 图型可达、`{size}` 不再泄漏、中文卡片计数已翻译），同时找出 4 个新 MAJOR 与 7 个 MINOR。以下全部已修复并复验。

## 新增 MAJOR（4）

### [阻断级退化] A. 「该图型需要更多列」的空状态渲染为空白

**症状**：1 列文件 → 右键 → 折线图（可绘制）→ 类型切到散点图（需要 2 列）→ 绘图区**全白**，提示文字永不出现，且此后任何重渲染都不会恢复。

**机制**（复验给出了节点同一性证明 `sameNodeAsOldPlot: true`）：绘制态与空状态是同一 `<div>` 位置的两个分支，React **复用了同一个 DOM 节点**：它先把文字写进被复用的节点，随后上一个 effect 的清理函数执行 `instance.dispose()`，而 zrender 的 `SVGPainter.dispose()` 里有一句 `this.root.innerHTML = ''`（`node_modules/zrender/lib/svg/Painter.js:190`）——把 React 刚写入的文字抹掉。React 认为 `children` 未变，不会重新插入。

**修复**：两个分支各自带 `key`（`plot` / `empty`），强制 React 使用不同节点。

**复验**：`{"emptyPresent":true,"text":"\"Scatter\" needs at least 2 columns: …","childNodes":1,"plotPresent":false}`。

> 这类"命令式库与 React 争抢同一 DOM 节点"的缺陷，静态读代码几乎不可能发现——它需要"切到不可绘制状态"这个具体操作序列。

### [MAJOR] B. `视图 → 平铺` 按应用外壳而非画布计算，卡片比画布高 48px

**症状**：画布是 `[0,34,1440,874]`（840px 高），但两张卡片都放在 y=46、高 876 → 底边 922，**超出画布 48px**；图表卡的页脚（Smoothing 行）只有 18/65px 可见且不可点击，底边与右下角缩放手柄全在屏幕外。

**机制**：`App.tsx` 的 `canvasSize()` 量的是 `shellRef`（`.app` 根节点，含菜单栏 34px + 状态栏 26px），不是 `.canvas`。

**修复**：`cardMetrics.ts` 新增 `canvasSize()`（量真正注册的画布元素），`App` 与 `workspaceStore` 改用它；外壳测量仅作兜底。

**复验**：平铺后卡片底边 862 ≤ 画布 874，`clippedBelow: 0`，页脚 **65/65px** 可见。

### [MAJOR] C. 从靠右的表格卡建图，卡片被放在画布外（完全不可见）

**症状**：把表格卡拖到 ≈(800,109) 后右键建图，卡片盒子 `[1472 … 2032]` vs 画布 `[0,1440]` → **可见像素 0**；`.canvas` 是 `overflow: hidden` 且滚动位置为 0，用户无法到达。状态栏却报告 `Created chart: Pos.4` 且卡片计数增加。

**机制**：`workspaceStore.addChartCard` 用 `x: matrixCard.x + matrixCard.width + 32`，没有任何视口钳制；react-rnd 的 `bounds="parent"` 只约束**拖动**，不约束初始位置。公式卡同样有这个问题。

**修复**：新增 `placeWithinCanvas(preferred, size)`，按画布尺寸钳制，图表卡与公式卡都走它。

**复验**：同一操作下卡片落在 `[872, 1432]`，`visiblePx: 560`（完整可见）。

### [MAJOR] D. 连线端点圆点画在卡片之下（不可见）；且只有选中图表卡时才标记源列

**症状三合一**：
1. 锚点圆点 `z-index` 在图之下 → 逐像素差分证明该位置**完全无变化**（圆点被遮挡）。
2. `.vtable__colhead--source` 只在选中**图表卡**时存在（选中表格卡时为 0）——而"选中表格卡"正是连线变红、最需要知道"哪一列被引用"的状态，此时反而没有任何标记。
3. 贝塞尔控制点用 `from.y-30` / `to.y-80`；平铺布局下 `to.y-80` 为负，曲线拱出画布顶部被 `overflow: hidden` 裁掉，只看到几段碎片。

**修复**：
1. 删除 SVG 里的端点圆点（它在这套层叠方案下永远会被自己要指向的卡片遮住；线的两端已经落在卡片边缘，源列由 DOM 标记承担）。
2. `CardCanvas` 改为：选中图表卡时标记它的源列；**选中表格卡时标记所有依赖它的图表的源列**。
3. 控制点抬升量钳制到 ≥0。三次贝塞尔包含于控制点的凸包内，因此两个抬升量非负即可保证整条曲线留在画布内。

**复验**：选中表格卡 → 标记 `["Pos.1"]`；路径 `M 788 197 C 788 167, 1152 28, 1152 108`；**无负坐标**；图层内圆点数 0。

## 新增 MINOR（7，全部已修）

| 问题 | 机制 | 修复与复验 |
|---|---|---|
| 直方图 X 轴标成「行号」，但画的是数据值 | 值轴命名对所有类型统一取 `'No.'` | 直方图用新键 `chart.binCentre`；散点/回归用 X 列名。复验：`xAxis.name === "Bin centre"` |
| `single` 类型忽略多余列，但徽标/芯片仍声称已用 | 徽标用 `sources.length` | 徽标改用**实际绘制**的系列数（`pairs` 按对数折算）。复验：`"1 × 10000 points"`（原 `2 ×`） |
| `single` 类型挂多列时无任何说明 | — | 列区新增提示「该图型只绘制第一列（Pos.1）」 |
| 次坐标轴的分线规则不可见（`index % 2 === 1`） | 图例/轴无任何映射提示 | 坐标轴面板新增「次坐标轴：Pos.2」。复验面板文本含该项 |
| 对数轴静默丢弃 ≤0 的点，曲线只剩一半 | 开启即 `type:'log'`，不校验数据 | 面板新增红字警告「对数轴上 N 个 ≤ 0 的数据点不会显示」。复验：`5048 sample(s) <= 0 …` |
| SG「阶数」输入 60（声明 max=5）把数据从 ±2 炸到 ±90 | 数字输入的 min/max 只约束步进按钮，不约束输入；`sgCoefficients(101,60)` 病态 | UI 输入钳制到 [1,5]；`Smoothing.savitzkyGolay` 也钳制上界（保留 `degree<1` 的既有 no-op 语义）。复验：输入 60 → 字段显示 `5`，数据范围 `[-1.99, 1.99]` |
| 输入 5 位分箱数会让坐标轴面板自行关闭 | `Popup` 的 `window` 捕获阶段 `scroll` 监听器也会收到**面板内部** `<input type=number>` 因文本溢出触发的 scroll 事件 | 监听器忽略事件目标位于面板内部的 scroll。复验：输入 `99999` 期间面板保持打开，字段钳制为 `200`，读数显示「200 bins」 |
| 分箱字段保留图表并不采用的值（`-5` / `99999`） | 只存原文，渲染侧另行钳制 | 输入即钳制到 [0,200]，读数显示实际箱数。复验：`99999` → `200` → 「200 bins」 |

另外删除了 `styles.css` 中已无对应元素的 `.connection__header-box` 死规则（复验注意到它已成死代码）。

## 第二轮复验确认无误的部分（摘录）

- 9 种图型全部绘制真实几何，且对全部 `<text>` 做过**两两包围盒重叠扫描**：0 对重叠、0 个文本越出绘图区。
- 芯片 × 在 `onePerSeries` / `pairs` / `matrix` / `single` 四种下限下都正确隐藏，越权点击无法再删。
- 导出（SVG/PNG 1×2×4×/PDF）在最小尺寸卡（285×245）与放大到 ≈1205×785 时都产出有效文件。
- 列头右键菜单在画布右下角时盒子 `(1262,564)-(1432,839)` 完全在视口内且可点击。
- 面板在 197 字符文件名下宽 320px，右边缘 1114 < 1440，不溢出窗口。
- 全流程 0 个 `console.warning`/`error`、0 个 `pageerror`。
