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

import { headerAnchor, cardTopAnchor, subscribeLayout, getLayoutVersion } from './cardMetrics.ts';
import { isChartCard, isMatrixCard, type CardModel } from './types.ts';

const COLOR_GREY = 'rgb(160, 160, 160)';
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
    const byId = new Map(cards.map((c) => [c.id, c]));

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

    void byId;
    return out;
  }, [cards, selectedId, tick]);
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
  const hidden = useBlockedBlink(blockedCardId, blockNonce);

  const isHidden = (conn: Connection): boolean =>
    hidden.has(conn.matrixCardId) || hidden.has(conn.chartCardId);

  const background = connections.filter((c) => !c.highlighted && !isHidden(c));
  const foreground = connections.filter((c) => c.highlighted && !isHidden(c));

  return (
    <svg className="connection-layer" aria-hidden="true">
      <g>
        {background.map((conn) => (
          <g key={conn.key} className="connection connection--bg">
            <path d={connectionPath(conn.from, conn.to)} stroke={conn.color} strokeWidth={1.5} />
            <circle cx={conn.from.x} cy={conn.from.y} r={3} fill={conn.color} />
          </g>
        ))}
      </g>
      <g>
        {foreground.map((conn) => (
          <g key={conn.key} className="connection connection--fg">
            <path d={connectionPath(conn.from, conn.to)} stroke={conn.color} strokeWidth={3} />
            <circle cx={conn.from.x} cy={conn.from.y} r={5} fill={conn.color} />
            {conn.sourceVisible && conn.sourceColumnWidth > 0 ? (
              <rect
                x={conn.from.x - conn.sourceColumnWidth / 2}
                y={conn.from.y}
                width={conn.sourceColumnWidth}
                height={22}
                rx={3}
                className="connection__header-box"
                style={{ stroke: conn.color, fill: withAlpha(conn.color, 0.16) }}
              />
            ) : null}
          </g>
        ))}
      </g>
    </svg>
  );
}

function withAlpha(color: string, alpha: number): string {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

export { COLOR_GREY, COLOR_RED, COLOR_BLUE };
