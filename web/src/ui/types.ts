/**
 * Card-layer types.
 *
 * These mirror the Qt widget layer (`src/widgets/BaseCard.h`, `MatrixCard.h`,
 * `ChartCard.h`) but expressed as plain data: a card is a record in the store, and a
 * React component renders it. Keeping cards as data (rather than classes) is what
 * makes the workspace persistable and the dependency graph easy to reason about.
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
  /** Display name — the file name. */
  name: string;
  matrixId: number;
}

export interface MatrixCardModel extends CardBase {
  kind: 'matrix';
  /** All files loaded into this card. */
  sources: MatrixSource[];
  /** Index into `sources` of the file currently displayed. */
  activeSource: number;
  /** File-backed tables are read-only, matching the Qt frontend. */
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

