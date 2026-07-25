import * as React from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  DETAILED_CATEGORY_DESCRIPTIONS,
  DETAILED_CATEGORY_LABELS,
  DETAILED_OPTIMIZATIONS_BY_CATEGORY,
  DETAILED_OPTIMIZATION_DESCRIPTIONS,
  DETAILED_OPTIMIZATION_LABELS,
} from './constants';
import type {
  DetailedCategoryId,
  DetailedOptimizationId,
  DetailedOptimizationMap,
} from './types';

export interface DetailedCategoryScreenProps {
  categoryId: DetailedCategoryId;
  masterOn: boolean;
  detailed: DetailedOptimizationMap;
  onToggle: (id: DetailedOptimizationId, enabled: boolean) => void;
}

/**
 * Phase 0 — Foundation. Per-category detailed-optimization screen.
 * Renders one row per toggle ID registered in
 * `DETAILED_OPTIMIZATIONS_BY_CATEGORY[categoryId]`, in declaration
 * order. Each row carries a label, description, and a Switch that
 * delegates to `useSettingsStore.setDetailedOptimization`.
 *
 * Master-off behaviour: when `masterOn === false` every row stays
 * visible but the Switch is disabled. The runtime guard already
 * forced every flag to false, so showing an interactive control
 * here would be a UI lie — and disabling the rows visually flags
 * the dependency between the master toggle and the detail toggles.
 *
 * Research rows (rows whose implementation does not yet exist in
 * scratch-vm) are not visually distinguished in Phase 0 because every
 * shipped ID currently has a backing optimization target (the IDs
 * mirror the Phase 1+ backlog in `patches/scratch-vm-symbols.md`).
 * Phase 1+ can flip individual IDs to "research" by tagging them in
 * `constants.ts`.
 */
export function DetailedCategoryScreen({
  categoryId,
  masterOn,
  detailed,
  onToggle,
}: DetailedCategoryScreenProps): React.JSX.Element {
  const ids = DETAILED_OPTIMIZATIONS_BY_CATEGORY[categoryId];
  const titleId = `detailed-category-${categoryId}-title`;
  return (
    <section
      aria-labelledby={titleId}
      data-testid={`detailed-category-screen-${categoryId}`}
      className="flex flex-col"
    >
      <h3
        id={titleId}
        className="pb-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.35em] text-muted-foreground"
      >
        {DETAILED_CATEGORY_LABELS[categoryId]}
      </h3>
      <p className="pb-2 text-xs leading-relaxed text-muted-foreground">
        {DETAILED_CATEGORY_DESCRIPTIONS[categoryId]}
      </p>
      <div className="divide-y divide-border">
        {ids.map((id) => {
          const checked = detailed[id];
          const disabled = !masterOn;
          return (
            <div
              key={id}
              className="flex items-start justify-between gap-4 py-4"
              data-testid={`detailed-toggle-row-${id}`}
            >
              <div className="flex-1">
                <Label htmlFor={`detailed-toggle-${id}`} className="text-sm">
                  {DETAILED_OPTIMIZATION_LABELS[id]}
                </Label>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {DETAILED_OPTIMIZATION_DESCRIPTIONS[id]}
                </p>
                <p
                  aria-hidden="true"
                  className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60"
                >
                  {id}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2" style={{ pointerEvents: 'auto' }}>
                <Switch
                  id={`detailed-toggle-${id}`}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(value) => onToggle(id, value)}
                  aria-label={`${DETAILED_OPTIMIZATION_LABELS[id]} toggle`}
                />
              </div>
            </div>
          );
        })}
      </div>
      <Separator className="mt-4" />
      <p className="pt-4 text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
        {ids.length} toggle{ids.length === 1 ? '' : 's'} ·{' '}
        {masterOn ? 'master on' : 'master off (locks every row to off)'}
      </p>
    </section>
  );
}