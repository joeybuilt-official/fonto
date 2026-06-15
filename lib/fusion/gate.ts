// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 4 (ADR-0005). The single confidence gate that
// governs all three subsystems, with PER-ACTION thresholds — a wrong date
// (two-way) and a purge (one-way) cannot share a bar. Pure.

export type GateAction = "date" | "purge";
export type GateDecision = "auto-commit" | "review" | "leave";

export interface GateThreshold {
  high: number;
  low: number;
}
export type GateThresholds = Record<GateAction, GateThreshold>;

// HIGH[purge] ≫ HIGH[date]: a destructive one-way action demands far more
// certainty than a reversible date proposal. Operator-overridable (config, not
// code) — and never auto-loosened without operator action.
export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  date: { high: 0.7, low: 0.35 },
  purge: { high: 0.95, low: 0.7 },
};

export interface GateInput {
  score: number;
  action: GateAction;
  /** A date with ANY conflict routes to review regardless of score. */
  conflict?: boolean;
  /**
   * Purge auto-commit is necessary-not-sufficient on score: the caller must ALSO
   * have passed Stage-2 structural verify + sole-copy safety (Phase 5/ADR-0004).
   * When false, a purge can never auto-commit no matter how high the score.
   */
  structurallyVerified?: boolean;
  thresholds?: GateThresholds;
}

/**
 * Decide: auto-commit (≥ HIGH) · review (LOW ≤ score < HIGH) · leave (< LOW).
 * Conservative middle → human, exactly per the UX-seat binding decision.
 */
export function gateDecision(input: GateInput): GateDecision {
  const thresholds = input.thresholds ?? DEFAULT_GATE_THRESHOLDS;
  const t = thresholds[input.action];

  // Any conflict on a date forces review (ADR-0005), even above HIGH.
  if (input.action === "date" && input.conflict) {
    return input.score >= t.low ? "review" : "leave";
  }

  if (input.score >= t.high) {
    // Purge needs the structural + sole-copy gate in addition to the score.
    if (input.action === "purge" && !input.structurallyVerified) return "review";
    return "auto-commit";
  }
  if (input.score >= t.low) return "review";
  return "leave";
}
