/**
 * Statistics primitives.
 *
 * The expected values follow NumPy/R conventions (linear-interpolation quantiles,
 * Bessel-corrected variance) so the numbers shown in the UI match what a script would
 * print for the same column.
 */
import { describe, expect, it } from 'vitest';

import {
  correlationMatrix,
  errorBarValues,
  fiveNumberSummary,
  histogram,
  kernelDensity,
  linearRegression,
  mean,
  median,
  outliers,
  pearson,
  quantile,
  stdDev,
  subsample,
  tCritical95,
  variance,
  finite,
} from '../src/core/stats.ts';

describe('finite', () => {
  it('drops NaN and infinities', () => {
    expect(finite([1, NaN, 2, Infinity, -Infinity, 3])).toEqual([1, 2, 3]);
  });
});

describe('mean / variance / stdDev', () => {
  it('computes the arithmetic mean', () => {
    expect(mean([1, 2, 3, 4])).toBeCloseTo(2.5, 12);
  });

  it('ignores NaN samples', () => {
    expect(mean([1, NaN, 3])).toBeCloseTo(2, 12);
  });

  it('returns NaN for no usable samples', () => {
    expect(mean([])).toBeNaN();
    expect(variance([NaN])).toBeNaN();
  });

  it('uses the Bessel-corrected sample variance', () => {
    // sum of squared deviations = 10, n - 1 = 3  =>  3.333...
    expect(variance([1, 2, 3, 4, 5])).toBeCloseTo(2.5, 12);
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(4.571428571, 8);
  });

  it('reports zero spread for a single sample', () => {
    expect(variance([7])).toBe(0);
    expect(stdDev([7])).toBe(0);
  });

  it('takes the square root for stdDev', () => {
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935, 8);
  });
});

describe('quantile', () => {
  it('matches NumPy linear interpolation for quarter quantiles', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // (n-1)*q = 9*0.25 = 2.25 -> 3 + 0.25*(4-3) = 3.25
    expect(quantile(data, 0.25)).toBeCloseTo(3.25, 12);
    expect(quantile(data, 0.5)).toBeCloseTo(5.5, 12);
    // 9*0.75 = 6.75 -> 7 + 0.75*(8-7) = 7.75
    expect(quantile(data, 0.75)).toBeCloseTo(7.75, 12);
  });

  it('is invariant to input order', () => {
    expect(quantile([5, 1, 3, 2, 4], 0.25)).toBeCloseTo(quantile([1, 2, 3, 4, 5], 0.25), 12);
  });

  it('clamps q outside [0,1] and handles the extremes', () => {
    expect(quantile([1, 2, 3], 0)).toBe(1);
    expect(quantile([1, 2, 3], 1)).toBe(3);
    expect(quantile([1, 2, 3], -5)).toBe(1);
    expect(quantile([1, 2, 3], 5)).toBe(3);
  });

  it('returns the single value for a one-element sample', () => {
    expect(quantile([42], 0.3)).toBe(42);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it('median agrees with quantile at 0.5', () => {
    expect(median([9, 1, 5, 3, 7])).toBe(5);
  });
});

describe('fiveNumberSummary / outliers', () => {
  it('summarises a simple sample', () => {
    const summary = fiveNumberSummary([1, 2, 3, 4, 5]);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(5);
    expect(summary.median).toBe(3);
    expect(summary.mean).toBe(3);
    expect(summary.count).toBe(5);
    expect(summary.iqr).toBeCloseTo(2, 12);
  });

  it('flags a Tukey outlier', () => {
    // IQR of [1,2,3,4,5] is 2, so the fences are -2 and 8: 1000 is an outlier.
    expect(outliers([1, 2, 3, 4, 5, 1000])).toEqual([1000]);
  });

  it('flags nothing when the data is tight', () => {
    expect(outliers([1, 2, 3, 4, 5])).toEqual([]);
  });

  it('returns an inert summary for empty input', () => {
    const summary = fiveNumberSummary([]);
    expect(summary.count).toBe(0);
    expect(summary.median).toBeNaN();
    expect(outliers([])).toEqual([]);
  });
});

describe('histogram', () => {
  it('counts every sample exactly once', () => {
    const values = Array.from({ length: 100 }, (_, i) => i / 10);
    const result = histogram(values, 10);
    expect(result.bins).toHaveLength(10);
    expect(result.total).toBe(100);
    expect(result.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(100);
  });

  it('includes the maximum sample in the last bin', () => {
    // The right edge is exclusive for every bin except the last.
    const result = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(result.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(11);
    expect(result.bins[result.bins.length - 1].count).toBeGreaterThan(0);
  });

  it('keeps bin edges contiguous', () => {
    const result = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    for (let i = 1; i < result.bins.length; ++i) {
      expect(result.bins[i].x0).toBeCloseTo(result.bins[i - 1].x1, 12);
    }
  });

  it('puts identical samples in a single bin instead of dividing by zero', () => {
    const result = histogram([5, 5, 5, 5], 10);
    expect(result.bins).toHaveLength(1);
    expect(result.bins[0].count).toBe(4);
    expect(result.binWidth).toBe(1);
  });

  it('uses Sturges rule when no bin count is given', () => {
    const values = Array.from({ length: 64 }, (_, i) => i);
    const result = histogram(values);
    expect(result.bins).toHaveLength(Math.ceil(Math.log2(64)) + 1); // 7
  });

  it('returns nothing for empty input', () => {
    const result = histogram([]);
    expect(result.bins).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe('kernelDensity', () => {
  it('produces a normalised-looking curve over the data range', () => {
    const values = Array.from({ length: 200 }, (_, i) => i / 200);
    const curve = kernelDensity(values, 48);
    expect(curve.length).toBe(49);
    // Symmetric uniform input -> symmetric curve ends.
    expect(curve[0].y).toBeCloseTo(curve[curve.length - 1].y, 6);
    // The density integrates to roughly 1 over the range.
    let area = 0;
    for (let i = 1; i < curve.length; ++i) {
      area += ((curve[i].y + curve[i - 1].y) / 2) * (curve[i].x - curve[i - 1].x);
    }
    expect(area).toBeGreaterThan(0.8);
    expect(area).toBeLessThan(1.3);
  });

  it('peaks at the centre of a symmetric sample', () => {
    const curve = kernelDensity([1, 1, 1, 1, 1, 1, 5], 64);
    const peak = curve.reduce((best, point) => (point.y > best.y ? point : best));
    expect(peak.x).toBeCloseTo(1, 1);
  });

  it('handles a constant sample with a finite bandwidth', () => {
    const curve = kernelDensity([3, 3, 3, 3], 16);
    expect(curve.length).toBe(17);
    for (const point of curve) expect(Number.isFinite(point.y)).toBe(true);
  });

  it('returns nothing for empty input', () => {
    expect(kernelDensity([], 16)).toEqual([]);
  });
});

describe('linearRegression', () => {
  it('recovers an exact line', () => {
    const fit = linearRegression([1, 2, 3, 4], [3, 5, 7, 9]);
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(2, 10);
    expect(fit!.intercept).toBeCloseTo(1, 10);
    expect(fit!.r2).toBeCloseTo(1, 10);
    expect(fit!.n).toBe(4);
  });

  it('reports r with the sign of the correlation', () => {
    const positive = linearRegression([1, 2, 3], [1, 2, 3])!;
    const negative = linearRegression([1, 2, 3], [3, 2, 1])!;
    expect(positive.r).toBeCloseTo(1, 10);
    expect(negative.r).toBeCloseTo(-1, 10);
  });

  it('produces a finite confidence interval for the slope', () => {
    const fit = linearRegression([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])!;
    expect(fit.slopeCi95[0]).toBeLessThan(fit.slope);
    expect(fit.slopeCi95[1]).toBeGreaterThan(fit.slope);
    expect(Number.isFinite(fit.slopeError)).toBe(true);
  });

  it('reports the t-based interval, widening as n shrinks', () => {
    const few = linearRegression([1, 2, 3], [1, 3, 2])!;
    const many = linearRegression(
      Array.from({ length: 30 }, (_, i) => i),
      Array.from({ length: 30 }, (_, i) => i + (i % 3)),
    )!;
    const fewWidth = few.slopeCi95[1] - few.slopeCi95[0];
    const manyWidth = many.slopeCi95[1] - many.slopeCi95[0];
    expect(fewWidth).toBeGreaterThan(manyWidth);
  });

  it('drops non-finite pairs', () => {
    const fit = linearRegression([1, NaN, 3], [2, 5, 6])!;
    expect(fit.n).toBe(2);
  });

  it('returns null when there are fewer than two usable points', () => {
    expect(linearRegression([1], [2])).toBeNull();
    expect(linearRegression([], [])).toBeNull();
    expect(linearRegression([1, NaN], [2, 3])).toBeNull();
  });

  it('handles vertical data without dividing by zero', () => {
    const fit = linearRegression([2, 2, 2], [1, 5, 9])!;
    expect(fit.slope).toBe(0);
    expect(Number.isFinite(fit.intercept)).toBe(true);
  });
});

describe('pearson / correlationMatrix', () => {
  it('gives 1 on the diagonal and is symmetric', () => {
    const series = [
      [1, 2, 3, 4],
      [2, 4, 6, 8],
      [4, 3, 2, 1],
    ];
    const matrix = correlationMatrix(series);
    expect(matrix[0][0]).toBe(1);
    expect(matrix[1][1]).toBe(1);
    expect(matrix[0][1]).toBeCloseTo(1, 10);
    expect(matrix[0][2]).toBeCloseTo(-1, 10);
    expect(matrix[0][2]).toBeCloseTo(matrix[2][0], 12);
  });

  it('returns NaN for a series with no variance', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNaN();
  });
});

describe('subsample', () => {
  it('keeps the endpoints and respects the limit', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const kept = subsample(values, 100);
    expect(kept).toHaveLength(100);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(999);
  });

  it('is a no-op when under the limit', () => {
    expect(subsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});

describe('errorBarValues / tCritical95', () => {
  it('relates SD, SE and CI as expected', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const sd = errorBarValues(values, 'sd');
    const se = errorBarValues(values, 'se');
    const ci = errorBarValues(values, 'ci95');
    expect(sd).toBeCloseTo(stdDev(values), 12);
    expect(se).toBeCloseTo(sd / Math.sqrt(values.length), 12);
    expect(ci).toBeCloseTo(tCritical95(values.length - 1) * se, 12);
    expect(ci).toBeGreaterThan(se);
  });

  it('returns 0 spread for a single sample', () => {
    expect(errorBarValues([5], 'sd')).toBe(0);
    expect(errorBarValues([5], 'se')).toBe(0);
    expect(errorBarValues([], 'sd')).toBeNaN();
  });

  it('approaches the normal quantile for large df', () => {
    expect(tCritical95(1000)).toBeCloseTo(1.96, 2);
    expect(tCritical95(1)).toBeGreaterThan(12);
  });
});
