// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import * as React from "react"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"

import { cn } from "@/lib/utils"

/**
 * MD3 Snackbar (toast) — ADR 0009.
 *
 * Surface: inverse-surface. Shape: small (8 px) per MD3 (NOT MD2's 4 px).
 * Elevation: 3. Single-line height 48 px, two-line up to 68 px.
 *
 * Compose at app root:
 *   <SnackbarProvider>
 *     {children}
 *     <SnackbarViewport />
 *   </SnackbarProvider>
 *
 * Trigger inside a component:
 *   const toast = useSnackbar();
 *   toast.add({ title: "Saved", description: "1 asset updated" });
 */
function SnackbarProvider({ ...props }: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />
}

function SnackbarViewport({
  className,
  ...props
}: ToastPrimitive.Viewport.Props) {
  return (
    <ToastPrimitive.Viewport
      data-slot="snackbar-viewport"
      className={cn(
        "fixed bottom-[var(--ft-space-4)] left-1/2 z-[60] flex w-[min(560px,calc(100vw-2*var(--ft-space-4)))] -translate-x-1/2 flex-col gap-[var(--ft-space-2)] outline-none",
        className
      )}
      {...props}
    />
  )
}

type SnackbarRootProps = Omit<ToastPrimitive.Root.Props, "toast"> & {
  toast: ToastPrimitive.Root.ToastObject
}

function Snackbar({ className, children, toast, ...props }: SnackbarRootProps) {
  return (
    <ToastPrimitive.Root
      data-slot="snackbar"
      toast={toast}
      className={cn(
        "flex w-full items-center gap-[var(--ft-space-4)] rounded-[var(--ft-shape-small)] bg-[var(--ft-color-inverse-surface)] px-[var(--ft-space-4)] py-[var(--ft-space-3)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-inverse-surface)] shadow-[var(--ft-elev-3)] outline-none data-[starting]:animate-in data-[starting]:slide-in-from-bottom data-[starting]:fade-in-0 data-[ending]:animate-out data-[ending]:fade-out-0",
        className
      )}
      {...props}
    >
      {children}
    </ToastPrimitive.Root>
  )
}

function SnackbarTitle({
  className,
  ...props
}: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="snackbar-title"
      className={cn("flex-1 font-medium", className)}
      {...props}
    />
  )
}

function SnackbarDescription({
  className,
  ...props
}: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="snackbar-description"
      className={cn(
        "flex-1 text-[var(--ft-color-on-inverse-surface)]/80",
        className
      )}
      {...props}
    />
  )
}

function SnackbarAction({
  className,
  ...props
}: ToastPrimitive.Action.Props) {
  return (
    <ToastPrimitive.Action
      data-slot="snackbar-action"
      className={cn(
        "shrink-0 rounded-[var(--ft-shape-full)] px-[var(--ft-space-3)] py-[var(--ft-space-1)] text-[length:var(--ft-type-label-large-size)] leading-[var(--ft-type-label-large-line)] font-medium text-[var(--ft-color-inverse-primary)] hover:bg-[color-mix(in_srgb,var(--ft-color-inverse-primary)_8%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ft-color-inverse-primary)]/40",
        className
      )}
      {...props}
    />
  )
}

function SnackbarClose({
  className,
  ...props
}: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="snackbar-close"
      className={cn(
        "shrink-0 rounded-[var(--ft-shape-full)] p-[var(--ft-space-1)] text-[var(--ft-color-on-inverse-surface)]/70 hover:bg-[color-mix(in_srgb,var(--ft-color-on-inverse-surface)_8%,transparent)]",
        className
      )}
      {...props}
    />
  )
}

const useSnackbar = ToastPrimitive.useToastManager
const createSnackbarManager = ToastPrimitive.createToastManager

export {
  Snackbar,
  SnackbarProvider,
  SnackbarViewport,
  SnackbarTitle,
  SnackbarDescription,
  SnackbarAction,
  SnackbarClose,
  useSnackbar,
  createSnackbarManager,
}
