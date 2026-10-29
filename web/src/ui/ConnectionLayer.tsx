/**
 * Connection layer — the React/SVG counterpart of `src/widgets/ConnectionOverlay.cpp`.
 *
 * Honours the project's **connection subordination** principle: connections are a
 * background visualization of data dependencies, they never intercept pointer
 * events, and they never take part in card layout.
 *
 * As of 2026-10-29 a wire runs **card centre → card centre** and is a single cubic Bézier
 * (see `connectionGeometry.ts`). The endpoints sit inside the two cards, so the layer's
 * mask — one black hole per card — is what turns "centre to centre" into "frame to frame":
 * the wire only becomes visible where it crosses a card's border. That is the whole trick,
 * and it is also why the arrowhead had to move: drawn on the anchor it would be erased.
 *
 * The layer still draws **every** dependency edge (2026-10-28): schema v2 made function
 * cards first-class graph nodes (`inputs[]` on the envelope), so a chain
 * `table → function → chart` is two edges and therefore two lines. A pair of cards is
 * exactly one line — a chart reading three columns of one table keeps one line and lists
 * its ports on the label. The label is now the *only* place a `portId` still shows up:
 * ports are data identity, not geometry.
 *
 * Layering reproduces the Qt two-overlay scheme with a single SVG using two groups:
 *   - `bg` group: thin grey lines for unselected cards, painted under the highlight
 *   - `fg` group: thick red/blue flowing dashes for the active card, painted on top
 *
 * The fg lines are dashed so that colour is not the only cue (red = the selected card is
 * the *source*, blue = it is the *target*, long dash vs short dash), and the dash offset
 * animates toward the target, so the flow direction itself reads as input/output.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import { cardRect, subscribeLayout, getLayoutVersion, type Rect } from './cardMetrics.ts';
import {
  arrowPathAt,
  dashArray,
  dashCycle,
  dashDuration,
  easeOutCubic,
  lerpPolyline,
  polylineArrowTip,
  polylineDistance,
  polylineLabelPoint,
  polylinePathData,
  routeArrowTip,
  routeGeometry,
  routeLabelPoint,
  routePathData,
  ROUTE_JUMP,
  ROUTE_REFLOW_MS,
  ROUTE_SAMPLES,
  sampleRoute,
  wireGeometry,
  type ArrowPlacement,
  type Point,
  type WireDirection,
  type WireGeometry,
} from './connectionGeometry.ts';
import type { DependencyGraph } from '../core/DependencyGraph.ts';
import type { CardModel } from './types.ts';

const COLOR_GREY = 'rgb(107, 114, 128)';
const COLOR_RED = 'rgb(200, 50, 50)';
const COLOR_BLUE = 'rgb(40, 120, 220)';

/** Durations mirroring the Qt blink timer: 200 ms tick, 6 ticks (3 on / 3 off). */
const BLINK_INTERVAL_MS = 200;
const BLINK_TICKS = 6;

export interface Connection {
  key: string;
  /** The target card's rectangle — the arrow parks on this frame. */
  targetRect: Rect;
  /** The curve as the layout currently says it should be (before any transition). */
  target: WireGeometry;
  /** Target-side port ids carried by this edge, for the on-line label. */
  ports: string[];
  dependsOn: number;
  dependent: number;
  color: string;
  /** `out` = the selected card is the source (red), `in` = it is the target (blue). */
  direction: WireDirection;
  highlighted: boolean;
}

function centreOf(rect: Rect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Canvas-relative rectangles of every card, keyed by card id, refreshed whenever the layout
 * could have changed. These become the holes in the connection mask — the lines belong to
 * the desktop *behind* the cards, so they must not be painted across a card's face — and
 * they are also the source of the centre endpoints.
 */
function useCardRects(cards: CardModel[]): Map<number, Rect> {
  const version = useSyncLayoutVersion();
  // `cardRect` reads the live DOM, so the memo is keyed on the layout version as well as
  // the card list — a drag or resize bumps the version without changing `cards`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const out = new Map<number, Rect>();
    for (const card of cards) {
      const rect = cardRect(card.id);
      if (rect) out.set(card.id, rect);
    }
    return out;
  }, [cards, version]);
}

/**
 * Recompute every connection whenever the measured rects or the graph could have changed.
 *
 * Endpoints are the two card centres, resolved from `rects` — the layer never touches the
 * DOM itself (see `cardMetrics`). A card whose rectangle cannot be measured is skipped
 * instead of guessing a position.
 */
export function useConnectionGeometry(
  cards: CardModel[],
  selectedId: number | null,
  dependencies: DependencyGraph,
  rects: Map<number, Rect>,
): Connection[] {
  return useMemo(() => {
    const out: Connection[] = [];

    for (const edge of dependencies.edges()) {
      const sourceCard = cards.find((card) => card.id === edge.dependsOn);
      const targetCard = cards.find((card) => card.id === edge.dependent);
      if (!sourceCard || !targetCard) continue;

      const sourceRect = rects.get(edge.dependsOn);
      const targetRect = rects.get(edge.dependent);
      if (!sourceRect || !targetRect) continue;

      const from = centreOf(sourceRect);
      const to = centreOf(targetRect);

      let color = COLOR_GREY;
      let direction: WireDirection = 'out';
      let highlighted = false;
      if (selectedId === edge.dependsOn) {
        color = COLOR_RED;
        direction = 'out';
        highlighted = true;
      } else if (selectedId === edge.dependent) {
        color = COLOR_BLUE;
        direction = 'in';
        highlighted = true;
      }

      out.push({
        key: `${edge.dependsOn}->${edge.dependent}`,
        targetRect,
        target: wireGeometry(from, to),
        ports: edge.ports,
        dependsOn: edge.dependsOn,
        dependent: edge.dependent,
        color,
        direction,
        highlighted,
      });
    }

    return out;
  }, [cards, selectedId, dependencies, rects]);
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

/** Motion is a courtesy: respect the OS setting, and never assume `matchMedia` exists. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Drive the drawn wire from the *settled* layout, not from a tweened centre pair.
 *
 * A wire has one shape to animate: its route. Interpolating the two card centres and then
 * re-routing (which is what the old `useTweenedGeometry` did) cannot animate a route whose
 * *topology* changed — when moving an obstacle flips the detour from above to below, the
 * centres barely move and the drawn path jumps anyway. So the whole route is sampled and
 * interpolated here, and that covers a card jump as well as a detour flip.
 */

/** One wire as it is currently drawn: path, arrowhead and label anchor. */
interface WireFrame {
  d: string;
  arrow: ArrowPlacement | null;
  label: Point;
  samples: Point[];
}

interface Reflow {
  from: Point[];
  to: Point[];
  target: WireFrame;
  /** Target card frame: the arrowhead has to re-park on it every animation frame. */
  rect: Rect;
  startedAt: number;
}

/**
 * Animate the wire when its route is forced to change shape.
 *
 * The route is recomputed from the **settled** card rects, and the whole sampled shape is
 * interpolated — which covers a card jump *and* a detour flip (moving an obstacle so the
 * wire goes from above a card to below it changes no centre at all, but changes the drawn
 * path by hundreds of pixels). Small per-frame changes during a drag are snapped, because
 * the wire has to track the cursor: a tween on every drag frame is rubber-band lag.
 *
 * A reflow already in flight is *retargeted*, never restarted — the layout can keep
 * changing while a card is dragged, and restarting would reset `startedAt` and leave the
 * wire chasing a moving goal forever.
 */
function useReflowedWires(
  connections: Connection[],
  rects: Map<number, Rect>,
  rectList: Rect[],
): Map<string, WireFrame> {
  const [frames, setFrames] = useState<Map<string, WireFrame>>(() => new Map());
  const shownRef = useRef(new Map<string, WireFrame>());
  const tweenRef = useRef(new Map<string, Reflow>());
  const frameRef = useRef(0);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    const now = performance.now();
    const keys = new Set<string>();
    let animating = false;
    let settled = false;

    const tick = () => {
      frameRef.current = 0;
      const time = performance.now();
      let alive = false;
      for (const [key, tween] of tweenRef.current) {
        const progress = easeOutCubic(Math.min(1, (time - tween.startedAt) / ROUTE_REFLOW_MS));
        if (progress >= 1) {
          shownRef.current.set(key, tween.target);
          tweenRef.current.delete(key);
          continue;
        }
        const samples = lerpPolyline(tween.from, tween.to, progress);
        shownRef.current.set(key, {
          samples,
          d: polylinePathData(samples),
          arrow: polylineArrowTip(samples, tween.rect),
          label: polylineLabelPoint(samples, rectList),
        });
        alive = true;
      }
      setFrames(new Map(shownRef.current));
      if (alive) frameRef.current = requestAnimationFrame(tick);
    };

    for (const conn of connections) {
      keys.add(conn.key);
      const obstacles: Rect[] = [];
      for (const [id, rect] of rects) {
        if (id !== conn.dependsOn && id !== conn.dependent) obstacles.push(rect);
      }
      const route = routeGeometry(conn.target.from, conn.target.to, obstacles);
      const target: WireFrame = {
        samples: sampleRoute(route, ROUTE_SAMPLES),
        d: routePathData(route),
        arrow: routeArrowTip(route, conn.targetRect),
        label: routeLabelPoint(route, rectList),
      };

      const shown = shownRef.current.get(conn.key);
      if (!shown) {
        // A brand new wire is born where it belongs: appearing is not a layout jump.
        shownRef.current.set(conn.key, target);
        settled = true;
        continue;
      }

      const active = tweenRef.current.get(conn.key);
      if (active) {
        active.to = target.samples;
        active.target = target;
        active.rect = conn.targetRect;
        animating = true;
        continue;
      }

      if (reduced || polylineDistance(shown.samples, target.samples) <= ROUTE_JUMP) {
        shownRef.current.set(conn.key, target);
        settled = true;
        continue;
      }

      tweenRef.current.set(conn.key, {
        from: shown.samples,
        to: target.samples,
        target,
        rect: conn.targetRect,
        startedAt: now,
      });
      animating = true;
    }

    for (const key of [...shownRef.current.keys()]) {
      if (!keys.has(key)) {
        shownRef.current.delete(key);
        tweenRef.current.delete(key);
        settled = true;
      }
    }

    if (settled) setFrames(new Map(shownRef.current));
    if (animating && !frameRef.current) frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };
  }, [connections, rects, rectList, reduced]);

  return frames;
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
  const rects = useCardRects(cards);
  const connections = useConnectionGeometry(cards, selectedId, dependencies, rects);
  const hidden = useBlockedBlink(blockedCardId, blockNonce);
  const rectList = useMemo(() => [...rects.values()], [rects]);

  const isHidden = (conn: Connection): boolean =>
    hidden.has(conn.dependsOn) || hidden.has(conn.dependent);

  const background = connections.filter((c) => !c.highlighted && !isHidden(c));
  const foreground = connections.filter((c) => c.highlighted && !isHidden(c));

  // One mask, reused by both line groups: white everywhere, a black hole per card. The
  // lines therefore stop at every card edge, exactly like lines drawn on the MDI desktop —
  // and that is also what turns centre-to-centre endpoints into frame-to-frame wires.
  const maskId = 'connection-card-cutout';

  const frames = useReflowedWires(connections, rects, rectList);

  const renderLine = (conn: Connection, framed: boolean) => {
    const frame = frames.get(conn.key);
    if (!frame) return null;
    const arrow = frame.arrow;
    // The whole layer sits inside a `scale(zoom)` group, so widths and dash lengths are
    // converted to user units here instead of relying on `vector-effect` (which does not
    // cover dash patterns, and left them zoom-dependent).
    const style: CSSProperties = framed
      ? ({
          animationDuration: `${dashDuration(conn.direction)}s`,
          '--connection-dash-cycle': `${dashCycle(conn.direction, view.zoom)}px`,
        } as CSSProperties)
      : {};

    return (
      <g key={conn.key} className={`connection connection--${framed ? 'fg' : 'bg'}`}>
        <path
          className={`connection__wire${framed ? ' connection__wire--flow' : ''}`}
          d={frame.d}
          stroke={conn.color}
          strokeWidth={(framed ? 3 : 1.5) / view.zoom}
          strokeDasharray={framed ? dashArray(conn.direction, view.zoom) : undefined}
          style={style}
        />
        {arrow ? (
          <path
            className="connection__arrow"
            d={arrowPathAt(arrow.tip, arrow.dir, view.zoom)}
            fill={conn.color}
          />
        ) : null}
        {framed && conn.ports.length > 0 ? (
          <ConnectionLabel
            conn={conn}
            point={frame.label}
            zoom={view.zoom}
          />
        ) : null}
      </g>
    );
  };

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
            {rectList.map((rect, index) => (
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
            end was occluded by the card it referred to. The arrowhead sits just outside the
            target card's frame instead, and the label spells the port ids out while a card
            is selected. */}
        <g mask={`url(#${maskId})`}>
          {background.map((conn) => renderLine(conn, false))}
        </g>
        <g mask={`url(#${maskId})`}>
          {foreground.map((conn) => renderLine(conn, true))}
        </g>
      </g>
    </svg>
  );
}

/** Port ids on the line, shown only while one of its two cards is selected. */
function ConnectionLabel({
  conn,
  point,
  zoom,
}: {
  conn: Connection;
  point: Point;
  zoom: number;
}) {
  return (
    <text
      className="connection__label"
      x={point.x}
      y={point.y}
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
