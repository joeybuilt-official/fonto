"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";

interface PersonPreview {
  id: string;
  name: string | null;
  coverFaceCropUrl: string | null;
  instanceCount: number;
}

export function PeopleCard() {
  const [persons, setPersons] = useState<PersonPreview[]>([]);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/v1/persons")
      .then((r) => r.json())
      .then((d: { persons?: PersonPreview[] }) => {
        const all = d.persons ?? [];
        setPersons(all.slice(0, 4));
        setTotal(all.length);
      })
      .catch(() => {});
  }, []);

  if (!persons.length) return null;

  const label = total != null ? `People & Pets, ${total} people` : "People & Pets";

  return (
    <Link
      href="/app/people"
      aria-label={label}
      className="group overflow-hidden rounded-xl border border-border bg-card hover:border-primary/50 hover:shadow-md transition-all"
    >
      {/* 2×2 face circles */}
      <div className="grid grid-cols-2 gap-1.5 p-3">
        {Array.from({ length: 4 }).map((_, i) => {
          const p = persons[i];
          return p?.coverFaceCropUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={p.id}
              src={p.coverFaceCropUrl}
              alt={p.name ?? "Person"}
              loading="lazy"
              className="aspect-square w-full rounded-full object-cover"
            />
          ) : (
            <div
              key={i}
              className="aspect-square w-full rounded-full bg-muted flex items-center justify-center"
            >
              <Users className="size-4 text-muted-foreground/40" />
            </div>
          );
        })}
      </div>
      <div className="px-3 pb-3">
        <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
          People &amp; Pets
        </p>
        {total != null && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? "person" : "people"}
          </p>
        )}
      </div>
    </Link>
  );
}
