import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cn } from '@/lib/utils';

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    /*
      Layout notes:
        - `flex flex-col` lets the Root participate as a flex item whose
          children can be sized against the parent's height.
        - `min-h-0` lets the Viewport child shrink below its content
          height (the default `min-height: auto` on flex items would
          otherwise force the Viewport to grow with its content and
          disable scrolling).
        - `overflow-hidden` keeps the absolutely-positioned custom
          scrollbar inside the Root's box.
      Tailwind's `h-full` on the Viewport previously failed to resolve
      against a flex parent's computed height, leaving the Viewport at
      its intrinsic content height and breaking overflow scrolling.
    */
    className={cn(
      'relative flex min-h-0 flex-col overflow-hidden',
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="min-h-0 flex-1 rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollBar orientation="horizontal" />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    /*
      Custom scrollbar — minimal and subtle:
        - Narrow track (w-1.5 / 6px) so the bar reads as a hairline
          indicator rather than a chunky UI element.
        - Minimal padding (p-px) leaves a small but usable click target
          for the thumb while keeping the track visually quiet.
        - Thumb uses very low foreground opacity (foreground/10) at rest
          and only steps up to foreground/30 while the user is hovering
          or actively dragging it.
        - Native scrollbar is hidden by Radix's injected style, so this
          is the only scrollbar the user sees.
    */
    className={cn(
      'flex touch-none select-none transition-colors',
      /*
        Radix positions the scrollbar flush against the Root's border
        edge, so padding on the Root has no effect on the bar's gap to
        the dialog border. We shift the bar inward by its own width
        (-translate-x-1.5 / -6px) so it floats with breathing room
        equal to its width on the right side, matching the visual
        breathing room the inner content already has on the left.
      */
      orientation === 'vertical' &&
        'h-full w-1.5 -translate-x-1.5 border-l border-l-transparent p-px',
      orientation === 'horizontal' &&
        'h-1.5 flex-col border-t border-t-transparent p-px',
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb
      className={cn(
        'relative flex-1 rounded-full bg-foreground/10 transition-colors',
        'hover:bg-foreground/30',
        // Radix toggles data-state between "visible" and "hidden"; the
        // hover variant fades the bar in/out via the parent Presence
        // wrapper, so we just rely on the parent for visibility.
      )}
    />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };