/**
 * Smoothing algorithms — TypeScript port of `src/core/algorithm/Smoothing.cpp`.
 *
 * Semantics (edge handling, validation, complexity) are kept identical to the C++
 * implementation so that charts produced by either frontend agree numerically.
 */

/** Moving average (boxcar filter). `window <= 1` returns a copy. O(n). */
export function movingAverage(raw: readonly number[], window: number): number[] {
  if (window <= 1) return raw.slice();

  const n = raw.length;
  if (n === 0) return [];

  const out = new Array<number>(n);
  const half = Math.floor(window / 2);

  for (let j = 0; j < n; ++j) {
    const lo = j < half ? 0 : j - half;
    const hi = Math.min(j + half + 1, n);
    let sum = 0;
    for (let k = lo; k < hi; ++k) sum += raw[k];
    out[j] = sum / (hi - lo);
  }

  return out;
}

/**
 * Exponential moving average. `alpha` in (0, 1]; smaller alpha = more smoothing.
 * The first element seeds the filter. O(n).
 */
export function exponentialMovingAverage(raw: readonly number[], alpha: number): number[] {
  const n = raw.length;
  if (n === 0) return [];

  const out = new Array<number>(n);
  out[0] = raw[0];
  for (let i = 1; i < n; ++i) {
    out[i] = alpha * raw[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

/**
 * Median filter with mirrored edges. Even windows are bumped to the next odd value.
 * O(n·w).
 */
export function medianFilter(raw: readonly number[], window: number): number[] {
  const n = raw.length;
  if (n === 0 || window < 1) return raw.slice();

  let w = window;
  if (w % 2 === 0) w += 1;

  const half = Math.floor(w / 2);
  const out = new Array<number>(n);
  const buf = new Array<number>(w);

  for (let i = 0; i < n; ++i) {
    let k = 0;
    for (let j = i - half; j <= i + half; ++j) {
      let idx = j;
      if (idx < 0) idx = -idx; // mirror left edge
      else if (idx >= n) idx = 2 * n - idx - 2; // mirror right edge
      if (idx < 0) idx = 0;
      if (idx >= n) idx = n - 1;
      buf[k++] = raw[idx];
    }
    const slice = buf.slice(0, k).sort((a, b) => a - b);
    out[i] = slice[Math.floor(k / 2)];
  }

  return out;
}

/**
 * Savitzky–Golay polynomial smoothing (zero-phase). Even windows are bumped to the
 * next odd value; invalid parameters return a copy. O(n · window) after coefficients.
 */
export function savitzkyGolay(raw: readonly number[], window: number, degree: number): number[] {
  if (window < 3 || degree < 1 || degree >= window) return raw.slice();

  let w = window;
  if (w % 2 === 0) w += 1; // ensure odd

  const n = raw.length;
  if (n === 0) return [];

  const coeffs = sgCoefficients(w, degree);
  const half = Math.floor(w / 2);

  const out = new Array<number>(n);
  for (let i = 0; i < n; ++i) {
    let sum = 0;
    for (let k = 0; k < w; ++k) {
      let idx = i - half + k;
      if (idx < 0) idx = -idx;
      else if (idx >= n) idx = 2 * n - idx - 2;
      if (idx < 0) idx = 0;
      if (idx >= n) idx = n - 1;
      sum += coeffs[k] * raw[idx];
    }
    out[i] = sum;
  }

  return out;
}

/**
 * Centre row of `(AᵀA)⁻¹Aᵀ` for a Vandermonde basis over symmetric window positions,
 * i.e. the Savitzky–Golay convolution kernel.
 */
export function sgCoefficients(window: number, degree: number): number[] {
  const half = Math.floor(window / 2);
  const rows = window;
  const cols = degree + 1;

  // AᵀA[j][k] = Σ xᵢ^(j+k)
  const ata: number[][] = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  for (let c = 0; c < cols; ++c) {
    for (let r = 0; r < cols; ++r) {
      let sum = 0;
      for (let i = 0; i < rows; ++i) {
        const x = i - half;
        const xc = c === 0 ? 1 : Math.pow(x, c);
        const xr = r === 0 ? 1 : Math.pow(x, r);
        sum += xc * xr;
      }
      ata[c][r] = sum;
    }
  }

  // Gauss–Jordan inversion on the augmented [ata | I] matrix.
  const inv: number[][] = ata.map((row, i) => [
    ...row,
    ...Array.from({ length: cols }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let i = 0; i < cols; ++i) {
    let pivot = i;
    for (let r = i + 1; r < cols; ++r) {
      if (Math.abs(inv[r][i]) > Math.abs(inv[pivot][i])) pivot = r;
    }
    if (pivot !== i) {
      const tmp = inv[i];
      inv[i] = inv[pivot];
      inv[pivot] = tmp;
    }

    const div = inv[i][i];
    for (let c = 0; c < 2 * cols; ++c) inv[i][c] /= div;

    for (let r = 0; r < cols; ++r) {
      if (r === i) continue;
      const factor = inv[r][i];
      for (let c = 0; c < 2 * cols; ++c) inv[r][c] -= factor * inv[i][c];
    }
  }

  const coeffs = new Array<number>(rows);
  for (let i = 0; i < rows; ++i) {
    let c = 0;
    const x = i - half;
    for (let j = 0; j < cols; ++j) {
      const xj = j === 0 ? 1 : Math.pow(x, j);
      c += inv[0][cols + j] * xj;
    }
    coeffs[i] = c;
  }

  return coeffs;
}

/** The smoothing modes offered by the UI. */
export type SmoothingMode = 'none' | 'movingAverage' | 'exponential' | 'median' | 'savitzkyGolay';

export interface SmoothingOptions {
  mode: SmoothingMode;
  /** Window size for movingAverage / median / savitzkyGolay. */
  window: number;
  /** Alpha for exponential smoothing. */
  alpha: number;
  /** Polynomial degree for savitzkyGolay. */
  degree: number;
}

export const DEFAULT_SMOOTHING: SmoothingOptions = {
  mode: 'movingAverage',
  window: 1,
  alpha: 0.3,
  degree: 2,
};

/** Apply the selected smoothing mode to a column. */
export function applySmoothing(raw: readonly number[], opts: SmoothingOptions): number[] {
  switch (opts.mode) {
    case 'none':
      return raw.slice();
    case 'movingAverage':
      return movingAverage(raw, opts.window);
    case 'exponential':
      return exponentialMovingAverage(raw, opts.alpha);
    case 'median':
      return medianFilter(raw, opts.window);
    case 'savitzkyGolay':
      return savitzkyGolay(raw, opts.window, opts.degree);
    default:
      return raw.slice();
  }
}
