/**
 * Browser-side equivalents of the Qt file dialogs, plus the workspace format.
 *
 * The C++ frontend leaned on `QFileDialog` and a filesystem path. In the browser the
 * user hands us `File` objects through an `<input type="file">` or a drop event, and
 * results are handed back as downloads. This module isolates both directions so the
 * components stay free of DOM plumbing.
 */
import { MatrixData } from '../core/MatrixData.ts';
import { FILE_ACCEPT, loadMatrixFile } from '../loaders/FileLoaderFactory.ts';
import type { WorkspaceSnapshot } from './types.ts';

/** Open the native picker and resolve with the chosen files (empty when cancelled). */
export function pickFiles(multiple: boolean, accept = FILE_ACCEPT): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.position = 'fixed';
    input.style.left = '-9999px';

    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => {
      finish(input.files ? Array.from(input.files) : []);
    });
    // `cancel` fires in modern browsers when the dialog is dismissed.
    input.addEventListener('cancel', () => finish([]));

    document.body.appendChild(input);
    input.click();
  });
}

export interface LoadedFile {
  name: string;
  matrix: MatrixData;
}

export interface LoadFailure {
  name: string;
  error: string;
}

/**
 * Parse a batch of files, reporting per-file failures instead of aborting.
 * Duplicate names are de-duplicated by suffixing, mirroring the Qt loader's
 * "file name -> matrix" map (which silently kept the last one).
 */
export async function parseFiles(
  files: File[],
): Promise<{ loaded: LoadedFile[]; failures: LoadFailure[] }> {
  const loaded: LoadedFile[] = [];
  const failures: LoadFailure[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    try {
      const matrix = await loadMatrixFile(file);
      let name = file.name;
      let counter = 2;
      while (seen.has(name)) {
        const dot = file.name.lastIndexOf('.');
        name =
          dot > 0
            ? `${file.name.slice(0, dot)} (${counter})${file.name.slice(dot)}`
            : `${file.name} (${counter})`;
        counter += 1;
      }
      seen.add(name);
      loaded.push({ name, matrix });
    } catch (error) {
      failures.push({
        name: file.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { loaded, failures };
}

/** Serialise a matrix as CSV, quoting only when needed. */
export function matrixToCsv(matrix: MatrixData): string {
  const rows = matrix.rowCount();
  const cols = matrix.columnCount();
  const lines: string[] = [];

  const header = [];
  for (let c = 0; c < cols; ++c) {
    header.push(csvField(matrix.columnLabel(c) || matrix.column(c).posName));
  }
  lines.push(header.join(','));

  for (let r = 0; r < rows; ++r) {
    const cells: string[] = [];
    for (let c = 0; c < cols; ++c) {
      const value = matrix.cell(r, c);
      cells.push(Number.isNaN(value) ? '' : String(value));
    }
    lines.push(cells.join(','));
  }

  return lines.join('\n');
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Trigger a browser download for text or binary payloads. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(
  filename: string,
  text: string,
  mime = 'text/plain;charset=utf-8',
): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

/** Read and validate a workspace JSON file. */
export async function readWorkspace(file: File): Promise<WorkspaceSnapshot> {
  const text = await file.text();
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Workspace file is not a JSON object.');
  }
  const snapshot = parsed as Partial<WorkspaceSnapshot>;
  if (snapshot.version !== 1) {
    throw new Error(`Unsupported workspace version: ${String(snapshot.version)}`);
  }
  if (!Array.isArray(snapshot.cards) || !Array.isArray(snapshot.matrices)) {
    throw new Error('Workspace file is missing cards or matrices.');
  }
  return snapshot as WorkspaceSnapshot;
}
