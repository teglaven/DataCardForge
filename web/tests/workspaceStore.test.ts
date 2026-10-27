/**
 * Workspace store behaviour.
 *
 * These tests lock in the interaction rules carried over from the Qt frontend:
 *   - one matrix card holds many files, switched by index,
 *   - a chart card is created from a column and registers a dependency,
 *   - switching the active file refreshes dependent charts,
 *   - a matrix with dependents cannot be closed,
 *   - everything round-trips through the workspace snapshot.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import {
  isChartCard,
  isMatrixCard,
  type ChartCardModel,
  type FunctionCardModel,
  type MatrixCardModel,
} from '../src/ui/types.ts';
import { decodeMatrixFrame } from '../src/backend/client.ts';

/**
 * Build a matrix from row-major data, mirroring how a text file is laid out.
 * Column-oriented storage is an internal detail, so tests express data as rows.
 */
function matrix(rows: number[][], annotations: string[] = []): MatrixData {
  const mat = new MatrixData();
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (let c = 0; c < columnCount; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, rows.map((row) => row[c] ?? NaN));
    if (annotations[c]) mat.setColumnAnnotation(c, annotations[c]);
  }
  return mat;
}

const store = () => useWorkspace.getState();

beforeEach(() => {
  store().reset();
});

describe('addMatrixCard', () => {
  it('creates one card holding all given files', () => {
    const id = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1], [2]]) },
      { name: '2.txt', matrix: matrix([[3], [4]]) },
    ]);

    const card = store().cards.find((c) => c.id === id) as MatrixCardModel;
    expect(card.kind).toBe('matrix');
    expect(card.sources.map((s) => s.name)).toEqual(['1.txt', '2.txt']);
    expect(card.activeSource).toBe(0);
    expect(card.readOnly).toBe(true);
    expect(store().selectedId).toBe(id);
  });

  it('reuses a parse when the same bytes are opened again', () => {
    const identity = { size: 1024, lastModified: 1_700_000_000_000 };
    const first = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1], [2]]), identity },
    ]);
    const second = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1], [2]]), identity },
    ]);

    const a = store().cards.find((c) => c.id === first) as MatrixCardModel;
    const b = store().cards.find((c) => c.id === second) as MatrixCardModel;
    expect(b.sources[0].matrixId).toBe(a.sources[0].matrixId);
    expect(store().matrices.size).toBe(1);
  });

  it('does NOT reuse a parse for a different file that shares the name', () => {
    // The bug this locks out: `export.csv` overwritten daily. Keying the cache on the
    // file name returned yesterday's measurements under today's label — silently stale
    // data in a scientific tool. Identity is the bytes, never the label.
    const cardA = store().addMatrixCard([
      { name: 'export.csv', matrix: matrix([[1], [2]]), identity: { size: 100, lastModified: 1 } },
    ]);
    const cardB = store().addMatrixCard([
      { name: 'export.csv', matrix: matrix([[9], [9]]), identity: { size: 250, lastModified: 2 } },
    ]);

    const a = store().cards.find((c) => c.id === cardA) as MatrixCardModel;
    const b = store().cards.find((c) => c.id === cardB) as MatrixCardModel;
    expect(b.sources[0].matrixId).not.toBe(a.sources[0].matrixId);
    expect(store().matrices.size).toBe(2);
    // Each card keeps its own values.
    expect(store().matrices.get(b.sources[0].matrixId)!.cell(0, 0)).toBe(9);
    expect(store().matrices.get(a.sources[0].matrixId)!.cell(0, 0)).toBe(1);
  });

  it('treats an entry with no identity as unshareable', () => {
    // Programmatically built tables and restored snapshots have no backing bytes, so
    // they must not be deduplicated against each other by coincidence of name.
    store().addMatrixCard([{ name: 'x.txt', matrix: matrix([[1]]) }]);
    store().addMatrixCard([{ name: 'x.txt', matrix: matrix([[2]]) }]);
    expect(store().matrices.size).toBe(2);
  });

  it('places each new card at a different offset', () => {
    const a = store().addMatrixCard([{ name: 'a.txt', matrix: matrix([[1]]) }]);
    const b = store().addMatrixCard([{ name: 'b.txt', matrix: matrix([[1]]) }]);
    const cardA = store().cards.find((c) => c.id === a)!;
    const cardB = store().cards.find((c) => c.id === b)!;
    expect(cardB.x).not.toBe(cardA.x);
    expect(cardB.z).toBeGreaterThan(cardA.z);
  });
});

describe('addChartCard', () => {
  it('creates a chart from a column and registers the dependency', () => {
    const matrixId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2], [3, 4]], ['a', 'b']) },
    ]);
    const chartId = store().addChartCard(matrixId, 1)!;

    const card = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(card.kind).toBe('chart');
    expect(card.config.sources).toHaveLength(1);
    expect(card.config.sources[0].raw).toEqual([2, 4]);
    expect(card.config.sources[0].label).toBe('Pos.2 b');

    const matrixCard = store().cards.find((c) => c.id === matrixId) as MatrixCardModel;
    expect(matrixCard.sources[0].matrixId).toBe(1);
    // The dependency is registered against the matrix *card*, not the parsed matrix.
    expect(store().dependencies.getDependents(matrixId)).toEqual([chartId]);
  });

  it('refuses an out-of-range column', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    expect(store().addChartCard(cardId, 5)).toBeNull();
    expect(store().addChartCard(999, 0)).toBeNull();
  });
});

describe('setActiveSource refreshes dependent charts', () => {
  it('pushes the new file data into charts reading that matrix', () => {
    const cardId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2], [3, 4]]) },
      { name: '2.txt', matrix: matrix([[10, 20], [30, 40]]) },
    ]);
    const chartId = store().addChartCard(cardId, 0)!;
    const before = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(before.config.sources[0].raw).toEqual([1, 3]);

    store().setActiveSource(cardId, 1);

    const after = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(after.config.sources[0].raw).toEqual([10, 30]);
  });

  it('keeps the old data when the column no longer exists', () => {
    const cardId = store().addMatrixCard([
      { name: 'wide.txt', matrix: matrix([[1, 2, 3], [4, 5, 6]]) },
      { name: 'narrow.txt', matrix: matrix([[7], [8]]) },
    ]);
    const chartId = store().addChartCard(cardId, 2)!;

    store().setActiveSource(cardId, 1);

    const chart = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    // Column 2 is gone in the narrow file: the line keeps its previous values but
    // follows the newly active matrix so a later switch back stays consistent.
    expect(chart.config.sources[0].raw).toEqual([3, 6]);
    expect(chart.config.sources[0].matrixId).toBe(2);
    expect(chart.config.sources[0].label).toBe('Pos.3');
  });

  it('ignores an invalid or unchanged index', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    store().setActiveSource(cardId, 0);
    store().setActiveSource(cardId, 99);
    const card = store().cards.find((c) => c.id === cardId) as MatrixCardModel;
    expect(card.activeSource).toBe(0);
  });
});

describe('close rules', () => {
  it('allows closing a matrix card that nothing depends on', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    expect(store().removeCard(cardId)).toBe(true);
    expect(store().cards).toHaveLength(0);
    expect(store().matrices.size).toBe(0);
  });

  it('refuses to close a matrix that still feeds a chart, and flags the block', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1, 2]]) }]);
    store().addChartCard(cardId, 0);
    const nonceBefore = store().blockNonce;

    expect(store().removeCard(cardId)).toBe(false);
    expect(store().cards).toHaveLength(2);
    expect(store().blockedCardId).toBe(cardId);
    expect(store().blockNonce).toBe(nonceBefore + 1);
  });

  it('allows the close once the dependent chart is gone', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1, 2]]) }]);
    const chartId = store().addChartCard(cardId, 0)!;

    expect(store().removeCard(chartId)).toBe(true);
    expect(store().removeCard(cardId)).toBe(true);
    expect(store().cards).toHaveLength(0);
    // The parsed matrix is released with its last owner.
    expect(store().matrices.size).toBe(0);
  });

  it('keeps a shared matrix alive until its last owning card closes', () => {
    // Two cards over the same bytes share one parsed matrix id.
    const identity = { size: 64, lastModified: 99 };
    const entries = () => [{ name: '1.txt', matrix: matrix([[1, 2]]), identity }];
    const first = store().addMatrixCard(entries());
    const second = store().addMatrixCard(entries());
    expect(store().matrices.size).toBe(1);

    expect(store().removeCard(first)).toBe(true);
    expect(store().matrices.size).toBe(1);

    expect(store().removeCard(second)).toBe(true);
    expect(store().matrices.size).toBe(0);
  });

  it('prunes the identity cache so re-dropping the file re-parses it', () => {
    const identity = { size: 64, lastModified: 99 };
    const first = store().addMatrixCard([
      { name: 'a.txt', matrix: matrix([[1]]), identity },
    ]);
    store().removeCard(first);

    // Same bytes again must NOT alias to the freed matrix.
    const again = store().addMatrixCard([
      { name: 'a.txt', matrix: matrix([[7]]), identity },
    ]);
    const card = store().cards.find((c) => c.id === again) as MatrixCardModel;
    expect(store().matrices.get(card.sources[0].matrixId)!.cell(0, 0)).toBe(7);
  });
});

describe('blockCard', () => {
  it('bumps the nonce so repeated refusals re-trigger the blink', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    const before = store().blockNonce;
    store().blockCard(cardId);
    store().blockCard(cardId);
    expect(store().blockNonce).toBe(before + 2);
    expect(store().selectedId).toBe(cardId);
  });
});

describe('setBounds', () => {
  it('clamps to the minimum card size', () => {
    const id = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    store().setBounds(id, { x: 5, y: 6, width: 10, height: 10 });
    const card = store().cards.find((c) => c.id === id)!;
    expect(card.x).toBe(5);
    expect(card.width).toBeGreaterThanOrEqual(280);
    expect(card.height).toBeGreaterThanOrEqual(180);
  });

  it('ignores sub-pixel noise so drag handlers cannot loop', () => {
    const id = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1]]) }]);
    const before = store().cards.find((c) => c.id === id)!;
    store().setBounds(id, {
      x: before.x + 0.001,
      y: before.y,
      width: before.width,
      height: before.height,
    });
    const after = store().cards.find((c) => c.id === id)!;
    expect(after).toBe(before); // identical object reference => no re-render
  });
});

describe('tile and cascade', () => {
  it('lays cards out in a grid that fits the viewport', () => {
    for (let i = 0; i < 4; ++i) {
      store().addMatrixCard([{ name: `${i}.txt`, matrix: matrix([[1]]) }]);
    }
    store().tileCards(1200, 800);
    const cards = store().cards;
    expect(new Set(cards.map((c) => `${c.x}:${c.y}`)).size).toBe(4);
    for (const card of cards) {
      expect(card.x + card.width).toBeLessThanOrEqual(1200);
      expect(card.y + card.height).toBeLessThanOrEqual(800);
    }
  });

  it('cascades with a fixed offset per card', () => {
    for (let i = 0; i < 3; ++i) {
      store().addMatrixCard([{ name: `${i}.txt`, matrix: matrix([[1]]) }]);
    }
    store().cascadeCards();
    const cards = store().cards;
    expect(cards[0].x).toBe(24);
    expect(cards[1].x).toBe(52);
    expect(cards[2].z).toBe(3);
  });
});

describe('snapshot round-trip', () => {
  it('restores cards, matrices and the dependency graph', () => {
    const cardId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2], [3, 4]], ['a', 'b']) },
    ]);
    store().addChartCard(cardId, 0);
    store().setSmoothing(2, { mode: 'median', window: 5, alpha: 0.4, degree: 3 });

    const snapshot = store().toSnapshot();
    store().reset();
    expect(store().cards).toHaveLength(0);

    store().loadSnapshot(snapshot);

    expect(store().cards).toHaveLength(2);
    expect(store().matrices.size).toBe(1);

    const restoredMatrix = store().matrices.get(1)!;
    expect(restoredMatrix.cell(1, 1)).toBe(4);
    expect(restoredMatrix.column(1).annotation).toBe('b');

    const chart = store().cards.find((c) => isChartCard(c)) as ChartCardModel;
    expect(chart.config.sources[0].raw).toEqual([1, 3]);
    expect(chart.smoothing.mode).toBe('median');
    expect(chart.smoothing.window).toBe(5);

    // The dependency graph is rebuilt from the restored lines.
    const matrixCard = store().cards.find((c) => isMatrixCard(c)) as MatrixCardModel;
    expect(store().dependencies.getDependents(matrixCard.id)).toEqual([chart.id]);
  });

  it('serialises cleanly to JSON', () => {
    store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1.5, 2.5]]) }]);
    const text = JSON.stringify(store().toSnapshot());
    expect(text).not.toContain('Infinity');
    expect(JSON.parse(text).version).toBe(2);
  });

  it('round-trips the column dock state and the chart→matrix edge', () => {
    const matrixCardId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2, 3], [4, 5, 6]]) },
    ]);
    const chartId = store().addChartCard(matrixCardId, 0)!;
    const matrixId = (store().cards.find((c) => c.id === matrixCardId) as MatrixCardModel).sources[0].matrixId;
    store().addChartSource(chartId, matrixId, 1); // second column of the same owner
    store().setChartColumnPanel(chartId, true);

    const snapshot = store().toSnapshot();
    store().reset();
    expect(store().cards).toHaveLength(0);

    store().loadSnapshot(snapshot);

    const chart = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(chart.columnPanelOpen).toBe(true);
    expect(chart.config.sources).toHaveLength(2);
    // The card-level edge is rebuilt from the restored sources.
    expect(store().dependencies.getDependents(matrixCardId)).toEqual([chartId]);
    expect(store().dependencies.edgeCount()).toBe(1);

    // A snapshot written before the dock existed (no columnPanelOpen field) still loads,
    // with the flag normalised to false.
    const stripped = store().toSnapshot();
    for (const card of stripped.cards) {
      if (isChartCard(card)) delete (card as ChartCardModel).columnPanelOpen;
    }
    store().reset();
    store().loadSnapshot(stripped);
    expect((store().cards.find((c) => c.id === chartId) as ChartCardModel).columnPanelOpen).toBe(false);
    expect(store().dependencies.getDependents(matrixCardId)).toEqual([chartId]);
  });
});

// ── card-level connection lines: the store owns the chart→matrix-card edges ──
describe('addChartSource', () => {
  it('attaches a column and registers the chart→matrix-card edge', () => {
    const matrixCardId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2, 3], [4, 5, 6]]) },
    ]);
    const chartId = store().addChartCard(matrixCardId, 0)!;
    const matrixId = (store().cards.find((c) => c.id === matrixCardId) as MatrixCardModel).sources[0].matrixId;

    store().addChartSource(chartId, matrixId, 2);

    const chart = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(chart.config.sources).toHaveLength(2);
    expect(chart.config.sources[1].raw).toEqual([3, 6]);
    // One card-level edge: the owning matrix card is the dependents' target.
    expect(store().dependencies.hasDependents(matrixCardId)).toBe(true);
    expect(store().dependencies.getDependents(matrixCardId)).toEqual([chartId]);
    expect(store().dependencies.edgeCount()).toBe(1);
  });

  it('adds no duplicate source and no duplicate edge for the same column', () => {
    const matrixCardId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2, 3], [4, 5, 6]]) },
    ]);
    const chartId = store().addChartCard(matrixCardId, 0)!;
    const matrixId = (store().cards.find((c) => c.id === matrixCardId) as MatrixCardModel).sources[0].matrixId;

    store().addChartSource(chartId, matrixId, 1);
    store().addChartSource(chartId, matrixId, 1); // attaching twice is a no-op

    const chart = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(chart.config.sources).toHaveLength(2);
    expect(store().dependencies.edgeCount()).toBe(1);
    expect(store().dependencies.getDependents(matrixCardId)).toEqual([chartId]);
  });

  it('refuses a source whose matrix is unknown, adding neither source nor edge', () => {
    const matrixCardId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2]]) },
    ]);
    const chartId = store().addChartCard(matrixCardId, 0)!;

    store().addChartSource(chartId, 999999, 0);

    const chart = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(chart.config.sources).toHaveLength(1);
    expect(store().dependencies.edgeCount()).toBe(1); // only the addChartCard edge
    expect(store().dependencies.getDependents(matrixCardId)).toEqual([chartId]);
  });
});

describe('removeChartSource', () => {
  it("drops the edge when the owner's last attached source is removed", () => {
    const ownerA = store().addMatrixCard([
      { name: 'a.txt', matrix: matrix([[1, 2]]) },
    ]);
    const ownerB = store().addMatrixCard([
      { name: 'b.txt', matrix: matrix([[7]]) },
    ]);
    const chartId = store().addChartCard(ownerA, 0)!;
    const matrixA = (store().cards.find((c) => c.id === ownerA) as MatrixCardModel).sources[0].matrixId;
    const matrixB = (store().cards.find((c) => c.id === ownerB) as MatrixCardModel).sources[0].matrixId;
    // A second source from another owner keeps the chart above its one-column floor,
    // so removing the last A source is allowed.
    store().addChartSource(chartId, matrixB, 0);

    expect(store().dependencies.getDependents(ownerA)).toEqual([chartId]);
    expect(store().dependencies.hasDependents(ownerB)).toBe(true);

    store().removeChartSource(chartId, matrixA, 0);

    const chart = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(chart.config.sources.map((s) => s.matrixId)).toEqual([matrixB]);
    expect(chart.config.xAxisSource).toBeNull();
    expect(store().dependencies.hasDependents(ownerA)).toBe(false);
    expect(store().dependencies.getDependents(ownerB)).toEqual([chartId]);
    expect(store().dependencies.edgeCount()).toBe(1);
  });

  it('keeps the edge while a source or the X axis still reads the owner, drops it otherwise', () => {
    const ownerA = store().addMatrixCard([
      { name: 'a.txt', matrix: matrix([[1, 2, 3], [4, 5, 6]]) },
    ]);
    const ownerB = store().addMatrixCard([
      { name: 'b.txt', matrix: matrix([[7]]) },
    ]);
    const chartId = store().addChartCard(ownerA, 0)!;
    const matrixA = (store().cards.find((c) => c.id === ownerA) as MatrixCardModel).sources[0].matrixId;
    const matrixB = (store().cards.find((c) => c.id === ownerB) as MatrixCardModel).sources[0].matrixId;
    store().addChartSource(chartId, matrixA, 1); // two sources of the same matrix
    store().addChartSource(chartId, matrixB, 0); // keeps the floor satisfied after the last A removal
    const columnA1 = store().matrices.get(matrixA)!.column(1);
    store().setChartConfig(chartId, {
      xAxisSource: {
        matrixId: matrixA,
        columnIndex: 1,
        label: columnA1.posName,
        raw: columnA1.data.slice(),
      },
    });

    // Remove the first source: the second one still reads the owner → edge stays.
    store().removeChartSource(chartId, matrixA, 0);
    expect(store().dependencies.hasDependents(ownerA)).toBe(true);

    // Remove the second source: the X axis pointed at it and is invalidated with it, so
    // nothing of the owner's matrices is left → edge gone.
    store().removeChartSource(chartId, matrixA, 1);
    const chart = store().cards.find((c) => c.id === chartId) as ChartCardModel;
    expect(chart.config.sources.map((s) => s.matrixId)).toEqual([matrixB]);
    expect(chart.config.xAxisSource).toBeNull();
    expect(store().dependencies.hasDependents(ownerA)).toBe(false);
    expect(store().dependencies.edgeCount()).toBe(1); // only the B edge remains
  });
});

describe('setChartColumnPanel', () => {
  it('defaults to false on creation and flips on the matching chart card only', () => {
    const matrixCardId = store().addMatrixCard([
      { name: '1.txt', matrix: matrix([[1, 2]]) },
    ]);
    const chartId = store().addChartCard(matrixCardId, 0)!;
    expect((store().cards.find((c) => c.id === chartId) as ChartCardModel).columnPanelOpen).toBe(false);

    store().setChartColumnPanel(chartId, true);
    expect((store().cards.find((c) => c.id === chartId) as ChartCardModel).columnPanelOpen).toBe(true);

    store().setChartColumnPanel(chartId, false);
    expect((store().cards.find((c) => c.id === chartId) as ChartCardModel).columnPanelOpen).toBe(false);

    // A matrix card never gains a dock state, and an unknown id is a no-op.
    store().setChartColumnPanel(matrixCardId, true);
    store().setChartColumnPanel(999, true);
    expect(store().cards).toHaveLength(2);
    expect((store().cards.find((c) => c.id === matrixCardId) as MatrixCardModel).kind).toBe('matrix');
  });
});

describe('map card keep-alive', () => {
  it('keeps read-only matrices as the single source of truth', () => {
    const cardId = store().addMatrixCard([{ name: '1.txt', matrix: matrix([[1, 2]]) }]);
    const card = store().cards.find((c) => c.id === cardId) as MatrixCardModel;
    expect(isMatrixCard(card)).toBe(true);
    const matrixId = card.sources[0].matrixId;
    expect(store().matrices.get(matrixId)!.cell(0, 1)).toBe(2);
  });
});

describe('compute-backend sync (B-plan)', () => {
  interface Call {
    url: string;
    method: string;
    body?: string;
  }

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  async function withStubbedFetch(
    reply: (call: Call) => { status?: number; body: unknown },
    run: (calls: Call[]) => Promise<void>,
  ): Promise<void> {
    const calls: Call[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      const r = reply(call);
      const text = JSON.stringify(r.body);
      const status = r.status ?? 200;
      return {
        ok: status < 400,
        status,
        text: async () => text,
        json: async () => r.body,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      } as unknown as Response;
    }) as typeof fetch;
    try {
      await run(calls);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('patches the server-side matrix when a cell is edited', async () => {
    await withStubbedFetch(
      (call) =>
        call.method === 'POST'
          ? { body: { matrixId: 7, revision: 1 } }
          : { body: { matrixId: 7, revision: 2 } },
      async (calls) => {
        const cardId = store().addMatrixCard([{ name: 'a.txt', matrix: matrix([[1], [2]]) }]);
        await tick(); // registration is fire-and-forget
        store().editCell(cardId, 1, 0, 42);
        await tick();
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch?.url).toBe('/api/matrices/7');
        expect(JSON.parse(patch!.body!)).toEqual({ cells: [{ row: 1, col: 0, value: 42 }] });
      },
    );
  });

  it('deletes the server-side matrix when the card closes', async () => {
    await withStubbedFetch(
      () => ({ body: { matrixId: 9, revision: 1 } }),
      async (calls) => {
        const cardId = store().addMatrixCard([{ name: 'a.txt', matrix: matrix([[1]]) }]);
        await tick();
        expect(store().removeCard(cardId)).toBe(true);
        await tick();
        expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/matrices/9')).toBe(true);
      },
    );
  });

  it('keeps no server ids across a reset', async () => {
    let nextServerId = 11;
    await withStubbedFetch(
      () => ({ body: { matrixId: nextServerId++, revision: 1 } }),
      async (calls) => {
        store().addMatrixCard([{ name: 'a.txt', matrix: matrix([[1]]) }]);
        await tick();
        store().reset();
        const cardId = store().addMatrixCard([{ name: 'b.txt', matrix: matrix([[5]]) }]);
        await tick();
        store().editCell(cardId, 0, 0, 6);
        await tick();
        // The new matrix gets its own server id (12); the stale mapping (11) is gone.
        expect(calls.some((c) => c.method === 'PATCH' && c.url === '/api/matrices/11')).toBe(false);
        expect(calls.some((c) => c.method === 'PATCH' && c.url === '/api/matrices/12')).toBe(true);
      },
    );
  });
});

// ── Stage 3: formula cards are computed by the backend, not the browser ─────────
// ── shared backend stub (module scope: several suites drive the same fake) ──
interface Call {
  url: string;
  method: string;
  body?: string;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Let queued promise continuations settle — one macrotask flushes the whole chain. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Encode a DCM1 frame exactly as the C++ server does (see decodeMatrixFrame). */
function encodeFrame(columns: number[][], names: string[]): ArrayBuffer {
  const rows = columns.reduce((max, c) => Math.max(max, c.length), 0);
  const cols = columns.length;
  const namesJson = JSON.stringify(names);
  const namesBytes = new TextEncoder().encode(namesJson);
  const buffer = new ArrayBuffer(16 + cols * rows * 8 + namesBytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x44434d31, true);
  view.setUint32(4, rows, true);
  view.setUint32(8, cols, true);
  view.setUint32(12, namesBytes.length, true);
  let offset = 16;
  for (const col of columns) {
    for (let r = 0; r < rows; ++r) {
      view.setFloat64(offset + r * 8, col[r] ?? NaN, true);
    }
    offset += rows * 8;
  }
  new Uint8Array(buffer, offset, namesBytes.length).set(namesBytes);
  return buffer;
}

function stubBackend(opts: {
  nodeResult?: number[][];
  nodeNames?: string[];
  /** Serve this many rows through real start/count paging (exercises the window loop). */
  resultRows?: number;
  createState?: 'done' | 'error';
  error?: { code: string; params?: Record<string, unknown> };
  failAll?: boolean;
  /** Override the advertised capabilities (to test version negotiation). */
  capabilities?: string[];
}) {
  const calls: Call[] = [];
  let nextNodeId = 1;
  let nextMatrixId = 100;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });
    if (opts.failAll) {
      return { ok: false, status: 503, text: async () => '', json: async () => ({}) } as unknown as Response;
    }
    if (url.includes('/events')) {
      return json([]);
    }
    if (url.endsWith('/signatures')) {
      return json({
        signatures: [
          {
            id: 'builtin:expression-columns',
            version: 1,
            displayName: 'expression columns',
            inputs: [{ portId: 'src', displayName: 'source table', required: true }],
            outputs: [{ outputId: 'result' }],
          },
        ],
      });
    }
    if (url.endsWith('/hello')) {
      return json({
        protocol: 1,
        build: 'test',
        capabilities: opts.capabilities ?? ['expr.v1', 'matrix.v1', 'signature.v1', 'card.v2'],
        limits: { maxWindowRows: 5000 },
      });
    }
    if (url.endsWith('/matrices') && method === 'POST') {
      return json({ matrixId: nextMatrixId++, revision: 1 });
    }
    if (url.endsWith('/nodes') && method === 'POST') {
      const nodeId = nextNodeId++;
      const resultMatrixId = nextMatrixId++;
      if (opts.createState === 'error') {
        return err(opts.error?.code ?? 'unexpectedToken', opts.error?.params ?? {});
      }
      return json({
        nodeId,
        resultMatrixId,
        resultMatrixIds: [resultMatrixId],
        signatureId: 'builtin:expression-columns',
        state: opts.createState ?? 'done',
      });
    }
    if (/\/nodes\/\d+$/.test(url) && method === 'PATCH') {
      const id = Number(url.split('/').pop());
      return json({ nodeId: id, state: opts.createState ?? 'done', resultMatrixIds: [nextMatrixId - 1] });
    }
    if (/\/nodes\/\d+$/.test(url) && method === 'DELETE') {
      return json({ deleted: Number(url.split('/').pop()) });
    }
    if (url.includes('/window')) {
      if (opts.resultRows !== undefined) {
        const query = new URL(url, 'http://x').searchParams;
        const start = Number(query.get('start') ?? 0);
        const count = Number(query.get('count') ?? 500);
        const end = Math.min(opts.resultRows, start + count);
        const column = Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => encodeFrame([column], ['Pos.1 big']),
          json: async () => ({}),
          text: async () => '',
        } as unknown as Response;
      }
      const bytes = encodeFrame(opts.nodeResult ?? [[2, 4]], opts.nodeNames ?? ['Pos.1']);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes,
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response;
    }
    return json({});
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

function json(body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text, json: async () => body } as unknown as Response;
}
function err(code: string, params: Record<string, unknown>): Response {
  const text = JSON.stringify({ code, params });
  return { ok: false, status: 400, text: async () => text, json: async () => ({ code, params }) } as unknown as Response;
}

/** Load a source table and wait for its fire-and-forget backend registration. */
async function loadSource(rows: number[][], annotations: string[]) {
  const cardId = store().addMatrixCard([{ name: 's.txt', matrix: matrix(rows, annotations) }]);
  await tick();
  return cardId;
}

describe('formula-card compute authority (B-plan stage 3)', () => {
  it('registers ONE signature node binding the whole table', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4, 6]] });
    try {
      const srcId = await loadSource([[1], [2], [3]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      const creates = stub.calls.filter((c) => c.url.endsWith('/nodes') && c.method === 'POST');
      expect(creates).toHaveLength(1);
      const payload = JSON.parse(creates[0].body!);
      // v2: one signature-driven node, one whole-table binding under port `src`.
      expect(payload.signatureId).toBe('builtin:expression-columns');
      expect(payload.formula).toBeUndefined();
      expect(payload.inputs).toEqual([
        { portId: 'src', varName: 'src', mode: 'matrix', sourceMatrixId: 100 },
      ]);
      expect(payload.params.formulas).toEqual([{ name: 'A × 2', expression: 'A * 2' }]);
      const card = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(card.node?.nodeId).toBe(1);
      expect(card.node?.state).toBe('done');
      // K is fixed by the signature: one declared output carrying the server matrix.
      expect(card.outputs).toHaveLength(1);
      expect(card.outputs[0].resultMatrixId).toBe(101);
    } finally {
      stub.restore();
    }
  });

  it('pulls the done result through the window endpoint into the display cache', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4, 6]], nodeNames: ['Pos.1 doubled'] });
    try {
      const srcId = await loadSource([[1], [2], [3]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      const card = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      const resultMatrix = store().matrices.get(card.displayMatrixId)!;
      expect(Array.from(resultMatrix.column(0).data)).toEqual([2, 4, 6]);
      // The expression name rides on the annotation, so a wide table is self-describing.
      expect(resultMatrix.column(0).annotation).toBe('doubled');
      // It really hit the documented window route, not a local evaluation.
      expect(stub.calls.some((c) => c.url.includes('/window'))).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it('patches the SAME node (params) when a formula is edited', async () => {
    const stub = stubBackend({ nodeResult: [[3, 6, 9]] });
    try {
      const srcId = await loadSource([[1], [2], [3]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      stub.calls.length = 0;
      store().setFormula(fId, 0, 'Triple', 'A * 3');
      await flush();
      const patches = stub.calls.filter((c) => /\/nodes\/\d+$/.test(c.url) && c.method === 'PATCH');
      // One edit ⇒ one PATCH (v1 needed one node per column, each re-evaluating the input).
      expect(patches).toHaveLength(1);
      const payload = JSON.parse(patches[0].body!);
      expect(payload.params.formulas).toEqual([{ name: 'Triple', expression: 'A * 3' }]);
      expect(payload.formula).toBeUndefined();
      expect(payload.inputs).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('adding a second column still uses the one node (no node is created or deleted)', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4]] });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      stub.calls.length = 0;
      store().setFormula(fId, 1, 'B2', 'A * 2');
      await flush();
      const card = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(card.params.formulas).toHaveLength(2);
      expect(card.node?.nodeId).toBe(1);
      expect(stub.calls.some((c) => c.method === 'POST' && c.url.endsWith('/nodes'))).toBe(false);
      expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
      // Removing one column also keeps the node.
      stub.calls.length = 0;
      store().removeFormula(fId, 1);
      await flush();
      expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);
      const after = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(after.node?.nodeId).toBe(1);
    } finally {
      stub.restore();
    }
  });

  it('deletes the node when the card closes', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4]] });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      const nodeId = (store().cards.find((c) => c.id === fId) as FunctionCardModel).node!.nodeId;
      stub.calls.length = 0;
      expect(store().removeCard(fId)).toBe(true);
      await flush();
      expect(stub.calls.some((c) => c.method === 'DELETE' && c.url === `/api/nodes/${nodeId}`)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it('surfaces a structured backend error as an i18n-renderable code on the node', async () => {
    const stub = stubBackend({ createState: 'error', error: { code: 'unknownColumn', params: { position: 0 } } });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      const card = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(card.node?.state).toBe('error');
      expect(card.node?.code).toBe('unknownColumn');
      // The key the UI will render resolves to real copy, never a silent blank.
      const msg = (await import('../src/ui/i18n.ts')).translatorFor('en')(
        `formula.error.${card.node!.code}` as never,
        card.node!.params as never,
      );
      expect(msg).toContain('Unknown column');
    } finally {
      stub.restore();
    }
  });

  it('does NOT compute locally or register a node when the backend is unreachable', async () => {
    const stub = stubBackend({ failAll: true });
    try {
      const srcId = await loadSource([[1], [2], [3]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      const card = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      // No node was ever created (the source matrix could not be registered either).
      expect(card.node).toBeNull();
      // And crucially: the display cache stayed EMPTY — no fabricated [2,4,6].
      const resultMatrix = store().matrices.get(card.displayMatrixId)!;
      expect(resultMatrix.rowCount()).toBe(0);
      // Offline is VISIBLE via the banner contract (backend state flips offline on failure).
      expect(store().backend.state).toBe('offline');
    } finally {
      stub.restore();
    }
  });

  it('applyNodeEvent surfaces an error event as a structured code on the node', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4]] });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      const nid = (store().cards.find((c) => c.id === fId) as FunctionCardModel).node!.nodeId;
      // A `done`→`error` transition arrives through the stream with code + params.
      store().applyNodeEvent({ seq: 500, nodeId: nid, state: 'error', code: 'unknownColumn', params: { position: 3 } });
      const card = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(card.node?.state).toBe('error');
      expect(card.node?.code).toBe('unknownColumn');
      expect(card.node?.params).toEqual({ position: 3 });
    } finally {
      stub.restore();
    }
  });

  it('an unknown error code still renders a visible fallback + raw code (never silent)', async () => {
    const { translatorFor } = await import('../src/ui/i18n.ts');
    const t = translatorFor('en');
    // Mirrors FormulaCard's rendering rule for a code with no i18n key.
    const code = 'someBrandNewCode';
    const localised = t(`formula.error.${code}` as never);
    const shown = localised === `formula.error.${code}` ? `${t('formula.error.unknown')} (${code})` : localised;
    expect(shown).toContain('could not be computed');
    expect(shown).toContain(code);
  });

  it('applyNodeEvent updates the light and pulls results on done', async () => {
    const stub = stubBackend({ nodeResult: [[7, 8]] });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      const before = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      const nid = before.node!.nodeId;
      store().applyNodeEvent({ seq: 999, nodeId: nid, state: 'computing' });
      expect((store().cards.find((c) => c.id === fId) as FunctionCardModel).node?.state).toBe('computing');
      store().applyNodeEvent({ seq: 1000, nodeId: nid, state: 'done', matrixId: before.outputs[0].resultMatrixId });
      await flush();
      const after = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(after.node?.state).toBe('done');
      expect(Array.from(store().matrices.get(after.displayMatrixId)!.column(0).data)).toEqual([7, 8]);
    } finally {
      stub.restore();
    }
  });

  it('binds the explicit matrix the card was created with, not the table active file', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4]] });
    try {
      const srcId = store().addMatrixCard([
        { name: 'a.txt', matrix: matrix([[1], [2]], ['A']) },
        { name: 'b.txt', matrix: matrix([[10], [20]], ['A']) },
      ]);
      await flush();
      const card = store().cards.find((c) => c.id === srcId) as MatrixCardModel;
      const secondMatrixId = card.sources[1].matrixId;
      const fId = store().addFormulaCard(srcId, secondMatrixId)!;
      await flush();
      const created = JSON.parse(
        stub.calls.filter((c) => c.url.endsWith('/nodes') && c.method === 'POST')[0].body!,
      );
      // The binding points at the SECOND file's server id (100 is the first, 101 the second).
      expect(created.inputs[0].sourceMatrixId).toBe(101);
      const fn = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(fn.inputs).toEqual([
        { portId: 'src', target: { type: 'matrix', cardId: srcId, matrixId: secondMatrixId } },
      ]);
    } finally {
      stub.restore();
    }
  });

  it('switching the source file does NOT re-point the function card (v2 behaviour)', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4]] });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      const fn = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      const frozenMatrixId = fn.inputs[0].target.type === 'matrix' ? fn.inputs[0].target.matrixId : -1;
      stub.calls.length = 0;
      // An explicit re-point is the only way to change the input…
      store().setActiveSource(srcId, 0);
      await flush();
      expect(stub.calls.some((c) => /\/nodes\/\d+$/.test(c.url) && c.method === 'PATCH')).toBe(false);
      const after = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(after.inputs[0].target).toMatchObject({ matrixId: frozenMatrixId });
      // …and the dependency edge is still there (close protection must keep working).
      expect(store().dependencies.getDependents(srcId)).toContain(fId);
    } finally {
      stub.restore();
    }
  });

  it('re-registers restored function cards once (node ids do not survive a restart)', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4]] });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await flush();
      const snapshot = store().toSnapshot();
      expect(snapshot.version).toBe(2);
      stub.calls.length = 0;
      store().reset();
      store().loadSnapshot(snapshot);
      await flush();
      // Restored card has no node until it is registered again…
      const restored = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(restored.outputs[0].resultMatrixId).toBeGreaterThan(0);
      // …and the restore registered it exactly once.
      const creates = stub.calls.filter((c) => c.url.endsWith('/nodes') && c.method === 'POST');
      expect(creates).toHaveLength(1);
      const payload = JSON.parse(creates[0].body!);
      expect(payload.signatureId).toBe('builtin:expression-columns');
      expect(payload.params.formulas).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('decodeMatrixFrame round-trips the encoder used here', () => {
    const frame = decodeMatrixFrame(encodeFrame([[1, 2], [3, 4]], ['Pos.1 x', 'Pos.2']));
    expect(frame.ok).toBe(true);
    expect(frame.rows).toBe(2);
    expect(frame.columns).toBe(2);
    expect(Array.from(frame.data![0])).toEqual([1, 2]);
    expect(Array.from(frame.data![1])).toEqual([3, 4]);
    expect(frame.names).toEqual(['Pos.1 x', 'Pos.2']);
  });

  describe('result paging', () => {
    it('assembles a result larger than one window instead of truncating it', async () => {
      const stub = stubBackend({ resultRows: 12_000 });
      try {
        const srcId = await loadSource([[1], [2]], ['A']);
        const fId = store().addFormulaCard(srcId)!;
        await flush();
        await flush();
        const card = store().cards.find((c) => c.id === fId) as FunctionCardModel;
        const cached = store().matrices.get(card.displayMatrixId)!;
        expect(cached.rowCount()).toBe(12_000);
        // Assembled in order, and the last row is really the last one.
        expect(cached.cell(0, 0)).toBe(0);
        expect(cached.cell(11_999, 0)).toBe(11_999);
        // Three windows: 5000 + 5000 + 2000.
        const windows = stub.calls.filter((c) => c.url.includes('/window'));
        expect(windows.length).toBe(3);
      } finally {
        stub.restore();
      }
    });
  });

  // ── re-point confirmation (v2: switching a file is an explicit graph edit) ──────
  describe('re-point offers', () => {
    /** Two files in one data card: identical headers, and a third file with different ones. */
    function setup() {
      const srcId = store().addMatrixCard([
        { name: 'a.txt', matrix: matrix([[1, 2], [3, 4]], ['A', 'B']) },
        { name: 'b.txt', matrix: matrix([[5, 6], [7, 8]], ['A', 'B']) },
        { name: 'c.txt', matrix: matrix([[9], [10]], ['Z']) },
      ]);
      const card = store().cards.find((c) => c.id === srcId) as MatrixCardModel;
      return { srcId, matrices: card.sources.map((source) => source.matrixId) };
    }

    it('offers the switch for a function card instead of re-pointing it', () => {
      const { srcId, matrices } = setup();
      const fId = store().addFormulaCard(srcId, matrices[0])!;
      store().setActiveSource(srcId, 1);
      const offers = store().repointOffers;
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        cardId: fId,
        ownerCardId: srcId,
        fromMatrixId: matrices[0],
        toMatrixId: matrices[1],
        sameColumns: true,
        addedLabels: [],
        removedLabels: [],
        toName: 'b.txt',
      });
      // Nothing changed yet — the card still reads its frozen matrix.
      const fn = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(fn.inputs[0].target).toMatchObject({ matrixId: matrices[0] });
    });

    it('applies the offer as one explicit edit (input + node)', () => {
      const { srcId, matrices } = setup();
      const fId = store().addFormulaCard(srcId, matrices[0])!;
      store().setActiveSource(srcId, 1);
      store().applyRepoint(fId);
      const fn = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(fn.inputs[0].target).toMatchObject({ matrixId: matrices[1] });
      expect(store().repointOffers).toHaveLength(0);
      // The dependency edge is unchanged (same data card), so close protection still holds.
      expect(store().dependencies.getDependents(srcId)).toContain(fId);
    });

    it('flags a column change so the confirm cannot be a blind one', () => {
      const { srcId, matrices } = setup();
      store().addFormulaCard(srcId, matrices[0]);
      store().setActiveSource(srcId, 2);
      const offer = store().repointOffers[0];
      expect(offer.sameColumns).toBe(false);
      expect(offer.addedLabels).toEqual(['Z']);
      expect(offer.removedLabels).toEqual(['A', 'B']);
      expect(offer.toCols).toBe(1);
    });

    it('dismissing keeps the current input and clears the offer', () => {
      const { srcId, matrices } = setup();
      const fId = store().addFormulaCard(srcId, matrices[0])!;
      store().setActiveSource(srcId, 1);
      store().dismissRepoint(fId);
      expect(store().repointOffers).toHaveLength(0);
      const fn = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      expect(fn.inputs[0].target).toMatchObject({ matrixId: matrices[0] });
    });

    it('applies to every card reading the same data card in one go', () => {
      const { srcId, matrices } = setup();
      const a = store().addFormulaCard(srcId, matrices[0])!;
      const b = store().addFormulaCard(srcId, matrices[0])!;
      store().setActiveSource(srcId, 1);
      expect(store().repointOffers).toHaveLength(2);
      store().applyRepointsForOwner(srcId);
      expect(store().repointOffers).toHaveLength(0);
      for (const id of [a, b]) {
        const fn = store().cards.find((c) => c.id === id) as FunctionCardModel;
        expect(fn.inputs[0].target).toMatchObject({ matrixId: matrices[1] });
      }
    });

    it('offers nothing when the new file is already the card input', () => {
      const { srcId, matrices } = setup();
      store().addFormulaCard(srcId, matrices[1]);
      store().setActiveSource(srcId, 1);
      expect(store().repointOffers).toHaveLength(0);
    });
  });

  // ── output column rename + the column-count contract ───────────────────────────
  describe('column rename contract', () => {
    async function card() {
      const srcId = store().addMatrixCard([{ name: 's.txt', matrix: matrix([[1], [2]], ['A']) }]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const id = store().addFormulaCard(srcId)!;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return store().cards.find((c) => c.id === id) as FunctionCardModel;
    }

    it('creates the contract on the first rename (naming promises the width)', async () => {
      const before = await card();
      expect(before.params.columnContract).toBeUndefined();
      store().renameOutputColumn(before.id, 0, 'temperature');
      const after = store().cards.find((c) => c.id === before.id) as FunctionCardModel;
      expect(after.params.formulas[0].name).toBe('temperature');
      expect(after.params.columnContract).toEqual({ outputId: 'result', columns: 1 });
    });

    it('extends the contract explicitly (the way out of a self-edit violation)', async () => {
      const c = await card();
      store().renameOutputColumn(c.id, 0, 'a');
      store().setFormula(c.id, 1, 'b', 'A * 2');
      expect(
        (store().cards.find((e) => e.id === c.id) as FunctionCardModel).params.columnContract,
      ).toEqual({ outputId: 'result', columns: 1 });
      store().setColumnContract(c.id, 2);
      expect(
        (store().cards.find((e) => e.id === c.id) as FunctionCardModel).params.columnContract,
      ).toEqual({ outputId: 'result', columns: 2 });
    });

    it('clears the contract, so the width is free again', async () => {
      const c = await card();
      store().renameOutputColumn(c.id, 0, 'a');
      store().setColumnContract(c.id, null);
      expect(
        (store().cards.find((e) => e.id === c.id) as FunctionCardModel).params.columnContract,
      ).toBeUndefined();
    });

    it('survives a snapshot round-trip (a contract the user cannot see is useless)', async () => {
      const c = await card();
      store().renameOutputColumn(c.id, 0, 'kept');
      store().setColumnContract(c.id, 1);
      const snapshot = store().toSnapshot();
      store().reset();
      store().loadSnapshot(snapshot);
      const restored = store().cards.find((e) => e.id === c.id) as FunctionCardModel;
      expect(restored.params.columnContract).toEqual({ outputId: 'result', columns: 1 });
      expect(restored.params.formulas[0].name).toBe('kept');
    });
  });
});

// ── version negotiation (capabilities, not just protocol number) ────────────────
describe('backend capability gate', () => {
  it('refuses a backend that cannot evaluate signatures', async () => {
    const stub = stubBackend({ capabilities: ['expr.v1', 'matrix.v1'] });
    try {
      await store().connectBackend();
      // Additive fields on the wire are not enough: an old backend would ignore
      // `signatureId` and evaluate an empty formula, producing a node that looks alive.
      expect(store().backend.state).toBe('mismatch');
      expect(store().backend.error).toContain('signature.v1');
    } finally {
      store().stopBackendEventLoop();
      stub.restore();
    }
  });

  it('accepts a v2 backend and records its advertised signatures', async () => {
    const stub = stubBackend({});
    try {
      await store().connectBackend();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(store().backend.state).toBe('online');
      expect(store().signatures.map((s) => s.id)).toEqual(['builtin:expression-columns']);
      expect(store().signatures[0].inputs[0].portId).toBe('src');
    } finally {
      // connectBackend arms the long-poll; a test must not leave it running.
      store().stopBackendEventLoop();
      stub.restore();
    }
  });
});

// ── the output side: a function card's result is chartable ──────────────────────
describe('charts from a function card', () => {
  it('creates a chart whose source is the function card output table', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4], [11, 22]], nodeNames: ['Pos.1 double', 'Pos.2 sum'] });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const fn = store().cards.find((c) => c.id === fId) as FunctionCardModel;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const chartId = store().addChartCard(fId, 0)!;
      expect(chartId).not.toBeNull();
      const chart = store().cards.find((c) => c.id === chartId) as ChartCardModel;
      // The chart reads the function card's output cache, not a data table.
      expect(chart.config.sources[0].matrixId).toBe(fn.displayMatrixId);
      expect(chart.config.sources[0].label).toContain('double');
      // …and the edge is the function card → chart, which is what close protection reads.
      expect(store().dependencies.getDependents(fId)).toContain(chartId);
      expect(chart.inputs[0].target).toMatchObject({
        type: 'cell',
        cardId: fId,
        matrixId: fn.displayMatrixId,
      });
    } finally {
      stub.restore();
    }
  });

  it('refuses to close a function card that still feeds a chart', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4]], nodeNames: ['Pos.1 double'] });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const chartId = store().addChartCard(fId, 0)!;
      expect(store().removeCard(fId)).toBe(false);
      expect(store().blockedCardId).toBe(fId);
      // Closing the chart first releases it (the normal close-protection flow).
      expect(store().removeCard(chartId)).toBe(true);
      expect(store().removeCard(fId)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  it('pushes fresh numbers into a chart when the function card recomputes', async () => {
    const stub = stubBackend({ nodeResult: [[2, 4]], nodeNames: ['Pos.1 double'] });
    try {
      const srcId = await loadSource([[1], [2]], ['A']);
      const fId = store().addFormulaCard(srcId)!;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      store().addChartCard(fId, 0)!;
      // The next pull returns different numbers (the expression changed upstream).
      const stub2 = stubBackend({ nodeResult: [[10, 20]], nodeNames: ['Pos.1 double'] });
      try {
        store().applyNodeEvent({
          seq: 5000,
          nodeId: (store().cards.find((c) => c.id === fId) as FunctionCardModel).node!.nodeId,
          state: 'done',
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } finally {
        stub2.restore();
      }
      const chart = store().cards.find((c) => isChartCard(c)) as ChartCardModel;
      expect(chart.config.sources[0].raw).toEqual([10, 20]);
    } finally {
      stub.restore();
    }
  });
});
