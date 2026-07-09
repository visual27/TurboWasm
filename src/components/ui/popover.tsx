import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 6, style, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    {/*
      Radix Dialog applies `pointer-events: none` inline on the document
      <body> while the dialog is open (so scrolling on the page is
      locked while the dialog grabs input). `pointer-events` is an
      inherited property per CSS UI 4, so every portal'd descendant —
      including the Popper content wrapper, the Radix Popover content
      root, the <ul role="listbox">, and each <button role="option"> —
      silently inherits `none`. The dropdown *renders*, but no option
      is clickable.

      We force `auto` here on the Radix content root. The class wins
      over the inherited body style by specificity, and the inline
      `style` is a belt-and-suspenders guarantee for the same reason.
    */}
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[10rem] overflow-hidden rounded-lg border border-border/60 bg-popover/95 p-1 text-popover-foreground shadow-md backdrop-blur-md',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'pointer-events-auto',
        className,
      )}
      style={{ ...style, pointerEvents: 'auto' }}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
