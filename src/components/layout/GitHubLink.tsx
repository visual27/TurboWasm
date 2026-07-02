import * as React from 'react';
import { Github } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ENV } from '@/utils/constants';

export function GitHubLink(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label="View source on GitHub"
        >
          <a href={ENV.githubRepoUrl} target="_blank" rel="noreferrer noopener">
            <Github className="h-5 w-5" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>View source on GitHub</TooltipContent>
    </Tooltip>
  );
}