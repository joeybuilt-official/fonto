// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { Button, type ButtonProps } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * MD3 Dialog — ADR 0009.
 *
 * Surface: surface-container-high. Shape: large (16 px). Elevation: 3.
 * Backdrop uses scrim @ 32% per MD3 modal-scrim spec.
 *
 * Compose:
 *   <Dialog>
 *     <DialogTrigger />
 *     <DialogContent>
 *       <DialogHeader>
 *         <DialogTitle />
 *         <DialogDescription />
 *       </DialogHeader>
 *       ...content...
 *       <DialogFooter>...buttons...</DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 */
function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

// Shorthand: `DialogCloseButton` renders an MD3 `<Button>` that, when
// clicked, closes the parent dialog. base-ui's `render` prop on
// `Dialog.Close` swaps the underlying element — we hand it a Button so
// the close action inherits the MD3 variant system (filled / tonal /
// outlined / text / elevated) instead of forcing callers to hand-roll
// the close trigger. Default variant is `text` (subtle dismiss).
function DialogCloseButton({
  variant = "text",
  size,
  children,
  className,
  ...props
}: Omit<DialogPrimitive.Close.Props, "render"> &
  Pick<ButtonProps, "variant" | "size">) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close-button"
      render={
        <Button variant={variant} size={size} className={className}>
          {children}
        </Button>
      }
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-backdrop"
        className="fixed inset-0 z-50 bg-[var(--ft-color-scrim)]/50 data-[open]:animate-in data-[open]:fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-[var(--ft-space-4)] rounded-[var(--ft-shape-large)] bg-[var(--ft-color-surface-container-high)] p-[var(--ft-space-6)] text-[var(--ft-color-on-surface)] shadow-[var(--ft-elev-3)] outline-none data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex flex-col gap-[var(--ft-space-1)] text-left",
        className
      )}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-row items-center justify-end gap-[var(--ft-space-2)]",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-[length:var(--ft-type-headline-small-size)] leading-[var(--ft-type-headline-small-line)] font-medium text-[var(--ft-color-on-surface)]",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogCloseButton,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
