/**
 * Loader factory — port of `src/loaders/FileLoaderFactory.cpp`.
 *
 * This is the only module that knows about every concrete loader, keeping the
 * decision of "which parser for this file" in one place — the same seam the C++
 * tree uses so that `core/` stays free of specific parsers.
 */
import { extensionOf, type FileLoader } from '../core/FileLoader.ts';
import { MatrixData } from '../core/MatrixData.ts';
import { TxtLoader } from './TxtLoader.ts';
import { CsvLoader } from './CsvLoader.ts';
import { XlsxLoader } from './XlsxLoader.ts';

// Re-exported so UI modules have a single import site for "what can I open?".
export { FILE_ACCEPT, SUPPORTED_EXTENSIONS, extensionOf } from '../core/FileLoader.ts';

export function createLoader(fileName: string): FileLoader | null {
  switch (extensionOf(fileName)) {
    case '.txt':
    case '.dat':
      return new TxtLoader();
    case '.csv':
    case '.tsv':
      return new CsvLoader();
    case '.xlsx':
    case '.xls':
      return new XlsxLoader();
    default:
      return null;
  }
}

/** Convenience wrapper: pick a loader, parse, and explain failures concisely. */
export async function loadMatrixFile(file: File): Promise<MatrixData> {
  const loader = createLoader(file.name);
  if (!loader) {
    throw new Error(
      `Unsupported file format "${extensionOf(file.name) || file.name}". ` +
        'Supported: txt, csv, tsv, dat, xlsx.',
    );
  }
  return loader.load(file);
}
