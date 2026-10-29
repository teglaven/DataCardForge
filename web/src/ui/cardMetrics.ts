/**
 * Card anchor metrics.
 *
 * The Qt frontend drew connection lines by asking every widget for a global point
 * (`mapToGlobal`) on each repaint. The web equivalent needs the same information,
 * but the platform gives it to us only through the DOM. This module is the single
 * place where that DOM measurement happens:
 *
 *   - a card registers its root element once,
 *   - the connection layer asks for `cardRect()` in canvas coordinates and never touches
 *     the DOM itself (it derives the wire endpoints from the rectangle's centre).
 *
 * All measurements are in CSS pixels relative to the canvas container, so window
 * scroll and devicePixelRatio do not have to be handled twice.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CardMetrics {
  root: HTMLElement;
}

/** Monotonic counter bumped whenever a measurement could have changed. */
let layoutVersion = 0;
const listeners = new Set<() => void>();
const cards = new Map<number, CardMetrics>();
/**
 * Two different references, because the canvas is now a pannable, unbounded plane:
 *
 *   - `viewportElement` is the visible clipping box — its *size* answers "how much room
 *     does the user have on screen" (Tile/Cascade, new-card placement).
 *   - `worldElement` is the origin of the card coordinate system. It carries the pan
 *     transform, so `getBoundingClientRect()` differences against it stay in plane
 *     coordinates no matter how far the view has been panned — the same trick that used
 *     to make scroll position a non-issue.
 *
 * Before the plane was pannable these were the same element, which is why the module
 * predates the split.
 */
let viewportElement: HTMLElement | null = null;
let worldElement: HTMLElement | null = null;

export function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLayoutVersion(): number {
  return layoutVersion;
}

/** Mark the layout dirty; React subscribers recompute on the next frame. */
export function invalidateLayout(): void {
  layoutVersion += 1;
  for (const listener of listeners) listener();
}

export function setCanvasElement(element: HTMLElement | null): void {
  viewportElement = element;
  invalidateLayout();
}

/** Register the panned world layer that defines the card coordinate origin. */
export function setWorldElement(element: HTMLElement | null): void {
  worldElement = element;
  invalidateLayout();
}

export function registerCard(id: number, root: HTMLElement): void {
  cards.set(id, { root });
  invalidateLayout();
}

export function unregisterCard(id: number): void {
  if (cards.delete(id)) invalidateLayout();
}

/**
 * Size of the *visible* canvas viewport, in CSS px.
 *
 * `Tile`/`Cascade` and new-card placement must measure *this*, not the window or the app
 * shell: the shell also contains the menu bar and the status bar, so sizing cards from it
 * made every tiled card ~48px taller than the canvas and pushed its bottom edge (and the
 * south-east resize handle) off-screen. Note it is the viewport, not the card plane: the
 * plane is unbounded, so "how big is the canvas" only means anything on screen.
 */
/**
 * Zoom bounds for the whole workbench. Shared by the store (zoom-to-fit) and the canvas
 * (wheel zoom), so the two can never disagree about how far the view may go.
 *
 * The lower bound is deliberately far out: "adapt the view to the cards" (View → Reset
 * View) is the answer to a workflow that spans several screens, and at 20% that answer
 * only reaches ~5 screenfuls — the very complaint that started this feature. Text is
 * unreadable down there, which is fine: it is an overview, not a reading mode.
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;

/** Current zoom of the world layer. 1 = 100%. */
let worldScale = 1;

/**
 * Publish the zoom so measurements can be converted back into plane units.
 *
 * `getBoundingClientRect()` reports *scaled* screen pixels, so every difference has to be
 * divided by the zoom before it means anything in card coordinates — the same reason the
 * pan cancels out of the differences.
 */
export function setCanvasZoom(zoom: number): void {
  if (zoom === worldScale || !Number.isFinite(zoom) || zoom <= 0) return;
  worldScale = zoom;
  invalidateLayout();
}

export function getCanvasZoom(): number {
  return worldScale;
}

export function canvasSize(): { width: number; height: number } {
  if (!viewportElement) return { width: 0, height: 0 };
  const rect = viewportElement.getBoundingClientRect();
  // Reported in *plane* units: every caller places cards with it (Tile/Cascade), and at
  // 50% zoom the same screen box holds twice as many plane pixels.
  return { width: rect.width / worldScale, height: rect.height / worldScale };
}

/**
 * Origin of the card coordinate system, in screen px.
 *
 * Every measurement is a difference against this rectangle, so panning cancels out and
 * all anchors stay in unbounded plane coordinates.
 */
function canvasRect(): Rect {
  const element = worldElement ?? viewportElement;
  if (!element) return { left: 0, top: 0, width: 0, height: 0 };
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * The visible viewport rectangle expressed in plane coordinates.
 *
 * New cards are placed relative to *this*: with an unbounded plane there is no "canvas
 * edge" to clamp against any more, but a card must still be born where the user can see
 * it. Panning moves the rectangle, so a card created after panning lands in view.
 */
export function viewportRectInWorld(): Rect {
  if (!viewportElement) return { left: 0, top: 0, width: 0, height: 0 };
  const origin = canvasRect();
  const v = viewportElement.getBoundingClientRect();
  return {
    left: (v.left - origin.left) / worldScale,
    top: (v.top - origin.top) / worldScale,
    width: v.width / worldScale,
    height: v.height / worldScale,
  };
}

function toCanvas(rect: DOMRect, canvas: Rect): Rect {
  // Screen differences divided by the zoom: the world layer is CSS-scaled, so a card that
  // measures 400px wide on screen is 200 plane px at 200% zoom.
  return {
    left: (rect.left - canvas.left) / worldScale,
    top: (rect.top - canvas.top) / worldScale,
    width: rect.width / worldScale,
    height: rect.height / worldScale,
  };
}

export function cardRect(id: number): Rect | null {
  const metrics = cards.get(id);
  if (!metrics) return null;
  return toCanvas(metrics.root.getBoundingClientRect(), canvasRect());
}

/**
 * Which side of a card a line leaves from or enters into.
 *
 * A line is not just two points: the side decides the bezier's control points *and* the
 * direction of the arrowhead. Sending every wire out of the top edge made a card that
 * sits below its source bend the line back over itself; a port on the left column and an
 * output on the right column left/entered horizontally.
 *
 * **Since 2026-10-29 nothing in the connection layer reads this**: wires own the whole
 * curve (`wireGeometry` in `connectionGeometry.ts`), endpoints are card centres, and the
 * arrowhead follows the curve's tangent. `AnchorSide` is kept only because the dormant
 * port anchors below still carry one.
 */
export type AnchorSide = 'top' | 'bottom' | 'left' | 'right';

export interface Anchor {
  x: number;
  y: number;
  side: AnchorSide;
}

/** Port anchors registered by the cards that actually render ports (2026-10-28). */
const ports = new Map<number, Map<string, { element: HTMLElement; side: AnchorSide }>>();

/**
 * Register one rendered port element as a line endpoint.
 *
 * `portId` — not its position — is the identity (port-semantics-v1 §已锁定 1). Cards call
 * this from a ref callback.
 *
 * **Since 2026-10-29 the connection layer does not read these anchors any more**: a wire
 * runs from one card centre to the other (see `connectionGeometry.ts` and the
 * `2026-10-29-connection-center-anchors` decision), and a `portId` survives only as data
 * identity in the edge and in the on-line label. The measurement is kept because the
 * "port marker dot" from the 08-07 subordination decision is still unimplemented, and it
 * is the only existing way to place a dot on a rendered port.
 */
export function registerPort(
  cardId: number,
  portId: string,
  element: HTMLElement,
  side: AnchorSide = 'left',
): void {
  let cardPorts = ports.get(cardId);
  if (!cardPorts) {
    cardPorts = new Map();
    ports.set(cardId, cardPorts);
  }
  cardPorts.set(portId, { element, side });
  invalidateLayout();
}

export function unregisterPort(cardId: number, portId: string): void {
  const cardPorts = ports.get(cardId);
  if (!cardPorts || !cardPorts.delete(portId)) return;
  if (cardPorts.size === 0) ports.delete(cardId);
  invalidateLayout();
}

/** Centre of the registered port element, in plane coordinates. */
export function portAnchor(cardId: number, portId: string): Anchor | null {
  const entry = ports.get(cardId)?.get(portId);
  if (!entry) return null;
  const r = entry.element.getBoundingClientRect();
  const origin = canvasRect();
  return {
    x: (r.left + r.width / 2 - origin.left) / worldScale,
    y: (r.top + r.height / 2 - origin.top) / worldScale,
    side: entry.side,
  };
}

/** Anchor on one side of a card: top/bottom mid-point, or left/right mid-height. */
export function cardAnchor(id: number, side: AnchorSide = 'top'): Anchor | null {
  const rect = cardRect(id);
  if (!rect) return null;
  switch (side) {
    case 'top':
      return { x: rect.left + rect.width / 2, y: rect.top, side };
    case 'bottom':
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height, side };
    case 'left':
      return { x: rect.left, y: rect.top + rect.height / 2, side };
    case 'right':
      return { x: rect.left + rect.width, y: rect.top + rect.height / 2, side };
  }
}

/** Anchor at the top-centre of a card — the card-level fallback this layer used to use. */
export function cardTopAnchor(id: number): Anchor | null {
  return cardAnchor(id, 'top');
}

/** Reset everything — used when the whole workspace is replaced. */
export function resetMetrics(): void {
  cards.clear();
  ports.clear();
  invalidateLayout();
}
