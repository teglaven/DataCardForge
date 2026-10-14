/**
 * Whitespace / delimiter separated text loader — port of `TxtLoader` in
 * `src/core/FileLoader.cpp`.
 *
 * The C++ splitter treats space, tab, comma and semicolon as interchangeable
 * separators and collapses runs of them. We keep that behaviour for `.txt` / `.dat`
 * so existing measurement exports load identically; real CSV gets its own
 * quote-aware parser in `CsvLoader`.
 */
import { MatrixData } from '../core/MatrixData.ts';
import { decodeText, gridToMatrix, type FileLoader } from '../core/FileLoader.ts';

/** Split on runs of space / tab / comma / semicolon (C++ `split_row`). */
export function splitWhitespaceDelimited(line: string): string[] {
  return line.split(/[ \t,;]+/).filter((token) => token !== '');
}

export class TxtLoader implements FileLoader {
  async load(file: File): Promise<MatrixData> {
    const text = await decodeText(file);
    const grid: string[][] = [];
    for (const rawLine of text.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      const parts = splitWhitespaceDelimited(line);
      if (parts.length > 0) grid.push(parts);
    }
    return gridToMatrix(grid);
  }
}
