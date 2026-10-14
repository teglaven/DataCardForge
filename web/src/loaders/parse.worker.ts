/**
 * Worker-side parse entry point (fix F, 2026-10-15).
 *
 * Parsing a measurement file is CPU-bound string work: decode, split, then one numeric
 * grammar check per cell. A 10 000 × 10 TXT takes hundreds of milliseconds and an XLSX
 * far longer — previously that ran on the main thread, so the UI froze mid-drop with no
 * feedback while the browser was blocked.
 *
 * This module does the same work inside a dedicated worker and returns only plain data
 * (`ColumnPayload[]`), which is structured-cloneable. `MatrixData` deliberately stays out
 * of the wire format: it is a class with private state, and shipping instances would
 * couple the worker build to the UI's internal model.
 *
 * Vite compiles `new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' })`
 * into its own chunk, so the loaders keep importing `@e965/xlsx` lazily and that ~490 KB
 * bundle lands in the worker instead of the first paint.
 */
import { MatrixData } from '../core/MatrixData.ts';
import { extensionOf } from '../core/FileLoader.ts';
import { createLoader } from './FileLoaderFactory.ts';
import type { ColumnPayload, ParseRequest, ParseResponse } from './parseTypes.ts';

export function matrixToPayload(matrix: MatrixData): ColumnPayload[] {
  return matrix.columns().map((col) => ({
    posName: col.posName,
    annotation: col.annotation,
    data: col.data,
  }));
}

/** Reject unsupported extensions before doing any reading — mirrors the factory. */
async function parse(name: string, file: File): Promise<MatrixData> {
  const loader = createLoader(name);
  if (!loader) {
    throw new Error(
      `Unsupported file format "${extensionOf(name) || name}". ` +
        'Supported: txt, csv, tsv, dat, xlsx.',
    );
  }
  return loader.load(file);
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<ParseRequest>) => Promise<void> | void) | null;
  postMessage(message: ParseResponse): void;
}

// Cast through a narrow shape rather than pulling in the `webworker` lib: tsconfig already
// loads `dom`, and the two disagree about the type of `self`.
const ctx = self as unknown as WorkerScope;

ctx.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const { id, name, file } = event.data;
  try {
    const matrix = await parse(name, file);
    const response: ParseResponse = {
      id,
      ok: true,
      columns: matrixToPayload(matrix),
      rows: matrix.rowCount(),
    };
    ctx.postMessage(response);
  } catch (error) {
    const response: ParseResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    ctx.postMessage(response);
  }
};
