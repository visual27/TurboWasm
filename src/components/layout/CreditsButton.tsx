import * as React from 'react';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface CreditsButtonProps {
  onClick: () => void;
}

export function CreditsButton({ onClick }: CreditsButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Show credits"
          onClick={onClick}
          data-testid="open-credits"
        >
          <Info className="h-5 w-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Credits</TooltipContent>
    </Tooltip>
  );
}