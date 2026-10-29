/**
 * @vitest-environment jsdom
 *
 * Connection lines.
 *
 * The store's DependencyGraph is the source of truth: exactly one line per dependency
 * edge — every edge, not only the ones that end at a chart card (2026-10-28). Since
 * 2026-10-29 both endpoints are the two **card centres**, so the visible wire is whatever
 * the mask leaves uncovered between the two frames; the arrowhead parks on the target
 * frame (inside it, the mask would erase it) and the port label moves to the visible
 * stretch, because the exact midpoint is often under a card.
 *
 * A pair of cards is still exactly one line: attaching a second column of the same matrix
 * card adds no line, and table scrolling cannot move anything (the geometry never reads
 * the table viewport).
 *
 * jsdom reports all-zero rectangles, so the card roots and the world layer are given
 * explicit geometry, exactly like InfiniteCanvas.dom.test.tsx does.
 */
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  invalidateLayout,
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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** Give an element a fixed rect — jsdom reports zeros otherwise. */
function stubRect(element: HTMLElement, box: Box): void {
  element.getBoundingClientRect = () =>
    ({
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
      right: box.x + box.width,
      bottom: box.y + box.height,
      x: box.x,
      y: box.y,
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

function Harness({ selectedId, zoom = 1 }: { selectedId: number | null; zoom?: number }) {
  const cards = useWorkspace((s) => s.cards);
  const dependencies = useWorkspace((s) => s.dependencies);
  return (
    <ConnectionLayer
      cards={cards}
      selectedId={selectedId}
      blockedCardId={null}
      blockNonce={0}
      view={{ x: 0, y: 0, zoom }}
      dependencies={dependencies}
    />
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Let animation frames run: a layout jump is tweened over ~220 ms. */
async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mountLayer(selectedId: number | null = null, zoom = 1): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <Harness selectedId={selectedId} zoom={zoom} />
      </StrictMode>,
    );
  });
  await flush();
  return host;
}

function stubRoot(box: Box): HTMLElement {
  const element = document.createElement('div');
  stubRect(element, box);
  return element;
}

const MATRIX_AT: Box = { x: 100, y: 80, width: 640, height: 420 };
const CHART_AT: Box = { x: 772, y: 104, width: 560, height: 400 };
const MATRIX_CENTRE: Point = { x: 420, y: 290 };
const CHART_CENTRE: Point = { x: 1052, y: 304 };

/**
 * A matrix card at (100,80,640,420) and a chart card at (772,104,560,400), each with its
 * registered root rect. The wire therefore runs from the table's centre (420,290) to the
 * chart's centre (1052,304); only the 32px gap between the two frames shows it.
 */
function setupScene({
  chart = true,
  matrixAt = MATRIX_AT,
  chartAt = CHART_AT,
}: { chart?: boolean; matrixAt?: Box; chartAt?: Box } = {}) {
  const viewport = document.createElement('div');
  stubRect(viewport, { x: 0, y: 0, width: 1200, height: 800 });
  const world = document.createElement('div');
  stubRect(world, { x: 0, y: 0, width: 20000, height: 20000 });
  setCanvasElement(viewport);
  setWorldElement(world);
  setCanvasZoom(1);

  const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: buildMatrix(3) }]);
  store().setBounds(matrixCardId, matrixAt);
  const matrixRoot = stubRoot(matrixAt);
  registerCard(matrixCardId, matrixRoot);

  let chartId = 0;
  let chartRoot: HTMLElement | null = null;
  if (chart) {
    chartId = store().addChartCard(matrixCardId, 0) ?? 0;
    if (chartId !== 0) {
      store().setBounds(chartId, chartAt);
      chartRoot = stubRoot(chartAt);
      registerCard(chartId, chartRoot);
    }
  }

  return { matrixCardId, chartId, matrixRoot, chartRoot };
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
function addFunctionCard(inputs: PortConnection[], at: Box): FunctionCardModel {
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
    result: null,
    displayMatrixId: 900 + id,
  };
  useWorkspace.setState({ cards: [...store().cards, card] });
  registerCard(id, stubRoot(at));
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

/** Pull the eight coordinates out of `M fx fy C c1x c1y, c2x c2y, tx ty`. */
function parsePath(d: string): { from: Point; c1: Point; c2: Point; to: Point } {
  const [fx, fy, c1x, c1y, c2x, c2y, tx, ty] = numbers(d);
  return { from: { x: fx, y: fy }, c1: { x: c1x, y: c1y }, c2: { x: c2x, y: c2y }, to: { x: tx, y: ty } };
}

/** Pull the three triangle vertices out of `M tip L base1 L base2 Z`. */
function parseArrow(d: string): { tip: Point; base1: Point; base2: Point } {
  const [tx, ty, ax, ay, bx, by] = numbers(d);
  return { tip: { x: tx, y: ty }, base1: { x: ax, y: ay }, base2: { x: bx, y: by } };
}

function numbers(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

function animationSeconds(element: Element): number {
  return Number.parseFloat((element as SVGElement).style.animationDuration);
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
  it('draws one line per dependency edge, from card centre to card centre', async () => {
    setupScene();
    const host = await mountLayer();

    const path = wirePaths(host);
    expect(path).toEqual(['M 420 290 C 729.152 290.152, 742.848 303.848, 1052 304']);
    expect(parsePath(path[0]).from).toEqual(MATRIX_CENTRE);
    expect(parsePath(path[0]).to).toEqual(CHART_CENTRE);
  });

  it('draws a horizontally aligned pair as a straight line', async () => {
    setupScene({
      matrixAt: { x: 100, y: 100, width: 600, height: 400 },
      chartAt: { x: 700, y: 100, width: 600, height: 400 },
    });
    const host = await mountLayer();

    expect(wirePaths(host)).toEqual(['M 400 300 C 700 300, 700 300, 1000 300']);
  });

  it('parks exactly one arrowhead on the target frame, outside the mask', async () => {
    setupScene();
    const host = await mountLayer();

    const arrows = arrowPaths(host);
    expect(arrows).toHaveLength(1);
    const arrow = parseArrow(arrows[0]);
    // The target frame starts at x = 772; anything inside it is erased by the mask.
    expect(arrow.tip.x).toBeLessThan(CHART_AT.x);
    expect(arrow.tip.x).toBeGreaterThan(CHART_AT.x - 12);
    expect(arrow.tip.y).toBeGreaterThan(CHART_AT.y);
    expect(arrow.tip.y).toBeLessThan(CHART_AT.y + CHART_AT.height);
    // The base sits behind the tip (smaller x), so the triangle points into the card.
    expect(arrow.base1.x).toBeLessThan(arrow.tip.x);
    expect(arrow.base2.x).toBeLessThan(arrow.tip.x);
    expect(Math.abs(arrow.base1.y - arrow.base2.y)).toBeCloseTo(8, 1);
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

  // ── flowing dashes (2026-10-29): colour is not the only cue ──────────
  it('dashes the highlighted wire — long for the source, short for the target', async () => {
    const { matrixCardId, chartId } = setupScene();
    const host = await mountLayer(matrixCardId);

    const red = host.querySelector('.connection--fg .connection__wire')!;
    expect(red.getAttribute('class')).toBe('connection__wire connection__wire--flow');
    // 10/6 vs 4/5 in screen px: the pattern itself distinguishes in from out.
    expect(red.getAttribute('stroke-dasharray')).toBe('10 6');
    expect(animationSeconds(red)).toBeCloseTo(16 / 28, 6);

    const root = roots[0];
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness selectedId={chartId} />
        </StrictMode>,
      );
    });
    await flush();
    const blue = host.querySelector('.connection--fg .connection__wire')!;
    expect(blue.getAttribute('stroke-dasharray')).toBe('4 5');
    expect(animationSeconds(blue)).toBeCloseTo(9 / 28, 6);
  });

  it('leaves the unselected background wire a plain grey line', async () => {
    setupScene();
    const host = await mountLayer(null);

    const grey = host.querySelector('.connection--bg .connection__wire')!;
    expect(grey.getAttribute('stroke-dasharray')).toBeNull();
    expect(grey.getAttribute('class')).toBe('connection__wire');
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
      registerCard(secondCardId, stubRoot({ x: 100, y: 620, width: 640, height: 420 }));
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
    expect(wirePaths(host)[0]).toBe('M 420 290 C 729.152 290.152, 742.848 303.848, 1052 304');
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

    // Table centre (420,290) -> function card centre (340,720).
    const path = parsePath(wirePaths(host)[0]);
    expect(path.from).toEqual(MATRIX_CENTRE);
    expect(path.to).toEqual({ x: 340, y: 720 });
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

    const paths = wirePaths(host).map(parsePath);
    expect(paths).toHaveLength(2);
    expect(paths[0].from).toEqual(MATRIX_CENTRE);
    expect(paths[0].to).toEqual({ x: 340, y: 720 });
    expect(paths[1].from).toEqual({ x: 340, y: 720 });
    expect(paths[1].to).toEqual({ x: 340, y: 1120 });
  });

  it('ignores port registration — ports are identity, not geometry (2026-10-29)', async () => {
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
    stubRect(chip, { x: 120, y: 600, width: 80, height: 20 });
    await act(async () => {
      registerPort(functionCard.id, 'src', chip, 'left');
    });

    const host = await mountLayer();

    // The endpoint is still the function card's centre: the chip no longer pulls the wire.
    expect(parsePath(wirePaths(host)[0]).to).toEqual({ x: 340, y: 720 });
  });

  it('routes around a third card instead of letting the mask erase it', async () => {
    const { chartId } = setupScene();

    // Put the chart *below* the table and slide a third card exactly between them.
    let betweenId = 0;
    await act(async () => {
      store().setBounds(chartId, { x: 100, y: 900, width: 640, height: 300 });
      registerCard(chartId, stubRoot({ x: 100, y: 900, width: 640, height: 300 }));
      betweenId = store().addMatrixCard([{ name: 'c.csv', matrix: buildMatrix(2) }]);
      store().setBounds(betweenId, { x: 100, y: 540, width: 640, height: 320 });
      registerCard(betweenId, stubRoot({ x: 100, y: 540, width: 640, height: 320 }));
    });
    await flush();

    const host = await mountLayer();
    const d = wirePaths(host)[0];

    // Table centre (420,290) -> chart centre (420,1050); a straight line would cross the
    // card at (100,540,640,320), so the wire must bend around it — as a smooth bezier
    // chain (2026-10-29: at most two bends, no polyline corners).
    expect(d.startsWith('M 420 290')).toBe(true);
    expect(d).not.toContain(' L ');
    expect(d).not.toContain(' Q ');
    expect((d.match(/C/g) ?? []).length).toBe(3);
    expect(d.endsWith('420 1050')).toBe(true);
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

  it('parks the label in the visible gap between the two cards, not under one', async () => {
    const { matrixCardId } = setupScene();
    const host = await mountLayer(matrixCardId);

    const label = host.querySelector('.connection__label')!;
    const x = Number(label.getAttribute('x'));
    const y = Number(label.getAttribute('y'));
    // Cards cover x <= 740 and x >= 772, so the label has to sit in the 32px gap.
    expect(x).toBeGreaterThan(MATRIX_AT.x + MATRIX_AT.width);
    expect(x).toBeLessThan(CHART_AT.x);
    expect(y).toBeGreaterThan(280);
    expect(y).toBeLessThan(310);
  });

  // ── the trajectory is smooth: follow small deltas, animate jumps ─────

  it('follows a drag frame exactly instead of easing behind it', async () => {
    const { matrixCardId, matrixRoot } = setupScene();
    const host = await mountLayer();

    const moved = { ...MATRIX_AT, x: MATRIX_AT.x + 5 };
    await act(async () => {
      stubRect(matrixRoot, moved);
      store().setBounds(matrixCardId, moved);
      invalidateLayout();
    });
    await flush();

    // 5px is far below the jump threshold: the wire is where the card is, right away.
    expect(parsePath(wirePaths(host)[0]).from).toEqual({ x: 425, y: 290 });
  });

  it('animates a layout jump and still lands on the new centre', async () => {
    const { matrixCardId, matrixRoot } = setupScene();
    const host = await mountLayer();
    const before = wirePaths(host)[0];

    const moved = { ...MATRIX_AT, y: MATRIX_AT.y + 420 };
    await act(async () => {
      stubRect(matrixRoot, moved);
      store().setBounds(matrixCardId, moved);
      invalidateLayout();
    });
    await flush();

    // Not teleported: the wire is still on its way (it has not reached y = 710 yet).
    const during = parsePath(wirePaths(host)[0]).from;
    expect(Math.abs(during.y - 710)).toBeGreaterThan(5);

    await settle(600);
    const after = parsePath(wirePaths(host)[0]);
    expect(after.from).toEqual({ x: 420, y: 710 });
    expect(wirePaths(host)[0]).not.toBe(before);
  });

  // ── zoom: widths and dash lengths are screen px, not plane px ───────

  it('keeps the wire weight and dash length constant on screen at any zoom', async () => {
    // A browser reports *scaled* rects, so at 200% a 640x420 card measures 1280x840.
    const { matrixCardId } = setupScene({
      matrixAt: { x: 200, y: 160, width: 1280, height: 840 },
      chartAt: { x: 1544, y: 208, width: 1120, height: 800 },
    });
    setCanvasZoom(2);

    const plain = await mountLayer(null, 2);
    const grey = plain.querySelector('.connection--bg .connection__wire')!;
    expect(grey.getAttribute('stroke-width')).toBe('0.75');
    // Measured in plane coordinates: the zoom cannot move the endpoints.
    expect(parsePath(wirePaths(plain)[0]).from).toEqual(MATRIX_CENTRE);

    const host = await mountLayer(matrixCardId, 2);
    const wire = host.querySelector('.connection--fg .connection__wire')!;
    expect(wire.getAttribute('stroke-width')).toBe('1.5');
    expect(wire.getAttribute('stroke-dasharray')).toBe('5 3');
    expect((wire as SVGElement).style.getPropertyValue('--connection-dash-cycle')).toBe('-8px');
    // Flow speed is a screen quantity too, so the cycle duration does not change with zoom.
    expect(animationSeconds(wire)).toBeCloseTo(16 / 28, 6);
  });
});
