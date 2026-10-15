/**
 * Minimal i18n layer.
 *
 * The Qt frontend externalised every string into `.ts` files. Without a build-time
 * extraction step in the web stack, the pragmatic equivalent is a typed dictionary
 * plus a `t()` helper — same "no literals in components" discipline, far less
 * scaffolding. Adding a locale means adding one object.
 */

export type Locale = 'zh' | 'en';

const dictionaries = {
  zh: {
    'app.title': 'Data Workbench — 数据矩阵工作台',
    'menu.file': '文件',
    'menu.view': '视图',
    'menu.language': '语言',
    'menu.newMatrix': '打开数据文件…',
    'menu.openWorkspace': '打开工作区…',
    'menu.saveWorkspace': '保存工作区',
    'menu.exportCsv': '导出当前表格为 CSV…',
    'menu.exportAllCharts': '批量导出所有图表 SVG…',
    'menu.tile': '平铺',
    'menu.cascade': '层叠',
    'menu.closeAll': '关闭全部卡片',

    'status.ready': '就绪 — 在空白处点击右键 → 打开数据文件，或直接拖入数据文件',
    'status.loaded': '已加载 {name}（{rows} 行 × {cols} 列）',
    'status.loadedMany': '已加载 {count} 个文件',
    'status.chartCreated': '已创建图表：{name}',
    'status.closeBlocked': '无法关闭：其他卡片依赖它，请先关闭这些卡片',
    'status.exported': '已导出 {name}（{size}）',
    'status.exportedBatch': '已批量导出 {n} 个图表 SVG',
    'status.exportPartial': '已导出 {done} 个，{failed} 个失败',
    'status.exportFailed': '导出失败：{error}',
    'status.saveFailed': '保存失败：{error}',
    'status.needTrailingColumns': '「{type}」需要从该列起连续 {n} 列数据，此处只剩 {have} 列',
    'status.notVector': '注意：{format} 不是矢量格式，期刊投稿请用 SVG',
    'status.cycle': '循环依赖：{path}',
    'status.cycleDropped': '工作区含 {n} 条循环依赖，已忽略（保存文件可能被手工编辑过）',
    'status.workspace': '已打开 {name}（{cards} 张卡片 · {matrices} 个矩阵）',
    'status.cards': '{n} 张卡片',

    'empty.title': '还没有卡片',
    'empty.hint': '点击按钮或右键打开数据文件，也可以把 txt / csv / tsv / xlsx 拖到这里',
    'empty.button': '打开数据文件…',
    'empty.dropHint': '松开即可导入文件',

    'card.matrix': '{name} — {rows}×{cols}',
    'card.matrixMulti': '{name} 等 {count} 个文件 — {rows}×{cols}',
    'card.chart': '{type} — {name}',
    'card.unlabeled': '未标注',
    'card.close': '关闭',

    'table.rowHeader': 'No.{n}',
    'table.readOnly': '只读',
    'table.editable': '可编辑',
    'table.rows': '{n} 行',
    'table.cols': '{n} 列',
    'table.contextChart': '为「{name}」绘制{type}',
    'table.contextChartMenu': '绘制图表',
    'table.virtualHint': '虚拟滚动 — 只渲染可见行',
    'table.invalidNumber': '「{value}」不是数值，已忽略该次编辑',

    'chart.smoothing': '平滑',
    'chart.mode.none': '关闭',
    'chart.mode.movingAverage': '滑动平均',
    'chart.mode.exponential': '指数平滑',
    'chart.mode.median': '中值滤波',
    'chart.mode.savitzkyGolay': 'Savitzky–Golay',
    'chart.window': '窗口',
    'chart.alpha': 'α',
    'chart.degree': '阶数',
    'chart.resetZoom': '重置缩放',
    'chart.points': '{n} 点',
    'chart.needMoreColumns': '「{type}」需要至少 {n} 列：在表格中右键更多列头添加',

    'chart.type': '图型',
    'chart.type.line': '折线图',
    'chart.type.scatter': '散点图',
    'chart.type.regression': '回归图',
    'chart.type.bar': '柱状图',
    'chart.type.histogram': '直方图',
    'chart.type.boxplot': '箱线图',
    'chart.type.violin': '小提琴图',
    'chart.type.heatmap': '相关性热力图',
    'chart.type.errorBar': '均值±误差棒',
    'chart.hint.line': '按行号绘制一个或多个列的折线',
    'chart.hint.scatter': '两列配对为 (X, Y) 散点，可叠加最小二乘拟合线',
    'chart.hint.regression': '散点 + 最小二乘拟合直线，标注斜率与 R²',
    'chart.hint.bar': '按行号的柱状图，支持分组/堆叠',
    'chart.hint.histogram': '对单列数值分箱统计频数分布',
    'chart.hint.boxplot': '每列一个箱体：中位数、四分位数与 Tukey 离群点',
    'chart.hint.violin': 'KDE 密度轮廓 + 四分位线（比箱线图更能看出双峰）',
    'chart.hint.heatmap': '多列两两 Pearson 相关系数矩阵',
    'chart.hint.errorBar': '每列的均值与离散度（SD / SE / 95% CI）',

    'chart.mean': '均值',
    'chart.value': '数值',
    'chart.density': '密度',
    'chart.binCentre': '分箱中心',
    'chart.outliers': '离群点',
    'chart.quartiles': '四分位',
    'chart.correlation': 'r',
    'chart.rowIndex': '行号',
    'chart.vector': '矢量',
    'chart.raster': '位图',
    'chart.axis': '坐标轴',
    'chart.logScale': '对数 Y 轴',
    'chart.secondAxis': '次坐标轴',
    'chart.fitLine': '拟合线',
    'chart.bins': '分箱数',
    'chart.binsAuto': '自动',
    'chart.binsUsed': '实际 {n} 箱',
    'chart.onlyFirstColumn': '该图型只绘制第一列（{name}）',
    'chart.logDropsNonPositive': '对数轴上 {n} 个 ≤ 0 的数据点不会显示',
    'chart.secondAxisOn': '次坐标轴：{names}',
    'chart.errorKind': '误差类型',
    'chart.error.sd': '标准差 SD',
    'chart.error.se': '标准误 SE',
    'chart.error.ci95': '95% 置信区间',
    'chart.layout': '排列',
    'chart.layout.grouped': '分组',
    'chart.layout.stacked': '堆叠',
    'chart.capWidth': '误差帽宽',
    'chart.columns': '数据列',
    'chart.addColumn': '添加列…',
    'chart.removeColumn': '移除该列',
    'chart.export': '导出',
    'chart.exportSvg': '导出 SVG（矢量）',
    'chart.exportPdf': '导出 PDF',
    'chart.exportPng': '导出 PNG {ratio}×',
    'chart.pixelRatio': '分辨率',
    'chart.xAxis': 'X 轴',
    'chart.xAxisDefault': '行号 (No.N)',

    'dialog.loadFailed': '加载失败',
    'dialog.loadFailedBody': '无法加载「{name}」：{error}',
    'dialog.openWorkspaceFailed': '无法打开工作区文件',

    'card.formula': '公式 — {name}',
    'formula.hint': '可用列：',
    'formula.namePlaceholder': '列名',
    'formula.exprPlaceholder': '表达式，如 (A - AVG(A)) / STD(A)',
    'formula.addColumn': '添加公式列',
    'formula.remove': '删除此公式',
    'formula.columns': '列',
    'formula.rows': '行',
    'formula.empty': '输入表达式以计算派生列',
    'formula.error.unexpectedChar': '无法识别的字符「{char}」（第 {position} 个字符）',
    'formula.error.unknownFunction': '未知函数「{name}」',
    'formula.error.expectedCloseAfterArgs': '函数参数后面缺少右括号',
    'formula.error.badArgCount': '「{name}」需要 {expected} 个参数，实际给了 {got} 个',
    'formula.error.unknownColumn': '未知列名「{name}」',
    'formula.error.expectedClose': '缺少右括号',
    'formula.error.unexpectedToken': '无法解析的记号「{token}」',
    'formula.error.trailingToken': '表达式结束后多出「{token}」',
    'menu.newFormula': '新建公式卡…',
  },

  en: {
    'app.title': 'Data Workbench — Data Matrix Workbench',
    'menu.file': 'File',
    'menu.view': 'View',
    'menu.language': 'Language',
    'menu.newMatrix': 'Open Data Files…',
    'menu.openWorkspace': 'Open Workspace…',
    'menu.saveWorkspace': 'Save Workspace',
    'menu.exportCsv': 'Export Current Table as CSV…',
    'menu.exportAllCharts': 'Export All Charts as SVG…',
    'menu.tile': 'Tile',
    'menu.cascade': 'Cascade',
    'menu.closeAll': 'Close All Cards',

    'status.ready': 'Ready — right-click the empty area → Open Data Files, or drop data files here',
    'status.loaded': 'Loaded {name} ({rows} rows × {cols} cols)',
    'status.loadedMany': 'Loaded {count} files',
    'status.chartCreated': 'Created chart: {name}',
    'status.closeBlocked': 'Cannot close: other cards depend on it. Close them first.',
    'status.exported': 'Exported {name} ({size})',
    'status.exportedBatch': 'Exported {n} chart SVG(s)',
    'status.exportPartial': 'Exported {done}, {failed} failed',
    'status.exportFailed': 'Export failed: {error}',
    'status.saveFailed': 'Save failed: {error}',
    'status.needTrailingColumns': '"{type}" needs {n} consecutive columns from this one; only {have} remain',
    'status.notVector': 'Note: {format} is not vector — use SVG for journal submission',
    'status.cycle': 'Dependency cycle: {path}',
    'status.cycleDropped': 'The workspace had {n} dependency cycle(s); they were ignored (the file may have been edited by hand)',
    'status.workspace': 'Opened {name} ({cards} cards · {matrices} matrices)',
    'status.cards': '{n} cards',

    'empty.title': 'No cards yet',
    'empty.hint': 'Open data files with the button or right-click, or drop txt / csv / tsv / xlsx here',
    'empty.button': 'Open Data Files…',
    'empty.dropHint': 'Release to import the files',

    'card.matrix': '{name} — {rows}×{cols}',
    'card.matrixMulti': '{name} and {count} more files — {rows}×{cols}',
    'card.chart': '{type} — {name}',
    'card.unlabeled': 'Unlabeled',
    'card.close': 'Close',

    'table.rowHeader': 'No.{n}',
    'table.readOnly': 'read-only',
    'table.editable': 'editable',
    'table.rows': '{n} rows',
    'table.cols': '{n} cols',
    'table.contextChart': 'Draw {type} for "{name}"',
    'table.contextChartMenu': 'Draw chart',
    'table.virtualHint': 'Virtual scrolling — only visible rows are rendered',
    'table.invalidNumber': '"{value}" is not a number; the edit was discarded',

    'chart.smoothing': 'Smoothing',
    'chart.mode.none': 'Off',
    'chart.mode.movingAverage': 'Moving average',
    'chart.mode.exponential': 'Exponential',
    'chart.mode.median': 'Median filter',
    'chart.mode.savitzkyGolay': 'Savitzky–Golay',
    'chart.window': 'Window',
    'chart.alpha': 'α',
    'chart.degree': 'Degree',
    'chart.resetZoom': 'Reset zoom',
    'chart.points': '{n} points',
    'chart.needMoreColumns': '"{type}" needs at least {n} columns: right-click more column headers in the table',

    'chart.type': 'Type',
    'chart.type.line': 'Line',
    'chart.type.scatter': 'Scatter',
    'chart.type.regression': 'Regression',
    'chart.type.bar': 'Bar',
    'chart.type.histogram': 'Histogram',
    'chart.type.boxplot': 'Box plot',
    'chart.type.violin': 'Violin plot',
    'chart.type.heatmap': 'Correlation heatmap',
    'chart.type.errorBar': 'Mean ± error',
    'chart.hint.line': 'Plot one or more columns against the row index',
    'chart.hint.scatter': 'Pair two columns as (X, Y), optionally with a least-squares fit line',
    'chart.hint.regression': 'Scatter plus a least-squares line, annotated with slope and R²',
    'chart.hint.bar': 'Column values against the row index, grouped or stacked',
    'chart.hint.histogram': 'Bin one column and count occurrences',
    'chart.hint.boxplot': 'One box per column: median, quartiles and Tukey outliers',
    'chart.hint.violin': 'KDE density outline with quartile rules — reveals bimodality',
    'chart.hint.heatmap': 'Pairwise Pearson correlation matrix over the attached columns',
    'chart.hint.errorBar': 'Mean and spread (SD / SE / 95% CI) per column',

    'chart.mean': 'Mean',
    'chart.value': 'Value',
    'chart.density': 'Density',
    'chart.binCentre': 'Bin centre',
    'chart.outliers': 'Outliers',
    'chart.quartiles': 'Quartiles',
    'chart.correlation': 'r',
    'chart.rowIndex': 'No.',
    'chart.vector': 'vector',
    'chart.raster': 'raster',
    'chart.axis': 'Axes',
    'chart.logScale': 'Log Y axis',
    'chart.secondAxis': 'Second axis',
    'chart.fitLine': 'Fit line',
    'chart.bins': 'Bins',
    'chart.binsAuto': 'Auto',
    'chart.binsUsed': '{n} bins',
    'chart.onlyFirstColumn': 'This type plots the first column only ({name})',
    'chart.logDropsNonPositive': '{n} sample(s) <= 0 are not shown on a log axis',
    'chart.secondAxisOn': 'Right axis: {names}',
    'chart.errorKind': 'Error',
    'chart.error.sd': 'Std dev (SD)',
    'chart.error.se': 'Std error (SE)',
    'chart.error.ci95': '95% CI',
    'chart.layout': 'Layout',
    'chart.layout.grouped': 'Grouped',
    'chart.layout.stacked': 'Stacked',
    'chart.capWidth': 'Cap width',
    'chart.columns': 'Columns',
    'chart.addColumn': 'Add column…',
    'chart.removeColumn': 'Remove this column',
    'chart.export': 'Export',
    'chart.exportSvg': 'Export SVG (vector)',
    'chart.exportPdf': 'Export PDF',
    'chart.exportPng': 'Export PNG {ratio}×',
    'chart.pixelRatio': 'Resolution',
    'chart.xAxis': 'X axis',
    'chart.xAxisDefault': 'Row index (No.N)',

    'dialog.loadFailed': 'Load Failed',
    'dialog.loadFailedBody': 'Cannot load "{name}": {error}',
    'dialog.openWorkspaceFailed': 'Cannot open the workspace file',

    'card.formula': 'Formula — {name}',
    'formula.hint': 'Available columns: ',
    'formula.namePlaceholder': 'Column name',
    'formula.exprPlaceholder': 'Expression, e.g. (A - AVG(A)) / STD(A)',
    'formula.addColumn': 'Add formula column',
    'formula.remove': 'Remove this formula',
    'formula.columns': 'columns',
    'formula.rows': 'rows',
    'formula.empty': 'Enter an expression to compute derived columns',
    'formula.error.unexpectedChar': "Unexpected character '{char}' (position {position})",
    'formula.error.unknownFunction': "Unknown function '{name}'",
    'formula.error.expectedCloseAfterArgs': "Missing ')' after the function arguments",
    'formula.error.badArgCount': "'{name}' takes {expected} argument(s) but got {got}",
    'formula.error.unknownColumn': "Unknown column '{name}'",
    'formula.error.expectedClose': "Missing ')'",
    'formula.error.unexpectedToken': "Unrecognised token '{token}'",
    'formula.error.trailingToken': "Unexpected '{token}' after the expression",
    'menu.newFormula': 'New Formula Card…',
  },
} as const;

export type MessageKey = keyof (typeof dictionaries)['zh'];

export type TranslateFn = (key: MessageKey, params?: Record<string, string | number>) => string;

/** Build a `t()` bound to one locale. Unknown keys fall back to the key itself. */
export function createTranslator(locale: Locale): TranslateFn {
  const dict: Record<string, string> = dictionaries[locale];
  return (key, params) => {
    let text = dict[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  };
}

/**
 * One translator instance per locale.
 *
 * Components hand `t` to `useMemo`/`useCallback` dependency arrays, so returning a fresh
 * closure on every render invalidated every memo that mentioned it — which made each
 * chart rebuild its whole ECharts option (and re-apply it with `notMerge`) whenever any
 * card moved. Caching by locale keeps the identity stable for the life of the locale.
 */
const translators = new Map<Locale, TranslateFn>();

export function translatorFor(locale: Locale): TranslateFn {
  let cached = translators.get(locale);
  if (!cached) {
    cached = createTranslator(locale);
    translators.set(locale, cached);
  }
  return cached;
}

/** Pick a sensible default locale from the browser, defaulting to Chinese. */
export function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return 'zh';
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Human-readable byte size, used by the export status message. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
