/**
 * Workspace snapshot migration (schema v1 → v2).
 *
 * The v2 schema (docs/decisions/2026-10-26-card-schema-v2.md) moves dependencies onto the
 * card envelope (`inputs[]`), makes every reference an explicit matrix, and turns a
 * function card into one node with K outputs. Snapshots written before that change are
 * still on users' disks, so reading one has to be a **pure, deterministic** upgrade —
 * never a silent reinterpretation. Two behaviours are deliberate:
 *
 *   1. A v1 formula card followed its source card's *active file*. That is frozen here, at
 *      migration time, into one explicit `matrixId`. From then on switching the source
 *      table's file no longer changes what the function card reads; re-pointing is an
 *      explicit operation. (This is the documented behaviour change, not an accident.)
 *   2. `nodes[]` (one node per formula column) collapses into a single node: any error
 *      wins, then computing, then done, otherwise "not registered yet". The per-column
 *      result matrices disappear with it — the surviving output is the card-level table.
 *
 * Everything here is total for a well-formed v1 file and throws `WorkspaceFormatError`
 * with a human-readable reason otherwise; `readWorkspace` surfaces that as a load failure.
 */
import { SOURCE_PORT } from './bindings.ts';
import type {
  CardModel,
  ChartCardModel,
  FormulaColumn,
  MatrixCardModel,
  MatrixSnapshot,
  OutputBinding,
  PortConnection,
  WorkspaceSnapshot,
} from './types.ts';

export class WorkspaceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceFormatError';
  }
}

/** The signature every migrated formula card lands on. */
export const EXPRESSION_COLUMNS_SIGNATURE = 'builtin:expression-columns';
/** Second built-in: two cell ports, no formula parameters, signature-fixed output shape. */
export const REGRESSION_SIGNATURE = 'builtin:linear-regression';

/**
 * Port id a function card uses for its single matrix input.
 *
 * Re-exported from `bindings.ts` so there is exactly one definition of the identity the
 * port-semantics spec locks in (a second spelling of "src" is how the v1 positional
 * convention would sneak back in).
 */
export { SOURCE_PORT as INPUT_PORT_SOURCE } from './bindings.ts';

/**
 * Stable port id for one attached chart column.
 *
 * Derived from the column's identity (matrix + column index), never from its position in
 * the list — removing the middle column must not rename the ones after it.
 */
export function chartPortId(matrixId: number, column: number): string {
  return `src:${matrixId}:${column}`;
}

/** Port id a chart card uses for its explicit X axis. */
export const CHART_PORT_X = 'x';

interface CardBaseShape {
  id: number;
  kind: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  createdAt: number;
}

interface V1MatrixCard extends CardBaseShape {
  kind: 'matrix';
  sources: Array<{ name: string; matrixId: number }>;
  activeSource: number;
  readOnly: boolean;
}

interface V1ChartCard extends CardBaseShape {
  kind: 'chart';
  config: { sources: Array<{ matrixId: number; columnIndex: number }>; xAxisSource?: { matrixId: number; columnIndex: number } | null };
}

interface V1NodeStatus {
  nodeId: number;
  resultMatrixId: number;
  state: 'dirty' | 'computing' | 'done' | 'error';
  code?: string;
  params?: Record<string, unknown>;
}

interface V1FormulaCard extends CardBaseShape {
  kind: 'formula';
  sourceCardId: number;
  formulas: FormulaColumn[];
  resultMatrixId: number;
  nodes: Array<V1NodeStatus | null>;
}

type V1Card = V1MatrixCard | V1ChartCard | V1FormulaCard;

/** Merge the v1 per-column node statuses into one node status (worst case wins). */
function mergeNodeStatus(nodes: Array<V1NodeStatus | null>): V1NodeStatus | null {
  const present = nodes.filter((n): n is V1NodeStatus => n !== null);
  if (present.length === 0) return null;
  const error = present.find((n) => n.state === 'error');
  if (error) return error;
  const computing = present.find((n) => n.state === 'computing');
  if (computing) return { ...computing, state: 'computing' };
  const allDone = present.length === nodes.length && present.every((n) => n.state === 'done');
  return {
    ...present[0],
    state: allDone ? 'done' : 'dirty',
  };
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Owner matrix card of a local matrix id, or null when no restored card owns it. */
function ownerCardOfMatrix(cards: V1Card[], matrixId: number): V1MatrixCard | null {
  for (const card of cards) {
    if (card.kind !== 'matrix') continue;
    if (card.sources.some((source) => source.matrixId === matrixId)) return card;
  }
  return null;
}

function migrateChart(card: V1ChartCard, cards: V1Card[]): CardModel {
  const inputs: PortConnection[] = [];
  const sources = Array.isArray(card.config?.sources) ? card.config.sources : [];
  sources.forEach((source) => {
    const owner = ownerCardOfMatrix(cards, asNumber(source.matrixId, -1));
    if (!owner) return; // unresolvable reference: keep the display view, add no edge
    inputs.push({
      portId: chartPortId(asNumber(source.matrixId, -1), asNumber(source.columnIndex, 0)),
      target: {
        type: 'cell',
        cardId: owner.id,
        matrixId: asNumber(source.matrixId, -1),
        column: asNumber(source.columnIndex, 0),
      },
    });
  });
  const x = card.config?.xAxisSource;
  if (x) {
    const owner = ownerCardOfMatrix(cards, asNumber(x.matrixId, -1));
    if (owner) {
      inputs.push({
        portId: CHART_PORT_X,
        target: {
          type: 'cell',
          cardId: owner.id,
          matrixId: asNumber(x.matrixId, -1),
          column: asNumber(x.columnIndex, 0),
        },
      });
    }
  }

  // Spread the original so presentation fields (smoothing, columnPanelOpen, …) survive;
  // v1 charts have no `inputs`, which is exactly what gets added here.
  const base = card as unknown as ChartCardModel;
  return { ...base, inputs };
}

function migrateFormula(card: V1FormulaCard, cards: V1Card[]): CardModel {
  const inputs: PortConnection[] = [];
  const sourceCard = cards.find((c) => c.id === card.sourceCardId);
  if (sourceCard && sourceCard.kind === 'matrix') {
    const active = sourceCard.sources[sourceCard.activeSource] ?? sourceCard.sources[0];
    if (active) {
      // Freeze the matrix that was feeding this card at migration time.
      inputs.push({
        portId: SOURCE_PORT,
        target: { type: 'matrix', cardId: sourceCard.id, matrixId: active.matrixId },
      });
    }
  }

  const merged = mergeNodeStatus(Array.isArray(card.nodes) ? card.nodes : []);
  const formulas = Array.isArray(card.formulas) ? card.formulas : [];
  const outputs: OutputBinding[] = [
    { outputId: 'result', resultMatrixId: merged ? asNumber(merged.resultMatrixId, -1) : -1 },
  ];

  return {
    kind: 'formula',
    id: card.id,
    title: card.title,
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
    z: card.z,
    createdAt: card.createdAt,
    inputs,
    signatureId: EXPRESSION_COLUMNS_SIGNATURE,
    params: {
      formulas: formulas.map((f) => ({
        name: asString(f.name),
        expression: asString(f.expression),
      })),
    },
    outputs,
    node: merged
      ? {
          nodeId: merged.nodeId,
          state: merged.state,
          ...(merged.code !== undefined ? { code: merged.code } : {}),
          ...(merged.params !== undefined ? { params: merged.params } : {}),
        }
      : null,
    displayMatrixId: asNumber(card.resultMatrixId, -1),
    // Display state, not a definition: a restored workspace re-pulls the preview.
    result: null,
  };
}

function migrateCard(raw: unknown, cards: V1Card[]): CardModel {
  if (typeof raw !== 'object' || raw === null) {
    throw new WorkspaceFormatError('card is not an object');
  }
  const card = raw as V1Card;
  if (typeof card.id !== 'number' || typeof card.kind !== 'string') {
    throw new WorkspaceFormatError('card is missing id/kind');
  }
  if (card.kind === 'matrix') {
    // A data source depends on nothing; `sources[]` is content, not an edge.
    return { ...(card as unknown as MatrixCardModel), inputs: [] };
  }
  if (card.kind === 'chart') return migrateChart(card, cards);
  if (card.kind === 'formula') return migrateFormula(card, cards);
  throw new WorkspaceFormatError(`unknown card kind "${String((raw as { kind: unknown }).kind)}"`);
}

function migrateMatrices(raw: unknown): MatrixSnapshot[] {
  if (!Array.isArray(raw)) throw new WorkspaceFormatError('workspace is missing matrices');
  return raw.map((entry) => {
    const item = entry as Partial<MatrixSnapshot>;
    if (typeof item.id !== 'number' || !Array.isArray(item.columns)) {
      throw new WorkspaceFormatError('matrix entry is malformed');
    }
    return {
      id: item.id,
      name: typeof item.name === 'string' ? item.name : `#${item.id}`,
      columns: item.columns.map((col) => ({
        posName: asString(col?.posName),
        annotation: asString(col?.annotation),
        data: Array.isArray(col?.data) ? col.data.map((v) => (typeof v === 'number' ? v : Number(v))) : [],
      })),
    };
  });
}

/**
 * Upgrade a parsed workspace file to schema v2. v2 input passes through unchanged (only
 * shape-validated); v1 input is migrated. Any other version is refused.
 */
export function migrateWorkspace(raw: unknown): WorkspaceSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    throw new WorkspaceFormatError('workspace file is not a JSON object');
  }
  const snapshot = raw as { version?: unknown; cards?: unknown; matrices?: unknown };
  const version = snapshot.version;

  if (version === 2) {
    if (!Array.isArray(snapshot.cards)) throw new WorkspaceFormatError('workspace is missing cards');
    return {
      version: 2,
      savedAt: asString((raw as { savedAt?: unknown }).savedAt, new Date().toISOString()),
      cards: snapshot.cards as CardModel[],
      matrices: migrateMatrices(snapshot.matrices),
      nextCardId: asNumber((raw as { nextCardId?: unknown }).nextCardId, 1),
      nextMatrixId: asNumber((raw as { nextMatrixId?: unknown }).nextMatrixId, 1),
    };
  }

  if (version !== 1) {
    throw new WorkspaceFormatError(`Unsupported workspace version: ${String(version)}`);
  }
  if (!Array.isArray(snapshot.cards)) throw new WorkspaceFormatError('workspace is missing cards');

  const v1Cards = snapshot.cards as V1Card[];
  const cards = v1Cards.map((card) => migrateCard(card, v1Cards));
  return {
    version: 2,
    savedAt: asString((raw as { savedAt?: unknown }).savedAt, new Date().toISOString()),
    cards,
    matrices: migrateMatrices(snapshot.matrices),
    nextCardId: asNumber((raw as { nextCardId?: unknown }).nextCardId, 1),
    nextMatrixId: asNumber((raw as { nextMatrixId?: unknown }).nextMatrixId, 1),
  };
}
