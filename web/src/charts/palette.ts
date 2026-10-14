/**
 * Deterministic colour ramp for chart series.
 *
 * Kept in its own module (and re-exported by the workspace store) so that both the store
 * and the chart builders can use it without importing each other.
 */

/** Palette entry `index`, cycling a small perceptually-distinct set. */
export function lineColor(index: number): string {
  const palette = PALETTE;
  return palette[((index % palette.length) + palette.length) % palette.length];
}

/**
 * Colour-blind-friendly qualitative set (Okabe–Ito), which is the usual choice for
 * figures that have to survive print and greyscale conversion.
 */
export const PALETTE: readonly string[] = [
  'rgb(0, 114, 178)', // blue
  'rgb(213, 94, 0)', // vermillion
  'rgb(0, 158, 115)', // bluish green
  'rgb(204, 121, 167)', // reddish purple
  'rgb(230, 159, 0)', // orange
  'rgb(86, 180, 233)', // sky blue
  'rgb(240, 228, 66)', // yellow
  'rgb(0, 0, 0)', // black
];

/** Hex fallback for tools that cannot parse `rgb(...)`. */
export function lineColorHex(index: number): string {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(lineColor(index));
  if (!match) return '#000000';
  const hex = (value: string) => Number(value).toString(16).padStart(2, '0');
  return `#${hex(match[1])}${hex(match[2])}${hex(match[3])}`;
}
