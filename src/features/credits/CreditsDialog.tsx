import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';

export interface CreditsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CreditRowProps {
  label: string;
  children: React.ReactNode;
}

function CreditRow({ label, children }: CreditRowProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 px-1 py-5 text-left">
      <span className="text-[11px] font-semibold uppercase tracking-[0.35em] text-muted-foreground">
        {label}
      </span>
      <div className="text-sm leading-relaxed text-foreground/90">{children}</div>
    </div>
  );
}

export function CreditsDialog({ open, onOpenChange }: CreditsDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-center">Credits</DialogTitle>
          <DialogDescription className="text-center">
            The people and projects that made this viewer possible.
          </DialogDescription>
        </DialogHeader>
        <Separator />

        {/*
          Stacked CreditRows separated by horizontal rules. We wrap the
          rows in a divider-style container so each block gets equal
          breathing room above and below, matching the spacing rhythm of
          the Settings dialog categories.
        */}
        <div className="divide-y divide-border">
          <CreditRow label="Created by">
            <div className="flex items-baseline justify-center gap-2 text-center">
              <span className="text-base font-medium">visual27</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-base font-medium">_vfx</span>
            </div>
          </CreditRow>

          <CreditRow label="Built on">
            <p className="leading-relaxed">
              This project is built on top of{' '}
              <a
                href="https://github.com/TurboWarp/scaffolding"
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium underline underline-offset-4 hover:opacity-70"
              >
                TurboWarp Scaffolding
              </a>
              , a minimal Scratch project runner maintained by the TurboWarp team. Scaffolding
              provides the VM, Renderer, Audio Engine, and runtime infrastructure that power this
              viewer. We are deeply grateful to the TurboWarp contributors for making this work
              possible.
            </p>
          </CreditRow>

          <CreditRow label="Thanks to">
            <ul className="space-y-2 text-sm leading-relaxed">
              <li>
                The{' '}
                <a
                  href="https://turbowarp.org/"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium underline underline-offset-4 hover:opacity-70"
                >
                  TurboWarp
                </a>{' '}
                project for the wider ecosystem of extensions, compiler, and packager tooling.
              </li>
              <li>
                The{' '}
                <a
                  href="https://scratch.mit.edu"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium underline underline-offset-4 hover:opacity-70"
                >
                  Scratch Foundation
                </a>{' '}
                for the original project format and the creative community it has inspired.
              </li>
              <li>All open-source contributors whose work appears in this stack.</li>
            </ul>
          </CreditRow>

          <CreditRow label="License">
            <p className="leading-relaxed text-muted-foreground">
              This project is released under the GNU General Public License v3.0, in accordance with
              the license of the underlying TurboWarp Scaffolding library.
            </p>
          </CreditRow>
        </div>
      </DialogContent>
    </Dialog>
  );
}
