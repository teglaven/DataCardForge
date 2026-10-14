/**
 * Chart-type registry.
 *
 * Every scientific/statistical chart the workbench can draw is declared here
 * declaratively: how many columns it consumes, whether it reads the row index as x,
 * whether it understands a logarithmic scale, and — importantly — whether it is
 * *vector-safe* (renders entirely with ECharts primitives, so the exported SVG contains
 * real paths and text rather than a rasterised bitmap).
 *
 * Capability audit (ECharts 6.1.0, verified against the installed package):
 *   native series: line, scatter, bar, boxplot, heatmap, candlestick, custom, …
 *   native vector export: `echarts.init(el, null, { renderer: 'svg' })` plus the
 *   `getSvgDataURL()` / `getDataURL({ type: 'svg' })` API.
 *
 *   type          | native?            | note
 *   --------------|--------------------|------------------------------------------
 *   line          | ✅ line            |
 *   scatter       | ✅ scatter         |
 *   regression    | ✅ line + custom   | band is a stacked-category trick
 *   bar           | ✅ bar             |
 *   histogram     | ✅ bar (pre-binned)| binning in core/stats.ts
 *   boxplot       | ✅ boxplot         | outliers drawn by ECharts itself
 *   violin        | ⚠️ custom series   | KDE curve + quartile overlay (no native type)
 *   heatmap       | ✅ heatmap         | used for the correlation matrix
 *   errorBar      | ⚠️ custom series   | no native error-bar series exists
 *
 * So the only two types that need hand-written rendering are **violin** and
 * **errorBar** — both are implemented with ECharts' genuine `custom` series (vector
 * primitives), not with a canvas overlay, which keeps them vector-safe.
 */
import type { MessageKey } from '../ui/i18n.ts';

export type ChartTypeId =
  | 'line'
  | 'scatter'
  | 'regression'
  | 'bar'
  | 'histogram'
  | 'boxplot'
  | 'violin'
  | 'heatmap'
  | 'errorBar';

/** How a chart consumes the columns attached to it. */
export type ColumnArity =
  /** Exactly one column (line, histogram, …). Extra columns are ignored. */
  | 'single'
  /** One position column per group (boxplot, violin, error bar). */
  | 'onePerSeries'
  /** A pair (x, y) per series (scatter, regression). */
  | 'pairs'
  /** All attached columns at once (heatmap / correlation matrix). */
  | 'matrix';

export interface ChartTypeDef {
  id: ChartTypeId;
  /** Label key in the i18n dictionary. */
  labelKey: MessageKey;
  /** Short description key shown as the control's tooltip. */
  hintKey: MessageKey;
  columnArity: ColumnArity;
  /** True when the x axis is the row index (`No.N`) rather than a second column. */
  usesRowIndexAsX: boolean;
  /** True when the type can be switched to a logarithmic value axis. */
  supportsLogScale: boolean;
  /** True when a second value axis (dual axis) is meaningful. */
  supportsSecondAxis: boolean;
  /**
   * True when the ECharts primitives used by this type render as paths/text in the SVG
   * renderer. All current types qualify; the flag exists so a future canvas-only
   * overlay cannot silently break vector export.
   */
  vectorSafe: boolean;
  /** Default number of columns to attach when the type is first selected. */
  defaultColumnCount: number;
}

export const CHART_TYPES: Record<ChartTypeId, ChartTypeDef> = {
  line: {
    id: 'line',
    labelKey: 'chart.type.line',
    hintKey: 'chart.hint.line',
    columnArity: 'onePerSeries',
    usesRowIndexAsX: true,
    supportsLogScale: true,
    supportsSecondAxis: true,
    vectorSafe: true,
    defaultColumnCount: 1,
  },
  scatter: {
    id: 'scatter',
    labelKey: 'chart.type.scatter',
    hintKey: 'chart.hint.scatter',
    columnArity: 'pairs',
    usesRowIndexAsX: false,
    supportsLogScale: true,
    supportsSecondAxis: false,
    vectorSafe: true,
    defaultColumnCount: 2,
  },
  regression: {
    id: 'regression',
    labelKey: 'chart.type.regression',
    hintKey: 'chart.hint.regression',
    columnArity: 'pairs',
    usesRowIndexAsX: false,
    supportsLogScale: false,
    supportsSecondAxis: false,
    vectorSafe: true,
    defaultColumnCount: 2,
  },
  bar: {
    id: 'bar',
    labelKey: 'chart.type.bar',
    hintKey: 'chart.hint.bar',
    columnArity: 'onePerSeries',
    usesRowIndexAsX: true,
    supportsLogScale: true,
    supportsSecondAxis: true,
    vectorSafe: true,
    defaultColumnCount: 1,
  },
  histogram: {
    id: 'histogram',
    labelKey: 'chart.type.histogram',
    hintKey: 'chart.hint.histogram',
    columnArity: 'single',
    usesRowIndexAsX: false,
    supportsLogScale: false,
    supportsSecondAxis: false,
    vectorSafe: true,
    defaultColumnCount: 1,
  },
  boxplot: {
    id: 'boxplot',
    labelKey: 'chart.type.boxplot',
    hintKey: 'chart.hint.boxplot',
    columnArity: 'onePerSeries',
    usesRowIndexAsX: true,
    supportsLogScale: true,
    supportsSecondAxis: false,
    vectorSafe: true,
    defaultColumnCount: 1,
  },
  violin: {
    id: 'violin',
    labelKey: 'chart.type.violin',
    hintKey: 'chart.hint.violin',
    columnArity: 'onePerSeries',
    usesRowIndexAsX: true,
    supportsLogScale: false,
    supportsSecondAxis: false,
    vectorSafe: true,
    defaultColumnCount: 1,
  },
  heatmap: {
    id: 'heatmap',
    labelKey: 'chart.type.heatmap',
    hintKey: 'chart.hint.heatmap',
    columnArity: 'matrix',
    usesRowIndexAsX: false,
    supportsLogScale: false,
    supportsSecondAxis: false,
    vectorSafe: true,
    defaultColumnCount: 4,
  },
  errorBar: {
    id: 'errorBar',
    labelKey: 'chart.type.errorBar',
    hintKey: 'chart.hint.errorBar',
    columnArity: 'onePerSeries',
    usesRowIndexAsX: true,
    supportsLogScale: true,
    supportsSecondAxis: false,
    vectorSafe: true,
    defaultColumnCount: 1,
  },
};

/** Display order of the chart-type selector. */
export const CHART_TYPE_ORDER: ChartTypeId[] = [
  'line',
  'scatter',
  'regression',
  'bar',
  'histogram',
  'boxplot',
  'violin',
  'errorBar',
  'heatmap',
];

export function chartTypeDef(id: ChartTypeId): ChartTypeDef {
  return CHART_TYPES[id];
}

/**
 * Minimum number of columns a type needs before it can draw anything meaningful.
 * `pairs` needs two; `matrix` needs two (a 1×1 correlation matrix is not informative
 * but should still not crash).
 */
export function minimumColumns(id: ChartTypeId): number {
  const def = chartTypeDef(id);
  switch (def.columnArity) {
    case 'pairs':
      return 2;
    case 'matrix':
      return 2;
    default:
      return 1;
  }
}

/** Which export formats this app offers, and whether each is vector. */
export interface ExportFormat {
  id: 'svg' | 'png' | 'pdf';
  labelKey: MessageKey;
  extension: string;
  mime: string;
  /** True when the output contains resolution-independent vector geometry. */
  vector: boolean;
}

export const EXPORT_FORMATS: ExportFormat[] = [
  {
    id: 'svg',
    labelKey: 'chart.exportSvg',
    extension: 'svg',
    mime: 'image/svg+xml',
    vector: true,
  },
  {
    id: 'pdf',
    labelKey: 'chart.exportPdf',
    extension: 'pdf',
    mime: 'application/pdf',
    // The PDF wrapper embeds a high-resolution raster of the SVG. Flagged honestly so
    // the UI can tell the user which format to pick for a journal submission.
    vector: false,
  },
  {
    id: 'png',
    labelKey: 'chart.exportPng',
    extension: 'png',
    mime: 'image/png',
    vector: false,
  },
];

export function exportFormat(id: ExportFormat['id']): ExportFormat {
  const found = EXPORT_FORMATS.find((format) => format.id === id);
  if (!found) throw new Error(`Unknown export format: ${id}`);
  return found;
}
