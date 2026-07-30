import * as React from 'react';
import {
  DETAILED_CATEGORY_DESCRIPTIONS,
  DETAILED_CATEGORY_LABELS,
  DETAILED_CATEGORY_ORDER,
  DETAILED_OPTIMIZATIONS_BY_CATEGORY,
} from './constants';
import { ClickableFieldRow } from './SettingsDialog';
import type { DetailedCategoryId, DetailedOptimizationMap } from './types';

export interface DetailedSettingsScreenProps {
  masterOn: boolean;
  detailed: DetailedOptimizationMap;
  onOpenCategory: (categoryId: DetailedCategoryId) => void;
}

/**
 * Phase 0 — Foundation. Category picker for the detailed settings
 * screen. One row per category; each row opens that category's
 * toggle list when clicked. The category list mirrors
 * `DETAILED_CATEGORY_ORDER` so the visible order is deterministic.
 *
 * When `masterOn` is false the rows stay clickable (so the user can
 * still inspect what's there) but every leaf toggle in the category
 * is forced to false by the runtime guard in
 * `useSettingsStore.toggleTurboWasmMaster(false)`. The category rows
 * themselves do not show a disabled visual — Phase 1+ can revisit
 * this once a category ships a row whose runtime side effect is
 * observably harmful while master-off.
 */
export function DetailedSettingsScreen({
  masterOn,
  detailed,
  onOpenCategory,
}: DetailedSettingsScreenProps): React.JSX.Element {
  // Count the per-category leaf toggles. Master ON → "off" is the
  // number of detailed-optimization IDs the user has flipped to
  // false. Master OFF → every leaf is locked to false by
  // `useSettingsStore.toggleTurboWasmMaster(false)`, so we report
  // `off = total` for every category.
  const summaryByCategory = React.useMemo(() => {
    const map = new Map<DetailedCategoryId, { off: number; total: number }>();
    for (const categoryId of DETAILED_CATEGORY_ORDER) {
      const ids = DETAILED_OPTIMIZATIONS_BY_CATEGORY[categoryId];
      let off = 0;
      for (const id of ids) {
        if (detailed[id] === false) off += 1;
      }
      map.set(categoryId, { off, total: ids.length });
    }
    if (!masterOn) {
      for (const [categoryId, entry] of map) {
        map.set(categoryId, { off: entry.total, total: entry.total });
      }
    }
    return map;
  }, [masterOn, detailed]);

  return (
    <section
      aria-labelledby="settings-section-detailed"
      data-testid="settings-section-detailed"
      className="flex flex-col"
    >
      <h3
        id="settings-section-detailed"
        className="pb-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.35em] text-muted-foreground"
      >
        Detailed Settings
      </h3>
      <div className="divide-y divide-border">
        {DETAILED_CATEGORY_ORDER.map((categoryId) => {
          const summary = summaryByCategory.get(categoryId) ?? { off: 0, total: 0 };
          const description = masterOn
            ? DETAILED_CATEGORY_DESCRIPTIONS[categoryId]
            : `${DETAILED_CATEGORY_DESCRIPTIONS[categoryId]} (master toggle is off — every row is locked to off until TurboWasm Acceleration is turned back on).`;
          return (
            <ClickableFieldRow
              key={categoryId}
              id={`detailed-category-${categoryId}`}
              label={DETAILED_CATEGORY_LABELS[categoryId]}
              description={description}
              onClick={() => onOpenCategory(categoryId)}
              ariaLabel={`Open ${DETAILED_CATEGORY_LABELS[categoryId]} detailed settings`}
              testId={`detailed-category-row-${categoryId}`}
            >
              <span
                aria-hidden="true"
                className="text-xs tabular-nums text-muted-foreground"
              >
                {summary.off}/{summary.total}
              </span>
            </ClickableFieldRow>
          );
        })}
      </div>
    </section>
  );
}