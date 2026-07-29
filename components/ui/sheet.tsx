// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * MD3 Sheet — bottom-sheet + side-sheet variants. ADR 0009.
 *
 * Built on `@base-ui/react/dialog` (modal sheet pattern). Sheets share the
 * dialog scrim + focus behaviour but anchor to a viewport edge.
 *
 * Sides:
 *   bottom (default) — slides up from the bottom. Top corners 28 px.
 *   top    — slides down from the top. Bottom corners 28 px.
 *   left   — slides in from the left. Right corners 28 px.
 *   right  — slides in from the right. Left corners 28 px.
 *
 * Surface: surface-container-high. Shape: extra-large (28 px on the leading
 * edge). Elevation: 1 (sheets are flatter than dialogs).
 */
const sheetContentVariants = cva(
  "fixed z-50 flex flex-col gap-[var(--ft-space-4)] bg-[var(--ft-color-surface-container-high)] p-[var(--ft-space-6)] text-[var(--ft-color-on-surface)] shadow-[var(--ft-elev-1)] outline-none transition ease-[var(--ft-motion-emphasized)] duration-[var(--ft-motion-medium)]",
  {
    variants: {
      side: {
        bottom:
          "inset-x-0 bottom-0 max-h-[90vh] rounded-t-[var(--ft-shape-extra-large)] data-[open]:animate-in data-[open]:slide-in-from-bottom data-[closed]:animate-out data-[closed]:slide-out-to-bottom",
        top: "inset-x-0 top-0 max-h-[90vh] rounded-b-[var(--ft-shape-extra-large)] data-[open]:animate-in data-[open]:slide-in-from-top data-[closed]:animate-out data-[closed]:slide-out-to-top",
        left: "inset-y-0 left-0 h-full w-3/4 max-w-sm rounded-r-[var(--ft-shape-extra-large)] data-[open]:animate-in data-[open]:slide-in-from-left data-[closed]:animate-out data-[closed]:slide-out-to-left",
        right:
          "inset-y-0 right-0 h-full w-3/4 max-w-sm rounded-l-[var(--ft-shape-extra-large)] data-[open]:animate-in data-[open]:slide-in-from-right data-[closed]:animate-out data-[closed]:slide-out-to-right",
      },
    },
    defaultVariants: {
      side: "bottom",
    },
  }
)

function Sheet({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />
}

function SheetTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetContent({
  className,
  side = "bottom",
  children,
  ...props
}: DialogPrimitive.Popup.Props & VariantProps<typeof sheetContentVariants>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="sheet-backdrop"
        className="fixed inset-0 z-50 bg-[var(--ft-color-scrim)]/50 data-[open]:animate-in data-[open]:fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0"
      />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(sheetContentVariants({ side }), className)}
        {...props}
      >
        {side === "bottom" ? (
          <div
            aria-hidden
            className="mx-auto h-1 w-8 shrink-0 rounded-full bg-[var(--ft-color-outline-variant)]"
          />
        ) : null}
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-[var(--ft-space-1)]", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "mt-auto flex flex-row items-center justify-end gap-[var(--ft-space-2)]",
        className
      )}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "text-[length:var(--ft-type-title-large-size)] leading-[var(--ft-type-title-large-line)] font-medium",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn(
        "text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]",
        className
      )}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  sheetContentVariants,
}
