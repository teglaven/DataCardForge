/**
 * ECharts option builders.
 *
 * One builder per chart family, all producing an `EChartsOption` for the **SVG**
 * renderer. Two families are drawn with ECharts' genuine `custom` series rather than a
 * canvas overlay, which is what keeps them vector-exportable:
 *
 *   - **violin**: a KDE density outline plus quartile rules. ECharts has no native
 *     violin type; drawing it from `polygon`/`line` shapes keeps it as real SVG paths.
 *   - **error bar**: capped mean ± spread bars. ECharts has no native error-bar series.
 *
 * Axis strategy per type (the part that is easy to get wrong):
 *
 *   type        | x axis                                  | y axis
 *   ------------|-----------------------------------------|------------------
 *   line/bar    | value (`No.N` row index)                | value (log optional)
 *   histogram   | value (bin centre)                      | value (count)
 *   scatter     | value                                   | value
 *   regression  | value                                   | value
 *   boxplot     | category (one slot per attached column) | value (log optional)
 *   violin      | category                                | value (density)
 *   errorBar    | category                                | value
 *   heatmap     | category × category (correlation)       | —
 */
import type {
  CustomSeriesOption,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
  EChartsOption,
  SeriesOption,
} from 'echarts';

import {
  correlationMatrix,
  errorBarValues,
  fiveNumberSummary,
  histogram,
  kernelDensity,
  linearRegression,
  mean,
  outliers,
  stdDev,
} from '../core/stats.ts';
import { applySmoothing, type SmoothingOptions } from '../core/Smoothing.ts';
import type { ChartConfig, ChartSource } from './chartModel.ts';
import { resolveSeries } from './chartModel.ts';
import { lineColor } from './palette.ts';

/**
 * Cap on plotted points for the scatter-based types.
 *
 * ECharts draws every scatter symbol as its own SVG path, so the cap bounds both the
 * render cost and the size of an exported vector file (10 000 points produced a ~1 MB
 * SVG; 5 000 keeps the cloud's shape while staying a practical figure to publish).
 */
const SCATTER_LIMIT = 5_000;
/** KDE curve resolution — smooth enough visually without bloating the SVG. */
const KDE_SAMPLES = 96;

/**
 * `Extract<SeriesOption, { type: 'custom' }>` resolves to `never` in ECharts 6 (the
 * discriminant is optional on the union members), which would silently widen every cast
 * to `any`. The package re-exports the real custom-series types, so those are used
 * directly and the `renderItem` signature stays checked.
 */
type RenderItemResult = CustomSeriesRenderItemReturn;

export interface BuildContext {
  config: ChartConfig;
  smoothing: SmoothingOptions;
  /** Localised axis/tooltip labels, resolved by the caller (keeps this module i18n-free). */
  strings: {
    rowIndex: string;
    value: string;
    count: string;
    density: string;
    correlation: string;
    quartiles: string;
    /** Axis name for a histogram's value axis (bin centres), not the row index. */
    binCentre: string;
    /** Legend name for the mean/error series, e.g. `Mean ± SD`. */
    mean: string;
    outliers: string;
    secondAxis: string;
  };
}

/** Values of a source with the card's smoothing applied. */
function smoothed(source: ChartSource, smoothing: SmoothingOptions): number[] {
  return applySmoothing(source.raw, smoothing);
}

/** Strip NaN/Infinity so ECharts does not plot artefacts. */
function finite(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Series builders — exported so tests can assert each type's shape directly.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Explicit axis ranges for the types whose axis extent cannot be inferred from the
 * series data.
 *
 * ECharts infers a value axis from the numbers it is given, which is wrong for the
 * hand-rendered types: a violin plots *density* on y while its data values live on x,
 * so without an explicit range the density curve is scaled against the data extent.
 */
export interface AxisBounds {
  yMin?: number;
  yMax?: number;
  xMin?: number;
  xMax?: number;
}

export interface BuiltChart {
  series: SeriesOption[];
  bounds: AxisBounds;
}

/** Ids of the `dataZoom` components the option installs, in draw order. */
export const ZOOM_COMPONENT_IDS = ['zoom-x', 'zoom-y'] as const;

export function buildSeries(context: BuildContext): SeriesOption[] {
  switch (context.config.type) {
    case 'line':
      return lineSeries(context);
    case 'bar':
      return barSeries(context);
    case 'scatter':
      return scatterSeries(context);
    case 'regression':
      return regressionSeries(context);
    case 'histogram':
      return histogramSeries(context);
    case 'boxplot':
      return boxplotSeries(context);
    case 'violin':
      return violinSeries(context);
    case 'errorBar':
      return errorBarSeries(context);
    case 'heatmap':
      return heatmapSeries(context);
    default:
      return [];
  }
}

// ── line / bar ─────────────────────────────────────────────────────────────

function yAxisIndexFor(config: ChartConfig, index: number): number {
  return config.secondAxis && index % 2 === 1 ? 1 : 0;
}

function lineSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing } = context;
  const xData = config.xAxisSource?.raw;
  return config.sources.map((source, index) => {
    const values = smoothed(source, smoothing);
    const data: Array<[number, number]> = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      data[i] = [xData ? xData[i] ?? i + 1 : i + 1, values[i]];
    }
    return {
      name: source.label,
      type: 'line',
      data,
      showSymbol: values.length <= 2,
      sampling: 'lttb',
      lineStyle: { width: 1.6, color: lineColor(index) },
      itemStyle: { color: lineColor(index) },
      emphasis: { focus: 'series' },
      animation: false,
      yAxisIndex: yAxisIndexFor(config, index),
    };
  });
}

function barSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing } = context;
  const xData = config.xAxisSource?.raw;
  return config.sources.map((source, index) => {
    const values = smoothed(source, smoothing);
    const data: Array<[number, number]> = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      data[i] = [xData ? xData[i] ?? i + 1 : i + 1, values[i]];
    }
    return {
      name: source.label,
      type: 'bar',
      data,
      stack: config.layout === 'stacked' ? 'total' : undefined,
      large: true,
      largeThreshold: 4000,
      itemStyle: { color: lineColor(index) },
      emphasis: { focus: 'series' },
      animation: false,
      yAxisIndex: yAxisIndexFor(config, index),
    };
  });
}

// ── scatter / regression ───────────────────────────────────────────────────

function scatterSeries(context: BuildContext): SeriesOption[] {
  const { config } = context;
  const out: SeriesOption[] = [];

  resolveSeries(config).forEach((entry, index) => {
    const points = thin(entry.points);
    out.push({
      name: entry.label,
      type: 'scatter',
      data: points,
      symbolSize: 5,
      itemStyle: { color: lineColor(index), opacity: 0.75 },
      large: true,
      largeThreshold: 2000,
      animation: false,
    });
    if (config.showFitLine) {
      const fit = fitOverlay(entry.points, entry.label, index, config);
      if (fit) out.push(fit);
    }
  });

  return out;
}

function regressionSeries(context: BuildContext): SeriesOption[] {
  const { config } = context;
  const out: SeriesOption[] = [];

  resolveSeries(config).forEach((entry, index) => {
    out.push({
      name: entry.label,
      type: 'scatter',
      data: thin(entry.points),
      symbolSize: 5,
      itemStyle: { color: lineColor(index), opacity: 0.5 },
      large: true,
      largeThreshold: 2000,
      animation: false,
    });
    const fit = fitOverlay(entry.points, entry.label, index, config);
    if (fit) out.push(fit);
  });

  return out;
}

/** Deterministic thinning plus NaN removal, to keep big scatters interactive. */
function thin(points: Array<{ x: number; y: number }>): Array<[number, number]> {
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const kept =
    clean.length > SCATTER_LIMIT
      ? clean.filter((_, i) => i % Math.ceil(clean.length / SCATTER_LIMIT) === 0)
      : clean;
  return kept.map((point) => [point.x, point.y] as [number, number]);
}

/**
 * OLS fit line over a scatter. The R²/slope annotation goes in the series name so it
 * appears in the tooltip, and the name is filtered out of the legend by `legendNames`.
 */
function fitOverlay(
  points: Array<{ x: number; y: number }>,
  label: string,
  index: number,
  config: ChartConfig,
): SeriesOption | null {
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (clean.length < 2) return null;

  const fit = linearRegression(
    clean.map((point) => point.x),
    clean.map((point) => point.y),
  );
  if (!fit) return null;

  const xs = clean.map((point) => point.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const color = lineColor(index);

  const steps = 32;
  const data: Array<[number, number]> = [];
  for (let i = 0; i <= steps; ++i) {
    const x = xMin + ((xMax - xMin) * i) / steps;
    data.push([x, fit.intercept + fit.slope * x]);
  }

  const sign = fit.intercept >= 0 ? '+' : '−';
  const name =
    `${label} — fit y=${fit.slope.toPrecision(4)}x${sign}${Math.abs(fit.intercept).toPrecision(4)}, ` +
    `R²=${fit.r2.toFixed(4)}, n=${fit.n}`;

  void config;
  return {
    name,
    type: 'line',
    data,
    showSymbol: false,
    silent: true,
    lineStyle: { width: 2, color },
    itemStyle: { color },
    z: 10,
    animation: false,
  };
}

// ── histogram ──────────────────────────────────────────────────────────────

function histogramSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing } = context;
  const source = config.sources[0];
  if (!source) return [];

  const values = smoothed(source, smoothing);
  const result = histogram(values, config.binCount > 0 ? config.binCount : undefined);
  const data = result.bins.map((bin) => [bin.centre, bin.count] as [number, number]);

  return [
    {
      name: source.label,
      type: 'bar',
      data,
      barWidth: '92%',
      large: true,
      itemStyle: {
        color: lineColor(0),
        opacity: 0.85,
        // Hairline outline keeps adjacent bins separated when printed in greyscale.
        borderColor: 'rgba(0,0,0,0.28)',
        borderWidth: 0.6,
      },
      animation: false,
    },
  ];
}

// ── boxplot ────────────────────────────────────────────────────────────────

function boxplotSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing, strings } = context;

  const summaries = config.sources.map((source) => fiveNumberSummary(smoothed(source, smoothing)));
  const boxData = summaries.map((summary) => [
    summary.min,
    summary.q1,
    summary.median,
    summary.q3,
    summary.max,
  ]);

  const series: SeriesOption[] = [
    {
      name: strings.quartiles,
      type: 'boxplot',
      data: boxData,
      boxWidth: ['22%', '58%'],
      itemStyle: {
        color: 'rgba(0, 114, 178, 0.18)',
        borderColor: lineColor(0),
        borderWidth: 1.6,
      },
      emphasis: { itemStyle: { borderWidth: 2.4 } },
      animation: false,
    },
  ];

  const outlierPoints: Array<[number, number]> = [];
  config.sources.forEach((source, index) => {
    for (const value of outliers(smoothed(source, smoothing))) {
      outlierPoints.push([index, value]);
    }
  });
  if (outlierPoints.length > 0 && outlierPoints.length <= SCATTER_LIMIT) {
    series.push({
      name: strings.outliers,
      type: 'scatter',
      data: outlierPoints,
      symbolSize: 3.5,
      itemStyle: { color: 'rgba(213, 94, 0, 0.8)' },
      animation: false,
    });
  }

  return series;
}

// ── violin (custom series — no native ECharts type) ────────────────────────

interface ViolinShape {
  curve: Array<{ x: number; y: number }>;
  summary: ReturnType<typeof fiveNumberSummary>;
}

/** Half-width of a violin in pixels. A fixed width keeps violins readable side by side
 *  regardless of the density scale, which is how Matplotlib/Seaborn draw them. */
const VIOLIN_HALF_WIDTH_PX = 42;

function violinSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing, strings } = context;

  // Pre-compute every curve: `renderItem` is called per item on each render, so it must
  // stay cheap and must not recompute the KDE.
  const shapes: ViolinShape[] = config.sources.map((source) => {
    const values = finite(smoothed(source, smoothing));
    return { curve: kernelDensity(values, KDE_SAMPLES), summary: fiveNumberSummary(values) };
  });

  const series: SeriesOption[] = [
    {
      name: strings.density,
      type: 'custom',
      // One data item per attached column; the value drives the tooltip.
      data: shapes.map((shape, index) => ({
        value: [index, shape.summary.median],
        itemStyle: { color: lineColor(index), borderColor: lineColor(index) },
      })),
      clip: false,
      animation: false,
      z: 2,
      renderItem: (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
        const index = Number(api.value(0));
        const shape = shapes[index];
        if (!shape || shape.curve.length < 3) return undefined;

        const centreX = api.coord([index, shape.summary.median])[0];
        const halfWidth = VIOLIN_HALF_WIDTH_PX;
        void params;

        const peak = shape.curve.reduce((best, point) => Math.max(best, point.y), 0);
        const left: Array<[number, number]> = [];
        const right: Array<[number, number]> = [];
        for (const point of shape.curve) {
          const y = api.coord([index, point.x])[1];
          const w = peak > 0 ? (point.y / peak) * halfWidth : 0;
          left.push([centreX - w, y]);
          right.push([centreX + w, y]);
        }
        const outline = [...right, ...left.reverse()];

        const color = lineColor(index);
        const rule = (value: number, dashed: boolean) => ({
          type: 'line',
          shape: {
            x1: centreX - halfWidth,
            y1: api.coord([index, value])[1],
            x2: centreX + halfWidth,
            y2: api.coord([index, value])[1],
          },
          style: {
            stroke: color,
            lineWidth: dashed ? 1 : 1.8,
            lineDash: dashed ? [3, 3] : undefined,
          },
        });

        return {
          type: 'group',
          children: [
            {
              type: 'polygon',
              shape: { points: outline },
              style: { fill: withAlpha(color, 0.22), stroke: color, lineWidth: 1.4 },
            },
            rule(shape.summary.q1, true),
            rule(shape.summary.q3, true),
            rule(shape.summary.median, false),
          ],
        } as unknown as RenderItemResult;
      },
    },
  ];

  return series;
}

// ── error bar (custom series — no native ECharts type) ─────────────────────

interface ErrorStat {
  centre: number;
  spread: number;
  count: number;
}

function errorBarSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing, strings } = context;

  const stats: ErrorStat[] = config.sources.map((source) => {
    const values = finite(smoothed(source, smoothing));
    return {
      centre: values.length > 0 ? mean(values) : NaN,
      spread: values.length > 0 ? errorBarValues(values, config.errorKind) : NaN,
      count: values.length,
    };
  });

  const capHalf = Math.max(4, config.capWidth * 40);

  const drawn: CustomSeriesOption = {
    // Deliberately unnamed: an unnamed series never gets its own legend entry, while the
    // labelled backing scatter owns the legend. This avoids a duplicate entry without
    // relying on a private flag ECharts would not understand.
    type: 'custom',
    data: stats.map((stat, index) => ({
      value: [index, stat.centre],
      itemStyle: { color: lineColor(index) },
    })),
    clip: false,
    animation: false,
    z: 3,
    renderItem: (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
      const index = Number(api.value(0));
      const stat = stats[index];
      if (!stat || !Number.isFinite(stat.centre)) return undefined;

      const color = lineColor(index);
      const [cx, cy] = api.coord([index, stat.centre]);
      const yTop = api.coord([index, stat.centre + stat.spread])[1];
      const yBottom = api.coord([index, stat.centre - stat.spread])[1];

      const line = (x1: number, y1: number, x2: number, y2: number) => ({
        type: 'line',
        shape: { x1, y1, x2, y2 },
        style: { stroke: color, lineWidth: 1.6 },
      });

      return {
        type: 'group',
        children: [
          line(cx, yTop, cx, yBottom),
          line(cx - capHalf, yTop, cx + capHalf, yTop),
          line(cx - capHalf, yBottom, cx + capHalf, yBottom),
          {
            type: 'circle',
            shape: { cx, cy, r: 4 },
            style: { fill: color, stroke: '#ffffff', lineWidth: 1 },
          },
        ],
      } as unknown as RenderItemResult;
    },
  };

  // A plain scatter shares the tooltip/legend machinery, and gives the axis a real
  // series to scale against even when the error bars are zero-width.
  const backing: SeriesOption = {
    name: strings.mean,
    type: 'scatter',
    data: stats.map((stat, index) => [index, stat.centre] as [number, number]),
    symbolSize: 9,
    itemStyle: { color: (params: { dataIndex: number }) => lineColor(params.dataIndex) },
    animation: false,
  };

  return [backing, drawn];
}

// ── heatmap / correlation matrix ───────────────────────────────────────────

function heatmapSeries(context: BuildContext): SeriesOption[] {
  const { config, smoothing, strings } = context;
  const series = config.sources.map((source) => smoothed(source, smoothing));
  const matrix = correlationMatrix(series);

  const data: Array<[number, number, number]> = [];
  for (let row = 0; row < matrix.length; ++row) {
    for (let col = 0; col < matrix[row].length; ++col) {
      // `pearson()` returns NaN where a correlation is *undefined* (a constant column has
      // no variance, so there is nothing to correlate). ECharts skips NaN cells, which
      // keeps the distinction visible; coercing to 0 used to paint it as "no correlation".
      data.push([col, row, matrix[row][col]]);
    }
  }

  return [
    {
      name: strings.correlation,
      type: 'heatmap',
      data,
      label: {
        show: matrix.length <= 8,
        formatter: (params: { value: unknown }) => {
          const value = params.value as [number, number, number];
          return Number.isFinite(value[2]) ? value[2].toFixed(2) : '—';
        },
        fontSize: 9,
      },
      itemStyle: { borderColor: 'rgba(255,255,255,0.6)', borderWidth: 0.6 },
      emphasis: { itemStyle: { borderColor: '#333333', borderWidth: 1 } },
      animation: false,
    },
  ];
}

/**
 * Axis ranges that ECharts cannot infer.
 *
 * The hand-rendered types plot something other than the raw column values on y
 * (violin: density, errorBar: mean), so their extent has to be stated explicitly —
 * otherwise the curve is drawn against the wrong scale.
 */
export function computeBounds(context: BuildContext): AxisBounds {
  const { config, smoothing } = context;

  // Violin: the outline is drawn along the *value* axis (the KDE curve spans the sample
  // range, and the ribbon width encodes density — normalised to the peak in renderItem).
  // So the range is the data extent, exactly like a box plot, plus room for the
  // mirrored edge padding of the density estimate.
  if (config.type === 'violin') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const source of config.sources) {
      const values = finite(smoothed(source, smoothing));
      if (values.length === 0) continue;
      lo = Math.min(lo, Math.min(...values));
      hi = Math.max(hi, Math.max(...values));
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return {};
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
    return { yMin: lo - pad, yMax: hi + pad };
  }

  // Error bar: the whiskers extend past the means, so pad the observed extent.
  if (config.type === 'errorBar') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const source of config.sources) {
      const values = finite(smoothed(source, smoothing));
      if (values.length === 0) continue;
      const centre = mean(values);
      const spread = errorBarValues(values, config.errorKind);
      if (!Number.isFinite(centre) || !Number.isFinite(spread)) continue;
      lo = Math.min(lo, centre - spread);
      hi = Math.max(hi, centre + spread);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return {};
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
    return { yMin: lo - pad, yMax: hi + pad };
  }

  // Box plot: the whiskers span min..max, and outliers can escape that range.
  if (config.type === 'boxplot') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const source of config.sources) {
      const values = finite(smoothed(source, smoothing));
      if (values.length === 0) continue;
      lo = Math.min(lo, Math.min(...values));
      hi = Math.max(hi, Math.max(...values));
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return {};
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.06;
    return { yMin: lo - pad, yMax: hi + pad };
  }

  return {};
}

// ═══════════════════════════════════════════════════════════════════════════
//  Shared option scaffolding
// ═══════════════════════════════════════════════════════════════════════════

type AxisKind = 'value' | 'log' | 'category';

/** Which x-axis form each chart type needs. */
function xAxisKind(config: ChartConfig): AxisKind {
  switch (config.type) {
    case 'boxplot':
    case 'violin':
    case 'errorBar':
      return 'category';
    default:
      return 'value';
  }
}

export function buildOption(context: BuildContext): EChartsOption {
  const { config, strings } = context;
  const series = buildSeries(context);
  const categories = config.sources.map((source) => source.label);
  const isHeatmap = config.type === 'heatmap';
  // When an explicit X-axis source is set, the X axis is always a value axis regardless
  // of chart type — this enables time-series and arbitrary X plots.
  const hasExplicitX = config.xAxisSource !== null;
  const kind: AxisKind = isHeatmap ? 'category' : hasExplicitX ? 'value' : xAxisKind(config);

  const xAxis =
    kind === 'category'
      ? {
          type: 'category' as const,
          data: categories,
          name: config.type === 'histogram' ? '' : undefined,
          nameLocation: 'end' as const,
          axisLabel: {
            fontSize: 10,
            interval: 0,
            rotate: categories.length > 6 ? 30 : 0,
          },
          splitLine: { show: isHeatmap, lineStyle: { color: 'rgba(128,128,128,0.15)' } },
        }
      : {
          type: 'value' as const,
          scale: true,
          // The x axis is only "the row index" for the types that really plot against it.
          // A histogram plots bin *centres* and a scatter/regression plots the first column
          // of each pair, so labelling those "No." was simply wrong.
          name: hasExplicitX
            ? config.xAxisSource!.label
            : config.type === 'histogram'
              ? strings.binCentre
              : config.type === 'scatter' || config.type === 'regression'
                ? config.sources[0]?.label
                : strings.rowIndex,
          nameLocation: 'end' as const,
          axisLabel: { fontSize: 10 },
          splitLine: { show: true, lineStyle: { color: 'rgba(128,128,128,0.18)' } },
        };

  const yAxisName =
    config.type === 'histogram'
      ? strings.count
      : config.type === 'heatmap'
        ? ''
        : strings.value;

  // Explicit bounds where the plotted quantity differs from the column values.
  const bounds = computeBounds(context);
  const hasFixedRange = bounds.yMin !== undefined && bounds.yMax !== undefined;

  const primaryYAxis: NonNullable<EChartsOption['yAxis']> = {
    // Bar charts stay linear even with the log toggle on: a bar of height 0 has no
    // representable position on a log axis.
    type: config.logScale && config.type !== 'bar' ? 'log' : 'value',
    // `scale: true` lets ECharts tighten the axis to the data; with a stated range the
    // range wins, and a log axis may not contain zero.
    scale: !hasFixedRange,
    min: config.logScale ? undefined : bounds.yMin,
    max: bounds.yMax,
    name: yAxisName,
    nameLocation: 'end' as const,
    axisLabel: {
      fontSize: 10,
      formatter: (value: number) => formatAxisNumber(value),
    },
    splitLine: { show: true, lineStyle: { color: 'rgba(128,128,128,0.18)' } },
  };

  const heatmapYAxis = {
    type: 'category' as const,
    data: categories,
    axisLabel: { fontSize: 10, interval: 0 },
  };

  const option: EChartsOption = {
    animation: false,
    grid: {
      left: 64,
      right: config.secondAxis && !isHeatmap ? 74 : 22,
      top: 32,
      bottom: isHeatmap ? 74 : 80,
      containLabel: false,
    },
    legend: {
      // `data` must be supplied explicitly: the fit-line series have long generated
      // names that should stay out of the legend while remaining present on the chart.
      data: isHeatmap ? [] : legendNames(series),
      show: !isHeatmap && legendNames(series).length > 0,
      type: 'scroll',
      bottom: 38,
      textStyle: { fontSize: 11 },
    },
    tooltip: {
      trigger: isHeatmap ? 'item' : 'axis',
      confine: true,
      axisPointer: { type: isHeatmap ? 'none' : 'cross' },
      valueFormatter: (value: unknown) =>
        typeof value === 'number' ? formatTooltipNumber(value) : String(value),
    },
    dataZoom: isHeatmap
      ? []
      : [
          // Both axes are zoomable by wheel/drag. `filterMode: 'none'` keeps the data
          // extent intact so a zoom is purely a view change and is fully reversible —
          // see the "reset zoom" control in the axes panel.
          { id: 'zoom-x', type: 'inside', xAxisIndex: 0, filterMode: 'none' },
          { id: 'zoom-y', type: 'inside', yAxisIndex: 0, filterMode: 'none' },
        ],
    xAxis,
    yAxis: isHeatmap ? heatmapYAxis : primaryYAxis,
    series: series as EChartsOption['series'],
  };

  if (config.secondAxis && !isHeatmap) {
    option.yAxis = [
      primaryYAxis as never,
      {
        type: config.logScale ? 'log' : 'value',
        scale: !hasFixedRange,
        min: config.logScale ? undefined : bounds.yMin,
        max: bounds.yMax,
        position: 'right',
        name: strings.secondAxis,
        nameLocation: 'end',
        axisLabel: { fontSize: 10, formatter: (value: number) => formatAxisNumber(value) },
        splitLine: { show: false },
      } as never,
    ];
  }

  if (isHeatmap) {
    option.visualMap = [
      {
        min: -1,
        max: 1,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 4,
        itemWidth: 14,
        itemHeight: 200,
        precision: 2,
        textStyle: { fontSize: 10 },
        // Diverging scale: negative (blue) → none (white) → positive (red).
        inRange: { color: ['#3b6ea5', '#9ecae1', '#f7f7f7', '#fcae91', '#c83232'] },
      },
    ];
  }

  return option;
}

/** Legend entries, excluding the fit lines whose names carry the regression statistics. */
function legendNames(series: SeriesOption[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of series) {
    const name = (entry as { name?: unknown }).name;
    // Unnamed series (the whisker geometry) and fit lines are drawn but kept out of the
    // legend — their generated names would only add clutter, and names are never repeated.
    if (typeof name !== 'string' || name.length === 0) continue;
    if (name.includes('fit y=') || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function formatAxisNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e-3 && abs < 1e6) return String(Number(value.toPrecision(4)));
  return value.toExponential(1);
}

function formatTooltipNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  // Use plain notation where it stays readable, exponent form otherwise.
  if (abs >= 1e-4 && abs < 1e7) return String(Number(value.toPrecision(6)));
  return value.toExponential(4);
}

function withAlpha(color: string, alpha: number): string {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

export { stdDev };
