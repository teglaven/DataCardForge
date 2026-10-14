/**
 * Card shell — the Qt `QMdiSubWindow` replacement.
 *
 * Provides the title bar, close button and the draggable/resizable frame. Cards are
 * absolutely positioned inside the canvas so that the connection layer can measure
 * them directly; react-rnd handles the pointer interactions and reports the new
 * geometry back to the store.
 */
import { useEffect, useRef } from 'react';
import { Rnd } from 'react-rnd';
import type { ReactNode } from 'react';

import { MIN_CARD_HEIGHT, MIN_CARD_WIDTH } from '../workspaceStore.ts';
import { registerCard, unregisterCard, invalidateLayout } from '../cardMetrics.ts';
import type { CardModel } from '../types.ts';

interface CardShellProps {
  card: CardModel;
  title: string;
  /** Optional short badge shown after the title, e.g. dimensions or smoothing mode. */
  badge?: string;
  active: boolean;
  /** Extra classes appended to the card root (e.g. `card--chart`). */
  variant: string;
  onActivate: () => void;
  onClose: () => void;
  onCloseBlocked: () => void;
  onBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
  /** True when closing must be refused because other cards depend on this one. */
  closeBlocked: boolean;
  closeLabel: string;
  children: ReactNode;
}

export function CardShell({
  card,
  title,
  badge,
  active,
  variant,
  onActivate,
  onClose,
  onCloseBlocked,
  onBounds,
  closeBlocked,
  closeLabel,
  children,
}: CardShellProps) {
  const rndRef = useRef<Rnd | null>(null);

  // Publish this card's DOM element so the connection layer can measure anchors on it.
  useEffect(() => {
    const element = rndRef.current?.getSelfElement();
    if (element) registerCard(card.id, element);
    return () => unregisterCard(card.id);
  }, [card.id]);

  const handleClose = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (closeBlocked) onCloseBlocked();
    else onClose();
  };

  return (
    <Rnd
      className={`card ${variant}${active ? ' card--active' : ''}`}
      data-card-id={card.id}
      style={{ zIndex: card.z }}
      size={{ width: card.width, height: card.height }}
      position={{ x: card.x, y: card.y }}
      minWidth={MIN_CARD_WIDTH}
      minHeight={MIN_CARD_HEIGHT}
      bounds="parent"
      dragHandleClassName="card__titlebar"
      cancel=".card__close, .card__control, button, input, select"
      onMouseDown={onActivate}
      onDragStart={onActivate}
      onDrag={() => invalidateLayout()}
      onDragStop={(_event, data) =>
        onBounds({ x: data.x, y: data.y, width: card.width, height: card.height })
      }
      onResizeStart={onActivate}
      onResize={() => invalidateLayout()}
      onResizeStop={(_event, _dir, ref, _delta, position) =>
        onBounds({
          x: position.x,
          y: position.y,
          width: ref.offsetWidth,
          height: ref.offsetHeight,
        })
      }
      ref={rndRef}
    >
      <div className="card__titlebar" onDoubleClick={onActivate}>
        <span className="card__title" title={title}>
          {title}
        </span>
        {badge ? <span className="card__badge">{badge}</span> : null}
        <button
          type="button"
          className={`card__close${closeBlocked ? ' card__close--blocked' : ''}`}
          title={closeLabel}
          aria-label={closeLabel}
          onClick={handleClose}
        >
          ×
        </button>
      </div>
      <div className="card__body">{children}</div>
    </Rnd>
  );
}
