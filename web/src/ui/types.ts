/**
 * Card-layer types — **schema v2** (docs/decisions/2026-10-26-card-schema-v2.md).
 *
 * A card is a record in the store and a React component renders it. Keeping cards as
 * data (rather than classes) is what makes the workspace persistable and the dependency
 * graph easy to reason about.
 *
 * v2 changes, all of them consequences of the function-card review:
 *   - **Dependencies live on the envelope** (`CardBase.inputs`), not inside each payload.
 *     Rebuilding the graph is one pass with zero per-kind knowledge — which is what makes
 *     the old "formula dependencies silently vanish on reload" bug impossible.
 *   - **References point at explicit matrices**, not at "a card, whatever file it happens
 *     to be showing". Switching a table's active file no longer silently re-points a
 *     function card's input; that is now an explicit, visible operation.
 *   - **A function card is ONE node with K outputs** (`outputs[]`), not N nodes. The old
 *     per-column mapping computed the same input N times and could not express a
 *     heterogeneous K-output function (SVD's U/S/V).
 *
 * The header comment used to describe these as mirroring the Qt widget layer; that C++
 * tree was removed on 2026-10-15 (docs/decisions/2026-10-15-qt-implementation-removed.md),
 * so this file is now the authoritative definition rather than a port.
 */

import type { SmoothingOptions } from '../core/Smoothing.ts';
import type { MatrixData } from '../core/MatrixData.ts';
import type { ChartConfig, ChartSource } from '../charts/chartModel.ts';
import type { ChartTypeId } from '../charts/chartTypes.ts';

export type CardKind = 'matrix' | 'chart' | 'formula';

/** A card can be dragged, resized, stacked and closed. */
export interface CardBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One data dependency. `portId` is the stable identity — renaming a display label must
 * never change it, and connections are recognised by it, never by position.
 */
export interface PortConnection {
  portId: string;
  target:
    | { type: 'matrix'; cardId: number; matrixId: number }
    | { type: 'cell'; cardId: number; matrixId: number; column: number; row?: number };
}

export interface CardBase extends CardBounds {
  id: number;
  kind: CardKind;
  title: string;
  /** Stacking order; the highest value is the active card. */
  z: number;
  createdAt: number;
  /**
   * First-class citizen: who this card reads from. The dependency graph is rebuilt by
   * walking this array — never by inspecting a payload.
   */
  inputs: PortConnection[];
}

/** One parsed file inside a matrix card. */
export interface MatrixSource {
  /** Display name — the file name. Unique within its card, not globally. */
  name: string;
  matrixId: number;
}

/**
 * Byte identity of a loaded file. Two loads with the same size + lastModified are the
 * same bytes; a different identity under the same name is a *new* file and must not
 * reuse an older parse.
 */
export interface FileIdentity {
  size: number;
  lastModified: number;
}

/** Cache key for a parse: the bytes, not the label. */
export function identityKey(identity: FileIdentity): string {
  return `${identity.size}:${identity.lastModified}`;
}

/**
 * One parsed file on its way into a matrix card: a drop, the picker, or a restored set.
 *
 * `identity` is the byte fingerprint used to reuse an identical parse (see
 * `matrixIdByIdentity`); programmatically built tables and restored snapshots leave it out
 * and therefore always get a matrix of their own.
 */
export interface MatrixEntry {
  name: string;
  matrix: MatrixData;
  identity?: FileIdentity;
}

export interface MatrixCardModel extends CardBase {
  kind: 'matrix';
  /** All files loaded into this card. Content, not a dependency — `inputs` is always []. */
  sources: MatrixSource[];
  /** Index into `sources` of the file currently displayed. */
  activeSource: number;
  /** File-backed tables are read-only. Editing belongs to non-file-backed cards. */
  readOnly: boolean;
}

/** Identifies one plotted column. */
export interface SourceRef {
  matrixId: number;
  columnIndex: number;
}

export interface ChartCardModel extends CardBase {
  kind: 'chart';
  /**
   * Chart type plus its attached columns and presentation options.
   *
   * `config.sources` is a *display view* in v2: the authoritative dependency edges live
   * on `inputs` (one `cell` connection per attached column, plus one `x` connection for
   * an explicit X axis). The two are kept in step by the store.
   */
  config: ChartConfig;
  smoothing: SmoothingOptions;
  /**
   * Whether the column dock is open on this chart card (pure UI state, persisted with
   * the card). Absent on older snapshots — normalizeRestoredCards reads it as false.
   */
  columnPanelOpen?: boolean;
}

/**
 * A compute node as the browser sees it (B-plan: docs/decisions/2026-10-17-backend-owns-compute.md).
 *
 * One card owns **one** node in v2. The card no longer computes anything; it mirrors the
 * server node's state machine so the UI can light an indicator (dirty/computing/done/error
 * → 灰/黄/绿/红) and render a localised message from a structured error code. `code`/`params`
 * are present only while `state === 'error'`; the user-facing sentence comes from i18n key
 * `formula.error.<code>`, never from the server.
 */
export interface NodeStatus {
  nodeId: number;
  state: 'dirty' | 'computing' | 'done' | 'error';
  /** Structured error identity from the backend (never user prose). */
  code?: string;
  params?: Record<string, unknown>;
}

/** One output declaration plus the server matrix that carries its values. */
export interface OutputBinding {
  /** Stable identity from the signature's output list. */
  outputId: string;
  /** Server-side result matrix id (authoritative copy); -1 until registration. */
  resultMatrixId: number;
}

/** One derived column: a display name and the expression that computes it. */
export interface FormulaColumn {
  name: string;
  expression: string;
}

/**
 * A promised column count for one output table.
 *
 * Created when the user first names an output column: from then on the width is a
 * contract, and a drift stops the data flow here with a structured error instead of
 * silently re-labelling columns. It is deliberately explicit — a heuristic "did the shape
 * change?" check would fire on every legitimate re-point.
 */
export interface ColumnContract {
  outputId: string;
  columns: number;
}

/**
 * A function card's parameter bag.
 *
 * Deliberately open: parameters belong to the SIGNATURE, not to the card. An expression
 * signature carries `formulas`; a signature like `builtin:linear-regression` carries none
 * at all. Typing this as "must have formulas" would force every future signature to
 * pretend it has an empty formula list — the kind of lie that later reads as data.
 */
export interface FunctionParams {
  /** Present for expression-shaped signatures (one expression per output column). */
  formulas?: FormulaColumn[];
  /** Present once the user has named an output column. */
  columnContract?: ColumnContract;
  [key: string]: unknown;
}

/** Parameters of `builtin:expression-columns` — the signature that requires formulas. */
export interface ExpressionColumnsParams extends FunctionParams {
  formulas: FormulaColumn[];
}

/**
 * A function card: a signature + parameters + K declared outputs, backed by ONE node.
 *
 * `signatureId` names an entry in the signature registry (built-in today, plugin
 * implementations tomorrow — the port-semantics spec forbids a second entry point).
 */
export interface FunctionCardModel extends CardBase {
  kind: 'formula';
  signatureId: string;
  /** Parameters are separate from the dataflow graph: changing one adds/removes no edge. */
  params: FunctionParams;
  /** K outputs = one node. K is fixed by the signature, never by the data. */
  outputs: OutputBinding[];
  /** The single backend compute node; null while registration is pending/offline. */
  node: NodeStatus | null;
  /**
   * Local display-cache matrix id (frontend id space, like a matrix card's `sources[]`).
   * Under the B-plan this is a **read-only cache** filled from the backend's result
   * matrix; nothing writes into it locally.
   */
  displayMatrixId: number;
  /**
   * How much of the result the display cache actually holds.
   *
   * A 10⁵-row result is shown as its first rows (`shownRows`) and the rest is fetched only
   * when the user asks (`complete: false` + the "show more" action). `totalRows` comes from
   * the dense-matrix frame's shape header, so the card can say "100 of 165 000" without
   * downloading the whole table. `null` while no result has arrived.
   */
  result: ResultDisplay | null;
}

/** Row budget of a function card's display cache (see `FunctionCardModel.result`). */
export interface ResultDisplay {
  /** Rows of the stored result matrix (authoritative, server-side). */
  totalRows: number;
  /** Rows currently mirrored in the browser cache. */
  shownRows: number;
  /** True once `shownRows === totalRows` (nothing left to fetch). */
  complete: boolean;
  /** True when the cache stopped at the row ceiling instead of the end of the data. */
  truncated: boolean;
}

export type CardModel = MatrixCardModel | ChartCardModel | FunctionCardModel;

export function isMatrixCard(card: CardModel): card is MatrixCardModel {
  return card.kind === 'matrix';
}

export function isChartCard(card: CardModel): card is ChartCardModel {
  return card.kind === 'chart';
}

export function isFormulaCard(card: CardModel): card is FunctionCardModel {
  return card.kind === 'formula';
}

/**
 * Does this card read from any matrix owned by `cardId`?
 *
 * Reads `inputs` only — the one place dependencies live. Used by close protection and by
 * the chart-refresh path, so neither needs kind-specific knowledge.
 */
export function dependsOnCard(card: CardModel, cardId: number): boolean {
  return card.inputs.some((input) => input.target.cardId === cardId);
}

/** Persisted card snapshot (no matrix payload — that travels in `MatrixSnapshot`). */
export type CardSnapshot = CardModel;

/** Serialisable form of `MatrixData`, used by the workspace save file. */
export interface MatrixSnapshot {
  id: number;
  name: string;
  columns: Array<{ posName: string; annotation: string; data: number[] }>;
}

export interface WorkspaceSnapshot {
  version: 2;
  savedAt: string;
  cards: CardSnapshot[];
  matrices: MatrixSnapshot[];
  nextCardId: number;
  nextMatrixId: number;
}

export type { ChartConfig, ChartSource, ChartTypeId };
