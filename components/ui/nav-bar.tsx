// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"

import { cn } from "@/lib/utils"

/**
 * MD3 Bottom Navigation Bar — ADR 0009.
 *
 * Surface: surface-container. Elevation: 2. Height 80 px per MD3 default
 * density. Active item has a `secondary-container` pill indicator around
 * the icon (64×32) and on-secondary-container icon/label colours.
 *
 * Compose:
 *   <NavBar>
 *     <NavBarItem icon={<HomeIcon />} label="Home" active={tab === 'home'}
 *       onClick={() => setTab('home')} />
 *     ...
 *   </NavBar>
 *
 * NOTE: This is the primitive only. Migrating
 * `components/app-mobile-bottom-bar.tsx` to consume it is Phase 2 work and
 * NOT done here.
 */
function NavBar({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="nav-bar"
      className={cn(
        "flex h-20 w-full items-stretch justify-around bg-[var(--ft-color-surface-container)] px-[var(--ft-space-2)] shadow-[var(--ft-elev-2)]",
        className
      )}
      {...props}
    />
  )
}

type NavBarItemProps = ButtonPrimitive.Props & {
  icon: React.ReactNode
  label: React.ReactNode
  active?: boolean
  badge?: React.ReactNode
}

function NavBarItem({
  className,
  icon,
  label,
  active,
  badge,
  ...props
}: NavBarItemProps) {
  return (
    <ButtonPrimitive
      data-slot="nav-bar-item"
      data-active={active ? "true" : "false"}
      className={cn(
        "group/nav-item relative flex flex-1 flex-col items-center justify-center gap-[var(--ft-space-1)] rounded-none bg-transparent py-[var(--ft-space-3)] text-[var(--ft-color-on-surface-variant)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ft-color-primary)]/40 data-[active=true]:text-[var(--ft-color-on-secondary-container)]",
        className
      )}
      {...props}
    >
      <span className="relative inline-flex h-8 w-16 items-center justify-center rounded-[var(--ft-shape-full)] transition-colors group-data-[active=true]/nav-item:bg-[var(--ft-color-secondary-container)] [&_svg]:size-6 [&_svg]:shrink-0">
        {icon}
        {badge ? (
          <span className="absolute top-0 right-2 inline-flex h-4 min-w-4 items-center justify-center rounded-[var(--ft-shape-full)] bg-[var(--ft-color-error)] px-1 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium text-[var(--ft-color-on-error)]">
            {badge}
          </span>
        ) : null}
      </span>
      <span className="text-[length:var(--ft-type-label-medium-size)] leading-[var(--ft-type-label-medium-line)] font-medium tracking-[var(--ft-type-label-medium-tracking)]">
        {label}
      </span>
    </ButtonPrimitive>
  )
}

export { NavBar, NavBarItem }
