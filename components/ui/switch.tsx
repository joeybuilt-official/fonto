// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

/**
 * MD3 Switch — ADR 0009.
 *
 * Off: surface-container-highest track, outline border, on-surface-variant thumb.
 * On:  primary track, on-primary thumb. Thumb grows on press.
 *
 * Built on `@base-ui/react/switch`. Track is 52×32, thumb 16/24 px (small→
 * large between states) per MD3.
 */
function Switch({
  className,
  ...props
}: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "group/switch relative inline-flex h-8 w-[52px] shrink-0 cursor-pointer items-center rounded-[var(--ft-shape-full)] border-2 border-[var(--ft-color-outline)] bg-[var(--ft-color-surface-container-highest)] outline-none transition-colors duration-[var(--ft-motion-medium)] focus-visible:ring-2 focus-visible:ring-[var(--ft-color-primary)]/40 disabled:cursor-not-allowed disabled:opacity-[var(--ft-state-disabled-content,0.38)] data-[checked]:border-[var(--ft-color-primary)] data-[checked]:bg-[var(--ft-color-primary)]",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none ml-1 block h-4 w-4 translate-x-0 rounded-[var(--ft-shape-full)] bg-[var(--ft-color-outline)] transition-all duration-[var(--ft-motion-medium)] group-data-[checked]/switch:ml-0 group-data-[checked]/switch:h-6 group-data-[checked]/switch:w-6 group-data-[checked]/switch:translate-x-6 group-data-[checked]/switch:bg-[var(--ft-color-on-primary)]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
