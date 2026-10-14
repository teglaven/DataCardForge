/**
 * Chart export pipeline.
 *
 * Three formats with deliberately different guarantees:
 *
 *  - **SVG** — true vector. The chart is created with ECharts' SVG renderer, so the
 *    live `<svg>` element already *is* the vector drawing. We clone it, inline the
 *    computed styles for the few attributes ECharts sets via CSS class, and serialise.
 *    Nothing is rasterised; curves stay curves and labels stay text.
 *  - **PNG** — raster at a configurable pixel ratio (2× for slides, 4× for print).
 *  - **PDF** — a one-page wrapper around a high-resolution raster (see `pdf.ts` for why
 *    it is not a vector PDF, and how that is reported in the UI).
 *
 * All three end in a browser download so the file lands in the user's downloads folder.
 */
import type { ECharts } from 'echarts';

import { pngToPdf } from './pdf.ts';
import { downloadBlob } from '../ui/fileActions.ts';

export type ExportType = 'svg' | 'png' | 'pdf';

export interface ExportOptions {
  /** File name without extension. */
  name: string;
  /** Pixel multiplier for raster formats. */
  pixelRatio?: number;
  /** Page/paper background; `null` keeps transparency (SVG/PNG only). */
  background?: string | null;
}

/** Attributes ECharts sets through CSS rather than SVG presentation attributes. */
const PRESENTATION_PROPS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'shape-rendering',
  'paint-order',
] as const;

/**
 * Produce a standalone SVG document string for an SVG-rendered chart.
 *
 * The live element is cloned rather than serialised in place so the on-screen chart is
 * untouched, and computed styles are folded in so the file renders correctly outside the
 * browser (where the app's stylesheet is absent).
 */
export function chartToSvgString(container: HTMLElement, background?: string | null): string {
  const source = container.querySelector('svg');
  if (!source) {
    throw new Error('The chart was not rendered with the SVG renderer; no vector output available.');
  }

  const clone = source.cloneNode(true) as SVGSVGElement;
  inlinePresentationStyles(source, clone);

  const width = Math.ceil(source.clientWidth || source.getBoundingClientRect().width || 800);
  const height = Math.ceil(source.clientHeight || source.getBoundingClientRect().height || 600);

  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('version', '1.1');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.removeAttribute('style');

  // A background rect keeps the exported figure readable in dark-themed viewers.
  if (background) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', '100%');
    rect.setAttribute('fill', background);
    clone.insertBefore(rect, clone.firstChild);
  }

  const serialised = new XMLSerializer().serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${serialised}\n`;
}

/** Copy computed presentation values from the live tree onto the clone. */
function inlinePresentationStyles(source: Element, clone: Element): void {
  const sourceNodes = [source, ...Array.from(source.querySelectorAll('*'))];
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll('*'))];

  for (let i = 0; i < sourceNodes.length; ++i) {
    const computed = window.getComputedStyle(sourceNodes[i]);
    const target = cloneNodes[i] as SVGElement;
    for (const property of PRESENTATION_PROPS) {
      const value = computed.getPropertyValue(property);
      if (value && value !== 'normal' && value !== 'auto' && value !== 'none') {
        // Skip the initial `fill: black` that every element reports, otherwise a
        // coloured series would be flattened to black.
        if (property === 'fill' && value === 'rgb(0, 0, 0)' && target.getAttribute('fill')) continue;
        if (property === 'fill' && value === 'rgb(0, 0, 0)' && !target.getAttribute('fill')) {
          // Only meaningful for shapes that actually paint something.
          const tag = target.tagName.toLowerCase();
          if (tag === 'g' || tag === 'svg' || tag === 'defs') continue;
        }
        target.style.setProperty(property, value);
      }
    }
  }
}

/** Rasterise the SVG document through an `<img>` + canvas, returning a PNG blob. */
async function svgStringToPngBlob(
  svg: string,
  width: number,
  height: number,
  pixelRatio: number,
  background: string | null,
): Promise<Blob> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = Math.max(1, Math.round(height * pixelRatio));

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not acquire a 2D canvas context for export.');
  context.scale(pixelRatio, pixelRatio);
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas failed to produce a PNG.'));
    }, 'image/png');
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not rasterise the SVG for export.'));
    image.src = url;
  });
}

export interface ExportResult {
  type: ExportType;
  fileName: string;
  bytes: number;
  /** True when the produced file contains resolution-independent geometry. */
  vector: boolean;
}

/**
 * Export the chart in `container` and trigger a download.
 * Returns a small report so tests (and the status bar) can confirm what happened.
 */
export async function exportChart(
  container: HTMLElement,
  type: ExportType,
  options: ExportOptions,
): Promise<ExportResult> {
  const pixelRatio = options.pixelRatio ?? 2;
  const background = options.background === undefined ? '#ffffff' : options.background;

  const svgElement = container.querySelector('svg');
  const width = Math.ceil(svgElement?.clientWidth || container.clientWidth || 800);
  const height = Math.ceil(svgElement?.clientHeight || container.clientHeight || 600);

  if (type === 'svg') {
    const svg = chartToSvgString(container, background);
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const fileName = `${options.name}.svg`;
    downloadBlob(fileName, blob);
    return { type, fileName, bytes: blob.size, vector: true };
  }

  const svg = chartToSvgString(container, background);
  const pngBlob = await svgStringToPngBlob(svg, width, height, pixelRatio, background);

  if (type === 'png') {
    const fileName = `${options.name}.png`;
    downloadBlob(fileName, pngBlob);
    return { type, fileName, bytes: pngBlob.size, vector: false };
  }

  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const pdfBytes = await pngToPdf(pngBytes, { title: options.name });
  const pdfBlob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
  const fileName = `${options.name}.pdf`;
  downloadBlob(fileName, pdfBlob);
  return { type, fileName, bytes: pdfBlob.size, vector: false };
}

/**
 * Fallback raster path using ECharts' own exporter, used only when the container has no
 * live `<svg>` (i.e. a canvas-rendered chart), so a canvas chart can still export.
 */
export function echartsRasterDataUrl(
  chart: ECharts,
  pixelRatio: number,
  background: string,
): string {
  return chart.getDataURL({ type: 'png', pixelRatio, backgroundColor: background });
}
