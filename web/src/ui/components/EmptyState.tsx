/**
 * Empty-workspace placeholder — the discoverable entry point.
 *
 * The Qt frontend relied on a right-click context menu on the MDI area ("New Table…").
 * The web version keeps that gesture but adds an explicit button and a drop hint,
 * because a blank browser page has no affordance telling the user to right-click.
 */
import { useTranslator } from '../workspaceStore.ts';

interface EmptyStateProps {
  onNewTable: () => void;
  dragActive: boolean;
}

export function EmptyState({ onNewTable, dragActive }: EmptyStateProps) {
  const { t } = useTranslator();
  return (
    <div className={`empty-state${dragActive ? ' empty-state--drop' : ''}`}>
      <div className="empty-state__badge">▦</div>
      <h2 className="empty-state__title">{t('empty.title')}</h2>
      <p className="empty-state__hint">{t('empty.hint')}</p>
      <button type="button" className="empty-state__button" onClick={onNewTable}>
        {t('empty.button')}
      </button>
    </div>
  );
}
