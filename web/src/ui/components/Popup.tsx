/**
 * Viewport-anchored popup.
 *
 * Why this exists: the card is a react-rnd window, and react-draggable positions it with
 * `transform: translate(...)`. A transform makes the card the containing block for *any*
 * `position: fixed` descendant, so a popup rendered inside the card is positioned relative
 * to the card rather than the viewport — and `.card { overflow: hidden }` then clips it.
 * The column context menu was measurably displaced by the card's own offset (801px right
 * and 455px down for a card at (800, 454)), which put every menu item off-screen.
 *
 * Rendering into `document.body` via a portal restores true viewport coordinates, so the
 * popup lands at the cursor/anchor it was given and can be clamped to the window edge.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export interface PopupProps {
  /** Viewport coordinates of the popup's top-left corner (before clamping). */
  x: number;
  y: number;
  className?: string;
  /** Prefer opening above/left of the anchor when there is no room below/right. */
  flip?: boolean;
  onDismiss: () => void;
  children: ReactNode;
}

const MARGIN = 8;

export function Popup({ x, y, className, flip = true, onDismiss, children }: PopupProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y, placement: 'below' as 'below' | 'above' });

  // Measure, then clamp into the viewport on the same frame so the popup never flashes
  // at an off-screen position.
  //
  // `children` is deliberately NOT a dependency: it is a fresh element on every render, so
  // including it re-ran this effect on each render, and the `setPos` below then produced
  // another render — an update loop. Size only changes when the popup is remounted with a
  // different panel, and each panel is its own `<Popup>` instance.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN);
    const top = flip && y + height > window.innerHeight - MARGIN && y - height >= MARGIN
      ? y - height // open upwards rather than being cut off at the bottom
      : y;
    const next = {
      left: Math.min(Math.max(MARGIN, x), maxLeft),
      top: Math.min(Math.max(MARGIN, top), maxTop),
      placement: (top === y ? 'below' : 'above') as 'below' | 'above',
    };
    setPos((current) =>
      current.left === next.left && current.top === next.top && current.placement === next.placement
        ? current
        : next,
    );
  }, [x, y, flip]);

  // Dismiss on a click outside, Escape, window resize and any scroll: a viewport-anchored
  // popup would otherwise detach from its anchor.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('scroll', onDismiss, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('scroll', onDismiss, true);
    };
  }, [onDismiss]);

  return createPortal(
    <div
      ref={ref}
      className={className}
      data-popup-placement={pos.placement}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
