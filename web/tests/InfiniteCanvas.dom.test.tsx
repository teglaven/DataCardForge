/**
 * @vitest-environment jsdom
 *
 * Infinite (pannable, unbounded) canvas.
 *
 * These lock in the rules that replaced "one screenful":
 *   - the plane grows with the cards instead of ending at the window edge,
 *   - new cards are placed next to their parent and the *view* follows them (folding the
 *     card back would stretch its connection line across the plane),
 *   - panning is bounded by the plane, not by a fixed canvas size,
 *   - cards keep ownership of the wheel: the virtual table scrolls, the chart zooms.
 *
 * `cardMetrics` measures through `getBoundingClientRect`, and jsdom returns all-zero
 * rectangles, so the tests that need geometry stub it explicitly.
 */
import { StrictMode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_ZOOM,
  MIN_ZOOM,
  setCanvasElement,
  setCanvasZoom,
  setWorldElement,
  viewportRectInWorld,
} from '../src/ui/cardMetrics.ts';
import { MatrixData } from '../src/core/MatrixData.ts';
import { useWorkspace } from '../src/ui/workspaceStore.ts';
import { CardCanvas } from '../src/ui/components/CardCanvas.tsx';

// React 19 wants this set so act() works outside its test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; CardCanvas only uses it to notice viewport resizes.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const roots: ReturnType<typeof createRoot>[] = [];

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

async function mountCanvas(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <StrictMode>
        <CardCanvas onNewTable={() => {}} onFilesDropped={() => {}} onContextMenu={() => {}} />
      </StrictMode>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

const store = () => useWorkspace.getState();

/** A one-column matrix, laid out the way the file loaders produce one. */
function matrix(values: number[]): MatrixData {
  const mat = new MatrixData();
  mat.appendColumn('Pos.1', values);
  return mat;
}

beforeEach(() => {
  store().reset();
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
  setCanvasElement(null);
  setWorldElement(null);
  setCanvasZoom(1);
});

describe('viewportRectInWorld', () => {
  it('expresses the visible box in plane coordinates, so panning cancels out', () => {
    const viewport = document.createElement('div');
    stubRect(viewport, { left: 0, top: 0, width: 1000, height: 700 });
    const world = document.createElement('div');
    // The world layer is translated by the pan: panned by (300, 200).
    stubRect(world, { left: -300, top: -200, width: 6000, height: 6000 });
    setCanvasElement(viewport);
    setWorldElement(world);

    expect(viewportRectInWorld()).toEqual({ left: 300, top: 200, width: 1000, height: 700 });
  });

  it('reports an unmeasurable box as empty rather than inventing one', () => {
    expect(viewportRectInWorld()).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

describe('placing new cards on the unbounded plane', () => {
  it('puts a chart beside its table when the table is in view', () => {
    const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([1, 2, 3]) }]);
    store().setBounds(matrixCardId, { x: 100, y: 80, width: 640, height: 420 });

    const chartId = store().addChartCard(matrixCardId, 0);
    const chart = store().cards.find((c) => c.id === chartId)!;

    expect(chart.x).toBe(100 + 640 + 32);
    expect(chart.y).toBe(80 + 24);
  });

  it('pans the view to a card created far from the visible area instead of folding it back', () => {
    const viewport = document.createElement('div');
    stubRect(viewport, { left: 0, top: 0, width: 1000, height: 700 });
    const world = document.createElement('div');
    stubRect(world, { left: 0, top: 0, width: 20000, height: 20000 });
    setCanvasElement(viewport);
    setWorldElement(world);

    const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([1, 2, 3]) }]);
    // Drag the table far to the right of anything currently visible.
    store().setBounds(matrixCardId, { x: 8000, y: 6000, width: 640, height: 420 });
    store().setView({ x: 0, y: 0, zoom: 1 });

    const chartId = store().addChartCard(matrixCardId, 0);
    const chart = store().cards.find((c) => c.id === chartId)!;

    // The card stays where it belongs — next to its parent...
    expect(chart.x).toBe(8000 + 640 + 32);
    // ...and the view travels to it.
    expect(store().view.x).toBeGreaterThan(8000);
    expect(store().view.y).toBeGreaterThan(5000);
  });

  it('cascades instead of stacking a second card on the first', () => {
    const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([1, 2, 3]) }]);
    store().setBounds(matrixCardId, { x: 100, y: 80, width: 640, height: 420 });

    const first = store().addChartCard(matrixCardId, 0)!;
    const second = store().addChartCard(matrixCardId, 0)!;
    const a = store().cards.find((c) => c.id === first)!;
    const b = store().cards.find((c) => c.id === second)!;

    expect(b.x).not.toBe(a.x);
    expect(b.y).not.toBe(a.y);
  });

  it('never places a card at negative coordinates', () => {
    const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([1, 2, 3]) }]);
    store().setBounds(matrixCardId, { x: 0, y: 0, width: 640, height: 420 });

    const chartId = store().addChartCard(matrixCardId, 0)!;
    const chart = store().cards.find((c) => c.id === chartId)!;

    expect(chart.x).toBeGreaterThanOrEqual(8);
    expect(chart.y).toBeGreaterThanOrEqual(8);
  });
});

describe('pan gestures', () => {
  it('pans with a middle-button drag', async () => {
    const host = await mountCanvas();
    const canvas = host.querySelector('.canvas') as HTMLElement;

    await act(async () => {
      canvas.dispatchEvent(
        new MouseEvent('pointerdown', { button: 1, clientX: 500, clientY: 400, bubbles: true }),
      );
      canvas.dispatchEvent(
        new MouseEvent('pointermove', { clientX: 460, clientY: 370, bubbles: true }),
      );
      canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: 460, clientY: 370, bubbles: true }));
    });

    // Dragging the plane left/up moves the view right/down. Pan is in *screen* px, which
    // is why it is unaffected by the zoom.
    expect(store().view).toEqual({ x: 40, y: 30, zoom: 1 });
  });

  it('pans at any zoom without scaling the delta twice', async () => {
    const host = await mountCanvas();
    const canvas = host.querySelector('.canvas') as HTMLElement;
    store().setView({ x: 0, y: 0, zoom: 2 });

    await act(async () => {
      canvas.dispatchEvent(
        new MouseEvent('pointerdown', { button: 1, clientX: 500, clientY: 400, bubbles: true }),
      );
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 480, clientY: 390, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: 480, clientY: 390, bubbles: true }));
    });

    // 20 screen px of travel must be 20 px of pan, not 40: `view` is already screen space.
    expect(store().view.x).toBe(20);
    expect(store().view.y).toBe(10);
  });

  it('does not pan on a plain click, and still clears the selection', async () => {
    const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([1, 2, 3]) }]);
    store().select(matrixCardId);
    const host = await mountCanvas();
    const canvas = host.querySelector('.canvas') as HTMLElement;

    await act(async () => {
      canvas.dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, clientX: 500, clientY: 400, bubbles: true }),
      );
      canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: 500, clientY: 400, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 400, bubbles: true }));
    });

    expect(store().view).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(store().selectedId).toBeNull();
  });
});

describe('wheel zoom of the whole workbench', () => {
  const wheel = (target: HTMLElement, init: WheelEventInit) =>
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }));

  it('zooms out on a wheel-down over the bare canvas', async () => {
    const host = await mountCanvas();
    const canvas = host.querySelector('.canvas') as HTMLElement;

    await act(async () => wheel(canvas, { deltaY: 120, clientX: 700, clientY: 400 }));

    expect(store().view.zoom).toBeLessThan(1);
  });

  it('zooms in on a wheel-up and keeps the point under the cursor fixed', async () => {
    const host = await mountCanvas();
    const canvas = host.querySelector('.canvas') as HTMLElement;
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const before = store().view;
    const cursor = { x: 300, y: 200 };
    // Plane point under the cursor before the zoom.
    const anchorBefore = {
      x: (cursor.x + before.x) / before.zoom,
      y: (cursor.y + before.y) / before.zoom,
    };

    await act(async () => wheel(canvas, { deltaY: -120, clientX: cursor.x, clientY: cursor.y }));

    const after = store().view;
    expect(after.zoom).toBeGreaterThan(1);
    // screen = plane*zoom - pan, solved for plane: it must be the same point.
    expect((cursor.x + after.x) / after.zoom).toBeCloseTo(anchorBefore.x, 6);
    expect((cursor.y + after.y) / after.zoom).toBeCloseTo(anchorBefore.y, 6);
  });

  it('never zooms past its limits', async () => {
    const host = await mountCanvas();
    const canvas = host.querySelector('.canvas') as HTMLElement;

    await act(async () => {
      for (let i = 0; i < 80; i += 1) wheel(canvas, { deltaY: -120, clientX: 400, clientY: 300 });
    });
    expect(store().view.zoom).toBeLessThanOrEqual(MAX_ZOOM);

    await act(async () => {
      for (let i = 0; i < 200; i += 1) wheel(canvas, { deltaY: 120, clientX: 400, clientY: 300 });
    });
    expect(store().view.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
  });

  it('leaves the wheel to the cards (table scrolling, chart zoom)', async () => {
    const host = await mountCanvas();
    const canvas = host.querySelector('.canvas') as HTMLElement;
    // Any descendant of a `.card` owns its own wheel behaviour.
    const card = document.createElement('div');
    card.className = 'card';
    canvas.appendChild(card);

    await act(async () => wheel(card, { deltaY: 120 }));

    expect(store().view).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('still zooms over a card when Ctrl is held (trackpad pinch too)', async () => {
    const host = await mountCanvas();
    const canvas = host.querySelector('.canvas') as HTMLElement;
    const card = document.createElement('div');
    card.className = 'card';
    canvas.appendChild(card);

    await act(async () => wheel(card, { deltaY: -120, ctrlKey: true, clientX: 300, clientY: 300 }));

    expect(store().view.zoom).toBeGreaterThan(1);
  });

  it('measures the visible box in plane units while zoomed', () => {
    const viewport = document.createElement('div');
    stubRect(viewport, { left: 0, top: 0, width: 1000, height: 800 });
    const world = document.createElement('div');
    stubRect(world, { left: -200, top: -100, width: 8000, height: 8000 });
    setCanvasElement(viewport);
    setWorldElement(world);
    setCanvasZoom(2);

    // Screen differences halved, and the pan (200, 100) screen px is 100/50 plane px.
    expect(viewportRectInWorld()).toEqual({ left: 100, top: 50, width: 500, height: 400 });
  });

  it('resets with a zoom-to-fit that frames every card', async () => {
    const viewport = document.createElement('div');
    stubRect(viewport, { left: 0, top: 0, width: 1000, height: 800 });
    const world = document.createElement('div');
    stubRect(world, { left: 0, top: 0, width: 8000, height: 8000 });
    setCanvasElement(viewport);
    setWorldElement(world);

    const matrixCardId = store().addMatrixCard([{ name: 'a.csv', matrix: matrix([1, 2, 3]) }]);
    store().setBounds(matrixCardId, { x: 0, y: 0, width: 640, height: 420 });
    const chartId = store().addChartCard(matrixCardId, 0)!;
    store().setBounds(chartId, { x: 5000, y: 3000, width: 560, height: 400 });

    const before = store().view.zoom;
    store().resetView();
    const after = store().view.zoom;

    // The cards span far more than one screenful, so fitting them must zoom out…
    expect(after).toBeLessThan(before);
    // …and the widest extent (5000 + 560) has to end up inside the 1000px viewport.
    expect((5000 + 560) * after - store().view.x).toBeLessThanOrEqual(1000 + 1);
  });
});
