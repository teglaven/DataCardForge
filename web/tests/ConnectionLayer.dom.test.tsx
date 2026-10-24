/**
 * @vitest-environment jsdom
 *
 * Card-level connection lines.
 *
 * The connection line no longer corresponds to a row/column inside a matrix card —
 * it belongs to the whole card. The store's DependencyGraph is the source of truth:
 * exactly one line per dependency edge whose dependent side is a chart card, drawn
 * top-centre to top-centre. Attaching a second column of the same matrix card adds
 * no line, and table scrolling cannot move anything (the geometry never reads the
 * table viewport).
 *
 * jsdom reports all-zero rectangles, so the card roots and the world layer are given
 * explicit geometry, exactly like InfiniteCanvas.dom.test.tsx does.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  registerCard,
  resetMetrics,
  setCanvasElement,
  setCanvasZoom,
  setWorldElement,
} from '../src/ui/cardMetrics.ts';
import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { ConnectionLayer } from '../src/ui/ConnectionLayer.tsx';

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
 * its registered root rect. Top centres therefore are (420,80) and (1052,104).
 */
function setupScene() {
  const viewport = document.createElement('div');
  stubRect(viewport, { left: 0, top: 0, width: 1200, height: 800 });
  const world = document.createElement('div');
  stubRect(world, { left: 0, top: 0, width: 20000, height: 20000 });
  setCanvasElement(viewport);
  setWorldElement(world);
  setCanvasZoom(1);

  const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: buildMatrix(3) }]);
  store().setBounds(matrixCardId, { x: 100, y: 80, width: 640, height: 420 });
  const chartId = store().addChartCard(matrixCardId, 0)!;
  store().setBounds(chartId, { x: 772, y: 104, width: 560, height: 400 });

  registerCard(matrixCardId, stubRoot(100, 80, 640, 420));
  registerCard(chartId, stubRoot(772, 104, 560, 400));

  return { matrixCardId, chartId };
}

function linePaths(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.connection-layer .connection path')].map(
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

describe('card-level connection lines', () => {
  it('draws one line per dependency edge, top-centre to top-centre', async () => {
    setupScene();
    const host = await mountLayer();

    expect(linePaths(host)).toEqual(['M 420 80 C 420 50, 1052 24, 1052 104']);
  });

  it('colours the line red for the selected source card and blue for the chart', async () => {
    const { matrixCardId, chartId } = setupScene();
    const host = await mountLayer(matrixCardId);

    const red = host.querySelector('.connection--fg path');
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
    const blue = host.querySelector('.connection--fg path');
    expect(blue?.getAttribute('stroke')).toBe(BLUE);

    await act(async () => {
      root.render(
        <StrictMode>
          <Harness selectedId={null} />
        </StrictMode>,
      );
    });
    await flush();
    const grey = host.querySelector('.connection--bg path');
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
    expect(host.querySelectorAll('.connection-layer .connection')).toHaveLength(1);
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

    expect(host.querySelectorAll('.connection-layer .connection')).toHaveLength(2);
  });

  it('skips an edge whose source card no longer exists, without crashing', async () => {
    const { chartId } = setupScene();
    // A dangling edge: the chart depends on a card that is not in the workspace.
    store().dependencies.addDependency(chartId, 99999);

    const host = await mountLayer();

    expect(host.querySelectorAll('.connection-layer .connection')).toHaveLength(1);
    expect(linePaths(host)[0]).toBe('M 420 80 C 420 50, 1052 24, 1052 104');
  });
});
