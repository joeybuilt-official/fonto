// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * MD3 Card — ADR 0009.
 *
 * Variants:
 *   elevated  — surface-container-low background + elevation-1.
 *   filled    — surface-container-highest background, no shadow.
 *   outlined  — surface background + outline-variant border, no shadow.
 *
 * Compose: <Card><CardHeader/><CardContent/><CardFooter/></Card>
 * Shape: medium (12 px). Spacing 16 px / 24 px per MD3 density-default.
 */
const cardVariants = cva(
  "flex flex-col rounded-[var(--ft-shape-medium)] text-[var(--ft-color-on-surface)] transition-shadow",
  {
    variants: {
      variant: {
        elevated:
          "bg-[var(--ft-color-surface-container-low)] shadow-[var(--ft-elev-1)] hover:shadow-[var(--ft-elev-2)]",
        filled:
          "bg-[var(--ft-color-surface-container-highest)] shadow-none",
        outlined:
          "border border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface)] shadow-none",
      },
    },
    defaultVariants: {
      variant: "elevated",
    },
  }
)

function Card({
  className,
  variant = "elevated",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ variant }), className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "flex flex-col gap-[var(--ft-space-1)] px-[var(--ft-space-4)] pt-[var(--ft-space-4)]",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "text-[length:var(--ft-type-title-large-size)] leading-[var(--ft-type-title-large-line)] font-medium",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn(
        "text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-[var(--ft-space-4)] py-[var(--ft-space-4)]", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center gap-[var(--ft-space-2)] px-[var(--ft-space-4)] pb-[var(--ft-space-4)]",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  cardVariants,
}
