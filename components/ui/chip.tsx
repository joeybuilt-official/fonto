// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * MD3 Chip — ADR 0009.
 *
 * Variants:
 *   assist     — outlined, surface bg. For contextual actions. Border = outline.
 *   filter     — selectable. Off: outlined. On: secondary-container fill.
 *   input      — user-entered tokens. surface-container-low fill, removable.
 *   suggestion — outlined, low-emphasis. surface bg.
 *
 * Selected state is driven by `selected` prop (filter chips) or `data-selected`.
 * Shape: full pill. Height 32 px. Padding horizontal 12-16 px per MD3 density.
 */
const chipVariants = cva(
  "group/chip inline-flex h-8 shrink-0 items-center justify-center gap-[var(--ft-space-2)] rounded-[var(--ft-shape-full)] border bg-clip-padding px-[var(--ft-space-3)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ft-color-primary)]/40 disabled:pointer-events-none disabled:opacity-[var(--ft-state-disabled-content,0.38)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        assist:
          "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]",
        filter:
          "border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] data-[selected=true]:border-transparent data-[selected=true]:bg-[var(--ft-color-secondary-container)] data-[selected=true]:text-[var(--ft-color-on-secondary-container)]",
        input:
          "border-transparent bg-[var(--ft-color-surface-container-low)] text-[var(--ft-color-on-surface)] hover:bg-[var(--ft-color-surface-container)]",
        suggestion:
          "border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)] text-[var(--ft-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)]",
      },
    },
    defaultVariants: {
      variant: "assist",
    },
  }
)

type ChipProps = ButtonPrimitive.Props &
  VariantProps<typeof chipVariants> & {
    selected?: boolean
  }

function Chip({
  className,
  variant = "assist",
  selected,
  ...props
}: ChipProps) {
  return (
    <ButtonPrimitive
      data-slot="chip"
      data-selected={selected ? "true" : "false"}
      className={cn(chipVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Chip, chipVariants }
