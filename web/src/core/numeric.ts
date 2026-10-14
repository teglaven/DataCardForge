/**
 * Numeric parsing helpers — a lightweight stand-in for `fast_float`.
 *
 * JavaScript's `Number()` accepts a handful of literals that C++'s `from_chars`
 * rejects (`Infinity`, `0x10`, `1e`), so `parseNumeric` narrows the grammar to the
 * shapes a measurement file actually produces: optional sign, decimal digits,
 * optional fraction, optional exponent.
 */

const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** True when the token is a plain decimal number (C++ `is_numeric` semantics). */
export function isNumeric(token: string): boolean {
  return NUMERIC_RE.test(token);
}

/** Parse a token, returning `fallback` when it is not a plain decimal number. */
export function parseNumeric(token: string, fallback = NaN): number {
  if (!NUMERIC_RE.test(token)) return fallback;
  return Number(token);
}

/** Format a value for display the way the Qt model did (`'g'` with 6 digits). */
export function formatCell(value: number): string {
  if (Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  if (value === 0) return '0';
  // `toPrecision(6)` then trim is the closest match to printf("%.6g").
  const abs = Math.abs(value);
  if (abs >= 1e-4 && abs < 1e6) {
    // Fixed notation would add trailing zeros; `toPrecision` normalises them away.
    return trimNumber(value.toPrecision(6));
  }
  // Exponent form: JS writes `1e-7`, C writes `1e-07`.
  return trimNumber(value.toExponential(5)).replace(/e([+-])(\d)$/, 'e$10$2');
}

function trimNumber(text: string): string {
  if (!text.includes('.')) return text;
  let out = text;
  if (out.includes('e') || out.includes('E')) {
    const [mantissa, exponent] = out.split(/[eE]/);
    const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa;
    return `${trimmed}e${exponent}`;
  }
  if (out.includes('.')) out = out.replace(/\.?0+$/, '');
  return out;
}
