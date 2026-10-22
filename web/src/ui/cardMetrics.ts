/**
 * Card anchor metrics.
 *
 * The Qt frontend drew connection lines by asking every widget for a global point
 * (`mapToGlobal`) on each repaint. The web equivalent needs the same information,
 * but the platform gives it to us only through the DOM. This module is the single
 * place where that DOM measurement happens:
 *
 *   - a card registers its root element once,
 *   - a matrix table reports the CSS-px offsets of its column headers and its
 *     viewport rectangle,
 *   - the connection layer asks for `headerAnchor()` / `cardTopAnchor()` in canvas
 *     coordinates and never touches the DOM itself.
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

export interface HeaderAnchor {
  /** Canvas-relative point at the centre of the column header. */
  x: number;
  y: number;
  width: number;
  /** False when the column is scrolled out of the table viewport. */
  visible: boolean;
  /** Column is entirely to the left of the viewport. */
  offLeft: boolean;
}

interface CardMetrics {
  root: HTMLElement;
  /** Table viewport (the scrolling box), when the card has a table. */
  tableViewport?: HTMLElement;
  /** Header x offset (within the header row) for each column, in CSS px. */
  columnOffsets: number[];
  columnWidths: number[];
  headerHeight: number;
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
  const existing = cards.get(id);
  cards.set(id, { ...(existing ?? { columnOffsets: [], columnWidths: [], headerHeight: 0 }), root });
  invalidateLayout();
}

export function unregisterCard(id: number): void {
  if (cards.delete(id)) invalidateLayout();
}

/**
 * Publish the table geometry for a matrix card.
 * `offsets`/`widths` are the cumulative left edge and width of each column header;
 * the caller keeps them in sync with the horizontal scroll position.
 */
export function setTableMetrics(
  id: number,
  metrics: {
    tableViewport: HTMLElement | null;
    columnOffsets: number[];
    columnWidths: number[];
    headerHeight: number;
  },
): void {
  const existing = cards.get(id);
  if (!existing) return;
  cards.set(id, {
    ...existing,
    tableViewport: metrics.tableViewport ?? undefined,
    columnOffsets: metrics.columnOffsets,
    columnWidths: metrics.columnWidths,
    headerHeight: metrics.headerHeight,
  });
  invalidateLayout();
}

export function clearTableMetrics(id: number): void {
  const existing = cards.get(id);
  if (!existing) return;
  cards.set(id, {
    ...existing,
    tableViewport: undefined,
    columnOffsets: [],
    columnWidths: [],
    headerHeight: 0,
  });
  invalidateLayout();
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
export function canvasSize(): { width: number; height: number } {
  if (!viewportElement) return { width: 0, height: 0 };
  const rect = viewportElement.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
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
    left: v.left - origin.left,
    top: v.top - origin.top,
    width: v.width,
    height: v.height,
  };
}

function toCanvas(rect: DOMRect, canvas: Rect): Rect {
  return {
    left: rect.left - canvas.left,
    top: rect.top - canvas.top,
    width: rect.width,
    height: rect.height,
  };
}

export function cardRect(id: number): Rect | null {
  const metrics = cards.get(id);
  if (!metrics) return null;
  return toCanvas(metrics.root.getBoundingClientRect(), canvasRect());
}

/** Anchor at the top-centre of a card — used for the chart end of a line. */
export function cardTopAnchor(id: number): { x: number; y: number } | null {
  const rect = cardRect(id);
  if (!rect) return null;
  return { x: rect.left + rect.width / 2, y: rect.top };
}

/**
 * Anchor at the centre of a matrix column header.
 *
 * When the column is outside the table viewport the Qt code snapped the endpoint to
 * the left or right edge of the window instead; we reproduce that by reporting
 * `visible: false` plus the off-screen width, letting the caller clamp.
 */
export function headerAnchor(id: number, columnIndex: number): HeaderAnchor | null {
  const metrics = cards.get(id);
  if (!metrics) return null;
  const card = cardRect(id);
  if (!card) return null;

  const offset = metrics.columnOffsets[columnIndex];
  const width = metrics.columnWidths[columnIndex] ?? 0;
  if (offset === undefined || width === 0) return null;

  const viewport = metrics.tableViewport;
  const canvas = canvasRect();

  if (!viewport) {
    return { x: card.left + offset + width / 2, y: card.top, width, visible: true, offLeft: false };
  }

  const viewportRect = viewport.getBoundingClientRect();
  const scrollLeft = viewport.scrollLeft;

  // Where the header sits inside the table viewport, in viewport-local px.
  const localLeft = offset - scrollLeft;
  const visible = localLeft + width > 0 && localLeft < viewportRect.width;

  const canvasViewportLeft = viewportRect.left - canvas.left;
  const canvasViewportRight = canvasViewportLeft + viewportRect.width;

  if (!visible) {
    const x = localLeft < 0 ? canvasViewportLeft : canvasViewportRight;
    return {
      x,
      y: viewportRect.top - canvas.top,
      width,
      visible: false,
      offLeft: localLeft < 0,
    };
  }

  return {
    x: canvasViewportLeft + localLeft + width / 2,
    y: viewportRect.top - canvas.top,
    width,
    visible: true,
    offLeft: false,
  };
}

/** Reset everything — used when the whole workspace is replaced. */
export function resetMetrics(): void {
  cards.clear();
  invalidateLayout();
}
