/**
 * Connection layer — the React/SVG counterpart of `src/widgets/ConnectionOverlay.cpp`.
 *
 * Honours the project's **connection subordination** principle: connections are a
 * background visualization of data dependencies, they never intercept pointer
 * events, and they never take part in card layout.
 *
 * Layering reproduces the Qt two-overlay scheme with a single SVG using two groups:
 *   - `bg` group: thin grey lines for unselected cards, painted under the highlight
 *   - `fg` group: thick red/blue lines for the active card, painted on top
 *
 * Colours and geometry constants are carried over verbatim from the Qt version:
 *   grey  rgb(160,160,160), red rgb(200,50,50), blue rgb(40,120,220).
 *   Bezier control points are (from.x, from.y - 30) and (to.x, to.y - 80).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  headerAnchor,
  cardTopAnchor,
  cardRect,
  subscribeLayout,
  getLayoutVersion,
  type Rect,
} from './cardMetrics.ts';
import { isChartCard, isMatrixCard, type CardModel } from './types.ts';

// The grey was rgb(160,160,160), which measures 2.27:1 against the canvas and 2.61:1
// against a card surface — below the 3:1 non-text threshold — so an idle connection was
// nearly invisible. 107/114/128 keeps the same neutral hue at ~4.6:1 on white.
const COLOR_GREY = 'rgb(107, 114, 128)';
const COLOR_RED = 'rgb(200, 50, 50)';
const COLOR_BLUE = 'rgb(40, 120, 220)';

/** Durations mirroring the Qt blink timer: 200 ms tick, 6 ticks (3 on / 3 off). */
const BLINK_INTERVAL_MS = 200;
const BLINK_TICKS = 6;

export interface Connection {
  key: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  matrixCardId: number;
  chartCardId: number;
  color: string;
  highlighted: boolean;
  sourceVisible: boolean;
  sourceColumnWidth: number;
}

/**
 * Recompute every connection endpoint whenever the layout could have changed.
 * Subscribes to the layout version counter (bumped by drag/resize/scroll) plus
 * window resize, and coalesces redraws into one animation frame.
 */
export function useConnectionGeometry(cards: CardModel[], selectedId: number | null): Connection[] {
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

    for (const card of cards) {
      if (!isChartCard(card)) continue;
      const target = cardTopAnchor(card.id);
      if (!target) continue;

      for (const source of card.config.sources) {
        // Find the matrix card that owns this matrix id and is still open.
        const matrixCard = cards.find(
          (c) => isMatrixCard(c) && c.sources.some((s) => s.matrixId === source.matrixId),
        );
        if (!matrixCard) continue;

        const anchor = headerAnchor(matrixCard.id, source.columnIndex);
        if (!anchor) continue;

        const sourceActive = selectedId === matrixCard.id;
        const targetActive = selectedId === card.id;

        let color = COLOR_GREY;
        let highlighted = false;
        if (sourceActive) {
          color = COLOR_RED;
          highlighted = true;
        } else if (targetActive) {
          color = COLOR_BLUE;
          highlighted = true;
        }

        out.push({
          key: `${source.matrixId}:${source.columnIndex}->${card.id}`,
          from: { x: anchor.x, y: anchor.y },
          to: target,
          matrixCardId: matrixCard.id,
          chartCardId: card.id,
          color,
          highlighted,
          sourceVisible: anchor.visible,
          sourceColumnWidth: anchor.width,
        });
      }
    }

    return out;
  }, [cards, selectedId, tick]);
}

/**
 * Canvas-relative rectangles of every card, refreshed whenever the layout could change.
 *
 * These become the holes in the connection mask: the lines belong to the desktop *behind*
 * the cards, so they must not be painted across a card's face. The `.connection-layer`
 * rule already claims that, but it sat at `z-index: 900` while cards sit at `z-index: 1…N`
 * in the same stacking context — so the SVG won every comparison and the curves ran over
 * table cells and title bars.
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

/** Cubic bezier path using the exact control offsets from the Qt painter. */
export function connectionPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const c1x = from.x;
  const c1y = from.y - 30;
  const c2x = to.x;
  const c2y = to.y - 80;
  return `M ${from.x} ${from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${to.x} ${to.y}`;
}

interface ConnectionLayerProps {
  cards: CardModel[];
  selectedId: number | null;
  blockedCardId: number | null;
  /** Changes on every refused close so the blink restarts. */
  blockNonce: number;
}

export function ConnectionLayer({
  cards,
  selectedId,
  blockedCardId,
  blockNonce,
}: ConnectionLayerProps) {
  const connections = useConnectionGeometry(cards, selectedId);
  const rects = useCardRects(cards);
  const hidden = useBlockedBlink(blockedCardId, blockNonce);

  const isHidden = (conn: Connection): boolean =>
    hidden.has(conn.matrixCardId) || hidden.has(conn.chartCardId);

  const background = connections.filter((c) => !c.highlighted && !isHidden(c));
  const foreground = connections.filter((c) => c.highlighted && !isHidden(c));

  // One mask, reused by both line groups: white everywhere, a black hole per card. The
  // lines therefore stop at every card edge, exactly like lines drawn on the MDI desktop.
  // The anchor dots and the source-column highlight are drawn *outside* the mask, because
  // they are deliberately meant to be readable on top of the card they refer to.
  const maskId = 'connection-card-cutout';

  return (
    <svg className="connection-layer" aria-hidden="true">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect x="0" y="0" width="100%" height="100%" fill="#ffffff" />
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
      <g mask={`url(#${maskId})`}>
        {background.map((conn) => (
          <g key={conn.key} className="connection connection--bg">
            <path d={connectionPath(conn.from, conn.to)} stroke={conn.color} strokeWidth={1.5} />
          </g>
        ))}
      </g>
      <g mask={`url(#${maskId})`}>
        {foreground.map((conn) => (
          <g key={conn.key} className="connection connection--fg">
            <path d={connectionPath(conn.from, conn.to)} stroke={conn.color} strokeWidth={3} />
          </g>
        ))}
      </g>
      {/* Unmasked: the end points only. The source column itself is marked in the DOM by
          `MatrixCard` (`vtable__colhead--source`), because this SVG now paints *behind* the
          cards — an in-SVG highlight rect or box around a header would be occluded. */}
      <g>
        {background.map((conn) => (
          <circle key={conn.key} cx={conn.from.x} cy={conn.from.y} r={3} fill={conn.color} />
        ))}
        {foreground.map((conn) => (
          <circle key={conn.key} cx={conn.from.x} cy={conn.from.y} r={5} fill={conn.color} />
        ))}
      </g>
    </svg>
  );
}

export { COLOR_GREY, COLOR_RED, COLOR_BLUE };
