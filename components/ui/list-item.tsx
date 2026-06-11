// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Material 3 ListItem — single-density (one-line / two-line / three-line) row
// for menus, settings, search results, picker lists. Built on plain `<button>`
// so it can be either an interactive row (default) OR a static container
// (`asChild` slot via the `render` prop). Hover/focus/pressed use the MD3
// state-layer at 8 % over the foreground role. ADR 0009 §primitives.

"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const listItemVariants = cva(
  // base — MD3 one-line ListItem default (56 px), label-large type,
  // surface foreground, state-layer hover/focus/pressed via color-mix
  "group/list-item flex w-full items-center gap-[var(--ft-space-4)] px-[var(--ft-space-4)] text-left text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-[weight:var(--ft-type-label-large-weight)] tracking-[var(--ft-type-label-large-tracking)] text-[var(--ft-color-on-surface)] outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_10%,transparent)] active:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_10%,transparent)] disabled:cursor-not-allowed disabled:opacity-[var(--ft-state-disabled-content)] disabled:hover:bg-transparent",
  {
    variants: {
      /** Row height per MD3 list-item density spec. */
      density: {
        // Single 56 px row — default in MD3.
        "one-line": "h-14",
        // 72 px two-line — secondary text under the title slot.
        "two-line": "min-h-[72px] py-[var(--ft-space-2)]",
        // 88 px three-line — tertiary text below secondary.
        "three-line": "min-h-[88px] py-[var(--ft-space-3)]",
      },
      /** Selected state — MD3 secondary-container fill. */
      selected: {
        true: "bg-[var(--ft-color-secondary-container)] text-[var(--ft-color-on-secondary-container)] hover:bg-[var(--ft-color-secondary-container)]/95",
        false: "",
      },
      /** Visual tone — `error` swaps the foreground to the error role
       * (used for destructive menu rows like "Sign out", "Delete account"). */
      tone: {
        default: "",
        error:
          "text-[var(--ft-color-error)] hover:bg-[color-mix(in_srgb,var(--ft-color-error)_8%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--ft-color-error)_10%,transparent)] active:bg-[color-mix(in_srgb,var(--ft-color-error)_10%,transparent)]",
      },
    },
    defaultVariants: {
      density: "one-line",
      selected: false,
      tone: "default",
    },
  },
)

interface ListItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "tone">,
    VariantProps<typeof listItemVariants> {
  /** Leading slot — icon, avatar, or thumbnail. Sized to 24 px by default. */
  leading?: React.ReactNode
  /** Trailing slot — usually an icon, switch, or `MoreHoriz`. */
  trailing?: React.ReactNode
  /** Optional secondary line — appears under the children content.
   *  Forces `density="two-line"` if not set explicitly. */
  supportingText?: React.ReactNode
}

function ListItem({
  className,
  density,
  selected,
  tone,
  leading,
  trailing,
  supportingText,
  children,
  ...props
}: ListItemProps) {
  // Auto-bump density if supportingText is present and caller didn't pin one.
  const resolvedDensity = supportingText && !density ? "two-line" : density
  return (
    <button
      data-slot="list-item"
      role="listitem"
      className={cn(
        listItemVariants({ density: resolvedDensity, selected, tone }),
        className,
      )}
      {...props}
    >
      {leading && (
        <span
          aria-hidden
          className="flex shrink-0 items-center justify-center text-[var(--ft-color-on-surface-variant)] [&_svg]:size-6"
        >
          {leading}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="truncate">{children}</span>
        {supportingText && (
          <span className="truncate text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] font-[weight:var(--ft-type-body-medium-weight)] tracking-[var(--ft-type-body-medium-tracking)] text-[var(--ft-color-on-surface-variant)]">
            {supportingText}
          </span>
        )}
      </span>
      {trailing && (
        <span
          aria-hidden
          className="flex shrink-0 items-center justify-center text-[var(--ft-color-on-surface-variant)] [&_svg]:size-5"
        >
          {trailing}
        </span>
      )}
    </button>
  )
}

export { ListItem, listItemVariants, type ListItemProps }
