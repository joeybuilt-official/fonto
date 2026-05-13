// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
import { createHmac } from "node:crypto";

/**
 * Phase D-Fonto-1 (ADR 0027) — pHash near-duplicate detection backed by a
 * FalkorDB vector index, replacing the in-memory full-scan in
 * app/api/v1/assets/route.ts:findPHashNearDuplicate.
 *
 * Prototype scope:
 *   - Each upload mirrors the new Asset to the sidecar's per-workspace
 *     fonto:<workspace_id> graph with a 64-dim phash_vec.
 *   - Reads use the same sidecar to issue a vector NN query and return
 *     the closest match below the Hamming threshold.
 *   - Live integration runs in shadow mode (logs disagreement vs the
 *     postgres full-scan); a follow-on milestone flips the read path.
 *
 * Failure mode is no-op: if env is missing or the sidecar is unreachable,
 * helpers return null and the upload path continues uninterrupted on the
 * existing postgres scan.
 *
 * Graph index bootstrap (operator runs once per workspace, out-of-band):
 *   CALL db.idx.vector.createNodeIndex('Asset', 'phash_vec', 64, 'L2', 16)
 */

const SIDECAR_URL = process.env.PLEXO_GRAPHITI_SIDECAR_URL ?? "";
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? "";
const APP_ID = "fonto";

export const PHASH_VEC_DIMENSION = 64;

/**
 * Unpack a 64-bit pHash bigint into a 64-dim float vector (LSB-first).
 * L2 distance on this vector is monotonic with Hamming distance on the
 * original bits, so a vector kNN query produces the same ordering as the
 * Hamming full-scan.
 */
export function phashToVec64(phash: bigint): number[] {
    const vec = new Array<number>(PHASH_VEC_DIMENSION);
    for (let i = 0; i < PHASH_VEC_DIMENSION; i++) {
        vec[i] = Number((phash >> BigInt(i)) & 1n);
    }
    return vec;
}

function sign(body: string): { sig: string; ts: string } {
    const sig = "sha256=" + createHmac("sha256", SERVICE_KEY).update(body).digest("hex");
    const ts = new Date().toISOString();
    return { sig, ts };
}

async function postSigned<T>(path: string, payload: unknown): Promise<T | null> {
    if (!SIDECAR_URL || !SERVICE_KEY) return null;
    const body = JSON.stringify(payload);
    const { sig, ts } = sign(body);
    try {
        const res = await fetch(`${SIDECAR_URL.replace(/\/$/, "")}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-App-Id": APP_ID,
                "X-Plexo-Timestamp": ts,
                "X-Plexo-Signature": sig,
            },
            body,
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

export interface MirrorAssetArgs {
    workspaceId: string;
    assetId: string;
    filename: string;
    mimeType: string;
    lifecycleState: "active" | "archivable" | "archived" | "trashed";
    phash: bigint;
}

/**
 * Fire-and-forget write of the Asset node into the workspace's fonto graph.
 * Idempotent on retry via the sidecar's MERGE-by-id pattern.
 */
export async function mirrorAssetToGraph(args: MirrorAssetArgs): Promise<{ ok: boolean }> {
    const phashVec = phashToVec64(args.phash);
    const res = await postSigned<{ nodes_written: number }>("/v1/graph/write", {
        workspace_id: args.workspaceId,
        app: APP_ID,
        nodes: [
            {
                label: "Asset",
                id: args.assetId,
                properties: {
                    filename: args.filename,
                    mimeType: args.mimeType,
                    lifecycleState: args.lifecycleState,
                    phash_vec: phashVec,
                },
            },
        ],
        edges: [],
    });
    return { ok: res !== null };
}

export interface GraphPhashMatch {
    assetId: string;
    filename: string;
    /** L2 distance in vector space. ≈ sqrt(Hamming) on binary input. */
    score: number;
}

/**
 * Vector kNN against the workspace fonto graph. Returns the closest active
 * Asset whose score is below the threshold, excluding the supplied id.
 * The sidecar's /v1/graph/cypher endpoint runs arbitrary cypher under
 * HMAC + service-key gating.
 */
export async function findNearestAssetByPhashGraph(args: {
    workspaceId: string;
    phash: bigint;
    excludeAssetId?: string;
    scoreThreshold: number;
}): Promise<GraphPhashMatch | null> {
    const vec = phashToVec64(args.phash);
    const cypher = `
        CALL db.idx.vector.queryNodes('Asset.phash_vec', 10, $vec)
        YIELD node, score
        WHERE node.lifecycleState = 'active'
          AND ($excludeId = '' OR node.id <> $excludeId)
          AND score <= $threshold
        RETURN node.id AS id, node.filename AS filename, score
        ORDER BY score ASC
        LIMIT 1
    `.trim();
    const res = await postSigned<{ header: string[]; rows: unknown[][] }>(
        "/v1/graph/cypher",
        {
            workspace_id: args.workspaceId,
            cypher,
            params: {
                vec,
                excludeId: args.excludeAssetId ?? "",
                threshold: args.scoreThreshold,
            },
        }
    );
    if (!res || !res.rows.length) return null;
    const row = res.rows[0] as [string, string, number];
    return { assetId: row[0], filename: row[1], score: row[2] };
}

/** True if the prototype is configured — useful for guarding the shadow log. */
export function fontoGraphConfigured(): boolean {
    return SIDECAR_URL !== "" && SERVICE_KEY !== "";
}
