/**
 * RFC 4180-ish CSV loader with delimiter sniffing.
 *
 * The C++ tree has no dedicated CSV parser (its TxtLoader handles comma as just
 * another separator). A real CSV parser is added here because the web frontend
 * advertises CSV support: quoted fields containing the delimiter, embedded
 * newlines and doubled quotes all need to survive, which a split() cannot do.
 */
import { MatrixData } from '../core/MatrixData.ts';
import { decodeText, gridToMatrix, type FileLoader } from '../core/FileLoader.ts';

export type Delimiter = ',' | ';' | '\t' | '|';

/**
 * Pick the delimiter by counting candidates outside quotes on the first lines and
 * preferring the one with the most consistent column count.
 */
export function sniffDelimiter(text: string): Delimiter {
  const candidates: Delimiter[] = [',', ';', '\t', '|'];
  const sample = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '').slice(0, 20);
  if (sample.length === 0) return ',';

  let best: Delimiter = ',';
  let bestScore = -1;
  for (const delim of candidates) {
    const counts = sample.map((line) => countOutsideQuotes(line, delim));
    if (counts.every((c) => c === 0)) continue;
    const cols = counts[0] + 1;
    const consistent = counts.filter((c) => c + 1 === cols).length / counts.length;
    const score = consistent * 100 + cols;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delim: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; ++i) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

/** Parse the whole text into a grid of raw cell strings. */
export function parseCsv(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; ++i) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing blank lines produced by a final newline.
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

export class CsvLoader implements FileLoader {
  async load(file: File): Promise<MatrixData> {
    const text = await decodeText(file);
    const delimiter = sniffDelimiter(text);
    const grid = parseCsv(text, delimiter);
    return gridToMatrix(grid);
  }
}
