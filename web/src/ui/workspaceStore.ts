/**
 * Workspace store.
 *
 * Holds everything the Qt `MainWindow` + `CardRegistry` used to own: the set of
 * cards, their geometry and stacking order, the parsed matrices behind each matrix
 * card, the dependency graph, and the transient status line.
 *
 * Two invariants carry over from the C++ implementation:
 *   1. A matrix card whose matrix still has dependents cannot be closed
 *      (`DependencyGraph::hasDependents`) — the UI blinks the offending lines.
 *   2. Switching the active file inside a matrix card pushes fresh column data into
 *      every dependent chart; if the column no longer exists the line keeps its old
 *      data rather than disappearing.
 */
import { create } from 'zustand';

import { DependencyGraph } from '../core/DependencyGraph.ts';
import { MatrixData } from '../core/MatrixData.ts';
import { DEFAULT_SMOOTHING, type SmoothingOptions } from '../core/Smoothing.ts';
import { defaultChartConfig, type ChartConfig, type ChartSource } from '../charts/chartModel.ts';
import { chartTypeDef, minimumColumns, type ChartTypeId } from '../charts/chartTypes.ts';
import { lineColor } from '../charts/palette.ts';
import {
  isChartCard,
  isMatrixCard,
  type CardModel,
  type ChartCardModel,
  type MatrixCardModel,
  type MatrixSnapshot,
  type WorkspaceSnapshot,
} from './types.ts';
import { createTranslator, detectLocale, type Locale, type MessageKey } from './i18n.ts';

export { lineColor };

/**
 * Display label for a column: the file's annotation when present, otherwise `Pos.N`.
 * Shared by every place that materialises a `ChartSource`.
 */
function columnLabel(column: { posName: string; annotation: string }): string {
  return column.annotation !== '' ? `${column.posName} ${column.annotation}` : column.posName;
}

/** Minimum card footprint, in px (the Qt cards had a 300×200 minimum). */
export const MIN_CARD_WIDTH = 280;
export const MIN_CARD_HEIGHT = 180;

/** Deliberately coarse epsilon: float noise from drag/resize must not re-render. */
const GEOM_EPSILON = 0.01;

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  message: string;
}

interface WorkspaceState {
  cards: CardModel[];
  /** Parsed matrices by id. Kept outside the cards so charts can share them. */
  matrices: Map<number, MatrixData>;
  /** file name -> matrix id, so re-opening the same file reuses the parse. */
  matrixIdByFile: Map<string, number>;
  selectedId: number | null;
  dependencies: DependencyGraph;
  /** Card that should blink because a close was blocked. */
  blockedCardId: number | null;
  /**
   * Increments on every refused close. The blink animation keys off this so that
   * blocking the same card twice in a row restarts the flash.
   */
  blockNonce: number;
  toast: Toast | null;
  locale: Locale;
  nextCardId: number;
  nextMatrixId: number;

  // ── card lifecycle ──────────────────────────────────────────────────
  addMatrixCard: (entries: Array<{ name: string; matrix: MatrixData }>) => number;
  addChartCard: (matrixCardId: number, columnIndex: number, chartType?: ChartTypeId) => number | null;
  removeCard: (id: number) => boolean;
  closeAllCards: () => void;
  setBounds: (id: number, bounds: { x: number; y: number; width: number; height: number }) => void;
  bringToFront: (id: number) => void;
  select: (id: number | null) => void;

  // ── matrix card behaviour ───────────────────────────────────────────
  setActiveSource: (cardId: number, index: number) => void;

  // ── chart card behaviour ────────────────────────────────────────────
  setSmoothing: (cardId: number, options: SmoothingOptions) => void;
  /** Change the chart type, growing the source list if the new type needs more columns. */
  setChartType: (cardId: number, type: ChartTypeId) => void;
  /** Patch presentation options (log axis, dual axis, fit line, bins, …). */
  setChartConfig: (cardId: number, patch: Partial<ChartConfig>) => void;
  addChartSource: (cardId: number, matrixId: number, columnIndex: number) => void;
  removeChartSource: (cardId: number, matrixId: number, columnIndex: number) => void;

  // ── view helpers ────────────────────────────────────────────────────
  tileCards: (viewportWidth: number, viewportHeight: number) => void;
  cascadeCards: () => void;

  // ── misc ────────────────────────────────────────────────────────────
  setLocale: (locale: Locale) => void;
  /** Flag a card as "cannot close", restarting the connection blink. */
  blockCard: (id: number) => void;
  showToast: (kind: Toast['kind'], message: string) => void;
  clearToast: () => void;

  // ── persistence ─────────────────────────────────────────────────────
  toSnapshot: () => WorkspaceSnapshot;
  loadSnapshot: (snapshot: WorkspaceSnapshot) => void;
  /** Return the store to its initial state (used by tests and "close all"). */
  reset: () => void;
}

let toastCounter = 0;

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < GEOM_EPSILON;
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Highest z currently in use, so new cards land on top. */
  const topZ = (): number =>
    get().cards.reduce((max, card) => Math.max(max, card.z), 0);

  /**
   * Push fresh column data into every chart that reads data from `matrixCardId`.
   *
   * Dependencies are registered against the *card* (chart → matrix card) rather than
   * the parsed matrix id, because a matrix card owns several matrices when it holds
   * several files. Switching the active file therefore re-points each dependent line
   * at the newly active matrix — the behaviour the Qt frontend wanted but could not
   * express, since its `SourceRef` captured a matrix id.
   *
   * A line keeps its previous data when the new file no longer has that column.
   */
  const refreshDependentCharts = (matrixCardId: number): void => {
    const state = get();
    const matrixCard = state.cards.find((c) => c.id === matrixCardId);
    if (!matrixCard || !isMatrixCard(matrixCard)) return;

    const active = matrixCard.sources[matrixCard.activeSource];
    if (!active) return;
    const activeMatrix = state.matrices.get(active.matrixId);
    if (!activeMatrix) return;

    const matrixIds = new Set(matrixCard.sources.map((source) => source.matrixId));
    const dependentIds = new Set(state.dependencies.getDependents(matrixCardId));
    if (dependentIds.size === 0) return;

    set((current) => ({
      cards: current.cards.map((card) => {
        if (!isChartCard(card) || !dependentIds.has(card.id)) return card;

        let changed = false;
        const sources = card.config.sources.map((source) => {
          // Only sources that actually read this card's data are re-pointed.
          if (!matrixIds.has(source.matrixId)) return source;
          changed = true;
          // Column vanished in the new file: re-point but keep the old values so the
          // curve does not silently disappear.
          if (source.columnIndex >= activeMatrix.columnCount()) {
            return { ...source, matrixId: active.matrixId };
          }
          const column = activeMatrix.column(source.columnIndex);
          return {
            ...source,
            matrixId: active.matrixId,
            raw: column.data.slice(),
            label: columnLabel(column),
          };
        });

        return changed ? { ...card, config: { ...card.config, sources } } : card;
      }),
    }));
  };

  return {
    cards: [],
    matrices: new Map(),
    matrixIdByFile: new Map(),
    selectedId: null,
    dependencies: new DependencyGraph(),
    blockedCardId: null,
    blockNonce: 0,
    toast: null,
    locale: detectLocale(),
    nextCardId: 1,
    nextMatrixId: 1,

    // ── card lifecycle ────────────────────────────────────────────────

    addMatrixCard(entries) {
      if (entries.length === 0) return -1;
      const state = get();
      const cardId = state.nextCardId;
      const z = topZ() + 1;

      // Reuse already-parsed matrices by file name; allocate new ids otherwise.
      const matrices = new Map(state.matrices);
      const matrixIdByFile = new Map(state.matrixIdByFile);
      let nextMatrixId = state.nextMatrixId;
      const sources: Array<{ name: string; matrixId: number }> = [];

      for (const entry of entries) {
        const existing = matrixIdByFile.get(entry.name);
        if (existing !== undefined && matrices.has(existing)) {
          sources.push({ name: entry.name, matrixId: existing });
          continue;
        }
        const matrixId = nextMatrixId++;
        matrices.set(matrixId, entry.matrix);
        matrixIdByFile.set(entry.name, matrixId);
        sources.push({ name: entry.name, matrixId });
      }

      // Cascade placement, so stacked cards do not land exactly on top of each other.
      const offset = (state.cards.length % 8) * 28;
      const card: MatrixCardModel = {
        kind: 'matrix',
        id: cardId,
        title: '',
        x: 24 + offset,
        y: 24 + offset,
        width: 640,
        height: 420,
        z,
        createdAt: Date.now(),
        sources,
        activeSource: 0,
        readOnly: true,
      };

      set({
        cards: [...state.cards, card],
        matrices,
        matrixIdByFile,
        nextCardId: cardId + 1,
        nextMatrixId,
        selectedId: cardId,
      });
      return cardId;
    },

    addChartCard(matrixCardId, columnIndex, chartType) {
      const state = get();
      const matrixCard = state.cards.find((c) => c.id === matrixCardId);
      if (!matrixCard || !isMatrixCard(matrixCard)) return null;

      const source = matrixCard.sources[matrixCard.activeSource];
      if (!source) return null;
      const matrix = state.matrices.get(source.matrixId);
      if (!matrix) return null;
      if (columnIndex < 0 || columnIndex >= matrix.columnCount()) return null;

      const type: ChartTypeId = chartType ?? 'line';
      const def = chartTypeDef(type);

      // Attach the clicked column first, then as many following columns as the type
      // wants (a scatter needs an X and a Y, a heatmap wants a whole set).
      const wanted = Math.max(def.defaultColumnCount, minimumColumns(type));
      const sources: ChartSource[] = [];
      for (let offset = 0; offset < wanted; ++offset) {
        const index = columnIndex + offset;
        if (index >= matrix.columnCount()) break;
        const column = matrix.column(index);
        sources.push({
          matrixId: source.matrixId,
          columnIndex: index,
          label: columnLabel(column),
          raw: column.data.slice(),
        });
      }
      if (sources.length < minimumColumns(type)) return null;

      const cardId = state.nextCardId;
      const card: ChartCardModel = {
        kind: 'chart',
        id: cardId,
        title: '',
        // Offset from the source card so the new chart is visibly its child.
        x: matrixCard.x + matrixCard.width + 32,
        y: matrixCard.y + 24,
        width: 560,
        height: 400,
        z: topZ() + 1,
        createdAt: Date.now(),
        config: defaultChartConfig(type, sources),
        smoothing: { ...DEFAULT_SMOOTHING },
      };

      // The chart depends on the matrix *card*: this is what makes "switch file in the
      // table, chart follows" work even though each file is a separate matrix.
      state.dependencies.addDependency(cardId, matrixCardId);

      set({
        cards: [...state.cards, card],
        nextCardId: cardId + 1,
        selectedId: cardId,
      });
      return cardId;
    },

    removeCard(id) {
      const state = get();
      const card = state.cards.find((c) => c.id === id);
      if (!card) return true;

      // A matrix card that still feeds a chart must not disappear under it.
      if (isMatrixCard(card)) {
        if (state.dependencies.hasDependents(id)) {
          set({
            blockedCardId: id,
            blockNonce: state.blockNonce + 1,
            selectedId: id,
          });
          return false;
        }
      }

      const cards = state.cards.filter((c) => c.id !== id);
      const matrices = new Map(state.matrices);
      const matrixIdByFile = new Map(state.matrixIdByFile);

      if (isMatrixCard(card)) {
        for (const source of card.sources) {
          // Drop the parse only when no remaining card refers to it.
          const stillUsed = cards.some(
            (c) => isMatrixCard(c) && c.sources.some((s) => s.matrixId === source.matrixId),
          );
          if (!stillUsed) {
            matrices.delete(source.matrixId);
            matrixIdByFile.delete(source.name);
          }
        }
      }

      state.dependencies.removeAllDependencies(id);

      set({
        cards,
        matrices,
        matrixIdByFile,
        selectedId: state.selectedId === id ? null : state.selectedId,
        blockedCardId: state.blockedCardId === id ? null : state.blockedCardId,
      });
      return true;
    },

    closeAllCards() {
      set((state) => ({
        cards: [],
        matrices: new Map(),
        matrixIdByFile: new Map(),
        selectedId: null,
        blockedCardId: null,
        blockNonce: state.blockNonce + 1,
        dependencies: new DependencyGraph(),
      }));
    },

    setBounds(id, bounds) {
      set((state) => {
        const index = state.cards.findIndex((c) => c.id === id);
        if (index < 0) return state;
        const card = state.cards[index];
        const width = Math.max(MIN_CARD_WIDTH, bounds.width);
        const height = Math.max(MIN_CARD_HEIGHT, bounds.height);
        if (
          nearlyEqual(card.x, bounds.x) &&
          nearlyEqual(card.y, bounds.y) &&
          nearlyEqual(card.width, width) &&
          nearlyEqual(card.height, height)
        ) {
          return state; // unchanged — avoids a render loop with the drag handler
        }
        const next = state.cards.slice();
        next[index] = { ...card, x: bounds.x, y: bounds.y, width, height };
        return { ...state, cards: next };
      });
    },

    bringToFront(id) {
      set((state) => {
        const top = state.cards.reduce((max, c) => Math.max(max, c.z), 0);
        const index = state.cards.findIndex((c) => c.id === id);
        if (index < 0) return state;
        // Already on top and already selected -> nothing to do.
        if (state.cards[index].z === top && state.selectedId === id) return state;
        const next = state.cards.slice();
        next[index] = { ...state.cards[index], z: top + 1 };
        return { ...state, cards: next, selectedId: id };
      });
    },

    select(id) {
      set({ selectedId: id });
    },

    // ── matrix card behaviour ─────────────────────────────────────────

    setActiveSource(cardId, index) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isMatrixCard(card)) return;
      if (index < 0 || index >= card.sources.length || index === card.activeSource) return;

      set({
        cards: state.cards.map((c) =>
          c.id === cardId && isMatrixCard(c) ? { ...c, activeSource: index } : c,
        ),
      });

      // Charts that read this card must pick up the new file's data.
      refreshDependentCharts(cardId);
    },

    // ── chart card behaviour ──────────────────────────────────────────

    setSmoothing(cardId, options) {
      set((state) => ({
        cards: state.cards.map((card) =>
          card.id === cardId && isChartCard(card) ? { ...card, smoothing: options } : card,
        ),
      }));
    },

    setChartType(cardId, type) {
      const state = get();
      const card = state.cards.find((c) => c.id === cardId);
      if (!card || !isChartCard(card)) return;

      // Switching to a type that consumes more columns may require growing the source
      // list: pull further columns from the same matrix so the chart can draw at once.
      const def = chartTypeDef(type);
      const needed = Math.max(def.defaultColumnCount, minimumColumns(type));
      let sources = card.config.sources.slice();

      if (sources.length < needed) {
        const owner = state.cards.find(
          (c) =>
            isMatrixCard(c) &&
            c.sources.some((s) => s.matrixId === sources[0]?.matrixId),
        );
        if (owner && isMatrixCard(owner)) {
          const matrixId = sources[0]?.matrixId ?? owner.sources[owner.activeSource]?.matrixId;
          const matrix = matrixId !== undefined ? state.matrices.get(matrixId) : undefined;
          if (matrix) {
            // Append unused columns in index order.
            const used = new Set(sources.map((source) => source.columnIndex));
            for (let index = 0; index < matrix.columnCount() && sources.length < needed; ++index) {
              if (used.has(index)) continue;
              const column = matrix.column(index);
              sources.push({
                matrixId,
                columnIndex: index,
                label: columnLabel(column),
                raw: column.data.slice(),
              });
            }
          }
        }
      }

      set((current) => ({
        cards: current.cards.map((entry) =>
          entry.id === cardId && isChartCard(entry)
            ? { ...entry, config: { ...entry.config, type, sources } }
            : entry,
        ),
      }));
    },

    setChartConfig(cardId, patch) {
      set((state) => ({
        cards: state.cards.map((card) =>
          card.id === cardId && isChartCard(card)
            ? { ...card, config: { ...card.config, ...patch } }
            : card,
        ),
      }));
    },

    addChartSource(cardId, matrixId, columnIndex) {
      set((state) => ({
        cards: state.cards.map((card) => {
          if (card.id !== cardId || !isChartCard(card)) return card;
          // Never attach the same column twice.
          if (
            card.config.sources.some(
              (source) => source.matrixId === matrixId && source.columnIndex === columnIndex,
            )
          ) {
            return card;
          }
          const matrix = state.matrices.get(matrixId);
          if (!matrix || columnIndex < 0 || columnIndex >= matrix.columnCount()) return card;
          const column = matrix.column(columnIndex);
          const source: ChartSource = {
            matrixId,
            columnIndex,
            label: columnLabel(column),
            raw: column.data.slice(),
          };
          return {
            ...card,
            config: { ...card.config, sources: [...card.config.sources, source] },
          };
        }),
      }));
    },

    removeChartSource(cardId, matrixId, columnIndex) {
      set((state) => ({
        cards: state.cards.map((card) => {
          if (card.id !== cardId || !isChartCard(card)) return card;
          const sources = card.config.sources.filter(
            (source) => !(source.matrixId === matrixId && source.columnIndex === columnIndex),
          );
          // A chart with no columns has nothing to draw; keep at least one.
          if (sources.length === 0) return card;
          return { ...card, config: { ...card.config, sources } };
        }),
      }));
    },

    // ── view helpers ──────────────────────────────────────────────────

    tileCards(viewportWidth, viewportHeight) {
      const state = get();
      const count = state.cards.length;
      if (count === 0) return;

      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      const gap = 12;
      const pad = 12;
      const cellWidth = Math.max(MIN_CARD_WIDTH, (viewportWidth - pad * 2 - gap * (cols - 1)) / cols);
      const cellHeight = Math.max(
        MIN_CARD_HEIGHT,
        (viewportHeight - pad * 2 - gap * (rows - 1)) / rows,
      );

      const cards = state.cards.map((card, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        return {
          ...card,
          x: pad + col * (cellWidth + gap),
          y: pad + row * (cellHeight + gap),
          width: cellWidth,
          height: cellHeight,
        };
      });
      set({ cards });
    },

    cascadeCards() {
      const state = get();
      const cards = state.cards.map((card, index) => ({
        ...card,
        x: 24 + index * 28,
        y: 24 + index * 28,
        z: index + 1,
      }));
      set({ cards });
    },

    // ── misc ──────────────────────────────────────────────────────────

    setLocale(locale) {
      set({ locale });
    },

    blockCard(id) {
      set((state) => ({
        blockedCardId: id,
        blockNonce: state.blockNonce + 1,
        selectedId: id,
      }));
    },

    showToast(kind, message) {
      set({ toast: { id: ++toastCounter, kind, message } });
    },

    clearToast() {
      set({ toast: null });
    },

    // ── persistence ───────────────────────────────────────────────────

    toSnapshot() {
      const state = get();
      const matrices: MatrixSnapshot[] = [];
      for (const [id, matrix] of state.matrices) {
        const name = [...state.matrixIdByFile.entries()].find(([, mid]) => mid === id)?.[0] ?? `#${id}`;
        matrices.push({
          id,
          name,
          columns: matrix.columns().map((col) => ({
            posName: col.posName,
            annotation: col.annotation,
            data: col.data,
          })),
        });
      }
      return {
        version: 1,
        savedAt: new Date().toISOString(),
        cards: state.cards,
        matrices,
        nextCardId: state.nextCardId,
        nextMatrixId: state.nextMatrixId,
      };
    },

    loadSnapshot(snapshot) {
      const matrices = new Map<number, MatrixData>();
      const matrixIdByFile = new Map<string, number>();
      for (const entry of snapshot.matrices) {
        const matrix = new MatrixData();
        for (const col of entry.columns) {
          matrix.appendColumn(col.posName, col.data.slice());
          matrix.setColumnAnnotation(matrix.columnCount() - 1, col.annotation);
        }
        matrices.set(entry.id, matrix);
        matrixIdByFile.set(entry.name, entry.id);
      }

      // Rebuild the graph from the restored chart lines. A line references a parsed
      // matrix, so resolve it back to the matrix card that owns it.
      const dependencies = new DependencyGraph();
      for (const card of snapshot.cards) {
        if (!isChartCard(card)) continue;
        const ownerIds = new Set<number>();
        for (const source of card.config.sources) {
          const owner = snapshot.cards.find(
            (other) =>
              isMatrixCard(other) && other.sources.some((s) => s.matrixId === source.matrixId),
          );
          if (owner) ownerIds.add(owner.id);
        }
        for (const ownerId of ownerIds) dependencies.addDependency(card.id, ownerId);
      }

      set({
        cards: snapshot.cards,
        matrices,
        matrixIdByFile,
        dependencies,
        nextCardId: snapshot.nextCardId,
        nextMatrixId: snapshot.nextMatrixId,
        selectedId: null,
        blockedCardId: null,
        blockNonce: 1,
      });
    },

    reset() {
      set({
        cards: [],
        matrices: new Map(),
        matrixIdByFile: new Map(),
        selectedId: null,
        dependencies: new DependencyGraph(),
        blockedCardId: null,
        blockNonce: 0,
        toast: null,
        nextCardId: 1,
        nextMatrixId: 1,
      });
    },
  };
});

// ── Selectors ─────────────────────────────────────────────────────────────

export function useTranslator() {
  const locale = useWorkspace((s) => s.locale);
  const t = createTranslator(locale);
  return { t: (key: MessageKey, params?: Record<string, string | number>) => t(key, params), locale };
}

export function useCard(id: number): CardModel | undefined {
  return useWorkspace((s) => s.cards.find((c) => c.id === id));
}

export function useMatrix(matrixId: number): MatrixData | undefined {
  return useWorkspace((s) => s.matrices.get(matrixId));
}
