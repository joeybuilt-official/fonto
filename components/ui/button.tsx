// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Variant matrix — MD3 is now canonical (ADR 0009).
 * --------------
 * MD3 (reach for these on new screens):
 *   filled    — primary container, on-primary text. High-emphasis CTA.
 *   tonal     — secondary-container, on-secondary-container text. Medium.
 *   outlined  — transparent fill, outline border, primary text.
 *   text      — transparent fill, primary text, no border. Low-emphasis.
 *   elevated  — surface-container-low fill, primary text + elevation-1.
 *
 * Legacy aliases (kept so pre-ADR-0009 call sites render MD3 without a sweep):
 *   default   → filled     (the default variant is now an MD3 pill)
 *   secondary → tonal
 *   outline   → outlined
 *   ghost     → text
 *   destructive / link — retained; pill-shaped for consistency.
 *
 * Sizes map to MD3 height-40 default; xs/sm/lg/icon retained for legacy.
 */
const MD3_FILLED =
  "rounded-[var(--ft-shape-full)] bg-[var(--ft-color-primary)] text-[var(--ft-color-on-primary)] hover:brightness-95 active:brightness-90";
const MD3_TONAL =
  "rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)] hover:brightness-95 active:brightness-90";
const MD3_OUTLINED =
  "rounded-[var(--ft-shape-full)] border-[var(--ft-color-outline)] bg-transparent text-[var(--ft-color-primary-text)] hover:bg-[color-mix(in_srgb,var(--ft-color-primary)_8%,transparent)]";
const MD3_TEXT =
  "rounded-[var(--ft-shape-full)] bg-transparent text-[var(--ft-color-primary-text)] hover:bg-[color-mix(in_srgb,var(--ft-color-primary)_8%,transparent)]";
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // MD3 canonical
        filled: MD3_FILLED,
        tonal: MD3_TONAL,
        outlined: MD3_OUTLINED,
        text: MD3_TEXT,
        elevated:
          "rounded-[var(--ft-shape-full)] bg-[var(--ft-color-surface-container-low)] text-[var(--ft-color-primary-text)] shadow-[var(--ft-elev-1)] hover:shadow-[var(--ft-elev-2)]",
        // Legacy aliases → MD3 equivalents (back-compat, no call-site sweep)
        default: MD3_FILLED,
        secondary: MD3_TONAL,
        outline: MD3_OUTLINED,
        ghost: MD3_TEXT,
        destructive:
          "rounded-[var(--ft-shape-full)] bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary-text underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants, type ButtonProps }
