// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 sweep: header → AssetPageToolbar. Card grid stays bespoke (cards
// here are folder-like, not asset tiles). Audit §4 calls for card covers
// from latest asset + multi-collection drag-drop — deferred.
"use client";

import { Suspense, useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Plus, Folder, Loader2, Trash2 } from "lucide-react";
import { AssetPageToolbar } from "../_components/asset-page-toolbar";
import { useToolbarState } from "@/lib/hooks/use-toolbar-state";

type Project = {
  id: string;
  name: string;
  description: string;
  color: string;
  createdAt: string;
  updatedAt: string;
};

function ProjectsContent() {
  const toolbar = useToolbarState({
    page: "projects",
    availableFilters: [],
  });

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/projects");
      if (res.ok) {
        const data = (await res.json()) as { projects?: Project[] };
        setProjects(data.projects ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const res = await fetch("/api/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (res.ok) {
      setNewName("");
      setCreating(false);
      void load();
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this project? Collections inside will be detached.")) return;
    await fetch(`/api/v1/projects/${id}`, { method: "DELETE" });
    void load();
  }

  const visible = useMemo(() => {
    let list = projects;
    if (toolbar.filters.q) {
      const needle = toolbar.filters.q.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.description.toLowerCase().includes(needle)
      );
    }
    if (toolbar.filters.sort === "oldest") {
      list = [...list].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    } else if (toolbar.filters.sort === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    } else {
      // newest = updated most recently. Distinguishes from collections page
      // which uses createdAt; projects tend to live longer + get touched.
      list = [...list].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    }
    return list;
  }, [projects, toolbar.filters.q, toolbar.filters.sort]);

  return (
    <div className="space-y-3">
      <AssetPageToolbar
        title="Projects"
        count={loading ? undefined : visible.length}
        toolbar={toolbar}
        searchPlaceholder="Search projects…"
        sortOptions={["newest", "oldest", "name"]}
        showDensity={false}
        showSelect={false}
        primaryAction={{
          label: "New",
          icon: <Plus className="h-3.5 w-3.5" />,
          onClick: () => setCreating(true),
        }}
      />

      <div className="px-4 space-y-4">
        {creating && (
          <form onSubmit={handleCreate} className="flex gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Project name"
              autoFocus
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button type="submit" className="rounded-lg bg-foreground px-3 py-2 text-sm text-background hover:bg-foreground/90">
              Create
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/40"
            >
              Cancel
            </button>
          </form>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : visible.length === 0 && !toolbar.filters.q ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
            <Folder className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-foreground">No projects yet</p>
            <p className="text-xs text-muted-foreground mt-1">Create a project to organize albums and collections</p>
          </div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((project) => (
              <div key={project.id} className="group relative rounded-xl border border-border bg-card p-4 hover:bg-muted/20 transition-colors">
                <Link href={`/app/projects/${project.id}`} className="flex items-start gap-3">
                  <div className="mt-0.5 h-8 w-8 shrink-0 rounded-lg flex items-center justify-center" style={{ backgroundColor: project.color + "30" }}>
                    <Folder className="h-4 w-4" style={{ color: project.color }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground truncate">{project.name}</p>
                    {project.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{project.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(project.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                </Link>
                <button
                  onClick={() => handleDelete(project.id)}
                  className="absolute top-3 right-3 hidden group-hover:flex items-center justify-center rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  aria-label="Delete project"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground py-4">Loading…</div>}>
      <ProjectsContent />
    </Suspense>
  );
}
