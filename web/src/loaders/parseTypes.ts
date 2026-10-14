/**
 * Wire format shared by the main thread and the parse worker (fix F).
 *
 * A separate module because the worker entry installs its `onmessage` handler at import
 * time — anything that only needs the *types* must not depend on that module, or loading
 * it outside a worker scope throws (`self is not defined`).
 */

export interface ColumnPayload {
  posName: string;
  annotation: string;
  data: number[];
}

export type ParseResponse =
  | { id: number; ok: true; columns: ColumnPayload[]; rows: number }
  | { id: number; ok: false; error: string };

export interface ParseRequest {
  id: number;
  name: string;
  file: File;
}
