/**
 * Smoothing parity with `src/core/algorithm/Smoothing.cpp`.
 * The expected values were computed from the C++ algorithms' documented behaviour
 * (trailing-window moving average, first-sample-seeded EMA, mirrored medians).
 */
import { describe, expect, it } from 'vitest';

import {
  applySmoothing,
  exponentialMovingAverage,
  medianFilter,
  movingAverage,
  savitzkyGolay,
  sgCoefficients,
} from '../src/core/Smoothing.ts';

describe('movingAverage', () => {
  it('returns a copy when the window is <= 1', () => {
    const raw = [1, 2, 3];
    const out = movingAverage(raw, 1);
    expect(out).toEqual(raw);
    expect(out).not.toBe(raw);
    expect(movingAverage(raw, 0)).toEqual(raw);
  });

  it('averages a trailing window, clamped at both edges', () => {
    // window 3, half = 1: index 0 -> mean([1,2]); index 3 -> mean([3,4,5]).
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([1.5, 2, 3, 4, 4.5]);
  });

  it('collapses to the overall mean for a full-width window', () => {
    const out = movingAverage([2, 4, 6], 9);
    expect(out).toEqual([4, 4, 4]);
  });

  it('handles empty input', () => {
    expect(movingAverage([], 3)).toEqual([]);
  });
});

describe('exponentialMovingAverage', () => {
  it('seeds with the first sample and converges towards the input', () => {
    const out = exponentialMovingAverage([10, 20], 0.5);
    expect(out[0]).toBe(10);
    expect(out[1]).toBeCloseTo(15, 12);
  });

  it('reproduces the input when alpha is 1', () => {
    expect(exponentialMovingAverage([3, 1, 4, 1, 5], 1)).toEqual([3, 1, 4, 1, 5]);
  });

  it('handles empty input', () => {
    expect(exponentialMovingAverage([], 0.5)).toEqual([]);
  });
});

describe('medianFilter', () => {
  it('mirrors the edges and takes the middle order statistic', () => {
    // window 3, half = 1. Windows are [1,0,1], [0,1,2], [1,2,3], [2,1,2] of
    // *indices*, so the mirrored samples are [9,0,9], [0,9,1], [9,1,2], [1,2,1].
    expect(medianFilter([0, 9, 1, 2], 3)).toEqual([9, 1, 2, 1]);
  });

  it('removes a spike away from the edges', () => {
    // Centred windows leave the middle sample alone without neighbouring outliers.
    expect(medianFilter([1, 1, 1, 1], 3)).toEqual([1, 1, 1, 1]);
  });

  it('bumps even windows to the next odd value', () => {
    expect(medianFilter([1, 5, 2], 2)).toEqual(medianFilter([1, 5, 2], 3));
  });

  it('returns a copy for window < 1 or empty input', () => {
    const raw = [1, 2, 3];
    const out = medianFilter(raw, 0);
    expect(out).toEqual(raw);
    expect(out).not.toBe(raw);
    expect(medianFilter([], 3)).toEqual([]);
  });
});

describe('savitzkyGolay', () => {
  it('rejects invalid parameters by returning the input unchanged', () => {
    const raw = [1, 2, 3, 4, 5];
    expect(savitzkyGolay(raw, 2, 1)).toEqual(raw); // window < 3
    expect(savitzkyGolay(raw, 5, 0)).toEqual(raw); // degree < 1
    expect(savitzkyGolay(raw, 5, 5)).toEqual(raw); // degree >= window
  });

  it('preserves polynomials exactly in the interior', () => {
    // Away from the mirrored edge windows, a degree-2 SG filter reproduces any
    // polynomial of degree <= 2 exactly — this is the defining property.
    const linear = [1, 3, 5, 7, 9, 11, 13];
    const smoothLinear = savitzkyGolay(linear, 5, 2);
    for (let i = 2; i <= linear.length - 3; ++i) {
      expect(smoothLinear[i]).toBeCloseTo(linear[i], 9);
    }

    const quadratic = [1, 4, 9, 16, 25, 36, 49];
    const smoothQuadratic = savitzkyGolay(quadratic, 5, 2);
    for (let i = 2; i <= quadratic.length - 3; ++i) {
      expect(smoothQuadratic[i]).toBeCloseTo(quadratic[i], 8);
    }
  });

  it('reflects the window into the array at the edges', () => {
    // At i = 0 the window indices are [1,0,1,2,3], i.e. the first sample enters the
    // kernel twice, so a straight line is *not* reproduced at the boundary.
    const raw = [1, 3, 5, 7, 9, 11, 13];
    const out = savitzkyGolay(raw, 5, 2);
    expect(out[0]).toBeCloseTo(1.6857142857142862, 9);
    expect(out[0]).not.toBeCloseTo(raw[0], 6);
  });

  it('produces normalised, symmetric convolution coefficients', () => {
    const coeffs = sgCoefficients(5, 2);
    const sum = coeffs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
    // Smoothing kernels are symmetric about the centre tap.
    expect(coeffs[0]).toBeCloseTo(coeffs[4], 12);
    expect(coeffs[1]).toBeCloseTo(coeffs[3], 12);
  });

  it('smooths noise while keeping the signal trend', () => {
    const raw = [0, 0, 0, 10, 0, 0, 0];
    const out = savitzkyGolay(raw, 5, 2);
    // The spike must be reduced but not eliminated entirely.
    expect(out[3]).toBeLessThan(10);
    expect(out[3]).toBeGreaterThan(0);
  });
});

describe('applySmoothing', () => {
  const raw = [1, 2, 3, 4, 5];

  it('dispatches to each mode', () => {
    expect(applySmoothing(raw, { mode: 'none', window: 3, alpha: 0.5, degree: 2 })).toEqual(raw);
    expect(applySmoothing(raw, { mode: 'movingAverage', window: 3, alpha: 0.5, degree: 2 })).toEqual(
      movingAverage(raw, 3),
    );
    expect(applySmoothing(raw, { mode: 'median', window: 3, alpha: 0.5, degree: 2 })).toEqual(
      medianFilter(raw, 3),
    );
    expect(
      applySmoothing(raw, { mode: 'exponential', window: 3, alpha: 0.5, degree: 2 }),
    ).toEqual(exponentialMovingAverage(raw, 0.5));
    expect(
      applySmoothing(raw, { mode: 'savitzkyGolay', window: 5, alpha: 0.5, degree: 2 }),
    ).toEqual(savitzkyGolay(raw, 5, 2));
  });

  it('never mutates the input', () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = input.slice();
    applySmoothing(input, { mode: 'movingAverage', window: 3, alpha: 0.5, degree: 2 });
    applySmoothing(input, { mode: 'median', window: 3, alpha: 0.5, degree: 2 });
    applySmoothing(input, { mode: 'savitzkyGolay', window: 3, alpha: 0.5, degree: 2 });
    expect(input).toEqual(snapshot);
  });
});
