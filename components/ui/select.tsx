// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { ChevronDown, Check } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * MD3 Select / Dropdown menu — ADR 0009.
 *
 * Surface: surface-container. Elevation: 2. Shape: extra-small (4 px) for the
 * popup per MD3 menu spec (small-corner menus). Trigger styled as MD3 outlined
 * text-field for parity with `<TextField variant="outlined" />`.
 *
 * Compose:
 *   <Select value={x} onValueChange={…}>
 *     <SelectTrigger><SelectValue placeholder="…" /></SelectTrigger>
 *     <SelectContent>
 *       <SelectItem value="a">A</SelectItem>
 *       <SelectItem value="b">B</SelectItem>
 *     </SelectContent>
 *   </Select>
 */
function Select<Value, Multiple extends boolean | undefined = false>(
  props: SelectPrimitive.Root.Props<Value, Multiple>
) {
  return <SelectPrimitive.Root {...props} />
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  children,
  ...props
}: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "inline-flex h-10 w-full items-center justify-between gap-[var(--ft-space-2)] rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-transparent px-[var(--ft-space-4)] text-[length:var(--ft-type-body-large-size)] leading-[var(--ft-type-body-large-line)] text-[var(--ft-color-on-surface)] outline-none transition-colors focus-visible:border-[var(--ft-color-primary)] focus-visible:ring-1 focus-visible:ring-[var(--ft-color-primary)] disabled:cursor-not-allowed disabled:opacity-[var(--ft-state-disabled-content,0.38)] [&_svg]:size-4 [&_svg]:shrink-0",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon>
        <ChevronDown className="opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  ...props
}: SelectPrimitive.Popup.Props) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        sideOffset={4}
        className="isolate z-50 outline-none"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "z-50 min-w-[var(--anchor-width)] overflow-hidden rounded-[var(--ft-shape-extra-small)] bg-[var(--ft-color-surface-container)] py-[var(--ft-space-2)] text-[var(--ft-color-on-surface)] shadow-[var(--ft-elev-2)] outline-none data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex h-10 cursor-pointer items-center gap-[var(--ft-space-2)] px-[var(--ft-space-4)] text-[length:var(--ft-type-body-large-size)] leading-[var(--ft-type-body-large-line)] outline-none data-[highlighted]:bg-[color-mix(in_srgb,var(--ft-color-on-surface)_8%,transparent)] data-[selected]:bg-[var(--ft-color-secondary-container)] data-[selected]:text-[var(--ft-color-on-secondary-container)] data-[disabled]:pointer-events-none data-[disabled]:opacity-[var(--ft-state-disabled-content,0.38)]",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="absolute right-[var(--ft-space-3)] inline-flex items-center justify-center">
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectGroupLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cn(
        "px-[var(--ft-space-4)] py-[var(--ft-space-2)] text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium text-[var(--ft-color-on-surface-variant)]",
        className
      )}
      {...props}
    />
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn(
        "my-[var(--ft-space-1)] h-px bg-[var(--ft-color-outline-variant)]",
        className
      )}
      {...props}
    />
  )
}

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectGroupLabel,
  SelectSeparator,
}
