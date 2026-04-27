// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { ArrowLeft, Folder, Plus, Loader2 } from "lucide-react";

type Project = {
  id: string;
  name: string;
  description: string;
  color: string;
};

type Collection = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
};

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/projects/${id}`);
      if (res.ok) {
        const data = await res.json();
        setProject(data.project);
        setCollections(data.collections ?? []);
        setEditName(data.project?.name ?? "");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function handleSave() {
    if (!editName.trim()) return;
    await fetch(`/api/v1/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName.trim() }),
    });
    setEditing(false);
    load();
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!project) {
    return <p className="text-center text-muted-foreground py-12">Project not found.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/app/projects" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        {editing ? (
          <div className="flex items-center gap-2 flex-1">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              autoFocus
              className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button onClick={handleSave} className="rounded-lg bg-foreground px-3 py-1.5 text-sm text-background hover:bg-foreground/90">Save</button>
            <button onClick={() => setEditing(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted/40">Cancel</button>
          </div>
        ) : (
          <h1
            className="text-2xl font-semibold text-foreground cursor-pointer hover:text-foreground/80"
            onClick={() => setEditing(true)}
          >
            {project.name}
          </h1>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Albums in this project</h2>
        </div>

        {collections.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12 text-center">
            <Folder className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">No albums yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Assign albums to this project from the{" "}
              <Link href="/app/collections" className="underline underline-offset-2">Albums</Link> page
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {collections.map((col) => (
              <Link
                key={col.id}
                href={`/app/collections/${col.id}`}
                className="rounded-xl border border-border bg-card p-4 hover:bg-muted/20 transition-colors"
              >
                <p className="font-medium text-foreground">{col.name}</p>
                {col.description && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{col.description}</p>
                )}
                <p className="text-xs text-muted-foreground mt-2">
                  {new Date(col.createdAt).toLocaleDateString()}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
