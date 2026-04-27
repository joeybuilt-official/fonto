// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Plus, Folder, Loader2, Trash2 } from "lucide-react";

type Project = {
  id: string;
  name: string;
  description: string;
  color: string;
  createdAt: string;
  updatedAt: string;
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/projects");
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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
      load();
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this project? Collections inside will be detached.")) return;
    await fetch(`/api/v1/projects/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Top-level containers grouping related albums and assets
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background hover:bg-foreground/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New project
        </button>
      </div>

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
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
          <Folder className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-sm font-medium text-foreground">No projects yet</p>
          <p className="text-xs text-muted-foreground mt-1">Create a project to organize albums and collections</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
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
  );
}
