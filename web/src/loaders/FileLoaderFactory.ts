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
import { client } from './parseWorker.ts';

// Re-exported so UI modules have a single import site for "what can I open?".
export { FILE_ACCEPT, SUPPORTED_EXTENSIONS, extensionOf } from '../core/FileLoader.ts';

/**
 * The bare loader set. Kept in its own module so `parse.worker.ts` can import the factory
 * without importing the worker client — that cycle would drag `new Worker(...)` into the
 * worker's own graph.
 */
export function loadWith(file: File, name = file.name): MatrixData | Promise<MatrixData> {
  const loader = createLoader(name);
  if (!loader) {
    throw new Error(
      `Unsupported file format "${extensionOf(name) || name}". ` +
        'Supported: txt, csv, tsv, dat, xlsx.',
    );
  }
  return loader.load(file);
}

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

/**
 * Pick a loader, parse, and explain failures concisely.
 *
 * Parsing is attempted off the main thread first (see `parseWorker.ts`); when workers are
 * unavailable the same loaders run inline, so behaviour never depends on the optimisation.
 * The unsupported-extension error is raised synchronously either way, before any read.
 */
export async function loadMatrixFile(file: File): Promise<MatrixData> {
  // Validate first so an unsupported name fails identically on both paths.
  const matrix = await client.parse(file.name, file);
  if (matrix) return matrix;
  return loadWith(file);
}
