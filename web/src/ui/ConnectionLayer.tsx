/**
 * Connection layer — the React/SVG counterpart of `src/widgets/ConnectionOverlay.cpp`.
 *
 * Honours the project's **connection subordination** principle: connections are a
 * background visualization of data dependencies, they never intercept pointer
 * events, and they never take part in card layout.
 *
 * As of 2026-10-28 the layer draws **every** dependency edge, not only the ones whose
 * dependent side is a chart card: schema v2 made function cards first-class graph nodes
 * (`inputs[]` on the envelope), so a chain `table → function → chart` is two edges and
 * therefore two lines. Endpoints resolve to a **port** when the edge names one and the
 * card renders it (`portAnchor`, keyed by `portId`, never by position); otherwise they
 * fall back to the card edge that faces the other card. A pair of cards is still exactly
 * one line — a chart reading three columns of one table keeps one line and lists its
 * ports on the label.
 *
 * Layering reproduces the Qt two-overlay scheme with a single SVG using two groups:
 *   - `bg` group: thin grey lines for unselected cards, painted under the highlight
 *   - `fg` group: thick red/blue lines for the active card, painted on top
 *
 * Colours are carried over from the Qt version, with the grey lifted to meet contrast:
 *   red rgb(200,50,50) for the selected source, blue rgb(40,120,220) for the selected
 *   dependent, grey rgb(107,114,128) when nothing is selected.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  cardAnchor,
  cardRect,
  portAnchor,
  subscribeLayout,
  getLayoutVersion,
  type Anchor,
  type Rect,
} from './cardMetrics.ts';
import type { DependencyGraph } from '../core/DependencyGraph.ts';
import { isFormulaCard, type CardModel } from './types.ts';

const COLOR_GREY = 'rgb(107, 114, 128)';
const COLOR_RED = 'rgb(200, 50, 50)';
const COLOR_BLUE = 'rgb(40, 120, 220)';

/** Durations mirroring the Qt blink timer: 200 ms tick, 6 ticks (3 on / 3 off). */
const BLINK_INTERVAL_MS = 200;
const BLINK_TICKS = 6;

/**
 * Output port that produced the matrix an edge hands over.
 *
 * The envelope names the *matrix* (`target.matrixId`), so a card with K outputs has to be
 * resolved back to one output id. `displayMatrixId` is the matrix the UI shows (output 0)
 * while `outputs[].resultMatrixId` is the server-side id — two different id spaces — so a
 * single-output card answers directly and K > 1 stays card-level instead of guessing.
 */
function sourceOutputId(card: CardModel | undefined, matrixId: number): string | null {
  if (!card || !isFormulaCard(card)) return null;
  const match = card.outputs.find((output) => output.resultMatrixId === matrixId);
  if (match) return match.outputId;
  if (card.outputs.length === 1) return card.outputs[0].outputId;
  if (card.displayMatrixId === matrixId) return card.outputs[0]?.outputId ?? null;
  return null;
}

export interface Connection {
  key: string;
  from: Anchor;
  to: Anchor;
  /** Target-side port ids carried by this edge, for the on-line label. */
  ports: string[];
  dependsOn: number;
  dependent: number;
  color: string;
  highlighted: boolean;
}

/**
 * Recompute every connection endpoint whenever the layout could have changed.
 * Subscribes to the layout version counter (bumped by drag/resize/scroll and by port
 * (un)registration) plus window resize, and coalesces redraws into one animation frame.
 */
export function useConnectionGeometry(
  cards: CardModel[],
  selectedId: number | null,
  dependencies: DependencyGraph,
): Connection[] {
  const version = useSyncLayoutVersion();
  const [tick, setTick] = useState(0);

  // Coalesce bursts of layout changes (drag produces one per frame) into one render.
  useEffect(() => {
    let frame = requestAnimationFrame(() => setTick((t) => t + 1));
    return () => cancelAnimationFrame(frame);
  }, [version]);

  useEffect(() => {
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return useMemo(() => {
    const out: Connection[] = [];

    for (const edge of dependencies.edges()) {
      const sourceCard = cards.find((card) => card.id === edge.dependsOn);
      const targetCard = cards.find((card) => card.id === edge.dependent);
      if (!sourceCard || !targetCard) continue;

      // Endpoint priority: the named port, then the card edge that faces the other card.
      const input = targetCard.inputs.find((entry) => entry.target.cardId === edge.dependsOn);
      const outputId = sourceOutputId(sourceCard, input?.target.matrixId ?? -1);
      const from =
        (outputId ? portAnchor(edge.dependsOn, outputId) : null) ??
        cardAnchor(edge.dependsOn, 'right');
      const to =
        (edge.ports.length === 1 ? portAnchor(edge.dependent, edge.ports[0]) : null) ??
        cardAnchor(edge.dependent, 'left');
      if (!from || !to) continue;

      let color = COLOR_GREY;
      let highlighted = false;
      if (selectedId === edge.dependsOn) {
        color = COLOR_RED;
        highlighted = true;
      } else if (selectedId === edge.dependent) {
        color = COLOR_BLUE;
        highlighted = true;
      }

      out.push({
        key: `${edge.dependsOn}->${edge.dependent}`,
        from,
        to,
        ports: edge.ports,
        dependsOn: edge.dependsOn,
        dependent: edge.dependent,
        color,
        highlighted,
      });
    }

    return out;
  }, [cards, selectedId, dependencies, tick]);
}

/**
 * Canvas-relative rectangles of every card, refreshed whenever the layout could change.
 *
 * These become the holes in the connection mask: the lines belong to the desktop *behind*
 * the cards, so they must not be painted across a card's face.
 */
function useCardRects(cards: CardModel[]): Rect[] {
  const version = useSyncLayoutVersion();
  // `cardRect` reads the live DOM, so the memo is keyed on the layout version as well as
  // the card list — a drag or resize bumps the version without changing `cards`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(
    () => cards.map((card) => cardRect(card.id)).filter((rect): rect is Rect => rect !== null),
    [cards, version],
  );
}

function useSyncLayoutVersion(): number {
  const [version, setVersion] = useState(getLayoutVersion);
  useEffect(() => {
    let frame = 0;
    return subscribeLayout(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVersion(getLayoutVersion());
      });
    });
  }, []);
  return version;
}

/**
 * Reset the blink animation each time a new close attempt is blocked.
 * `nonce` changes on every refusal, so blocking the same card twice re-flashes.
 * Returns the set of card ids that should currently be invisible.
 */
export function useBlockedBlink(blockedCardId: number | null, nonce: number): Set<number> {
  const [visible, setVisible] = useState(true);
  const [active, setActive] = useState<number | null>(null);
  const ticksRef = useRef(0);

  useEffect(() => {
    if (blockedCardId === null) return;
    setActive(blockedCardId);
    setVisible(true);
    ticksRef.current = BLINK_TICKS;
  }, [blockedCardId, nonce]);

  useEffect(() => {
    if (active === null) return;
    const timer = window.setInterval(() => {
      setVisible((v) => !v);
      ticksRef.current -= 1;
      if (ticksRef.current <= 0) {
        window.clearInterval(timer);
        setActive(null);
        setVisible(true);
      }
    }, BLINK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  return useMemo(() => {
    if (active === null || visible) return new Set<number>();
    return new Set<number>([active]);
  }, [active, visible]);
}

/** Outgoing control point: the curve leaves the anchor along its side's normal. */
function outControl(anchor: Anchor): { x: number; y: number } {
  switch (anchor.side) {
    case 'right':
      return { x: anchor.x + 60, y: anchor.y };
    case 'left':
      return { x: anchor.x - 60, y: anchor.y };
    case 'bottom':
      return { x: anchor.x, y: anchor.y + 30 };
    default:
      // Top anchors keep the Qt offsets; clamping keeps the curve inside the plane.
      return { x: anchor.x, y: Math.max(0, anchor.y - 30) };
  }
}

/** Incoming control point: same rule mirrored, with the Qt `-80` lift for top anchors. */
function inControl(anchor: Anchor): { x: number; y: number } {
  switch (anchor.side) {
    case 'left':
      return { x: anchor.x - 60, y: anchor.y };
    case 'right':
      return { x: anchor.x + 60, y: anchor.y };
    case 'bottom':
      return { x: anchor.x, y: anchor.y + 80 };
    default:
      return { x: anchor.x, y: Math.max(0, anchor.y - 80) };
  }
}

/**
 * Cubic bezier between two anchors.
 *
 * A cubic bezier is contained in the convex hull of its control points, so clamping the
 * control lift to >= 0 keeps the whole curve inside the plane (`overflow: hidden` would
 * otherwise clip it). Anchors default to the top side, which is the geometry the Qt
 * overlay used; real callers pass the port's own side.
 */
export function connectionPath(from: Anchor, to: Anchor): string {
  const c1 = outControl(from);
  const c2 = inControl(to);
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

/** Inward normal of an anchor: the direction a line points once it reaches the card. */
function inward(side: Anchor['side']): { x: number; y: number } {
  switch (side) {
    case 'left':
      return { x: 1, y: 0 };
    case 'right':
      return { x: -1, y: 0 };
    case 'bottom':
      return { x: 0, y: -1 };
    default:
      return { x: 0, y: 1 };
  }
}

/**
 * Arrowhead triangle with its tip on the anchor.
 *
 * Drawn as geometry rather than an SVG `<marker>` because `context-stroke` is not
 * dependable across browsers and the layer already knows each line's colour. `zoom`
 * divides the size so the arrow keeps a constant size on screen.
 */
export function arrowPath(to: Anchor, zoom: number): string {
  const length = 8 / zoom;
  const half = 4 / zoom;
  const d = inward(to.side);
  const baseX = to.x - d.x * length;
  const baseY = to.y - d.y * length;
  const px = -d.y;
  const py = d.x;
  return [
    `M ${to.x} ${to.y}`,
    `L ${baseX + px * half} ${baseY + py * half}`,
    `L ${baseX - px * half} ${baseY - py * half}`,
    'Z',
  ].join(' ');
}

/** Midpoint of the curve, where the port label is parked (De Casteljau at t = 0.5). */
function curveMidpoint(from: Anchor, to: Anchor): { x: number; y: number } {
  const c1 = outControl(from);
  const c2 = inControl(to);
  const ax = (from.x + c1.x) / 2;
  const ay = (from.y + c1.y) / 2;
  const bx = (c1.x + c2.x) / 2;
  const by = (c1.y + c2.y) / 2;
  const cx = (c2.x + to.x) / 2;
  const cy = (c2.y + to.y) / 2;
  const dx = (ax + bx) / 2;
  const dy = (ay + by) / 2;
  const ex = (bx + cx) / 2;
  const ey = (by + cy) / 2;
  return { x: (dx + ex) / 2, y: (dy + ey) / 2 };
}

/** Compact port list for the label: two ids, then a count. */
function portLabel(ports: string[]): string {
  if (ports.length === 0) return '';
  const shown = ports.slice(0, 2).join(' · ');
  return ports.length > 2 ? `${shown} +${ports.length - 2}` : shown;
}

interface ConnectionLayerProps {
  cards: CardModel[];
  selectedId: number | null;
  blockedCardId: number | null;
  /** Changes on every refused close so the blink restarts. */
  blockNonce: number;
  /** Current pan/zoom of the card plane; the layer counter-transforms by it. */
  view: { x: number; y: number; zoom: number };
  /** The store's dependency graph — the source of truth for which cards are connected. */
  dependencies: DependencyGraph;
}

export function ConnectionLayer({
  cards,
  selectedId,
  blockedCardId,
  blockNonce,
  view,
  dependencies,
}: ConnectionLayerProps) {
  const connections = useConnectionGeometry(cards, selectedId, dependencies);
  const rects = useCardRects(cards);
  const hidden = useBlockedBlink(blockedCardId, blockNonce);

  const isHidden = (conn: Connection): boolean =>
    hidden.has(conn.dependsOn) || hidden.has(conn.dependent);

  const background = connections.filter((c) => !c.highlighted && !isHidden(c));
  const foreground = connections.filter((c) => c.highlighted && !isHidden(c));

  // One mask, reused by both line groups: white everywhere, a black hole per card. The
  // lines therefore stop at every card edge, exactly like lines drawn on the MDI desktop.
  const maskId = 'connection-card-cutout';

  const renderLine = (conn: Connection, framed: boolean) => (
    <g key={conn.key} className={`connection connection--${framed ? 'fg' : 'bg'}`}>
      <path
        className="connection__wire"
        d={connectionPath(conn.from, conn.to)}
        stroke={conn.color}
        strokeWidth={framed ? 3 : 1.5}
      />
      <path className="connection__arrow" d={arrowPath(conn.to, view.zoom)} fill={conn.color} />
      {framed && conn.ports.length > 0 ? (
        <ConnectionLabel conn={conn} zoom={view.zoom} />
      ) : null}
    </g>
  );

  // The SVG itself stays pinned to the viewport (a plane-sized SVG would be rasterised
  // as one enormous layer); only its contents are counter-translated, so everything below
  // can keep working in unbounded *plane* coordinates — the same space the anchors are
  // measured in (see cardMetrics).
  return (
    <svg className="connection-layer" aria-hidden="true">
      {/* Same transform as the world layer: translate *after* scale, so a plane point
          (px, py) lands at (px*zoom - view.x, py*zoom - view.y) in viewport px. */}
      <g transform={`translate(${-view.x}, ${-view.y}) scale(${view.zoom})`}>
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            {/* Covers the whole unbounded plane, not just the viewport: this group is
                counter-translated by the pan, so a `100%` rect would whiten only the first
                screenful of plane coordinates and silently erase every line beyond it. */}
            <rect x="-100000" y="-100000" width="200000" height="200000" fill="#ffffff" />
            {rects.map((rect, index) => (
              <rect
                key={index}
                x={rect.left}
                y={rect.top}
                width={rect.width}
                height={rect.height}
                fill="#000000"
              />
            ))}
          </mask>
        </defs>
        {/* No end-point dots: this SVG paints *behind* the cards, so a marker at either
            end was occluded by the card it referred to. The arrowhead sits on the target
            anchor instead, and the label spells the port ids out while a card is selected. */}
        <g mask={`url(#${maskId})`}>{background.map((conn) => renderLine(conn, false))}</g>
        <g mask={`url(#${maskId})`}>{foreground.map((conn) => renderLine(conn, true))}</g>
      </g>
    </svg>
  );
}

/** Port ids on the line, shown only while one of its two cards is selected. */
function ConnectionLabel({ conn, zoom }: { conn: Connection; zoom: number }) {
  const mid = curveMidpoint(conn.from, conn.to);
  return (
    <text
      className="connection__label"
      x={mid.x}
      y={mid.y}
      fill={conn.color}
      fontSize={11 / zoom}
      stroke="#ffffff"
      strokeWidth={3 / zoom}
      paintOrder="stroke"
      textAnchor="middle"
      dominantBaseline="middle"
    >
      {portLabel(conn.ports)}
    </text>
  );
}

export { COLOR_GREY, COLOR_RED, COLOR_BLUE };
