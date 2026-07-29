// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Intelligence Core — Phase 3. Tiny weighted union-find used to cluster
// near-duplicate assets into variant groups. Pure + DB-free (unit-testable).

export class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  constructor(ids: Iterable<string>) {
    for (const id of ids) {
      this.parent.set(id, id);
      this.rank.set(id, 0);
    }
  }

  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) as string;
    }
    // Path-compress.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    if (!this.parent.has(a) || !this.parent.has(b)) return;
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rka = this.rank.get(ra) ?? 0;
    const rkb = this.rank.get(rb) ?? 0;
    if (rka < rkb) this.parent.set(ra, rb);
    else if (rka > rkb) this.parent.set(rb, ra);
    else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rka + 1);
    }
  }

  /** Connected components of size ≥ minSize, keyed by root. */
  components(minSize = 2): string[][] {
    const groups = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const arr = groups.get(root);
      if (arr) arr.push(id);
      else groups.set(root, [id]);
    }
    return Array.from(groups.values()).filter((g) => g.length >= minSize);
  }
}
