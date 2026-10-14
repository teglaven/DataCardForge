/**
 * Minimal PDF writer — just enough to place one image on a page.
 *
 * Why hand-write it: the app must be able to save a chart as a file the user can drop
 * into a report, and adding a PDF library (~500 KB for jsPDF + svg2pdf) for a single
 * "page with a picture" use case is poor value. The PDF format makes this genuinely
 * small — an image is one stream object, and the page/catalog tree is a handful of
 * dictionaries.
 *
 * Scope, stated honestly:
 *   - **Not** a vector PDF. The chart is rasterised at high resolution and embedded,
 *     because converting arbitrary SVG path/text geometry to PDF operators is a large
 *     project with its own fidelity problems. SVG remains the true vector output.
 *   - No fonts, no text objects, no compression beyond what the raster already has.
 */

export interface PdfImageOptions {
  /** Page width in PDF points (1 pt = 1/72 in). Defaults to A4 landscape width. */
  pageWidth?: number;
  pageHeight?: number;
  /** Margin in points around the image. */
  margin?: number;
  /** Document title metadata. */
  title?: string;
}

/** A PNG that has already been decoded into its raw pieces. */
interface DecodedPng {
  width: number;
  height: number;
  /** Raw concatenated IDAT payload (still zlib-compressed). */
  idat: Uint8Array;
  /** Raw RGB samples when the PNG was colour type 2. */
  rgb?: Uint8Array;
  /** Raw RGBA samples when the PNG was colour type 6. */
  rgba?: Uint8Array;
}

/**
 * Split a PNG byte stream into the pieces we need.
 * Supports 8-bit truecolour (colour type 2) and truecolour+alpha (type 6), which is
 * what `canvas.toBlob('image/png')` produces.
 */
function decodePng(bytes: Uint8Array): DecodedPng {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; ++i) {
    if (bytes[i] !== signature[i]) throw new Error('Not a PNG file.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idatParts: Uint8Array[] = [];

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const dataStart = offset + 8;

    if (type === 'IHDR') {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colourType = bytes[dataStart + 9];
      if (bytes[dataStart + 12] !== 0) throw new Error('Interlaced PNG is not supported.');
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }

    offset = dataStart + length + 4; // skip data + CRC
  }

  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${bitDepth}. Expected 8.`);
  }
  if (colourType !== 2 && colourType !== 6) {
    throw new Error(`Unsupported PNG colour type: ${colourType}. Expected 2 or 6.`);
  }

  const total = idatParts.reduce((sum, part) => sum + part.length, 0);
  const idat = new Uint8Array(total);
  let cursor = 0;
  for (const part of idatParts) {
    idat.set(part, cursor);
    cursor += part.length;
  }

  return { width, height, idat };
}

/**
 * Undo PNG scanline filtering so we can split RGB from alpha.
 * `inflate` is injected (browser `DecompressionStream`) to keep this module portable.
 */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const format = 'deflate' as const;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/** Reverse the per-scanline filters of a PNG (types 0-4). */
function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let inPos = 0;

  for (let y = 0; y < height; ++y) {
    const filter = raw[inPos];
    inPos += 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;

    for (let x = 0; x < stride; ++x) {
      const value = raw[inPos + x];
      const left = x >= channels ? out[rowStart + x - channels] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;

      let reconstructed: number;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          reconstructed = value + predictor;
          break;
        }
        default:
          throw new Error(`Unsupported PNG filter type: ${filter}`);
      }
      out[rowStart + x] = reconstructed & 0xff;
    }
    inPos += stride;
  }

  return out;
}

/** Split interleaved RGBA into separate RGB and alpha planes for the PDF. */
function splitRgba(rgba: Uint8Array, pixels: number): { rgb: Uint8Array; alpha: Uint8Array } {
  const rgb = new Uint8Array(pixels * 3);
  const alpha = new Uint8Array(pixels);
  for (let i = 0; i < pixels; ++i) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
    alpha[i] = rgba[i * 4 + 3];
  }
  return { rgb, alpha };
}

/** Accumulates PDF objects and emits the cross-reference table. */
class PdfWriter {
  private objects: string[] = [];

  /** Reserve an object number before its body is known. */
  reserve(): number {
    this.objects.push('');
    return this.objects.length;
  }

  define(id: number, body: string): void {
    this.objects[id - 1] = body;
  }

  /** Build the final PDF. `frame` is appended after the header. */
  finish(rootId: number, infoId?: number): Uint8Array {
    const chunks: string[] = [];
    chunks.push('%PDF-1.4\n');
    // A binary comment marks the file as binary for naive tools.
    chunks.push('%\xE2\xE3\xCF\xD3\n');

    const offsets: number[] = [];
    let position = 0;
    for (const chunk of chunks) position += byteLength(chunk);

    for (let i = 0; i < this.objects.length; ++i) {
      const body = this.objects[i];
      if (body === '') throw new Error(`PDF object ${i + 1} was reserved but never defined.`);
      offsets.push(position);
      const text = `${i + 1} 0 obj\n${body}\nendobj\n`;
      chunks.push(text);
      position += byteLength(text);
    }

    const xrefOffset = position;
    const count = this.objects.length + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
    }
    chunks.push(xref);

    const trailer =
      `trailer\n<< /Size ${count} /Root ${rootId} 0 R` +
      (infoId ? ` /Info ${infoId} 0 R` : '') +
      ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(trailer);

    return encodeLatin1(chunks.join(''));
  }
}

function byteLength(text: string): number {
  // Every string we push is Latin-1, so one char is one byte.
  return text.length;
}

function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; ++i) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function escapePdfText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Wrap a PNG bitmap in a one-page PDF.
 *
 * `imageBytes` must be a PNG produced by a canvas (8-bit RGB or RGBA, non-interlaced).
 */
export async function pngToPdf(
  imageBytes: Uint8Array,
  options: PdfImageOptions = {},
): Promise<Uint8Array> {
  const decoded = decodePng(imageBytes);
  const pageWidth = options.pageWidth ?? 841.89; // A4 landscape, points
  const pageHeight = options.pageHeight ?? 595.28;
  const margin = options.margin ?? 24;

  // Fit the image inside the page while preserving aspect ratio.
  const availableWidth = pageWidth - margin * 2;
  const availableHeight = pageHeight - margin * 2;
  const scale = Math.min(availableWidth / decoded.width, availableHeight / decoded.height, 1);
  const drawWidth = decoded.width * scale;
  const drawHeight = decoded.height * scale;
  const x = (pageWidth - drawWidth) / 2;
  const y = (pageHeight - drawHeight) / 2;

  // Split alpha out if present, so transparency survives instead of turning black.
  let rgbStream = decoded.idat;
  let alphaStream: Uint8Array | null = null;
  const pixels = decoded.width * decoded.height;

  const raw = await inflate(decoded.idat);
  const channels = 4; // canvas PNGs are RGBA; the decoder above guarantees it
  const pixelsData = unfilter(raw, decoded.width, decoded.height, channels);
  const { rgb, alpha } = splitRgba(pixelsData, pixels);
  rgbStream = await deflate(rgb);

  // Only add a soft mask when the image actually has transparent pixels.
  let hasTransparency = false;
  for (let i = 0; i < pixels; ++i) {
    if (alpha[i] !== 255) {
      hasTransparency = true;
      break;
    }
  }
  if (hasTransparency) alphaStream = await deflate(alpha);

  const writer = new PdfWriter();
  const pageId = writer.reserve();
  const contentId = writer.reserve();
  const imageId = writer.reserve();
  const maskId = alphaStream ? writer.reserve() : 0;
  const pagesId = writer.reserve();
  const catalogId = writer.reserve();
  const infoId = writer.reserve();

  const imageDict =
    `<< /Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode` +
    (alphaStream ? ` /SMask ${maskId} 0 R` : '') +
    ` /Length ${rgbStream.length} >>`;

  writer.define(
    imageId,
    `${imageDict}\nstream\n${binaryString(rgbStream)}\nendstream`,
  );

  if (alphaStream) {
    writer.define(
      maskId,
      `<< /Type /XObject /Subtype /Image /Width ${decoded.width} /Height ${decoded.height} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alphaStream.length} >>` +
        `\nstream\n${binaryString(alphaStream)}\nendstream`,
    );
  }

  const content = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  writer.define(contentId, `<< /Length ${content.length} >>\nstream\n${content}endstream`);

  writer.define(
    pageId,
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] ` +
      `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
  );

  writer.define(pagesId, `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  writer.define(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  writer.define(
    infoId,
    `<< /Title (${escapePdfText(options.title ?? 'Data Workbench chart')}) ` +
      `/Producer (Data Workbench) /Creator (Data Workbench) >>`,
  );

  return writer.finish(catalogId, infoId);
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]);
  const stream = source.stream().pipeThrough(new CompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/** Latin-1 view of binary data, for splicing into a PDF object stream. */
function binaryString(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}
