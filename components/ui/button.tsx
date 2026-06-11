// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Variant matrix
 * --------------
 * Legacy (shadcn-canonical, preserved for backwards compat with existing
 * screens that pre-date ADR 0009):
 *   default | outline | secondary | ghost | destructive | link
 *
 * MD3 (ADR 0009 — new screens should reach for these):
 *   filled    — primary container, on-primary text. High-emphasis CTA.
 *   tonal     — secondary-container, on-secondary-container text. Medium.
 *   outlined  — transparent fill, outline border, primary text.
 *   text      — transparent fill, primary text, no border. Low-emphasis.
 *   elevated  — surface-container-low fill, primary text + elevation-1.
 *
 * Sizes map to MD3 height-40 default; xs/sm/lg/icon retained for legacy.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary-text underline-offset-4 hover:underline",
        filled:
          "rounded-[var(--ft-shape-full)] bg-[var(--ft-color-primary)] text-[var(--ft-color-on-primary)] hover:brightness-95 active:brightness-90",
        tonal:
          "rounded-[var(--ft-shape-full)] bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)] hover:brightness-95 active:brightness-90",
        outlined:
          "rounded-[var(--ft-shape-full)] border-[var(--ft-color-outline)] bg-transparent text-[var(--ft-color-primary-text)] hover:bg-[color-mix(in_srgb,var(--ft-color-primary)_8%,transparent)]",
        text: "rounded-[var(--ft-shape-full)] bg-transparent text-[var(--ft-color-primary-text)] hover:bg-[color-mix(in_srgb,var(--ft-color-primary)_8%,transparent)]",
        elevated:
          "rounded-[var(--ft-shape-full)] bg-[var(--ft-color-surface-container-low)] text-[var(--ft-color-primary-text)] shadow-[var(--ft-elev-1)] hover:shadow-[var(--ft-elev-2)]",
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
