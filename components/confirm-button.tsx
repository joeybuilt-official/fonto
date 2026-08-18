// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
"use client";

/**
 * Two-step delete (or any destructive) confirmation button.
 *
 * First click arms the button — its label flips to a confirmation message,
 * a destructive ring + pulse animates, and a 4-second timer starts. A
 * second click within that window invokes `onConfirm`. Mouse-leave or
 * timeout resets the armed state.
 *
 * Hard rule across all Joeybuilt apps: every destructive UI action MUST
 * route through ConfirmButton (or an equivalent two-step / modal confirm).
 * No single-click destructive paths.
 *
 * ADR 0009 phase 2 (group D) — the inner control is the MD3 <Button>
 * primitive. The default look is the filled MD3 button, but the
 * destructive colour signalling (`destructive` prop, default true) maps
 * to the `--ft-color-error` token. Callers can still pass `className` /
 * `armedClassName` to override either layer; cn() applies tailwind-merge
 * so the override consistently wins.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ConfirmButtonProps {
  onConfirm: () => void | Promise<void>;
  className?: string;
  armedClassName?: string;
  children: React.ReactNode;
  confirmLabel?: React.ReactNode;
  timeoutMs?: number;
  disabled?: boolean;
  stopPropagation?: boolean;
  /** When true (default), the button signals a destructive action by
   *  resolving its base fill / text colour through `--ft-color-error`
   *  + on-error. Set to false for neutral confirms (e.g. "Sign out"). */
  destructive?: boolean;
}

export function ConfirmButton({
  onConfirm,
  className,
  armedClassName,
  children,
  confirmLabel,
  timeoutMs = 4000,
  disabled = false,
  stopPropagation = true,
  destructive = true,
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  function disarm() {
    setArmed(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  async function handleClick(e: React.MouseEvent) {
    if (stopPropagation) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (disabled) return;
    if (!armed) {
      setArmed(true);
      timerRef.current = setTimeout(() => disarm(), timeoutMs);
      return;
    }
    disarm();
    await onConfirm();
  }

  // Destructive base: text-only at rest so the caller's pre-MD3 className
  // (most existing trash / revoke buttons) still drives the resting look,
  // then the armed state lifts to a filled error fill + animated ring.
  // When `destructive` is false we leave the colour signalling neutral
  // (caller's className governs).
  const destructiveBase = destructive
    ? "text-[var(--ft-color-error)] hover:bg-[color-mix(in_srgb,var(--ft-color-error)_8%,transparent)]"
    : "";
  const armedDefault = destructive
    ? "bg-[var(--ft-color-error)] text-[var(--ft-color-on-error)] ring-2 ring-[var(--ft-color-error)] animate-pulse"
    : "ring-2 ring-[var(--ft-color-primary)] animate-pulse";

  return (
    <Button
      type="button"
      variant="filled"
      disabled={disabled}
      onClick={handleClick}
      onMouseLeave={disarm}
      className={cn(
        // Reset the filled variant's primary fill so destructive callers
        // (and their existing classNames) render correctly at rest.
        "bg-transparent",
        destructiveBase,
        className,
        armed && (armedClassName ?? armedDefault),
      )}
    >
      {armed ? (confirmLabel ?? "Click again to delete") : children}
    </Button>
  );
}
