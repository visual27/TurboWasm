import * as React from 'react';
import { ThemeToggle } from '@/features/theme/ThemeToggle';
import { GitHubLink } from '@/components/layout/GitHubLink';
import { CreditsButton } from '@/components/layout/CreditsButton';

export interface TopBarProps {
  left?: React.ReactNode;
  right?: React.ReactNode;
  onOpenCredits?: () => void;
}

export function TopBar({ left, right, onOpenCredits }: TopBarProps): React.JSX.Element {
  return (
    <header className="flex w-full items-center justify-between px-6 py-4">
      <div className="flex items-center">{left ?? <ThemeToggle />}</div>
      <div className="flex items-center gap-1">
        {right}
        {onOpenCredits && <CreditsButton onClick={onOpenCredits} />}
        <GitHubLink />
      </div>
    </header>
  );
}
