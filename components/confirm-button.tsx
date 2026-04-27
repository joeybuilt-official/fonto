"use client";

/**
 * Two-step delete (or any destructive) confirmation button.
 *
 * First click arms the button — its label flips to a confirmation message,
 * background turns destructive-red, and a 4-second timer starts. A second
 * click within that window invokes `onConfirm`. Mouse-leave or timeout
 * resets the armed state.
 *
 * Hard rule across all Joeybuilt apps: every destructive UI action MUST
 * route through ConfirmButton (or an equivalent two-step / modal confirm).
 * No single-click destructive paths.
 */

import { useEffect, useRef, useState } from "react";
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

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={handleClick}
      onMouseLeave={disarm}
      className={cn(
        className,
        armed && (armedClassName ?? "ring-2 ring-red-500 animate-pulse")
      )}
    >
      {armed ? (confirmLabel ?? "Click again to delete") : children}
    </button>
  );
}
