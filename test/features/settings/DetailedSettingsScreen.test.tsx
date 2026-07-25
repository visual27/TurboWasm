import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailedSettingsScreen } from '@/features/settings/DetailedSettingsScreen';
import { useSettingsStore } from '@/stores/useSettingsStore';
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_DETAILED_OPTIMIZATIONS,
} from '@/utils/constants';
import { DETAILED_CATEGORY_ORDER } from '@/features/settings/constants';

function resetStore(): void {
  useSettingsStore.setState({
    theme: 'system',
    volume: 100,
    lastNonMuteVolume: 100,
    advanced: { ...DEFAULT_ADVANCED_SETTINGS },
    defaultAdvanced: { ...DEFAULT_ADVANCED_SETTINGS },
    allowedExtensionUrls: [],
    enableWasm: true,
    userExplicitFps: null,
    detailedOptimizations: { ...DEFAULT_DETAILED_OPTIMIZATIONS },
    beforeTurboWasmMasterOffSnapshot: null,
  });
}

describe('DetailedSettingsScreen (Phase 0)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('renders one row per category in DETAILED_CATEGORY_ORDER', () => {
    render(
      <DetailedSettingsScreen
        masterOn={true}
        detailed={{ ...DEFAULT_DETAILED_OPTIMIZATIONS }}
        onOpenCategory={() => undefined}
      />,
    );
    for (const categoryId of DETAILED_CATEGORY_ORDER) {
      expect(
        screen.getByTestId(`detailed-category-row-${categoryId}`),
        `missing row for ${categoryId}`,
      ).toBeInTheDocument();
    }
  });

  it('invokes onOpenCategory with the category id when a row is clicked', async () => {
    const user = userEvent.setup();
    let captured: string | null = null;
    render(
      <DetailedSettingsScreen
        masterOn={true}
        detailed={{ ...DEFAULT_DETAILED_OPTIMIZATIONS }}
        onOpenCategory={(categoryId) => {
          captured = categoryId;
        }}
      />,
    );
    await user.click(screen.getByTestId('detailed-category-row-semantics'));
    expect(captured).toBe('semantics');
  });

  it('reports the master-off summary as "off = total" for every category', () => {
    render(
      <DetailedSettingsScreen
        masterOn={false}
        detailed={{ ...DEFAULT_DETAILED_OPTIMIZATIONS }}
        onOpenCategory={() => undefined}
      />,
    );
    // The semantics row has 5 toggles, all marked off by master.
    const semanticsRow = screen.getByTestId('detailed-category-row-semantics');
    expect(semanticsRow.textContent).toMatch(/5\/5/);
  });
});