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
    'menu.newMatrix': '新建表格…',
    'menu.openWorkspace': '打开工作区…',
    'menu.saveWorkspace': '保存工作区',
    'menu.exportCsv': '导出当前表格为 CSV…',
    'menu.exportAllCharts': '批量导出所有图表 SVG…',
    'menu.tile': '平铺',
    'menu.cascade': '层叠',
    'menu.closeAll': '关闭全部卡片',

    'status.ready': '就绪 — 在空白处点击右键 → 新建表格，或直接拖入数据文件',
    'status.loaded': '已加载 {name}（{rows} 行 × {cols} 列）',
    'status.loadedMany': '已加载 {count} 个文件',
    'status.chartCreated': '已创建图表：{name}',
    'status.closeBlocked': '无法关闭：其他卡片依赖它，请先关闭这些卡片',
    'status.exported': '已导出 {name}（{size}）',
    'status.exportFailed': '导出失败：{error}',
    'status.saveFailed': '保存失败：{error}',
    'status.needColumns': '该图型至少需要 {n} 列数据',
    'status.notVector': '注意：{format} 不是矢量格式，期刊投稿请用 SVG',

    'empty.title': '还没有卡片',
    'empty.hint': '点击右键新建表格，或把 txt / csv / tsv / xlsx 文件拖到这里',
    'empty.button': '新建表格…',

    'card.matrix': '{name} — {rows}×{cols}',
    'card.matrixMulti': '{name} 等 {count} 个文件 — {rows}×{cols}',
    'card.chart': '{type} — {name}',
    'card.unlabeled': '未标注',
    'card.close': '关闭',
    'card.activate': '置于顶层',

    'table.rowHeader': 'No.{n}',
    'table.readOnly': '只读',
    'table.editable': '可编辑',
    'table.rows': '{n} 行',
    'table.cols': '{n} 列',
    'table.contextChart': '为「{name}」绘制{type}',
    'table.contextChartMenu': '绘制图表',
    'table.virtualHint': '虚拟滚动 — 只渲染可见行',

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
    'chart.empty': '没有可绘制的数据',
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
    'chart.hint.scatter': '两列配对为 (X, Y) 散点，可叠加拟合线与置信带',
    'chart.hint.regression': '散点 + 最小二乘拟合直线，标注斜率与 R²',
    'chart.hint.bar': '按行号的柱状图，支持分组/堆叠',
    'chart.hint.histogram': '对单列数值分箱统计频数分布',
    'chart.hint.boxplot': '每列一个箱体：中位数、四分位数与 Tukey 离群点',
    'chart.hint.violin': 'KDE 密度轮廓 + 四分位线（比箱线图更能看出双峰）',
    'chart.hint.heatmap': '多列两两 Pearson 相关系数矩阵',
    'chart.hint.errorBar': '每列的均值与离散度（SD / SE / 95% CI）',

    'chart.mean': '均值',
    'chart.value': '数值',
    'chart.axis': '坐标轴',
    'chart.logScale': '对数 Y 轴',
    'chart.secondAxis': '次坐标轴',
    'chart.fitLine': '拟合线',
    'chart.confidence': '95% 置信带',
    'chart.bins': '分箱数',
    'chart.binsAuto': '自动',
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

    'dialog.unsupported': '不支持的文件格式',
    'dialog.unsupportedBody': '不支持「{name}」。支持：txt、csv、tsv、dat、xlsx',
    'dialog.loadFailed': '加载失败',
    'dialog.loadFailedBody': '无法加载「{name}」：{error}',
    'dialog.openWorkspaceFailed': '无法打开工作区文件',

    'newMatrix.title': '新建表格',

    'card.formula': '公式 — {name}',
    'formula.hint': '可用列：',
    'formula.namePlaceholder': '列名',
    'formula.exprPlaceholder': '表达式，如 (A - AVG(A)) / STD(A)',
    'formula.addColumn': '添加公式列',
    'formula.remove': '删除此公式',
    'formula.columns': '列',
    'formula.rows': '行',
    'formula.empty': '输入表达式以计算派生列',
    'menu.newFormula': '新建公式卡…',
  },

  en: {
    'app.title': 'Data Workbench — Data Matrix Workbench',
    'menu.file': 'File',
    'menu.view': 'View',
    'menu.language': 'Language',
    'menu.newMatrix': 'New Table…',
    'menu.openWorkspace': 'Open Workspace…',
    'menu.saveWorkspace': 'Save Workspace',
    'menu.exportCsv': 'Export Current Table as CSV…',
    'menu.exportAllCharts': 'Export All Charts as SVG…',
    'menu.tile': 'Tile',
    'menu.cascade': 'Cascade',
    'menu.closeAll': 'Close All Cards',

    'status.ready': 'Ready — right-click the empty area → New Table, or drop data files here',
    'status.loaded': 'Loaded {name} ({rows} rows × {cols} cols)',
    'status.loadedMany': 'Loaded {count} files',
    'status.chartCreated': 'Created chart: {name}',
    'status.closeBlocked': 'Cannot close: other cards depend on it. Close them first.',
    'status.exported': 'Exported {name} ({size})',
    'status.exportFailed': 'Export failed: {error}',
    'status.saveFailed': 'Save failed: {error}',
    'status.needColumns': 'This chart type needs at least {n} columns',
    'status.notVector': 'Note: {format} is not vector — use SVG for journal submission',

    'empty.title': 'No cards yet',
    'empty.hint': 'Right-click to create a table, or drop txt / csv / tsv / xlsx files here',
    'empty.button': 'New Table…',

    'card.matrix': '{name} — {rows}×{cols}',
    'card.matrixMulti': '{name} and {count} more files — {rows}×{cols}',
    'card.chart': '{type} — {name}',
    'card.unlabeled': 'Unlabeled',
    'card.close': 'Close',
    'card.activate': 'Bring to front',

    'table.rowHeader': 'No.{n}',
    'table.readOnly': 'read-only',
    'table.editable': 'editable',
    'table.rows': '{n} rows',
    'table.cols': '{n} cols',
    'table.contextChart': 'Draw {type} for "{name}"',
    'table.contextChartMenu': 'Draw chart',
    'table.virtualHint': 'Virtual scrolling — only visible rows are rendered',

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
    'chart.empty': 'Nothing to plot',
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
    'chart.hint.scatter': 'Pair two columns as (X, Y), optionally with a fit line and band',
    'chart.hint.regression': 'Scatter plus a least-squares line, annotated with slope and R²',
    'chart.hint.bar': 'Column values against the row index, grouped or stacked',
    'chart.hint.histogram': 'Bin one column and count occurrences',
    'chart.hint.boxplot': 'One box per column: median, quartiles and Tukey outliers',
    'chart.hint.violin': 'KDE density outline with quartile rules — reveals bimodality',
    'chart.hint.heatmap': 'Pairwise Pearson correlation matrix over the attached columns',
    'chart.hint.errorBar': 'Mean and spread (SD / SE / 95% CI) per column',

    'chart.mean': 'Mean',
    'chart.value': 'Value',
    'chart.axis': 'Axes',
    'chart.logScale': 'Log Y axis',
    'chart.secondAxis': 'Second axis',
    'chart.fitLine': 'Fit line',
    'chart.confidence': '95% band',
    'chart.bins': 'Bins',
    'chart.binsAuto': 'Auto',
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

    'dialog.unsupported': 'Not Supported',
    'dialog.unsupportedBody': 'Unsupported "{name}". Supported: txt, csv, tsv, dat, xlsx',
    'dialog.loadFailed': 'Load Failed',
    'dialog.loadFailedBody': 'Cannot load "{name}": {error}',
    'dialog.openWorkspaceFailed': 'Cannot open the workspace file',

    'newMatrix.title': 'New Table',

    'card.formula': 'Formula — {name}',
    'formula.hint': 'Available columns: ',
    'formula.namePlaceholder': 'Column name',
    'formula.exprPlaceholder': 'Expression, e.g. (A - AVG(A)) / STD(A)',
    'formula.addColumn': 'Add formula column',
    'formula.remove': 'Remove this formula',
    'formula.columns': 'columns',
    'formula.rows': 'rows',
    'formula.empty': 'Enter an expression to compute derived columns',
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
