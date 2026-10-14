/**
 * Off-main-thread file loading (fix F, 2026-10-15).
 *
 * `loadMatrixFile` keeps its exact contract — File in, MatrixData out, human-readable
 * rejection on failure — but runs the parse in a worker when one is available. The UI
 * stays responsive while a large file is decoded and tokenised.
 *
 * Two deliberate properties:
 *   - **Fallback, not requirement.** If workers are unavailable (a test runner without a
 *     DOM, an embedded webview with them disabled), parsing simply happens inline. The
 *     app must never lose the ability to open a file because of this optimisation.
 *   - **One shared worker**, created lazily on first use and reused. Spawning a worker per
 *     dropped file would pay ~50 ms of startup for every single load.
 */
import { MatrixData } from '../core/MatrixData.ts';
import type { ColumnPayload, ParseRequest, ParseResponse } from './parseTypes.ts';

/** Rebuild the UI-side model from the worker's plain payload. */
export function payloadToMatrix(columns: ColumnPayload[]): MatrixData {
  const matrix = new MatrixData();
  for (const col of columns) {
    matrix.appendColumn(col.posName, col.data.slice());
    matrix.setColumnAnnotation(matrix.columnCount() - 1, col.annotation);
  }
  return matrix;
}

type Pending = {
  resolve: (columns: ColumnPayload[]) => void;
  reject: (error: Error) => void;
};

class ParseWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined' || typeof self?.postMessage !== 'function') return null;
    try {
      const worker = new Worker(new URL('./parse.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<ParseResponse>) => {
        const { id, ...rest } = event.data;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (rest.ok) entry.resolve(rest.columns);
        else entry.reject(new Error(rest.error));
      };
      // A worker that dies (OOM, blocked by CSP mid-flight) must not hang the caller.
      worker.onerror = (event) => {
        const message = event.message || 'Parse worker failed to start.';
        this.failAll(new Error(message));
        worker.terminate();
        this.worker = null;
      };
      this.worker = worker;
      return worker;
    } catch {
      return null;
    }
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
  }

  async parse(name: string, file: File): Promise<MatrixData | null> {
    const worker = this.ensure();
    if (!worker) return null; // signal "use the inline path"

    const id = this.nextId++;
    return new Promise<MatrixData>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (columns) => resolve(payloadToMatrix(columns)),
        reject,
      });
      worker.postMessage({ id, name, file } satisfies ParseRequest);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error('Parse worker terminated.'));
  }
}

export const client = new ParseWorkerClient();

/** True when parses will run off the main thread — used by tests and diagnostics. */
export function workerParsingAvailable(): boolean {
  return typeof Worker !== 'undefined';
}

export function disposeParseWorker(): void {
  client.terminate();
}

