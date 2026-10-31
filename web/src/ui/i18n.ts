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
    'menu.resetView': '回到卡片',
    'menu.closeAll': '关闭全部卡片',
    'menu.help': '帮助',
    'menu.helpFormula': '公式与函数说明…',
    'menu.helpSyntax': '列引用写法',
    'menu.helpExamples': '示例',
    'menu.helpErrors': '常见报错',

    'status.ready': '就绪 — 在空白处点击右键 → 打开数据文件，或直接拖入数据文件',
    'backend.offline': '计算后端不可达 — 数值计算全部在后端进行，请启动后端后重试',
    'backend.mismatch': '计算后端版本不兼容（{detail}）— 请更新后端或前端',
    'backend.retry': '重试连接',
    'status.loaded': '已加载 {name}（{rows} 行 × {cols} 列）',
    'status.loadedMany': '已加载 {count} 个文件',
    'status.fileReplaced':
      '已替换为 {name}（{rows} 行 × {cols} 列）— 下游图表与公式卡已用新数据重算',
    'status.fileReplacedMany': '已替换为 {count} 个文件 — 下游图表与公式卡已用新数据重算',
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
    'status.resultTruncated': '结果超过 {n} 行，只显示前 {n} 行（完整结果仍在后端）',
    'status.workspace': '已打开 {name}（{cards} 张卡片 · {matrices} 个矩阵）',
    'status.cards': '{n} 张卡片',

    'empty.title': '还没有卡片',
    'empty.hint': '点击按钮或右键打开数据文件，也可以把 txt / csv / tsv / xlsx 拖到这里',
    'empty.button': '打开数据文件…',
    'empty.dropHint': '松开即可导入文件',
    'empty.dropHintReplace': '松开即可用这些文件替换「{name}」的数据',
    'empty.dropHintReplaceMultiple': '松开即可用这些文件替换这张卡的 {n} 个文件',

    'card.matrix': '{name} — {rows}×{cols}',
    'card.matrixMulti': '{name} 等 {count} 个文件 — {rows}×{cols}',
    'card.chart': '{type} — {name}',
    'card.unlabeled': '未标注',
    'card.close': '关闭',
    'matrix.replaceFile': '替换文件…',

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
    'chart.singleColumnHint': '只剩 1 列：只能画以行号为 X 轴的图（折线 / 柱状 / 直方图 / 箱线 / 小提琴 / 误差棒）；散点、回归、相关性热力图需要至少 2 列',

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
    'chart.columnDock': '选择绘制列',
    'chart.columnDockToggle': '列',
    'chart.columnDockCollapse': '收起列面板',
    'chart.columnDockEmpty': '还没有可用的数据表，先打开一个数据文件',
    'chart.columnDockRequired': '「{type}」至少需要 {n} 列',
    'chart.columnDockOrder': '配对图型按勾选顺序两两配对',
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
    'formula.pending': '等待后端计算…',
    'formula.emptyError': '计算失败 — 原因见上方提示',
    'formula.notBound': '尚未绑定后端计算节点 — 这张卡还没有结果表',
    'formula.recompute': '重算',
    'formula.error.unknown': '公式无法计算',
    'formula.error.unexpectedChar': '无法识别的字符「{char}」（第 {position} 个字符）',
    'formula.error.unknownFunction': '未知函数「{name}」',
    'formula.error.expectedCloseAfterArgs': '函数参数后面缺少右括号',
    'formula.error.badArgCount': '「{name}」需要 {expected} 个参数，实际给了 {got} 个',
    'formula.error.unknownColumn': '未知列名「{name}」',
    'formula.error.expectedClose': '缺少右括号',
    'formula.error.unexpectedToken': '无法解析的记号「{token}」',
    'formula.error.trailingToken': '表达式结束后多出「{token}」',
    'formula.error.upstreamError': '上游节点不可用：{name}',
    'formula.error.unknownSignature': '未知函数签名「{name}」',
    'formula.error.badSignatureParams': '函数参数不完整或非法（缺少「{name}」）',
    'formula.error.internalError': '内部错误（函数计算未完成）',

    // 函数卡三区布局（左：输入 / 右上：公式 / 右下：输出）
    'formula.zoneInputs': '输入',
    'formula.zoneFormulas': '计算公式',
    'formula.zoneParams': '参数',
    'formula.noParams': '此函数没有表达式参数：输入由端口决定（{signature}）',
    'formula.zoneOutputs': '输出',
    'formula.outputLabel': '输出 #{n}',
    'formula.modeMatrix': '矩阵',
    'formula.modeCell': '列',
    'formula.noInput': '未连接数据源 — 在数据卡上右键「新建公式卡…」',
    'formula.inputMissing': '引用的矩阵已不存在',
    'formula.outputColumns': '{n} 列 × {rows} 行',
    'formula.outputEmpty': '暂无结果',
    'formula.outputName': '结果',
    'formula.resultPreview': '显示前 {shown} 行 · 共 {total} 行',
    'formula.showMore': '显示更多',
    'formula.showAllTip': '拉取全部 {total} 行到本地显示（结果一直在后端）',
    'formula.resultTruncated': '已达到本地显示上限 {n} 行（完整结果仍在后端）',
    'formula.staleUpstream': '上游卡片失败 — 本卡结果已失效',
    'formula.signature': '签名：{id}',

    // 重指向确认（切文件后的一次显式图编辑）
    'formula.repoint.title': '数据卡已切换到「{name}」— 应用为新输入？',
    'formula.repoint.sameColumns': '列一致（{n} 列），行数 {from} → {to}',
    'formula.repoint.changedColumns': '列已变化：+{added} −{removed}（行数 {from} → {to}）',
    'formula.repoint.apply': '应用',
    'formula.repoint.applyAnyway': '仍然应用（列不匹配）',
    'formula.repoint.dismiss': '暂不',
    'formula.repoint.applyAll': '应用到全部 {n} 张',

    // 输出列重命名 + 列数契约
    'formula.rename': '重命名列',
    'formula.renameDone': '完成',
    'formula.renamePlaceholder': '第 {n} 列',
    'formula.contractLocked': '已锁定 {n} 列 — 上游列数变化将在此中断数据流',
    'formula.contractNone': '未锁定列数 — 命名输出列后即锁定',
    'formula.contractViolation':
      '列数契约被破坏：锁定 {expected} 列，实际 {actual} 列 — 数据流已在此中断',
    'formula.contractExtend': '扩展契约到 {n} 列',
    'formula.contractClear': '解除锁定',
    'formula.error.columnContractViolation': '列数契约被破坏（锁定 {expected} 列，实际 {actual} 列）',
    'menu.newFormula': '新建公式卡…',
    'menu.newRegression': '新建回归卡…',

    // 帮助（公式 / 函数说明）：菜单项、卡片上的「?」与悬停提示共用同一份文案。
    // 签名（Pos.1、SUM(c)…）是代码，保持字面量；这里只有散文，因此两个语言都齐。
    'help.title': '公式与函数说明',
    'help.close': '关闭',
    'help.section.syntax': '列引用写法',
    'help.section.functions': '函数速查',
    'help.section.examples': '示例',
    'help.section.errors': '常见报错',
    'help.syntax.form': '写法',
    'help.syntax.meaning': '含义',
    'help.functions.note':
      '聚合类先把整列压成一个数，再逐行展开；其余函数逐行计算。矩阵卡模式另有 TRANSPOSE/DET/INV/SOLVE/MMUL/EMUL（公式卡里不可用，故未列出）。',
    'formula.bracketHint':
      '名字含 / 、空格、括号或以数字开头时这样写：[列名]；也可以点左侧「可用列」插入 Pos.N',
    'help.group.aggregate': '聚合（整列 → 一个数，再逐行展开）',
    'help.group.math': '数学',
    'help.group.signal': '信号处理',
    'help.group.conditional': '条件',
    'help.syntax.pos': '位置名：列的固定编号，始终可用；大小写不敏感（pos.1 亦可）',
    'help.syntax.bare': '裸列名：列名只含字母、数字、_ 或中文（且不以数字开头）时可直接写',
    'help.syntax.leadingDigit':
      '名字以数字开头（2号测点）也必须方括号：裸写会被读成数字 2 加一个游离标识符',
    'help.syntax.bracket':
      '方括号引用任意列名（含 /、空格、(、- 等）；读到 ] 为止原样取用，全角【】/［］亦可',
    'help.syntax.qualified':
      '多输入时用 A、B、C…（或输入区显示的端口 id）指明是哪一路；只有一个矩阵输入时可省略',
    'help.syntax.fullwidth': '全角标点按对应的半角符号解析，可以直接输入',
    'help.example.scale': '把第 1 列乘 2',
    'help.example.unit': '单位换算（m → km 之类）',
    'help.example.zscore': '标准化（z 分数）',
    'help.example.smooth': '5 点平滑',
    'help.example.bracket': '列名含 / 时用方括号',
    'help.example.positive': '只保留正值，其余置 0',
    'help.error.unexpectedChar':
      '有无法识别的字符 — 多半是列名里有 / 、空格等符号，请改用 Pos.N 或 [列名]',
    'help.error.unknownColumn':
      '列名不存在 — 名字含 / 空格、或以数字开头时是写不出来的（`地面速度_μm/s` 会被读成 `地面速度_μm` 除以 `s`），请写成 [列名]，或点「可用列」里的列名插入 Pos.N',
    'help.error.unknownFunction':
      '函数名拼错 — 函数表里的名字都不区分大小写。若你写的是列名而它带括号，会被当成函数调用：请改写 [列名]',
    'help.error.badArgCount': '参数个数不对 — 例如 POW 要 2 个、IF 要 3 个',
    'help.error.expectedClose': '括号不配对 — 函数参数后面漏了右括号（全角 ） 也算）',
    'help.error.columnContractViolation':
      '输出列数与锁定的契约不符 — 改完公式后要么恢复列数，要么扩展契约',
    'help.fn.SUM': '整列求和（忽略缺失值）',
    'help.fn.AVG': '算术平均（与 MEAN 相同）',
    'help.fn.MEAN': '算术平均（与 AVG 相同）',
    'help.fn.MIN': '单参数取列最小值；多参数时逐行取各列最小值',
    'help.fn.MAX': '单参数取列最大值；多参数时逐行取各列最大值',
    'help.fn.MEDIAN': '中位数（偶数个样本取中间两值的平均）',
    'help.fn.STD': '样本标准差（ddof = 1）',
    'help.fn.COUNT': '有效值个数（只数有限值，NaN 与 ±∞ 不计）',
    'help.fn.NAN': '缺失值个数（只数 NaN；±∞ 是另一种问题，不计入）',
    'help.fn.VAR': '样本方差（ddof = 1）',
    'help.fn.SEM': '标准误 = 标准差 / √n（不足 2 个有效值时记 0）',
    'help.fn.QUANTILE': '分位数（R-7 线性插值）；q 可为常数或列名，逐行计算',
    'help.fn.ABS': '绝对值',
    'help.fn.SQRT': '平方根',
    'help.fn.LOG': '自然对数（以 e 为底，与 LN 相同）',
    'help.fn.LN': '自然对数（以 e 为底）',
    'help.fn.LOG10': '以 10 为底的对数',
    'help.fn.EXP': 'e 的 x 次幂',
    'help.fn.POW': 'a 的 b 次幂',
    'help.fn.ROUND': '四舍五入到 n 位小数（省略 n 时为整数）',
    'help.fn.FLOOR': '向下取整',
    'help.fn.CEIL': '向上取整',
    'help.fn.SIGN': '符号：−1 / 0 / 1',
    'help.fn.MOV': 'n 点滑动平均（窗口居中，两端窗口自动收窄）',
    'help.fn.EMA': '指数滑动平均；alpha 是新值的权重（0–1）',
    'help.fn.IF': '逐行判断：条件非 0 取前者，否则取后者',
    // 悬停提示：约 1 秒后出现在指针位置，替代原生 title 的瞬时弹窗
    'help.hover.openHelp': '打开公式与函数说明（Esc 关闭）',
    'help.hover.expr': '表达式写法：Pos.1 * 2、MOV(Pos.2, 5)、[列名] * 2 — 点 ? 看全部函数',
    'help.hover.name': '输出列名；一旦命名即锁定输出列数（契约）',
    'help.hover.addColumn': '追加一个公式列',
    'help.columns.hint': '点击插入 Pos.N；含 / 空格的列名请改用 [列名]',
    'help.chip.insert': '插入 {pos}（列 {name}）',
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
    'menu.resetView': 'Reset View',
    'menu.closeAll': 'Close All Cards',
    'menu.help': 'Help',
    'menu.helpFormula': 'Formula & Function Reference…',
    'menu.helpSyntax': 'Column References',
    'menu.helpExamples': 'Examples',
    'menu.helpErrors': 'Common Errors',

    'status.ready': 'Ready — right-click the empty area → Open Data Files, or drop data files here',
    'backend.offline': 'Compute backend unreachable — all numeric computation runs server-side; start the backend and retry',
    'backend.mismatch': 'Compute backend version mismatch ({detail}) — update the backend or frontend',
    'backend.retry': 'Retry connection',
    'status.loaded': 'Loaded {name} ({rows} rows × {cols} cols)',
    'status.loadedMany': 'Loaded {count} files',
    'status.fileReplaced':
      'Replaced with {name} ({rows} rows × {cols} cols) — dependent charts and cards now run on the new data',
    'status.fileReplacedMany': 'Replaced with {count} files — dependent charts and cards now run on the new data',
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
    'status.resultTruncated': 'The result has more than {n} rows; only the first {n} are shown (the full result stays on the backend)',
    'status.workspace': 'Opened {name} ({cards} cards · {matrices} matrices)',
    'status.cards': '{n} cards',

    'empty.title': 'No cards yet',
    'empty.hint': 'Open data files with the button or right-click, or drop txt / csv / tsv / xlsx here',
    'empty.button': 'Open Data Files…',
    'empty.dropHint': 'Release to import the files',
    'empty.dropHintReplace': 'Release to replace the data of “{name}” with these files',
    'empty.dropHintReplaceMultiple': 'Release to replace this card’s {n} files with these',

    'card.matrix': '{name} — {rows}×{cols}',
    'card.matrixMulti': '{name} and {count} more files — {rows}×{cols}',
    'card.chart': '{type} — {name}',
    'card.unlabeled': 'Unlabeled',
    'card.close': 'Close',
    'matrix.replaceFile': 'Replace file…',

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
    'chart.singleColumnHint': 'Only one column left: plot it against the row index (line / bar / histogram / box / violin / error bar). Scatter, regression and correlation need at least 2 columns.',

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
    'chart.columnDock': 'Columns to plot',
    'chart.columnDockToggle': 'Columns',
    'chart.columnDockCollapse': 'Collapse the column panel',
    'chart.columnDockEmpty': 'No tables yet — open a data file first',
    'chart.columnDockRequired': '"{type}" needs at least {n} columns',
    'chart.columnDockOrder': 'Paired chart types pair the columns in selection order',
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
    'formula.pending': 'Waiting for the backend to compute…',
    'formula.emptyError': 'Compute failed — the reason is shown above',
    'formula.notBound': 'Not bound to a compute node yet — this card has no result table',
    'formula.recompute': 'Recompute',
    'formula.error.unknown': 'The formula could not be computed',
    'formula.error.unexpectedChar': "Unexpected character '{char}' (position {position})",
    'formula.error.unknownFunction': "Unknown function '{name}'",
    'formula.error.expectedCloseAfterArgs': "Missing ')' after the function arguments",
    'formula.error.badArgCount': "'{name}' takes {expected} argument(s) but got {got}",
    'formula.error.unknownColumn': "Unknown column '{name}'",
    'formula.error.expectedClose': "Missing ')'",
    'formula.error.unexpectedToken': "Unrecognised token '{token}'",
    'formula.error.trailingToken': "Unexpected '{token}' after the expression",
    'formula.error.upstreamError': 'Upstream node unavailable: {name}',
    'formula.error.unknownSignature': "Unknown function signature '{name}'",
    'formula.error.badSignatureParams': "Function parameters are incomplete or invalid (missing '{name}')",
    'formula.error.internalError': 'Internal error (the function did not finish)',

    // Function card three-zone layout (left: inputs / top-right: formulas / bottom-right: outputs)
    'formula.zoneInputs': 'Inputs',
    'formula.zoneFormulas': 'Formulas',
    'formula.zoneParams': 'Parameters',
    'formula.noParams': 'This function takes no expressions: its inputs come from the ports ({signature})',
    'formula.zoneOutputs': 'Outputs',
    'formula.outputLabel': 'output #{n}',
    'formula.modeMatrix': 'matrix',
    'formula.modeCell': 'column',
    'formula.noInput': 'No input connected — right-click a data card → “New Formula Card…”',
    'formula.inputMissing': 'The referenced matrix no longer exists',
    'formula.outputColumns': '{n} cols × {rows} rows',
    'formula.outputEmpty': 'No result yet',
    'formula.outputName': 'Result',
    'formula.resultPreview': 'Showing {shown} of {total} rows',
    'formula.showMore': 'Show more',
    'formula.showAllTip': 'Fetch all {total} rows into the browser (the result always stays on the backend)',
    'formula.resultTruncated': 'Stopped at the local display limit of {n} rows (the full result stays on the backend)',
    'formula.staleUpstream': 'Upstream card failed — this result is invalidated',
    'formula.signature': 'signature: {id}',

    // Re-point confirmation (one explicit graph edit after a file switch)
    'formula.repoint.title': 'The data card switched to “{name}” — use it as the input?',
    'formula.repoint.sameColumns': 'Columns match ({n}); rows {from} → {to}',
    'formula.repoint.changedColumns': 'Columns changed: +{added} −{removed} (rows {from} → {to})',
    'formula.repoint.apply': 'Apply',
    'formula.repoint.applyAnyway': 'Apply anyway (columns differ)',
    'formula.repoint.dismiss': 'Not now',
    'formula.repoint.applyAll': 'Apply to all {n} cards',

    // Output column rename + column-count contract
    'formula.rename': 'Rename columns',
    'formula.renameDone': 'Done',
    'formula.renamePlaceholder': 'Column {n}',
    'formula.contractLocked':
      '{n} columns locked — a width change upstream stops the data flow here',
    'formula.contractNone': 'No column count locked — naming an output column locks it',
    'formula.contractViolation':
      'Column contract broken: {expected} locked, {actual} produced — the data flow stopped here',
    'formula.contractExtend': 'Extend contract to {n} columns',
    'formula.contractClear': 'Remove the lock',
    'formula.error.columnContractViolation':
      'Column contract broken ({expected} locked, {actual} produced)',
    'menu.newFormula': 'New Formula Card…',
    'menu.newRegression': 'New Regression Card…',

    // Help (formula / function reference): the menu entries, the card's "?" and the hover
    // tooltips all read these same strings.
    'help.title': 'Formulas & Functions',
    'help.close': 'Close',
    'help.section.syntax': 'Column references',
    'help.section.functions': 'Function reference',
    'help.section.examples': 'Examples',
    'help.section.errors': 'Common errors',
    'help.syntax.form': 'Form',
    'help.syntax.meaning': 'Meaning',
    'help.functions.note':
      'Reducing functions collapse a column to one number and broadcast it per row; everything else computes row by row. Matrix-card mode also has TRANSPOSE/DET/INV/SOLVE/MMUL/EMUL (not usable in a formula card, so not listed here).',
    'formula.bracketHint':
      'A name containing /, a space, a parenthesis, or starting with a digit must be written [column name] — or click an available-column chip to insert its Pos.N',
    'help.group.aggregate': 'Reducing (column → one number, broadcast per row)',
    'help.group.math': 'Math',
    'help.group.signal': 'Signal processing',
    'help.group.conditional': 'Conditional',
    'help.syntax.pos':
      'The column position — always available; case-insensitive (pos.1 works too)',
    'help.syntax.bare':
      'Bare column name: valid when the name contains only letters, digits, _ or CJK characters and does not start with a digit',
    'help.syntax.leadingDigit':
      'A name starting with a digit (2号测点) still needs brackets: bare, it reads as the number 2 followed by a stray identifier',
    'help.syntax.bracket':
      'Square brackets quote any name (/, spaces, (, - …); everything up to ] is taken verbatim — full-width 【】/［］ also work',
    'help.syntax.qualified':
      'With more than one matrix input, prefix the port identity (A, B, C… or the port id shown in the Inputs zone); optional for a single input',
    'help.syntax.fullwidth': 'Full-width punctuation is accepted as its ASCII equivalent',
    'help.example.scale': 'Multiply the first column by 2',
    'help.example.unit': 'Unit conversion (m → km and the like)',
    'help.example.zscore': 'Standardise (z-score)',
    'help.example.smooth': '5-point smoothing',
    'help.example.bracket': 'Bracket form for a name containing /',
    'help.example.positive': 'Keep positive values, zero the rest',
    'help.error.unexpectedChar':
      'Unrecognised character — usually a column name containing / or a space; use Pos.N or [column name] instead',
    'help.error.unknownColumn':
      'That column does not exist — a name containing / or a space, or starting with a digit, cannot be written bare (`地面速度_μm/s` reads as `地面速度_μm` divided by `s`); write [column name] or click an available-column chip to insert Pos.N',
    'help.error.unknownFunction':
      'The function name is misspelt — names in the function table are case-insensitive. If you meant a column whose name contains a parenthesis, it was read as a call: write [column name]',
    'help.error.badArgCount': 'Wrong number of arguments — POW takes 2, IF takes 3',
    'help.error.expectedClose':
      "Unbalanced parentheses — a closing ')' is missing after the function arguments (a full-width ） counts too)",
    'help.error.columnContractViolation':
      'The output width no longer matches the locked contract — restore the column count or extend the contract',
    'help.fn.SUM': "Sum of the column's finite values",
    'help.fn.AVG': 'Arithmetic mean (same as MEAN)',
    'help.fn.MEAN': 'Arithmetic mean (same as AVG)',
    'help.fn.MIN':
      'One argument reduces the column to its minimum; with several arguments it is a row-wise minimum',
    'help.fn.MAX':
      'One argument reduces the column to its maximum; with several arguments it is a row-wise maximum',
    'help.fn.MEDIAN': 'Median (the mean of the two middle values for an even count)',
    'help.fn.STD': 'Sample standard deviation (ddof = 1)',
    'help.fn.COUNT': 'Count of valid values (finite only; NaN and ±∞ are not counted)',
    'help.fn.NAN':
      'Count of missing values (NaN only — ±∞ is a different defect and is not counted)',
    'help.fn.VAR': 'Sample variance (ddof = 1)',
    'help.fn.SEM': 'Standard error = sd / √n (0 with fewer than two valid values)',
    'help.fn.QUANTILE':
      'Quantile (R-7 linear interpolation); q may be a constant or a column, computed per row',
    'help.fn.ABS': 'Absolute value',
    'help.fn.SQRT': 'Square root',
    'help.fn.LOG': 'Natural log (base e — identical to LN)',
    'help.fn.LN': 'Natural log (base e)',
    'help.fn.LOG10': 'Base-10 logarithm',
    'help.fn.EXP': 'e raised to x',
    'help.fn.POW': 'a raised to the power b',
    'help.fn.ROUND': 'Round to n decimals (an integer when n is omitted)',
    'help.fn.FLOOR': 'Round down',
    'help.fn.CEIL': 'Round up',
    'help.fn.SIGN': 'Sign: −1, 0 or 1',
    'help.fn.MOV': 'n-point moving average (centred window; it narrows at both ends)',
    'help.fn.EMA': 'Exponential moving average; alpha is the weight of the new sample (0–1)',
    'help.fn.IF': 'Row-wise: the first value when the condition is non-zero, otherwise the second',
    // Hover tooltips: appear after ~1s at the pointer instead of the instant native title.
    'help.hover.openHelp': 'Open the formula & function reference (Esc closes it)',
    'help.hover.expr':
      'Expression syntax: Pos.1 * 2, MOV(Pos.2, 5), [column name] * 2 — click ? for every function',
    'help.hover.name': 'Output column name; naming it locks the output width (contract)',
    'help.hover.addColumn': 'Append one formula column',
    'help.columns.hint':
      'Click to insert Pos.N; use [column name] for names containing / or spaces',
    'help.chip.insert': 'Insert {pos} (column {name})',
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
