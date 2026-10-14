/**
 * Loader parity with `src/core/FileLoader.cpp` (TxtLoader) plus the CSV/XLSX additions.
 *
 * Vitest runs in a Node environment, where the File / TextEncoder globals needed by
 * the loaders are available (Node >= 20).
 */
import { describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { createLoader, loadMatrixFile } from '../src/loaders/FileLoaderFactory.ts';
import { TxtLoader, splitWhitespaceDelimited } from '../src/loaders/TxtLoader.ts';
import { CsvLoader, parseCsv, sniffDelimiter } from '../src/loaders/CsvLoader.ts';
import { matrixToCsv } from '../src/ui/fileActions.ts';

function makeFile(name: string, content: string, type = 'text/plain'): File {
  return new File([content], name, { type });
}

describe('splitWhitespaceDelimited', () => {
  it('treats space, tab, comma and semicolon as interchangeable separators', () => {
    expect(splitWhitespaceDelimited('1 2\t3,4;5')).toEqual(['1', '2', '3', '4', '5']);
  });

  it('collapses delimiter runs and drops empty tokens', () => {
    expect(splitWhitespaceDelimited('  1,,  2  ')).toEqual(['1', '2']);
  });

  it('returns nothing for a blank line', () => {
    expect(splitWhitespaceDelimited('   ')).toEqual([]);
  });
});

describe('TxtLoader', () => {
  it('loads a plain numeric matrix with Pos.N columns', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1 2 3\n4 5 6\n'));
    expect(mat.columnCount()).toBe(3);
    expect(mat.rowCount()).toBe(2);
    expect(mat.column(0).posName).toBe('Pos.1');
    expect(mat.cell(1, 2)).toBe(6);
  });

  it('uses a non-numeric first row as column annotations, not as data', async () => {
    const mat = await new TxtLoader().load(
      makeFile('a.txt', 'temp pressure\n1.5 2.5\n3.5 4.5\n'),
    );
    expect(mat.rowCount()).toBe(2);
    expect(mat.column(0).annotation).toBe('temp');
    expect(mat.column(1).annotation).toBe('pressure');
    expect(mat.columnLabel(0)).toBe('temp');
    expect(mat.cell(0, 0)).toBe(1.5);
  });

  it('keeps a numeric first row as data', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1 2\n3 4\n'));
    expect(mat.rowCount()).toBe(2);
    expect(mat.column(0).annotation).toBe('');
  });

  it('skips blank lines and tolerates ragged rows', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1 2 3\n\n4 5\n'));
    expect(mat.columnCount()).toBe(3);
    expect(mat.rowCount()).toBe(2);
    // A missing trailing value surfaces as NaN rather than an invented zero.
    expect(mat.cell(1, 2)).toBeNaN();
  });

  it('parses scientific notation and signs', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1e-3 -2.5E+2 +7\n'));
    expect(mat.cell(0, 0)).toBeCloseTo(0.001, 12);
    expect(mat.cell(0, 1)).toBeCloseTo(-250, 12);
    expect(mat.cell(0, 2)).toBe(7);
  });

  it('handles CRLF line endings', async () => {
    const mat = await new TxtLoader().load(makeFile('a.txt', '1 2\r\n3 4\r\n'));
    expect(mat.rowCount()).toBe(2);
    expect(mat.cell(1, 1)).toBe(4);
  });

  it('rejects an empty file', async () => {
    await expect(new TxtLoader().load(makeFile('a.txt', '\n\n'))).rejects.toThrow(/Empty file/);
  });

  it('rejects a header-only file', async () => {
    await expect(new TxtLoader().load(makeFile('a.txt', 'temp pressure\n'))).rejects.toThrow(
      /no data/,
    );
  });
});

describe('sniffDelimiter / parseCsv', () => {
  it('detects comma, semicolon and tab separated files', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('keeps a quoted delimiter inside one field', () => {
    const grid = parseCsv('a,"b,c",d\n1,2,3', ',');
    expect(grid[0]).toEqual(['a', 'b,c', 'd']);
    expect(grid[1]).toEqual(['1', '2', '3']);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"say ""hi""",2', ',')[0]).toEqual(['say "hi"', '2']);
  });

  it('supports embedded newlines inside quotes', () => {
    const grid = parseCsv('"line1\nline2",b', ',');
    expect(grid[0]).toEqual(['line1\nline2', 'b']);
  });

  it('drops a trailing blank line', () => {
    expect(parseCsv('1,2\n', ',')).toEqual([['1', '2']]);
  });
});

describe('CsvLoader', () => {
  it('loads a comma separated file with header annotations', async () => {
    const mat = await new CsvLoader().load(makeFile('a.csv', 'x,y\n1,2\n3,4\n'));
    expect(mat.columnCount()).toBe(2);
    expect(mat.rowCount()).toBe(2);
    expect(mat.column(0).annotation).toBe('x');
    expect(mat.cell(1, 1)).toBe(4);
  });

  it('loads a semicolon separated file', async () => {
    const mat = await new CsvLoader().load(makeFile('a.csv', '1;2;3\n4;5;6\n'));
    expect(mat.columnCount()).toBe(3);
    expect(mat.cell(1, 2)).toBe(6);
  });
});

describe('createLoader', () => {
  it('maps each supported extension to a loader', () => {
    expect(createLoader('a.txt')).toBeInstanceOf(TxtLoader);
    expect(createLoader('A.TXT')).toBeInstanceOf(TxtLoader);
    expect(createLoader('a.dat')).toBeInstanceOf(TxtLoader);
    expect(createLoader('a.csv')).toBeInstanceOf(CsvLoader);
    expect(createLoader('a.tsv')).toBeInstanceOf(CsvLoader);
    expect(createLoader('a.xlsx')).not.toBeNull();
  });

  it('rejects unsupported extensions', () => {
    expect(createLoader('a.parquet')).toBeNull();
    expect(createLoader('noextension')).toBeNull();
  });

  it('explains an unsupported extension through loadMatrixFile', async () => {
    await expect(loadMatrixFile(makeFile('a.parquet', 'x'))).rejects.toThrow(/Unsupported/);
  });
});

describe('matrixToCsv', () => {
  it('emits a header row and full-precision values', () => {
    const mat = new MatrixData();
    mat.appendColumn('Pos.1', [1.5, 2]);
    mat.setColumnAnnotation(0, '温度');
    mat.appendColumn('Pos.2', [3, 4]);

    const csv = matrixToCsv(mat);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('温度,Pos.2');
    expect(lines[1]).toBe('1.5,3');
    expect(lines[2]).toBe('2,4');
  });

  it('quotes fields that contain separators or quotes', () => {
    const mat = new MatrixData();
    mat.appendColumn('Pos.1', [1]);
    mat.setColumnAnnotation(0, 'a,b "c"');
    expect(matrixToCsv(mat).split('\n')[0]).toBe('"a,b ""c"""');
  });

  it('writes NaN as an empty field', () => {
    const mat = new MatrixData();
    mat.appendColumn('Pos.1', [1, NaN]);
    expect(matrixToCsv(mat).split('\n')[2]).toBe('');
  });
});
