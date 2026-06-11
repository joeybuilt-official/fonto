// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
"use client"

import * as React from "react"
import { Field as FieldPrimitive } from "@base-ui/react/field"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * MD3 TextField — ADR 0009.
 *
 * Variants:
 *   filled    — surface-container-highest bg, bottom border only.
 *   outlined  — transparent bg, full outline border, primary on focus.
 *
 * Floating-label support is opt-in via the `floatingLabel` prop on `TextField`.
 * When set, the label sits inside the control and the consumer wraps it with
 * a `peer` input. For the simple case (label above), use plain
 * `<TextField><TextFieldLabel/><TextFieldInput/></TextField>` composition.
 *
 * Shape: extra-small (4 px) top corners on filled; small (8 px) all corners
 * on outlined per MD3 spec.
 */
const textFieldRootVariants = cva("flex flex-col gap-[var(--ft-space-1)]", {
  variants: {},
})

const textFieldInputVariants = cva(
  "peer w-full bg-transparent text-[length:var(--ft-type-body-large-size)] leading-[var(--ft-type-body-large-line)] text-[var(--ft-color-on-surface)] outline-none placeholder:text-[var(--ft-color-on-surface-variant)] disabled:opacity-[var(--ft-state-disabled-content,0.38)]",
  {
    variants: {
      variant: {
        filled:
          "h-14 rounded-t-[var(--ft-shape-extra-small)] border-b-2 border-[var(--ft-color-outline)] bg-[var(--ft-color-surface-container-highest)] px-[var(--ft-space-4)] pt-[var(--ft-space-5)] pb-[var(--ft-space-2)] focus:border-[var(--ft-color-primary)]",
        outlined:
          "h-14 rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-transparent px-[var(--ft-space-4)] focus:border-[var(--ft-color-primary)] focus:ring-1 focus:ring-[var(--ft-color-primary)]",
      },
    },
    defaultVariants: {
      variant: "outlined",
    },
  }
)

type TextFieldVariant = NonNullable<
  VariantProps<typeof textFieldInputVariants>["variant"]
>

const TextFieldContext = React.createContext<TextFieldVariant>("outlined")

type TextFieldProps = FieldPrimitive.Root.Props &
  VariantProps<typeof textFieldInputVariants>

function TextField({
  className,
  variant = "outlined",
  children,
  ...props
}: TextFieldProps) {
  return (
    <FieldPrimitive.Root
      data-slot="text-field"
      className={cn(textFieldRootVariants(), className)}
      {...props}
    >
      <TextFieldContext.Provider value={variant ?? "outlined"}>
        {children}
      </TextFieldContext.Provider>
    </FieldPrimitive.Root>
  )
}

function TextFieldLabel({
  className,
  ...props
}: FieldPrimitive.Label.Props) {
  return (
    <FieldPrimitive.Label
      data-slot="text-field-label"
      className={cn(
        "text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] font-medium text-[var(--ft-color-on-surface-variant)]",
        className
      )}
      {...props}
    />
  )
}

function TextFieldInput({
  className,
  ...props
}: FieldPrimitive.Control.Props) {
  const variant = React.useContext(TextFieldContext)
  return (
    <FieldPrimitive.Control
      data-slot="text-field-input"
      className={cn(textFieldInputVariants({ variant }), className)}
      {...props}
    />
  )
}

function TextFieldDescription({
  className,
  ...props
}: FieldPrimitive.Description.Props) {
  return (
    <FieldPrimitive.Description
      data-slot="text-field-description"
      className={cn(
        "text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-on-surface-variant)]",
        className
      )}
      {...props}
    />
  )
}

function TextFieldError({
  className,
  ...props
}: FieldPrimitive.Error.Props) {
  return (
    <FieldPrimitive.Error
      data-slot="text-field-error"
      className={cn(
        "text-[length:var(--ft-type-body-small-size)] leading-[var(--ft-type-body-small-line)] text-[var(--ft-color-error)]",
        className
      )}
      {...props}
    />
  )
}

export {
  TextField,
  TextFieldLabel,
  TextFieldInput,
  TextFieldDescription,
  TextFieldError,
  textFieldInputVariants,
}
