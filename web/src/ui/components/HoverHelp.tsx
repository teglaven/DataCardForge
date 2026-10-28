/**
 * Delayed hover tooltip — the formula card's explanatory affordance.
 *
 * Why not the native `title` attribute:
 *   - it appears **instantly** and cannot be styled, so merely crossing the expression
 *     input on the way to somewhere else pops a browser tooltip;
 *   - it always renders at the element (usually below it, far from the cursor), which for
 *     a narrow card lands over the thing being explained.
 *
 * So the rule here is "resting means asking": after the pointer has stayed on a control for
 * `HOVER_HELP_DELAY_MS` the tooltip opens **at the pointer**, and any leave / Escape /
 * scroll takes it away again. The delay is the whole point — a quick pass-over produces
 * nothing at all.
 *
 * The portal is not a style choice: the cards are transform-positioned and clipped
 * (`overflow: hidden`, see the rationale in `Popup.tsx`), so a tooltip rendered inside a
 * card is positioned against the card and cut off at its edge. Fixed coordinates plus
 * `document.body` restore true viewport positioning.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** How long the pointer must rest on the anchor before the tooltip appears (≈1 s). */
export const HOVER_HELP_DELAY_MS = 1000;

/** Distance between the pointer and the tooltip box, in px. */
const OFFSET = 14;

/** Smallest distance the tooltip keeps from the viewport edge, in px. */
const MARGIN = 8;

/**
 * Pointer coordinates, kept structural on purpose.
 *
 * The same props object is spread onto `<input>`, `<button>` and `<div>`, whose React
 * handler types differ only in `currentTarget`; a minimal `{clientX, clientY}` parameter
 * type is assignable to all of them, so one hook serves every element.
 */
export interface HoverPoint {
  clientX: number;
  clientY: number;
}

export interface HoverHelpAnchorProps {
  onMouseEnter: (event: HoverPoint) => void;
  onMouseMove: (event: HoverPoint) => void;
  onMouseLeave: () => void;
  onMouseDown: () => void;
}

export interface HoverHelpApi {
  /** Spread onto the element that explains itself (a wrapper would change its layout). */
  anchorProps: HoverHelpAnchorProps;
  /** Render this next to the anchor; it is a portal, so the DOM position is irrelevant. */
  tooltip: ReactNode | null;
}

type Placement = 'below' | 'above';

interface Position {
  left: number;
  top: number;
  placement: Placement;
}

export function useHoverHelp(text: string | null | undefined): HoverHelpApi {
  /** The pointer position captured when the rest became long enough; `null` ⇒ hidden. */
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [pos, setPos] = useState<Position>({ left: 0, top: 0, placement: 'below' });
  const timer = useRef<number | null>(null);
  const lastPoint = useRef({ x: 0, y: 0 });
  const tipRef = useRef<HTMLDivElement | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    cancel();
    setPoint(null);
  }, [cancel]);

  // Escape and any scroll dismiss it: a viewport-anchored box would otherwise stay put
  // while the control it describes scrolls away underneath it.
  useEffect(() => {
    if (point === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    // Capture phase: the card's own scroll containers must dismiss it too.
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [point, hide]);

  // Never leave a pending timer behind (unmount, or the text being removed).
  useEffect(() => {
    if (!text) hide();
    return cancel;
  }, [text, cancel, hide]);

  const onMouseEnter = useCallback(
    (event: HoverPoint) => {
      if (!text) return;
      lastPoint.current = { x: event.clientX, y: event.clientY };
      // Re-entering restarts the delay; the previous pending one is stale.
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setPoint(lastPoint.current);
      }, HOVER_HELP_DELAY_MS);
    },
    [text, cancel],
  );

  // Track the pointer until the timer fires, so the tooltip opens where the pointer
  // actually rests (the enter event alone can be hundreds of px away from where it settled).
  // Once visible it deliberately does NOT follow the pointer: a box chasing the cursor is
  // unreadable.
  const onMouseMove = useCallback((event: HoverPoint) => {
    lastPoint.current = { x: event.clientX, y: event.clientY };
  }, []);

  // Measure and clamp on the same frame the tooltip mounts, so it never paints off-screen.
  useLayoutEffect(() => {
    if (!point) return;
    const rect = tipRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN);
    // Flip above the pointer when there is no room below but there is above.
    const flip =
      point.y + OFFSET + height > window.innerHeight - MARGIN &&
      point.y - OFFSET - height >= MARGIN;
    const next: Position = {
      left: Math.min(Math.max(MARGIN, point.x + OFFSET), maxLeft),
      top: flip
        ? point.y - OFFSET - height
        : Math.min(Math.max(MARGIN, point.y + OFFSET), maxTop),
      placement: flip ? 'above' : 'below',
    };
    setPos((current) =>
      current.left === next.left && current.top === next.top && current.placement === next.placement
        ? current
        : next,
    );
  }, [point]);

  const tooltip = point
    ? createPortal(
        <div
          ref={tipRef}
          className="hover-help"
          role="tooltip"
          data-placement={pos.placement}
          style={{ left: pos.left, top: pos.top }}
        >
          {text}
        </div>,
        document.body,
      )
    : null;

  return {
    anchorProps: { onMouseEnter, onMouseMove, onMouseLeave: hide, onMouseDown: hide },
    tooltip,
  };
}

export interface HoverHelpProps {
  text: string | null | undefined;
  /** Extra class for the wrapper span (usually none — it must stay layout-neutral). */
  className?: string;
  children: ReactNode;
}

/**
 * Wrapper form, for anchors that can afford one extra `inline` element.
 *
 * Where a wrapper would break the layout — an `<input>` cannot have children, and a flex
 * row measures its items — use `useHoverHelp()` directly and spread `anchorProps` onto the
 * real element instead.
 */
export function HoverHelp({ text, className, children }: HoverHelpProps) {
  const { anchorProps, tooltip } = useHoverHelp(text);
  return (
    <span className={className} {...anchorProps}>
      {children}
      {tooltip}
    </span>
  );
}
