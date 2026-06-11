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
  const [resolved, setResolved] = useState<Record<string, string>>({});

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

  // `coverFaceCropUrl` is a relative API path that returns JSON
  // `{ url: "<presigned R2 URL>" }` — not an image. Resolve each before
  // setting <img src>. People page does the same in its FaceCrop.
  useEffect(() => {
    let cancelled = false;
    for (const p of persons) {
      if (!p.coverFaceCropUrl || resolved[p.id]) continue;
      fetch(p.coverFaceCropUrl)
        .then((r) => r.json())
        .then((d: { url?: string }) => {
          if (cancelled || !d.url) return;
          setResolved((r) => ({ ...r, [p.id]: d.url! }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [persons, resolved]);

  if (!persons.length) return null;

  // Accessible name derives from the inner heading + count text. Explicit
  // aria-label would override the visible label, which Lighthouse flags as
  // label-content-name-mismatch (visible text not in accessible name).

  return (
    <Link
      href="/app/people"
      className="group block max-w-md overflow-hidden rounded-xl border border-border bg-card hover:border-primary/50 hover:shadow-md transition-all sm:flex sm:max-w-none sm:items-center sm:gap-4 sm:p-3"
    >
      <div className="grid grid-cols-2 gap-1.5 p-3 sm:size-24 sm:shrink-0 sm:p-0">
        {Array.from({ length: 4 }).map((_, i) => {
          const p = persons[i];
          const url = p ? resolved[p.id] : null;
          return url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={p!.id}
              src={url}
              alt=""
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
      <div className="px-3 pb-3 sm:flex-1 sm:p-0">
        <p className="text-sm font-semibold text-foreground group-hover:text-primary-text transition-colors">
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
