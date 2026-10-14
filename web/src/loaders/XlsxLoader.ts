/**
 * XLSX loader — the browser-side counterpart of `src/loaders/XlsxLoader.cpp`
 * (which used QXlsx). Here we use the SheetJS community build, loaded lazily so the
 * ~1 MB parser never lands in the initial bundle.
 */
import { MatrixData } from '../core/MatrixData.ts';
import { gridToMatrix, type FileLoader } from '../core/FileLoader.ts';

export class XlsxLoader implements FileLoader {
  async load(file: File): Promise<MatrixData> {
    const XLSX = await import('@e965/xlsx');
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: false, dense: false });

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('Workbook contains no sheets.');
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`Sheet "${sheetName}" could not be read.`);

    // `header: 1` returns an array of arrays; raw values keep full double precision.
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      blankrows: false,
      defval: '',
    });

    const grid: string[][] = raw
      .map((row) => (Array.isArray(row) ? row.map((cell) => cellToToken(cell)) : []))
      .filter((row) => row.length > 0 && row.some((c) => c.trim() !== ''));

    if (grid.length === 0) {
      throw new Error(`Sheet "${sheetName}" is empty.`);
    }

    // Shared header rule and column assembly, identical to the text loaders.
    return gridToMatrix(grid);
  }
}

function cellToToken(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') return String(cell);
  if (typeof cell === 'boolean') return cell ? '1' : '0';
  if (cell instanceof Date) return String(cell.getTime());
  return String(cell);
}
