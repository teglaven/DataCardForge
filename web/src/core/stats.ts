/**
 * Statistics primitives for the scientific chart types.
 *
 * Pure functions only — no DOM, no ECharts. Keeping them separate means the maths is
 * unit-testable, and the same numbers can later feed the (still pending) element-wise
 * formula engine without dragging a rendering library along.
 *
 * Conventions:
 *   - Inputs are plain arrays of numbers; `NaN` entries are ignored (a column from a
 *     ragged text file legitimately contains them).
 *   - Every function returns finite numbers for empty/degenerate input rather than
 *     throwing, because a chart card must stay renderable while the user switches files.
 */

/** Drop `NaN`/`Infinity` — the rest of this module assumes finite samples. */
export function finite(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

export function mean(values: readonly number[]): number {
  const data = finite(values);
  if (data.length === 0) return NaN;
  let sum = 0;
  for (const value of data) sum += value;
  return sum / data.length;
}

/**
 * Sample variance (Bessel-corrected, denominator n-1) — the estimate a lab report
 * normally wants. Returns 0 for a single sample (no spread can be estimated).
 */
export function variance(values: readonly number[]): number {
  const data = finite(values);
  if (data.length === 0) return NaN;
  if (data.length === 1) return 0;
  const mu = mean(data);
  let sum = 0;
  for (const value of data) {
    const d = value - mu;
    sum += d * d;
  }
  return sum / (data.length - 1);
}

export function stdDev(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}

/** Standard error of the mean, `s / sqrt(n)`. */
export function standardError(values: readonly number[]): number {
  const data = finite(values);
  if (data.length < 2) return 0;
  return stdDev(data) / Math.sqrt(data.length);
}

export function min(values: readonly number[]): number {
  const data = finite(values);
  if (data.length === 0) return NaN;
  let out = Infinity;
  for (const value of data) if (value < out) out = value;
  return out;
}

export function max(values: readonly number[]): number {
  const data = finite(values);
  if (data.length === 0) return NaN;
  let out = -Infinity;
  for (const value of data) if (value > out) out = value;
  return out;
}

/**
 * Quantile via linear interpolation between closest ranks — the same definition as
 * NumPy's default and R's type 7, so values match what a script would produce.
 * `q` is in [0, 1].
 */
export function quantile(sortedOrRaw: readonly number[], q: number): number {
  const data = finite(sortedOrRaw).sort((a, b) => a - b);
  if (data.length === 0) return NaN;
  const clamped = Math.min(1, Math.max(0, q));
  if (data.length === 1) return data[0];

  const position = (data.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return data[lower];
  const fraction = position - lower;
  return data[lower] + (data[upper] - data[lower]) * fraction;
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/** The five-number summary plus mean, i.e. everything a box plot needs. */
export interface FiveNumberSummary {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  /** Interquartile range, `q3 - q1`. */
  iqr: number;
  count: number;
}

export function fiveNumberSummary(values: readonly number[]): FiveNumberSummary {
  const data = finite(values);
  if (data.length === 0) {
    return { min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, mean: NaN, iqr: NaN, count: 0 };
  }
  const sorted = data.slice().sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return {
    min: sorted[0],
    q1,
    median: quantile(sorted, 0.5),
    q3,
    max: sorted[sorted.length - 1],
    mean: mean(sorted),
    iqr: q3 - q1,
    count: data.length,
  };
}

/**
 * Tukey outliers: samples outside `[q1 - k·IQR, q3 + k·IQR]` (default k = 1.5).
 * Returned in the order they appear in the input.
 */
export function outliers(values: readonly number[], k = 1.5): number[] {
  const { q1, q3, iqr } = fiveNumberSummary(values);
  if (!Number.isFinite(q1) || !Number.isFinite(q3)) return [];
  const low = q1 - k * iqr;
  const high = q3 + k * iqr;
  return finite(values).filter((value) => value < low || value > high);
}

export interface HistogramBin {
  /** Inclusive lower edge. */
  x0: number;
  /** Exclusive upper edge (inclusive for the final bin). */
  x1: number;
  /** Bin centre, which is where a bar is anchored. */
  centre: number;
  count: number;
}

export interface Histogram {
  bins: HistogramBin[];
  binWidth: number;
  total: number;
}

/**
 * Bin samples into a histogram.
 *
 * `binCount` is clamped to a sane range; when omitted, Sturges' rule
 * (`ceil(log2(n)) + 1`) is used, which is the usual default for lab data.
 */
export function histogram(values: readonly number[], binCount?: number): Histogram {
  const data = finite(values);
  if (data.length === 0) return { bins: [], binWidth: 0, total: 0 };

  const lo = min(data);
  const hi = max(data);
  const requested = binCount ?? Math.ceil(Math.log2(data.length)) + 1;
  const count = Math.min(200, Math.max(1, Math.floor(requested)));

  // A degenerate range (all samples identical) still needs one bin, not a divide by 0.
  if (hi === lo) {
    return {
      bins: [{ x0: lo - 0.5, x1: hi + 0.5, centre: lo, count: data.length }],
      binWidth: 1,
      total: data.length,
    };
  }

  const binWidth = (hi - lo) / count;
  const bins: HistogramBin[] = Array.from({ length: count }, (_, i) => {
    const x0 = lo + i * binWidth;
    return { x0, x1: x0 + binWidth, centre: x0 + binWidth / 2, count: 0 };
  });

  for (const value of data) {
    // The maximum sample belongs to the last bin, not to a bin that does not exist.
    const index = Math.min(count - 1, Math.floor((value - lo) / binWidth));
    bins[index].count += 1;
  }

  return { bins, binWidth, total: data.length };
}

export interface KdePoint {
  x: number;
  /** Probability density estimate. */
  y: number;
}

/**
 * Gaussian kernel density estimate, the curve a violin plot is drawn from.
 *
 * Bandwidth uses Silverman's rule of thumb (`1.06 · σ · n^(-1/5)`), falling back to a
 * small fraction of the data range when σ is 0 (all samples identical).
 */
export function kernelDensity(
  values: readonly number[],
  samples = 96,
  bandwidth?: number,
): KdePoint[] {
  const data = finite(values);
  if (data.length === 0) return [];

  const lo = min(data);
  const hi = max(data);
  const sigma = stdDev(data);
  const range = hi - lo;

  const h =
    bandwidth ??
    (sigma > 0 ? 1.06 * sigma * Math.pow(data.length, -0.2) : Math.max(range, 1) / 10);
  const safeH = h > 0 ? h : 1;

  // Pad a little so the tails of the curve are visible.
  const pad = range > 0 ? range * 0.06 : safeH;
  const from = lo - pad;
  const to = hi + pad;
  const steps = Math.max(8, Math.floor(samples));

  const points: KdePoint[] = [];
  const factor = 1 / (data.length * safeH * Math.sqrt(2 * Math.PI));
  for (let i = 0; i <= steps; ++i) {
    const x = from + ((to - from) * i) / steps;
    let sum = 0;
    for (const value of data) {
      const z = (x - value) / safeH;
      sum += Math.exp(-0.5 * z * z);
    }
    points.push({ x, y: factor * sum });
  }
  return points;
}

/** How the points of a fitted line are reported. */
export interface RegressionFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination. */
  r2: number;
  /** Pearson correlation coefficient. */
  r: number;
  /** Standard error of the slope. */
  slopeError: number;
  /** Two-sided 95% confidence interval for the slope. */
  slopeCi95: [number, number];
  n: number;
}

/**
 * Ordinary least squares fit of `y = slope·x + intercept`.
 *
 * With `n = 2` the fit is exact and the errors are reported as 0 (a confidence
 * interval is undefined, not infinite).
 */
export function linearRegression(xs: readonly number[], ys: readonly number[]): RegressionFit | null {
  const pairs: Array<[number, number]> = [];
  const length = Math.min(xs.length, ys.length);
  for (let i = 0; i < length; ++i) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  const n = pairs.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  if (sxx === 0) {
    // Vertical data: no slope is defined; report a flat fit through the mean.
    return {
      slope: 0,
      intercept: meanY,
      r2: 0,
      r: 0,
      slopeError: 0,
      slopeCi95: [0, 0],
      n,
    };
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r = syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  const r2 = r * r;

  let slopeError = 0;
  if (n > 2 && syy > 0) {
    const residualSumSquares = syy - slope * sxy;
    const residualVariance = Math.max(0, residualSumSquares) / (n - 2);
    slopeError = Math.sqrt(residualVariance / sxx);
  }

  // t(0.975, n-2) for the common sample sizes; a normal approximation would
  // understate the interval exactly where lab data lives (small n).
  const t = tCritical95(n - 2);
  return {
    slope,
    intercept,
    r2,
    r,
    slopeError,
    slopeCi95: [slope - t * slopeError, slope + t * slopeError],
    n,
  };
}

/**
 * Sample Pearson correlation coefficient.
 *
 * Returns `NaN` when either series has no variance: the correlation is genuinely
 * undefined there, and reporting `0` would claim "uncorrelated" for a constant column.
 * The correlation matrix relies on this distinction.
 */
export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const fit = linearRegression(xs, ys);
  if (!fit) return NaN;

  // A zero slope estimate can also mean "no spread in x"; check the inputs directly so
  // a genuinely uncorrelated pair still reports 0 rather than NaN.
  const xFinite = finite(xs);
  const yFinite = finite(ys);
  if (xFinite.length < 2 || yFinite.length < 2) return NaN;
  if (stdDev(xFinite) === 0 || stdDev(yFinite) === 0) return NaN;

  return fit.r;
}

/**
 * A square correlation matrix over several series.
 * `matrix[i][j]` is the correlation between series i and j; the diagonal is 1 and an
 * undefined correlation (a constant series) is reported as `NaN`.
 */
export function correlationMatrix(series: ReadonlyArray<readonly number[]>): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < series.length; ++i) {
    const row: number[] = [];
    for (let j = 0; j < series.length; ++j) {
      if (i === j) {
        row.push(1);
        continue;
      }
      const value = pearson(series[i], series[j]);
      // Mirror the upper triangle so the matrix stays symmetric even when one side
      // hits a NaN-producing degenerate case.
      row.push(Number.isFinite(value) ? value : NaN);
    }
    out.push(row);
  }
  return out;
}

/** Two-sided 95% Student-t critical values, indexed by degrees of freedom. */
export function tCritical95(df: number): number {
  if (df <= 0) return 12.706;
  if (df === 1) return 12.706;
  if (df === 2) return 4.303;
  if (df === 3) return 3.182;
  if (df === 4) return 2.776;
  if (df === 5) return 2.571;
  if (df === 6) return 2.447;
  if (df === 7) return 2.365;
  if (df === 8) return 2.306;
  if (df === 9) return 2.262;
  if (df === 10) return 2.228;
  if (df === 12) return 2.179;
  if (df === 15) return 2.131;
  if (df === 20) return 2.086;
  if (df === 30) return 2.042;
  if (df === 60) return 2.0;
  if (df === 120) return 1.98;
  return 1.96;
}

/**
 * Deterministically thin a series to at most `limit` points, always keeping the first
 * and last sample. Used for scatter/regression so a 10⁵-point column stays interactive
 * without hiding the overall shape.
 */
export function subsample<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit || limit < 2) return values.slice();
  const out: T[] = [];
  const step = (values.length - 1) / (limit - 1);
  for (let i = 0; i < limit; ++i) {
    out.push(values[Math.round(i * step)]);
  }
  return out;
}

/** Sample standard deviation of the mean estimate, shaped for an error-bar series. */
export function errorBarValues(
  values: readonly number[],
  kind: 'sd' | 'se' | 'ci95',
): number {
  const data = finite(values);
  if (data.length === 0) return NaN;
  switch (kind) {
    case 'sd':
      return stdDev(data);
    case 'se':
      return standardError(data);
    case 'ci95':
      return tCritical95(data.length - 1) * standardError(data);
    default:
      return 0;
  }
}
