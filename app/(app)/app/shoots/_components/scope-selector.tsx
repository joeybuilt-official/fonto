// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// ADR 0008 Phase 5 — scope selector chip strip.
//
// Three-way pill row (Personal / Shoots / All) that drives the `?scope=`
// query param on browsable surfaces (library, search, etc.). The API
// defaults to PERSONAL when the param is absent (lib/scope.ts:72), so
// the "Personal" chip writes no param — it just strips the existing one.
// "Shoots" writes ?scope=SHOOT, "All" writes ?scope=all.
//
// This component is URL-only — it does NOT touch the localStorage
// default-scope preference (that's only consumed when arriving at a
// surface with no `?scope=`; once the user picks here it wins).
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Camera, Layers, User } from "lucide-react";
import { Chip } from "@/components/ui/chip";
import type { Scope } from "@/lib/scope";

const OPTIONS: Array<{
  value: Scope | "all";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: "PERSONAL", label: "Personal", icon: User },
  { value: "SHOOT", label: "Shoots", icon: Camera },
  { value: "all", label: "All", icon: Layers },
];

export function ScopeSelector({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const current = (() => {
    const raw = params.get("scope");
    if (raw === "SHOOT") return "SHOOT" as const;
    if (raw === "all") return "all" as const;
    return "PERSONAL" as const;
  })();

  function pick(value: Scope | "all") {
    const sp = new URLSearchParams(params.toString());
    if (value === "PERSONAL") sp.delete("scope");
    else sp.set("scope", value);
    const q = sp.toString();
    router.push(q ? `${pathname}?${q}` : pathname);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Library scope"
      className={`flex gap-[var(--ft-space-2)] ${className ?? ""}`}
    >
      {OPTIONS.map((o) => {
        const Icon = o.icon;
        const selected = current === o.value;
        return (
          <Chip
            key={o.value}
            variant="filter"
            selected={selected}
            role="radio"
            aria-checked={selected}
            onClick={() => pick(o.value)}
          >
            <Icon className="size-4" />
            {o.label}
          </Chip>
        );
      })}
    </div>
  );
}
