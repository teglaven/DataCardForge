/**
 * Chart builders.
 *
 * These assert the *shape* of what each chart type produces — series kinds, axis kinds,
 * computed statistics — rather than pixels. That is the part that silently breaks when
 * a data model changes, and it is testable without a DOM.
 */
import { describe, expect, it } from 'vitest';

import type { EChartsOption } from 'echarts';

import {
  buildOption,
  buildSeries,
  computeBounds,
  type BuildContext,
} from '../src/charts/chartOptions.ts';
import { defaultChartConfig, resolveSeries, isDrawable } from '../src/charts/chartModel.ts';
import type { ChartSource } from '../src/charts/chartModel.ts';
import { CHART_TYPES, minimumColumns, type ChartTypeId } from '../src/charts/chartTypes.ts';
import { DEFAULT_SMOOTHING } from '../src/core/Smoothing.ts';
import {
  errorBarValues,
  fiveNumberSummary,
  histogram,
  kernelDensity,
  mean,
} from '../src/core/stats.ts';

function source(label: string, raw: number[], columnIndex = 0, matrixId = 1): ChartSource {
  return { matrixId, columnIndex, label, raw };
}

const strings: BuildContext['strings'] = {
  rowIndex: 'No.',
  value: 'Value',
  count: 'Count',
  density: 'Density',
  correlation: 'r',
  quartiles: 'IQR',
  mean: 'Mean ± SD',
  outliers: 'outliers',
  secondAxis: '2nd',
};

function context(type: ChartTypeId, sources: ChartSource[], patch: Partial<BuildContext['config']> = {}): BuildContext {
  return {
    config: { ...defaultChartConfig(type, sources), ...patch },
    smoothing: { ...DEFAULT_SMOOTHING },
    strings,
  };
}

/** A well-behaved sample: 0..99 with a single bump, plus a constant series. */
const ramp = Array.from({ length: 100 }, (_, i) => i);
const wave = ramp.map((value) => Math.sin(value / 8) * 10 + 50);
const noisy = [1, 5, 2, 8, 3, 9, 4, 7, 6, 10];

describe('chart type registry', () => {
  it('declares every type with a distinct id and consistent flags', () => {
    const ids = Object.keys(CHART_TYPES) as ChartTypeId[];
    expect(ids.length).toBeGreaterThanOrEqual(9);
    for (const id of ids) {
      const def = CHART_TYPES[id];
      expect(def.id).toBe(id);
      expect(def.defaultColumnCount).toBeGreaterThanOrEqual(1);
      expect(def.vectorSafe).toBe(true);
    }
  });

  it('requires two columns for the types that pair or cross columns', () => {
    expect(minimumColumns('scatter')).toBe(2);
    expect(minimumColumns('regression')).toBe(2);
    expect(minimumColumns('heatmap')).toBe(2);
    expect(minimumColumns('line')).toBe(1);
    expect(minimumColumns('boxplot')).toBe(1);
  });
});

describe('resolveSeries', () => {
  it('pairs consecutive columns for scatter', () => {
    const config = defaultChartConfig('scatter', [source('X', [1, 2]), source('Y', [3, 4])]);
    const resolved = resolveSeries(config);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].points).toEqual([
      { x: 1, y: 3 },
      { x: 2, y: 4 },
    ]);
  });

  it('truncates a pair to the shorter column', () => {
    const config = defaultChartConfig('scatter', [source('X', [1, 2, 3]), source('Y', [9])]);
    expect(resolveSeries(config)[0].points).toEqual([{ x: 1, y: 9 }]);
  });

  it('produces one series per column for line', () => {
    const config = defaultChartConfig('line', [source('A', [1, 2]), source('B', [3, 4])]);
    const resolved = resolveSeries(config);
    expect(resolved).toHaveLength(2);
    // Row-indexed: x starts at 1, matching `No.N`.
    expect(resolved[0].points[0]).toEqual({ x: 1, y: 1 });
  });

  it('keeps an odd trailing column visible instead of dropping it', () => {
    const config = defaultChartConfig('scatter', [
      source('X', [1, 2]),
      source('Y', [3, 4]),
      source('Z', [5, 6]),
    ]);
    const resolved = resolveSeries(config);
    expect(resolved).toHaveLength(2);
    expect(resolved[1].label).toContain('Z');
  });
});

describe('isDrawable', () => {
  it('is false without enough columns for the type', () => {
    expect(isDrawable(defaultChartConfig('line', []))).toBe(false);
    expect(isDrawable(defaultChartConfig('scatter', [source('X', [1])]))).toBe(false);
  });

  it('is true once the type has what it needs', () => {
    expect(isDrawable(defaultChartConfig('line', [source('A', [1])]))).toBe(true);
    expect(
      isDrawable(defaultChartConfig('scatter', [source('X', [1]), source('Y', [2])])),
    ).toBe(true);
  });
});

describe('line / bar series', () => {
  it('plots row index against value and downsamples', () => {
    const series = buildSeries(context('line', [source('A', ramp)]));
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('line');
    expect((series[0] as { sampling?: string }).sampling).toBe('lttb');
    const data = (series[0] as { data: Array<[number, number]> }).data;
    expect(data[0]).toEqual([1, 0]);
    expect(data[99]).toEqual([100, 99]);
  });

  it('stacks bars when the layout is set', () => {
    const series = buildSeries(
      context('bar', [source('A', [1, 2]), source('B', [3, 4])], { layout: 'stacked' }),
    );
    expect(series.every((entry) => (entry as { stack?: string }).stack === 'total')).toBe(true);
  });

  it('leaves bars unstacked by default', () => {
    const series = buildSeries(context('bar', [source('A', [1, 2]), source('B', [3, 4])]));
    expect((series[0] as { stack?: string }).stack).toBeUndefined();
  });

  it('routes every second series to the second axis when enabled', () => {
    const series = buildSeries(
      context('line', [source('A', [1, 2]), source('B', [3, 4])], { secondAxis: true }),
    );
    expect((series[0] as { yAxisIndex?: number }).yAxisIndex).toBe(0);
    expect((series[1] as { yAxisIndex?: number }).yAxisIndex).toBe(1);
  });

  it('applies the card smoothing before plotting', () => {
    const smoothed = buildSeries(
      context('line', [source('A', [1, 2, 3, 4, 5])], {}, ),
    );
    expect(smoothed).toHaveLength(1);
    // Default smoothing is a window of 1 => the raw values pass through.
    expect((smoothed[0] as { data: Array<[number, number]> }).data.map((d) => d[1])).toEqual([
      1, 2, 3, 4, 5,
    ]);

    const averaged = buildSeries({
      config: {
        ...defaultChartConfig('line', [source('A', [1, 2, 3, 4, 5])]),
      },
      smoothing: { mode: 'movingAverage', window: 3, alpha: 0.5, degree: 2 },
      strings,
    });
    expect((averaged[0] as { data: Array<[number, number]> }).data.map((d) => d[1])).toEqual([
      1.5, 2, 3, 4, 4.5,
    ]);
  });
});

describe('histogram', () => {
  it('bins the column and keeps every sample', () => {
    const series = buildSeries(context('histogram', [source('A', ramp)]));
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('bar');
    const data = (series[0] as { data: Array<[number, number]> }).data;
    // `binCount: 0` means "choose automatically" (Sturges' rule over 100 samples).
    const expected = histogram(ramp);
    expect(data).toHaveLength(expected.bins.length);
    const total = data.reduce((sum, [, count]) => sum + count, 0);
    expect(total).toBe(ramp.length);
  });

  it('honours an explicit bin count', () => {
    const series = buildSeries(context('histogram', [source('A', ramp)], { binCount: 7 }));
    expect((series[0] as { data: unknown[] }).data).toHaveLength(7);
  });

  it('uses only the first column', () => {
    const series = buildSeries(context('histogram', [source('A', ramp), source('B', ramp)]));
    expect(series).toHaveLength(1);
  });
});

describe('boxplot', () => {
  it('emits the five-number summary per column', () => {
    const series = buildSeries(context('boxplot', [source('A', ramp), source('B', noisy)]));
    const box = series.find((entry) => entry.type === 'boxplot') as {
      data: number[][];
    };
    const expectedA = fiveNumberSummary(ramp);
    expect(box.data[0]).toEqual([
      expectedA.min,
      expectedA.q1,
      expectedA.median,
      expectedA.q3,
      expectedA.max,
    ]);
    expect(box.data).toHaveLength(2);
  });

  it('adds an outlier series only when there are outliers', () => {
    const clean = buildSeries(context('boxplot', [source('A', ramp)]));
    expect(clean.some((entry) => entry.type === 'scatter')).toBe(false);

    const withOutlier = buildSeries(
      context('boxplot', [source('A', [...ramp, 100000])]),
    );
    const scatter = withOutlier.find((entry) => entry.type === 'scatter') as {
      data: Array<[number, number]>;
    };
    expect(scatter).toBeDefined();
    expect(scatter.data.some(([, value]) => value === 100000)).toBe(true);
  });
});

describe('violin', () => {
  it('is a custom series with a working renderItem', () => {
    const series = buildSeries(context('violin', [source('A', ramp)]));
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('custom');
    expect(typeof (series[0] as { renderItem?: unknown }).renderItem).toBe('function');
  });

  it('renderItem emits a polygon plus three quartile rules', () => {
    const built = buildSeries(context('violin', [source('A', noisy)]));
    const renderItem = (built[0] as unknown as {
      renderItem: (
        params: unknown,
        api: {
          value: (dim: number) => number;
          coord: (pair: [number, number]) => [number, number];
        },
      ) => { type: string; children: Array<{ type: string; shape: { points?: unknown[] } }> } | undefined;
    }).renderItem;

    // `coord` must return a tuple, not a widened number[].
    const api = {
      value: (_dim: number) => 0,
      coord: (pair: [number, number]): [number, number] => [
        100 + pair[0] * 200,
        400 - pair[1] * 4,
      ],
    };
    const result = renderItem({}, api);
    expect(result).toBeDefined();
    expect(result!.type).toBe('group');

    const polygon = result!.children.find((child) => child.type === 'polygon');
    expect(polygon).toBeDefined();
    // The outline is a closed KDE curve: both mirrored halves.
    expect((polygon!.shape.points ?? []).length).toBeGreaterThan(100);
    const rules = result!.children.filter((child) => child.type === 'line');
    expect(rules).toHaveLength(3); // q1, q3, median
  });
});

describe('errorBar', () => {
  it('draws a custom series plus a scatter for the tooltip', () => {
    const series = buildSeries(context('errorBar', [source('A', noisy), source('B', ramp)]));
    expect(series.map((entry) => entry.type)).toEqual(['scatter', 'custom']);
  });

  it('renderItem emits a stem and two caps', () => {
    const built = buildSeries(context('errorBar', [source('A', noisy)]));
    const custom = built.find((entry) => entry.type === 'custom') as unknown as {
      renderItem: (params: unknown, api: {
        value: (dim: number) => number;
        coord: (pair: [number, number]) => [number, number];
      }) => { children: Array<{ type: string }> } | undefined;
    };
    const api = {
      value: (_dim: number) => 0,
      coord: (pair: [number, number]): [number, number] => [100, 200 - pair[1]],
    };
    const result = custom.renderItem({}, api);
    expect(result).toBeDefined();
    expect(result!.children.filter((child) => child.type === 'line')).toHaveLength(3);
    expect(result!.children.filter((child) => child.type === 'circle')).toHaveLength(1);
  });

  it('guards against a NaN mean (empty column)', () => {
    const built = buildSeries(context('errorBar', [source('A', [])]));
    const custom = built.find((entry) => entry.type === 'custom') as unknown as {
      renderItem: (params: unknown, api: {
        value: (dim: number) => number;
        coord: (pair: [number, number]) => [number, number];
      }) => unknown;
    };
    expect(
      custom.renderItem({}, { value: () => 0, coord: (): [number, number] => [0, 0] }),
    ).toBeUndefined();
  });
});

describe('heatmap', () => {
  it('builds a square correlation matrix with a unit diagonal', () => {
    const series = buildSeries(
      context('heatmap', [source('A', ramp), source('B', wave), source('C', noisy)]),
    );
    const data = (series[0] as { data: Array<[number, number, number]> }).data;
    expect(data).toHaveLength(9);
    const diagonal = data.filter(([x, y]) => x === y);
    expect(diagonal.every(([, , value]) => value === 1)).toBe(true);
  });

  it('reports an undefined correlation as 0 rather than NaN', () => {
    // A constant column produces NaN, which must not leak into the chart data.
    const series = buildSeries(
      context('heatmap', [source('A', [1, 1, 1]), source('B', [1, 2, 3])]),
    );
    const data = (series[0] as { data: Array<[number, number, number]> }).data;
    for (const [, , value] of data) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('buildOption axis selection', () => {
  it('gives per-series types a category x axis', () => {
    for (const type of ['boxplot', 'violin', 'errorBar'] as ChartTypeId[]) {
      const option = buildOption(context(type, [source('A', noisy), source('B', ramp)]));
      const xAxis = option.xAxis as { type: string; data: string[] };
      expect(xAxis.type).toBe('category');
      expect(xAxis.data).toEqual(['A', 'B']);
    }
  });

  it('gives row-indexed types a value x axis', () => {
    for (const type of ['line', 'bar', 'histogram'] as ChartTypeId[]) {
      const option = buildOption(context(type, [source('A', ramp)]));
      expect((option.xAxis as { type: string }).type).toBe('value');
    }
  });

  it('switches to a log value axis when requested', () => {
    const option = buildOption(context('line', [source('A', ramp)], { logScale: true }));
    expect((option.yAxis as { type: string }).type).toBe('log');
  });

  it('keeps bars linear even with the log toggle on', () => {
    // A zero-height bar has no position on a log axis.
    const option = buildOption(context('bar', [source('A', ramp)], { logScale: true }));
    expect((option.yAxis as { type: string }).type).toBe('value');
  });

  it('creates a second y axis only when enabled', () => {
    const single = buildOption(context('line', [source('A', ramp)]));
    expect(Array.isArray(single.yAxis)).toBe(false);

    const dual = buildOption(
      context('line', [source('A', ramp), source('B', ramp)], { secondAxis: true }),
    );
    expect(Array.isArray(dual.yAxis)).toBe(true);
    expect((dual.yAxis as unknown[]).length).toBe(2);
  });

  it('adds a diverging visual map for the heatmap', () => {
    const option = buildOption(
      context('heatmap', [source('A', ramp), source('B', wave)]),
    );
    const visualMap = option.visualMap as Array<{ min: number; max: number }>;
    expect(visualMap[0].min).toBe(-1);
    expect(visualMap[0].max).toBe(1);
    // A correlation heatmap must never offer axis zoom over a categorical grid.
    expect(option.dataZoom).toEqual([]);
  });

  it('keeps the fit-line name out of the legend', () => {
    const option = buildOption(
      context('regression', [source('X', ramp), source('Y', wave)]),
    );
    const legend = option.legend as { data?: string[] };
    const names = legend.data ?? [];
    expect(names.some((name) => name.includes('fit y='))).toBe(false);
    // …but the scatter series itself is still in the legend.
    expect(names).toContain('X → Y');
  });

  it('caps the number of scatter symbols so exported SVGs stay practical', () => {
    const big = Array.from({ length: 40_000 }, (_, i) => Math.sin(i / 50) + i / 100_000);
    const other = Array.from({ length: 40_000 }, (_, i) => Math.cos(i / 50));
    const series = buildSeries(context('regression', [source('X', big), source('Y', other)]));
    const scatter = series.find((entry) => entry.type === 'scatter') as {
      data: unknown[];
    };
    expect(scatter.data.length).toBeLessThanOrEqual(40_000);
    expect(scatter.data.length).toBeLessThan(40_000);
    // The thin pass keeps the first and last samples so the cloud's extent is preserved.
    expect(scatter.data.length).toBeGreaterThan(1_000);
  });

  it('produces a usable option for every declared chart type', () => {
    const ids = Object.keys(CHART_TYPES) as ChartTypeId[];
    for (const id of ids) {
      const option = buildOption(
        context(id, [source('A', ramp), source('B', wave), source('C', noisy)]),
      ) as EChartsOption;
      expect(option.series, `series for ${id}`).toBeDefined();
      expect((option.series as unknown[]).length, `series count for ${id}`).toBeGreaterThan(0);
      expect((option.series as unknown[]).length, `series count for ${id}`).toBeLessThan(12);
    }
  });
});

describe('computeBounds', () => {
  it('spans the value range for a violin (width carries density, not y)', () => {
    const ctx = context('violin', [source('A', ramp), source('B', noisy)]);
    const bounds = computeBounds(ctx);
    // The ribbon is drawn along the value axis, so the range covers the samples.
    expect(bounds.yMin).toBeLessThan(0);
    expect(bounds.yMax).toBeGreaterThan(99);
    // …and it must NOT be pinned to the density peak (a fraction, far below 99).
    const peak = Math.max(
      ...kernelDensity(ramp, 96).map((point) => point.y),
      ...kernelDensity(noisy, 96).map((point) => point.y),
    );
    expect(bounds.yMax).toBeGreaterThan(peak * 10);
  });

  it('covers the whiskers for error bars', () => {
    const ctx = context('errorBar', [source('A', noisy)], { errorKind: 'sd' });
    const bounds = computeBounds(ctx);
    const values = noisy.filter(Number.isFinite);
    const centre = mean(values);
    const spread = errorBarValues(values, 'sd');
    expect(bounds.yMin).toBeLessThan(centre - spread);
    expect(bounds.yMax).toBeGreaterThan(centre + spread);
  });

  it('spans the full data extent for a box plot', () => {
    const bounds = computeBounds(context('boxplot', [source('A', noisy)]));
    expect(bounds.yMin).toBeLessThan(1);
    expect(bounds.yMax).toBeGreaterThan(10);
  });

  it('states no bounds for the types ECharts can scale itself', () => {
    for (const type of ['line', 'bar', 'histogram', 'scatter', 'heatmap'] as ChartTypeId[]) {
      expect(computeBounds(context(type, [source('A', ramp)]))).toEqual({});
    }
  });

  it('drives the plotted axis range in the built option', () => {
    const option = buildOption(context('violin', [source('A', ramp)]));
    const yAxis = option.yAxis as { min?: number; max?: number; scale?: boolean; name?: string };
    expect(yAxis.min).toBeLessThan(0);
    expect(yAxis.max).toBeGreaterThan(99);
    // The y axis carries values, not density: the width encodes density.
    expect(yAxis.name).toBe('Value');
    // With a stated range, `scale` must be off or ECharts could still tighten the axis.
    expect(yAxis.scale).toBe(false);

    const lineAxis = buildOption(context('line', [source('A', ramp)])).yAxis as {
      scale?: boolean;
      min?: number;
    };
    expect(lineAxis.scale).toBe(true);
    expect(lineAxis.min).toBeUndefined();
  });

  it('does not impose a log axis minimum (log has no zero)', () => {
    const option = buildOption(
      context('errorBar', [source('A', noisy)], { logScale: true }),
    );
    const yAxis = option.yAxis as { type: string; min?: number };
    expect(yAxis.type).toBe('log');
    expect(yAxis.min).toBeUndefined();
  });
});
