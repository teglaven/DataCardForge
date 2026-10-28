/**
 * @vitest-environment jsdom
 *
 * Anchor geometry — the seam between the DOM and the connection layer.
 *
 * A port anchor is identified by `portId` (port-semantics-v1 §已锁定 1), measured from the
 * element the card registers, and converted into *plane* coordinates by dividing out the
 * zoom — the same conversion `cardRect` performs, so a wire and a card can never disagree
 * about where the same point is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cardAnchor,
  portAnchor,
  registerCard,
  registerPort,
  resetMetrics,
  setCanvasElement,
  setCanvasZoom,
  setWorldElement,
  unregisterPort,
} from '../src/ui/cardMetrics.ts';

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

function setupWorld(): void {
  const viewport = document.createElement('div');
  stubRect(viewport, { left: 0, top: 0, width: 1200, height: 800 });
  const world = document.createElement('div');
  stubRect(world, { left: 0, top: 0, width: 20000, height: 20000 });
  setCanvasElement(viewport);
  setWorldElement(world);
}

beforeEach(() => {
  resetMetrics();
  setCanvasElement(null);
  setWorldElement(null);
  setCanvasZoom(1);
});

afterEach(() => {
  resetMetrics();
  setCanvasElement(null);
  setWorldElement(null);
  setCanvasZoom(1);
});

describe('card anchors', () => {
  beforeEach(() => {
    setupWorld();
    const root = document.createElement('div');
    stubRect(root, { left: 100, top: 80, width: 640, height: 420 });
    registerCard(1, root);
  });

  it('resolves each side to its own mid-point', () => {
    expect(cardAnchor(1, 'top')).toEqual({ x: 420, y: 80, side: 'top' });
    expect(cardAnchor(1, 'bottom')).toEqual({ x: 420, y: 500, side: 'bottom' });
    expect(cardAnchor(1, 'left')).toEqual({ x: 100, y: 290, side: 'left' });
    expect(cardAnchor(1, 'right')).toEqual({ x: 740, y: 290, side: 'right' });
  });

  it('returns null for a card that was never registered', () => {
    expect(cardAnchor(99, 'top')).toBeNull();
  });

  it('divides the zoom out of the measurement', () => {
    // At 200% the world layer is CSS-scaled, so 200 screen px is 100 plane px.
    setCanvasZoom(2);
    const root = document.createElement('div');
    stubRect(root, { left: 200, top: 160, width: 1280, height: 840 });
    registerCard(2, root);
    expect(cardAnchor(2, 'top')).toEqual({ x: 840 / 2, y: 80, side: 'top' });
  });
});

describe('port anchors', () => {
  beforeEach(() => {
    setupWorld();
    const root = document.createElement('div');
    stubRect(root, { left: 100, top: 560, width: 480, height: 320 });
    registerCard(1, root);
  });

  it('measures the centre of the registered element', () => {
    const chip = document.createElement('span');
    stubRect(chip, { left: 120, top: 600, width: 80, height: 20 });
    registerPort(1, 'src', chip, 'left');

    expect(portAnchor(1, 'src')).toEqual({ x: 160, y: 610, side: 'left' });
  });

  it('keeps the side that was registered, because the arrowhead depends on it', () => {
    const chip = document.createElement('span');
    stubRect(chip, { left: 500, top: 600, width: 60, height: 20 });
    registerPort(1, 'result', chip, 'right');

    expect(portAnchor(1, 'result')?.side).toBe('right');
  });

  it('returns null once the port is unregistered or was never registered', () => {
    const chip = document.createElement('span');
    stubRect(chip, { left: 120, top: 600, width: 80, height: 20 });
    registerPort(1, 'src', chip, 'left');
    unregisterPort(1, 'src');

    expect(portAnchor(1, 'src')).toBeNull();
    expect(portAnchor(1, 'y')).toBeNull();
    expect(portAnchor(99, 'src')).toBeNull();
  });

  it('forgets every port when the workspace is reset', () => {
    const chip = document.createElement('span');
    stubRect(chip, { left: 120, top: 600, width: 80, height: 20 });
    registerPort(1, 'src', chip, 'left');
    resetMetrics();

    expect(portAnchor(1, 'src')).toBeNull();
  });
});
