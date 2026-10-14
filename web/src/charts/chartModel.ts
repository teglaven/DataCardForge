/**
 * Chart configuration model.
 *
 * A chart card is configured by:
 *   - a **type** (line / boxplot / violin / heatmap / …),
 *   - a list of **sources** (which matrix column feeds which slot),
 *   - presentation options (log axis, dual axis, regression line, normalisation).
 *
 * Everything is plain serialisable data so a workspace snapshot can round-trip it.
 */
import type { ChartTypeId } from './chartTypes.ts';
import { chartTypeDef } from './chartTypes.ts';

/** One column attached to a chart. */
export interface ChartSource {
  /** Identifies which matrix the column came from (for dependency tracking). */
  matrixId: number;
  columnIndex: number;
  /** Display label; `Pos.N` plus the file annotation when present. */
  label: string;
  /** Full-resolution values, smoothing applied on top by the renderer. */
  raw: number[];
}

export interface ChartConfig {
  type: ChartTypeId;
  sources: ChartSource[];
  /** Render series on a logarithmic value axis. */
  logScale: boolean;
  /** Put every second series on a right-hand axis. */
  secondAxis: boolean;
  /** Overlay an OLS fit (scatter / regression types). */
  showFitLine: boolean;
  /** Overlay a 95% confidence band around the fit. */
  showConfidenceBand: boolean;
  /** Bin count for the histogram; `0` means "choose automatically". */
  binCount: number;
  /** Which spread the error bars show. */
  errorKind: 'sd' | 'se' | 'ci95';
  /** Bar/box/violin layout. */
  layout: 'grouped' | 'stacked';
  /** Error-bar cap width in x units. */
  capWidth: number;
}

export function defaultChartConfig(type: ChartTypeId, sources: ChartSource[]): ChartConfig {
  return {
    type,
    sources,
    logScale: false,
    secondAxis: false,
    showFitLine: true,
    showConfidenceBand: true,
    binCount: 0,
    errorKind: 'sd',
    layout: 'grouped',
    capWidth: 0.35,
  };
}

/** Value combining one source with the row index, ready for charting. */
export interface XYPoint {
  x: number;
  y: number;
}

/**
 * Pair a source's values with the row index (`No.N`, 1-based) — the default x axis for
 * line/bar/boxplot/violin/error-bar charts, matching the original Qt behaviour.
 */
export function withRowIndex(source: ChartSource): XYPoint[] {
  const points: XYPoint[] = [];
  for (let i = 0; i < source.raw.length; ++i) {
    points.push({ x: i + 1, y: source.raw[i] });
  }
  return points;
}

/** Pair two sources as (x, y), truncating to the shorter one. */
export function pair(xSource: ChartSource, ySource: ChartSource): XYPoint[] {
  const length = Math.min(xSource.raw.length, ySource.raw.length);
  const points: XYPoint[] = [];
  for (let i = 0; i < length; ++i) {
    points.push({ x: xSource.raw[i], y: ySource.raw[i] });
  }
  return points;
}

/**
 * Interpret the attached sources for a type, resolving the ambiguous cases:
 * for `pairs` the sources are consecutive (x, y) tuples; for `single` only the first is
 * used; for `matrix` every source participates.
 */
export function resolveSeries(config: ChartConfig): Array<{ label: string; points: XYPoint[] }> {
  const { sources } = config;
  const def = chartTypeDef(config.type);

  switch (def.columnArity) {
    case 'single':
      return sources.slice(0, 1).map((source) => ({
        label: source.label,
        points: withRowIndex(source),
      }));

    case 'pairs': {
      const out: Array<{ label: string; points: XYPoint[] }> = [];
      for (let i = 0; i + 1 < sources.length; i += 2) {
        out.push({
          label: `${sources[i].label} → ${sources[i + 1].label}`,
          points: pair(sources[i], sources[i + 1]),
        });
      }
      // An odd trailing column cannot form a pair; still show it as y against the row
      // index so the user sees the data rather than an empty chart.
      if (sources.length % 2 === 1 && sources.length > 1) {
        const last = sources[sources.length - 1];
        out.push({ label: `${last.label} (no x)`, points: withRowIndex(last) });
      }
      return out;
    }

    case 'matrix':
    case 'onePerSeries':
    default:
      return sources.map((source) => ({
        label: source.label,
        points: withRowIndex(source),
      }));
  }
}

/** True when the configuration has enough sources to draw the selected type. */
export function isDrawable(config: ChartConfig): boolean {
  const def = chartTypeDef(config.type);
  if (config.sources.length === 0) return false;
  switch (def.columnArity) {
    case 'pairs':
      return config.sources.length >= 2;
    case 'matrix':
      return config.sources.length >= 2;
    default:
      return true;
  }
}
