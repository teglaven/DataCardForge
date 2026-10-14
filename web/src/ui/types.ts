/**
 * Card-layer types.
 *
 * A card is a record in the store and a React component renders it. Keeping cards as
 * data (rather than classes) is what makes the workspace persistable and the dependency
 * graph easy to reason about.
 *
 * The header comment used to describe these as mirroring the Qt widget layer; that C++
 * tree was removed on 2026-10-15 (docs/decisions/2026-10-15-qt-implementation-removed.md),
 * so this file is now the authoritative definition rather than a port.
 */

import type { SmoothingOptions } from '../core/Smoothing.ts';
import type { ChartConfig, ChartSource } from '../charts/chartModel.ts';
import type { ChartTypeId } from '../charts/chartTypes.ts';

export type CardKind = 'matrix' | 'chart';

/** A card can be dragged, resized, stacked and closed. */
export interface CardBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CardBase extends CardBounds {
  id: number;
  kind: CardKind;
  title: string;
  /** Stacking order; the highest value is the active card. */
  z: number;
  createdAt: number;
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

export interface MatrixCardModel extends CardBase {
  kind: 'matrix';
  /** All files loaded into this card. */
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
  /** Chart type plus its attached columns and presentation options. */
  config: ChartConfig;
  smoothing: SmoothingOptions;
}

export type CardModel = MatrixCardModel | ChartCardModel;

export function isMatrixCard(card: CardModel): card is MatrixCardModel {
  return card.kind === 'matrix';
}

export function isChartCard(card: CardModel): card is ChartCardModel {
  return card.kind === 'chart';
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
  version: 1;
  savedAt: string;
  cards: CardSnapshot[];
  matrices: MatrixSnapshot[];
  nextCardId: number;
  nextMatrixId: number;
}

export type { ChartConfig, ChartSource, ChartTypeId };

