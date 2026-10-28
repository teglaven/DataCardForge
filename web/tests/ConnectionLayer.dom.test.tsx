/**
 * @vitest-environment jsdom
 *
 * Connection lines.
 *
 * The store's DependencyGraph is the source of truth: exactly one line per dependency
 * edge — every edge, not only the ones that end at a chart card (2026-10-28). Endpoints
 * resolve to a port when the edge names one and the card renders it, otherwise to the
 * card edge that faces the other card, and each line carries an arrowhead at its target.
 *
 * A pair of cards is still exactly one line: attaching a second column of the same matrix
 * card adds no line, and table scrolling cannot move anything (the geometry never reads
 * the table viewport).
 *
 * jsdom reports all-zero rectangles, so the card roots, the port elements and the world
 * layer are given explicit geometry, exactly like InfiniteCanvas.dom.test.tsx does.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  registerCard,
  registerPort,
  resetMetrics,
  setCanvasElement,
  setCanvasZoom,
  setWorldElement,
} from '../src/ui/cardMetrics.ts';
import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { ConnectionLayer } from '../src/ui/ConnectionLayer.tsx';
import type { FunctionCardModel, PortConnection } from '../src/ui/types.ts';

// React 19 wants this set so act() works outside its test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
const store = () => useWorkspace.getState();

const GREY = 'rgb(107, 114, 128)';
const RED = 'rgb(200, 50, 50)';
const BLUE = 'rgb(40, 120, 220)';

/** Give an element a fixed rect — jsdom reports zeros otherwise. */
function stubRect(
  element: HTMLElement,
  r: { left: number; top: number; width: number; height: number },
): void {
  element.getBoundingClientRect = () =>
    ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function buildMatrix(columns: number): MatrixData {
  const mat = new MatrixData();
  for (let c = 0; c < columns; ++c) {
    mat.appendColumn(`Pos.${c + 1}`, [1, 2, 3, 4, 5]);
    mat.setColumnAnnotation(c, `sensor ${c}`);
  }
  return mat;
}

function Harness({ selectedId }: { selectedId: number | null }) {
  const cards = useWorkspace((s) => s.cards);
  const dependencies = useWorkspace((s) => s.dependencies);
  return (
    <ConnectionLayer
      cards={cards}
      selectedId={selectedId}
      blockedCardId={null}
      blockNonce={0}
      view={{ x: 0, y: 0, zoom: 1 }}
      dependencies={dependencies}
    />
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountLayer(selectedId: number | null = null): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <Harness selectedId={selectedId} />
      </StrictMode>,
    );
  });
  await flush();
  return host;
}

function stubRoot(left: number, top: number, width: number, height: number): HTMLElement {
  const element = document.createElement('div');
  stubRect(element, { left, top, width, height });
  return element;
}

/**
 * A matrix card at (100,80,640,420) and a chart card at (772,104,560,400), each with
 * its registered root rect. The line therefore leaves the table's right edge at
 * (740,290) and enters the chart's left edge at (772,304).
 */
function setupScene({ chart = true }: { chart?: boolean } = {}) {
  const viewport = document.createElement('div');
  stubRect(viewport, { left: 0, top: 0, width: 1200, height: 800 });
  const world = document.createElement('div');
  stubRect(world, { left: 0, top: 0, width: 20000, height: 20000 });
  setCanvasElement(viewport);
  setWorldElement(world);
  setCanvasZoom(1);

  const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: buildMatrix(3) }]);
  store().setBounds(matrixCardId, { x: 100, y: 80, width: 640, height: 420 });
  const chartId = (chart ? store().addChartCard(matrixCardId, 0) : 0) ?? 0;
  if (chartId !== 0) {
    store().setBounds(chartId, { x: 772, y: 104, width: 560, height: 400 });
    registerCard(chartId, stubRoot(772, 104, 560, 400));
  }

  registerCard(matrixCardId, stubRoot(100, 80, 640, 420));

  return { matrixCardId, chartId };
}

/** Matrix id of one card's first source. */
function matrixIdOf(cardId: number): number {
  const card = store().cards.find((entry) => entry.id === cardId) as
    | { sources?: { matrixId: number }[] }
    | undefined;
  return card?.sources?.[0]?.matrixId ?? -1;
}

/**
 * Push a function card straight into the store.
 *
 * The layer's contract is (cards, graph) — it draws whatever the graph says — so a
 * backend stub would only add noise here. Store-level creation is covered by
 * workspaceStore.test.ts.
 */
function addFunctionCard(
  inputs: PortConnection[],
  at: { x: number; y: number; width: number; height: number },
): FunctionCardModel {
  const id = Math.max(0, ...store().cards.map((card) => card.id)) + 50;
  const card: FunctionCardModel = {
    kind: 'formula',
    id,
    title: '',
    ...at,
    z: 5,
    createdAt: Date.now(),
    inputs,
    signatureId: 'builtin:expression-columns',
    params: { formulas: [{ name: 'A', expression: 'A' }] },
    outputs: [{ outputId: 'result', resultMatrixId: -1 }],
    node: null,
    displayMatrixId: 900 + id,
  };
  useWorkspace.setState({ cards: [...store().cards, card] });
  registerCard(id, stubRoot(at.x, at.y, at.width, at.height));
  return card;
}

function wirePaths(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.connection__wire')].map((path) => path.getAttribute('d') ?? '');
}

function arrowPaths(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.connection__arrow')].map(
    (path) => path.getAttribute('d') ?? '',
  );
}

beforeEach(() => {
  store().reset();
  resetMetrics();
  setCanvasElement(null);
  setWorldElement(null);
  setCanvasZoom(1);
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
  resetMetrics();
  setCanvasElement(null);
  setWorldElement(null);
  setCanvasZoom(1);
});

describe('connection lines', () => {
  it('draws one line per dependency edge, from the source edge to the target edge', async () => {
    setupScene();
    const host = await mountLayer();

    expect(wirePaths(host)).toEqual(['M 740 290 C 800 290, 712 304, 772 304']);
  });

  it('puts exactly one arrowhead on the target anchor, pointing into the card', async () => {
    setupScene();
    const host = await mountLayer();

    // Entering the chart through its left edge means the arrow points right (+x).
    expect(arrowPaths(host)).toEqual(['M 772 304 L 764 308 L 764 300 Z']);
  });

  it('colours the line red for the selected source card and blue for the target', async () => {
    const { matrixCardId, chartId } = setupScene();
    const host = await mountLayer(matrixCardId);

    const red = host.querySelector('.connection--fg .connection__wire');
    expect(red?.getAttribute('stroke')).toBe(RED);

    const root = roots[0];
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness selectedId={chartId} />
        </StrictMode>,
      );
    });
    await flush();
    const blue = host.querySelector('.connection--fg .connection__wire');
    expect(blue?.getAttribute('stroke')).toBe(BLUE);

    await act(async () => {
      root.render(
        <StrictMode>
          <Harness selectedId={null} />
        </StrictMode>,
      );
    });
    await flush();
    const grey = host.querySelector('.connection--bg .connection__wire');
    expect(grey?.getAttribute('stroke')).toBe(GREY);
    expect(host.querySelectorAll('.connection--fg')).toHaveLength(0);
  });

  it('keeps exactly one line when a second column of the same matrix is attached', async () => {
    const { matrixCardId, chartId } = setupScene();
    const host = await mountLayer();

    await act(async () => {
      store().addChartSource(chartId, matrixCardId, 1);
    });
    await flush();

    const chart = store().cards.find((card) => card.id === chartId);
    expect(chart && (chart as { config: { sources: unknown[] } }).config.sources).toHaveLength(2);
    expect(host.querySelectorAll('.connection')).toHaveLength(1);
  });

  it('draws a second line when the chart reads a second matrix card', async () => {
    const { chartId } = setupScene();
    const host = await mountLayer();

    let secondCardId = 0;
    await act(async () => {
      secondCardId = store().addMatrixCard([{ name: 'b.csv', matrix: buildMatrix(2) }]);
      store().setBounds(secondCardId, { x: 100, y: 620, width: 640, height: 420 });
      registerCard(secondCardId, stubRoot(100, 620, 640, 420));
    });
    const secondCard = store().cards.find((card) => card.id === secondCardId)!;
    const secondMatrixId = (secondCard as { sources: { matrixId: number }[] }).sources[0].matrixId;

    await act(async () => {
      store().addChartSource(chartId, secondMatrixId, 0);
    });
    await flush();

    expect(host.querySelectorAll('.connection')).toHaveLength(2);
  });

  it('skips an edge whose source card no longer exists, without crashing', async () => {
    const { chartId } = setupScene();
    // A dangling edge: the chart depends on a card that is not in the workspace.
    store().dependencies.addDependency(chartId, 99999);

    const host = await mountLayer();

    expect(host.querySelectorAll('.connection')).toHaveLength(1);
    expect(wirePaths(host)[0]).toBe('M 740 290 C 800 290, 712 304, 772 304');
  });

  // ── every edge is drawn, not only chart edges (2026-10-28) ──────────

  it('draws the line into a function card, not only into charts', async () => {
    const { matrixCardId } = setupScene({ chart: false });
    const functionCard = addFunctionCard(
      [
        {
          portId: 'src',
          target: { type: 'matrix', cardId: matrixCardId, matrixId: matrixIdOf(matrixCardId) },
        },
      ],
      { x: 100, y: 560, width: 480, height: 320 },
    );
    store().dependencies.addDependency(functionCard.id, matrixCardId, 'src');

    const host = await mountLayer();

    // Table right edge (740,290) -> function card left edge (100,720).
    expect(wirePaths(host)).toEqual(['M 740 290 C 800 290, 40 720, 100 720']);
  });

  it('draws both hops of a table -> function -> function chain', async () => {
    const { matrixCardId } = setupScene({ chart: false });
    const first = addFunctionCard(
      [
        {
          portId: 'src',
          target: { type: 'matrix', cardId: matrixCardId, matrixId: matrixIdOf(matrixCardId) },
        },
      ],
      { x: 100, y: 560, width: 480, height: 320 },
    );
    const second = addFunctionCard(
      [
        {
          portId: 'src',
          target: { type: 'matrix', cardId: first.id, matrixId: first.displayMatrixId },
        },
      ],
      { x: 100, y: 960, width: 480, height: 320 },
    );
    store().dependencies.addDependency(first.id, matrixCardId, 'src');
    store().dependencies.addDependency(second.id, first.id, 'src');

    const host = await mountLayer();

    // Matrix -> first, then first's right edge (580,720) -> second's left edge (100,1120).
    expect(wirePaths(host)).toEqual([
      'M 740 290 C 800 290, 40 720, 100 720',
      'M 580 720 C 640 720, 40 1120, 100 1120',
    ]);
  });

  it('anchors on the port when the card renders one for that portId', async () => {
    const { matrixCardId } = setupScene({ chart: false });
    const functionCard = addFunctionCard(
      [
        {
          portId: 'src',
          target: { type: 'matrix', cardId: matrixCardId, matrixId: matrixIdOf(matrixCardId) },
        },
      ],
      { x: 100, y: 560, width: 480, height: 320 },
    );
    store().dependencies.addDependency(functionCard.id, matrixCardId, 'src');

    // The port chip the card would render, at (120,600) with 80x20 -> centre (160,610).
    const chip = document.createElement('span');
    stubRect(chip, { left: 120, top: 600, width: 80, height: 20 });
    await act(async () => {
      registerPort(functionCard.id, 'src', chip, 'left');
    });

    const host = await mountLayer();

    expect(wirePaths(host)).toEqual(['M 740 290 C 800 290, 100 610, 160 610']);
    // The arrowhead follows the port's side, so it points right (+x) into the chip.
    expect(arrowPaths(host)).toEqual(['M 160 610 L 152 614 L 152 606 Z']);
  });

  it('labels a highlighted line with the port ids it carries', async () => {
    const { matrixCardId } = setupScene();
    const host = await mountLayer(matrixCardId);

    const labels = [...host.querySelectorAll('.connection__label')].map(
      (node) => node.textContent ?? '',
    );
    expect(labels).toHaveLength(1);
    expect(labels[0]).toBe(`src:${matrixIdOf(matrixCardId)}:0`);

    const plain = await mountLayer(null);
    expect(plain.querySelectorAll('.connection__label')).toHaveLength(0);
  });
});
