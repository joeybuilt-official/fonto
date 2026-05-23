// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Central OpenAPI registry for Fonto's `/api/v1/*` surface.
//
// We use `@asteasolutions/zod-to-openapi` (Zod 4 compatible) to keep a single
// source of truth: the same Zod schemas we already use for runtime validation
// also describe the wire format in the published OpenAPI document.
//
// Pattern:
//   - extend Zod with `.openapi()` once, at module load
//   - register reusable component schemas under nice refIds (Asset, Tag, ...)
//   - register security schemes for cookie/bearer/apiKey auth
//   - per-route registration lives in ./routes.ts
//
// The generator runs at request time in `app/api/v1/openapi.json/route.ts`.
import { z } from "zod";
import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// Must be called before any `.openapi()` chains lower in this file.
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Security schemes ------------------------------------------------------

registry.registerComponent("securitySchemes", "cookieAuth", {
  type: "apiKey",
  in: "cookie",
  name: "fonto.session_token",
  description:
    "Better-Auth session cookie. Set automatically by `/api/auth/*` flows. " +
    "Used by the first-party web client.",
});

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "fonto_pat_xxx",
  description:
    "Personal access token. Send as `Authorization: Bearer fonto_pat_<token>`. " +
    "Phase 2.1 — issued via `/api/v1/apikeys` once that endpoint lands.",
});

registry.registerComponent("securitySchemes", "apiKeyAuth", {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
  description:
    "Alternative header form for the same PAT accepted by `bearerAuth`. " +
    "Some clients (curl examples, generated SDKs) prefer the explicit header.",
});

// --- Primitives -----------------------------------------------------------

export const UuidSchema = z.string().uuid().openapi({
  description: "UUIDv4",
  example: "8f3a2d1c-7e6b-4a2f-9d3e-1c5b8a7f4e2d",
});

export const IsoDateTimeSchema = z.string().datetime().openapi({
  description: "ISO-8601 timestamp with timezone offset.",
  example: "2026-05-22T18:24:00.000Z",
});

export const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .openapi({ description: "RGB hex, `#rrggbb`.", example: "#6366f1" });

// --- Error envelope -------------------------------------------------------

export const ErrorSchema = registry.register(
  "Error",
  z
    .object({
      error: z.string().openapi({ description: "Human-readable error message." }),
    })
    .openapi({
      description: "Standard error envelope. Always paired with a non-2xx status.",
    })
);

export const ValidationErrorSchema = registry.register(
  "ValidationError",
  z
    .object({
      error: z.string(),
      issues: z.array(z.object({ path: z.array(z.string()), message: z.string() })).optional(),
    })
    .openapi({ description: "Validation failure detail." })
);

// --- Workspace ------------------------------------------------------------

export const WorkspaceSchema = registry.register(
  "Workspace",
  z
    .object({
      id: UuidSchema,
      userId: z.string(),
      name: z.string(),
      slug: z.string(),
      kind: z.enum(["personal", "shared"]).or(z.string()),
      color: HexColorSchema,
      createdAt: IsoDateTimeSchema,
    })
    .openapi({ description: "A user's workspace (top-level tenant scope)." })
);

// --- Asset ----------------------------------------------------------------

export const AssetColorEntrySchema = z.object({
  hex: HexColorSchema,
  weight: z.number().min(0).max(1),
});

export const AssetSchema = registry.register(
  "Asset",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      syncState: z.enum(["synced", "syncing", "error"]).or(z.string()),
      processingState: z
        .enum(["captured", "processing", "ready", "failed"])
        .or(z.string()),
      lifecycleState: z
        .enum(["active", "archivable", "archived", "trashed"])
        .or(z.string()),
      source: z.string().nullable().optional(),
      classification: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      extractedText: z.string().nullable().optional(),
      correspondentId: UuidSchema.nullable().optional(),
      documentTypeId: UuidSchema.nullable().optional(),
      capturedAt: IsoDateTimeSchema.nullable().optional(),
      deletedAt: IsoDateTimeSchema.nullable().optional(),
      archivedAt: IsoDateTimeSchema.nullable().optional(),
      // pHash is serialized as a decimal string in API responses (bigint
      // doesn't survive JSON.stringify natively).
      phash: z.string().nullable().optional(),
      colors: z.array(AssetColorEntrySchema).nullable().optional(),
      ocrText: z.string().nullable().optional(),
      // Phase 4.4 — `empty` joined the enum: PaddleOCR ran successfully but
      // found no text (distinct from `failed` and `skipped`).
      ocrState: z.enum(["pending", "ready", "empty", "failed", "skipped"]).or(z.string()),
      ocrBoxes: z
        .array(
          z.object({
            text: z.string(),
            bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
            confidence: z.number(),
          }),
        )
        .nullable()
        .optional(),
      exif: z.record(z.string(), z.unknown()).nullable().optional(),
      latitude: z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
      cameraMake: z.string().nullable().optional(),
      cameraModel: z.string().nullable().optional(),
      lensModel: z.string().nullable().optional(),
      focalLength: z.number().nullable().optional(),
      fNumber: z.number().nullable().optional(),
      iso: z.number().int().nullable().optional(),
      exposureTime: z.string().nullable().optional(),
      orientation: z.number().int().min(1).max(8).nullable().optional(),
      widthPx: z.number().int().nullable().optional(),
      heightPx: z.number().int().nullable().optional(),
      thumbnailKey: z.string().nullable().optional(),
      previewKey: z.string().nullable().optional(),
      thumbnailGeneratedAt: IsoDateTimeSchema.nullable().optional(),
      // Phase 3.4 — favorites + 0..5 star rating.
      isFavorite: z.boolean().openapi({
        description: "Heart toggle. True if the user has favorited this asset.",
      }),
      rating: z.number().int().min(0).max(5).openapi({
        description: "0..5 star rating. 0 means unrated.",
      }),
      // Phase 3.5 — virtual folder path. NULL = "lives at workspace root".
      // Normalised: leading `/`, no trailing `/`, no `..` segments.
      directoryPath: z
        .string()
        .nullable()
        .optional()
        .openapi({
          description:
            "Virtual folder path the asset was uploaded into. Captured from " +
            "the `X-Fonto-Path` header (multipart), the `path` field on " +
            "`/assets/init`, or `metadata.path` on tus. NULL means the asset " +
            "lives at the workspace root.",
          example: "/Photos/2024/Iceland",
        }),
      // Phase 5.5 — manual stacks. NULL/absent = standalone. When set, the
      // asset belongs to a `fonto.stacks` group; the timeline default-hides
      // non-primary members.
      stackId: UuidSchema.nullable().optional().openapi({
        description:
          "ID of the `fonto.stacks` row this asset belongs to. NULL = " +
          "standalone. The timeline shows only the stack's primary asset " +
          "unless `?expandStacks=true` is passed.",
      }),
      createdAt: IsoDateTimeSchema,
      updatedAt: IsoDateTimeSchema,
    })
    .openapi({
      description:
        "An ingested file (image, document, video). The wire shape matches " +
        "`serializeAsset()` in `lib/assets/createAssetRow.ts` — derived from " +
        "the `fonto.assets` Drizzle table.",
    })
);

// --- Tag ------------------------------------------------------------------

export const TagSchema = registry.register(
  "Tag",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      name: z.string(),
      color: HexColorSchema,
      aiSuggested: z.boolean(),
      createdAt: IsoDateTimeSchema,
    })
    .openapi({ description: "User- or AI-applied label scoped to a workspace." })
);

// --- Collection -----------------------------------------------------------

export const CollectionSchema = registry.register(
  "Collection",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      userId: z.string(),
      name: z.string(),
      description: z.string(),
      projectId: UuidSchema.nullable().optional(),
      sortOrder: z.number().int(),
      createdAt: IsoDateTimeSchema,
      updatedAt: IsoDateTimeSchema,
    })
    .openapi({ description: "A manually curated set of assets." })
);

export const SmartCollectionSchema = registry.register(
  "SmartCollection",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      userId: z.string(),
      name: z.string(),
      query: z.record(z.string(), z.unknown()),
      createdAt: IsoDateTimeSchema,
    })
    .openapi({
      description:
        "A saved query that materializes a dynamic asset list at read time. " +
        "`query` is a JSON predicate; see `lib/assets/smart-collections.ts`. " +
        "Accepted top-level keys (all AND-ed with each other and with the " +
        "user's `conditions[]`): " +
        "`conditions` (array of `{ field, op, value }`), `logic` (\"and\"|\"or\", " +
        "applies only inside `conditions[]`), `favorite` (bool), `ratingMin` " +
        "(int 1..5), `subClassification` (string, e.g. \"food\"), " +
        "`classifyMethod` (\"clip\"|\"llm-fallback\"), `clipText` (string — " +
        "free-text CLIP query; embedded server-side and intersected via " +
        "nearest-neighbour against `assets.clip_vec`; silently dropped if " +
        "the vision sidecar is unconfigured), `personIds` (uuid[]; matches " +
        "assets that have a non-hidden face_instance for one of the listed " +
        "persons; no-op until Phase 5.1 ships), `hasFaces` (bool; same dep), " +
        "`dominantColor` (\"#rrggbb\"; matches assets whose top palette " +
        "entry is within ΔE76 ≤ `tolerance` of the target), `tolerance` " +
        "(number, ΔE units, defaults to 30).",
    })
);

// --- Project --------------------------------------------------------------

export const ProjectSchema = registry.register(
  "Project",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      userId: z.string(),
      name: z.string(),
      description: z.string(),
      color: HexColorSchema,
      createdAt: IsoDateTimeSchema,
      updatedAt: IsoDateTimeSchema,
    })
    .openapi({ description: "A higher-level grouping of collections." })
);

// --- Correspondent / DocumentType -----------------------------------------

export const CorrespondentSchema = registry.register(
  "Correspondent",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      name: z.string(),
      matchPattern: z.string().nullable().optional(),
      createdAt: IsoDateTimeSchema,
    })
    .openapi({
      description:
        "Document-pipeline correspondent (sender/recipient). `matchPattern` is " +
        "an optional substring used by the auto-classifier.",
    })
);

export const DocumentTypeSchema = registry.register(
  "DocumentType",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      name: z.string(),
      matchPattern: z.string().nullable().optional(),
      createdAt: IsoDateTimeSchema,
    })
    .openapi({
      description:
        "Document classification (invoice, receipt, etc.). `matchPattern` is " +
        "an optional substring used by the auto-classifier.",
    })
);

// --- ShareLink ------------------------------------------------------------

export const ShareLinkSchema = registry.register(
  "ShareLink",
  z
    .object({
      id: UuidSchema,
      assetId: UuidSchema,
      workspaceId: UuidSchema,
      token: z.string().openapi({ description: "URL-safe random token; treat as secret." }),
      createdBy: z.string(),
      expiresAt: IsoDateTimeSchema,
      createdAt: IsoDateTimeSchema,
      revokedAt: IsoDateTimeSchema.nullable().optional(),
    })
    .openapi({ description: "Public, time-bounded share token for a single asset." })
);

// --- Webhook (forward-looking; Phase 2.5) ---------------------------------

export const WebhookSchema = registry.register(
  "Webhook",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      url: z.string().url(),
      events: z.array(z.string()).openapi({
        description: "Event names this hook subscribes to, e.g. `asset.created`.",
      }),
      secret: z
        .string()
        .nullable()
        .optional()
        .openapi({ description: "HMAC-SHA256 secret; sent only on creation." }),
      active: z.boolean(),
      createdAt: IsoDateTimeSchema,
    })
    .openapi({
      description:
        "Outbound webhook subscription. Forward-looking schema — Phase 2.5 " +
        "adds the actual `/api/v1/webhooks` routes. Documenting the shape now " +
        "so generated clients can stub against it.",
    })
);

// --- ApiKey / PAT (forward-looking; Phase 2.1) ----------------------------

export const ApiKeySchema = registry.register(
  "ApiKey",
  z
    .object({
      id: z.string(),
      name: z.string(),
      prefix: z.string().openapi({
        description: "First 12 chars of the token, e.g. `fonto_pat_a1b`.",
      }),
      // Full token returned ONLY on creation; subsequent GETs omit it.
      token: z.string().optional().openapi({
        description: "Plaintext token. Returned exactly once at creation time.",
      }),
      userId: z.string(),
      scopes: z.array(z.string()).optional(),
      expiresAt: IsoDateTimeSchema.nullable().optional(),
      lastUsedAt: IsoDateTimeSchema.nullable().optional(),
      createdAt: IsoDateTimeSchema,
    })
    .openapi({
      description:
        "Personal access token (PAT). Forward-looking — Phase 2.1 wires the " +
        "Better-Auth `apiKey` plugin and adds the `/api/v1/apikeys` routes.",
    })
);

// --- Workspace invitations (Phase 3.3) ------------------------------------

export const WorkspaceInvitationSchema = registry.register(
  "WorkspaceInvitation",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      email: z.string().email().openapi({
        description: "Invited email address (lowercased on insert).",
      }),
      role: z.enum(["editor", "viewer"]).openapi({
        description:
          "Role granted on acceptance. Owners cannot be invited — promote " +
          "an existing member instead.",
      }),
      token: z.string().openapi({
        description:
          "Plaintext URL-safe token. Stored in the clear so the settings UI " +
          "can re-show the URL; the short TTL (7d default) bounds the risk.",
      }),
      url: z.string().url().openapi({
        description:
          "Fully-qualified acceptance URL — `{APP_URL}/invitations/{token}`.",
      }),
      invitedBy: z.string().openapi({
        description: "Better Auth user.id of the inviter.",
      }),
      expiresAt: IsoDateTimeSchema,
      createdAt: IsoDateTimeSchema,
    })
    .openapi({
      description:
        "Pending workspace invitation. See ADR 0004 for the multi-user model.",
    })
);

// Public response for `GET /api/v1/workspace/invitations/:token` (no
// auth required). Deliberately narrow: just enough to render the accept
// page without leaking workspace/inviter identifiers.
export const PublicInvitationViewSchema = registry.register(
  "PublicInvitationView",
  z
    .object({
      workspace: z.object({ name: z.string() }),
      inviterEmail: z.string().email().nullable(),
      inviterName: z.string().nullable(),
      role: z.enum(["editor", "viewer"]),
      email: z.string().email(),
      state: z.enum(["pending", "accepted", "revoked", "expired"]),
      expired: z.boolean(),
      used: z.boolean(),
      revoked: z.boolean(),
      expiresAt: IsoDateTimeSchema,
    })
    .openapi({
      description:
        "Public view of an invitation, surfaced to the acceptance page " +
        "before the recipient signs in.",
    })
);

// --- Convenience: response shapes that wrap a single component ------------

export const AssetEnvelopeSchema = z.object({ asset: AssetSchema });
export const AssetsEnvelopeSchema = z.object({ assets: z.array(AssetSchema) });
export const TagsEnvelopeSchema = z.object({ tags: z.array(TagSchema) });
export const TagEnvelopeSchema = z.object({ tag: TagSchema });
export const CollectionEnvelopeSchema = z.object({ collection: CollectionSchema });
export const CollectionsEnvelopeSchema = z.object({ collections: z.array(CollectionSchema) });
export const SmartCollectionsEnvelopeSchema = z.object({
  smartCollections: z.array(SmartCollectionSchema),
});
export const SmartCollectionEnvelopeSchema = z.object({
  smartCollection: SmartCollectionSchema,
});
export const ProjectsEnvelopeSchema = z.object({ projects: z.array(ProjectSchema) });
export const ProjectEnvelopeSchema = z.object({ project: ProjectSchema });
export const CorrespondentsEnvelopeSchema = z.object({
  correspondents: z.array(CorrespondentSchema),
});
export const DocumentTypesEnvelopeSchema = z.object({
  documentTypes: z.array(DocumentTypeSchema),
});
export const ShareLinkEnvelopeSchema = z.object({ shareLink: ShareLinkSchema });
export const ShareLinksEnvelopeSchema = z.object({
  shareLinks: z.array(ShareLinkSchema),
});
export const WorkspacesEnvelopeSchema = z.object({
  workspaces: z.array(WorkspaceSchema),
});
// Phase 3.1 — workspace memberships.
export const WorkspaceRoleSchema = z.enum(["owner", "editor", "viewer"]).openapi({
  description: "Caller's role on the workspace. owner > editor > viewer.",
});

export const WorkspaceMemberSchema = registry.register(
  "WorkspaceMember",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      userId: z.string().openapi({
        description: "Better Auth user.id (text). Cross-schema FK to auth.user.",
      }),
      role: WorkspaceRoleSchema,
      createdAt: IsoDateTimeSchema,
      createdBy: z
        .string()
        .nullable()
        .openapi({
          description:
            "Inviter's user id, or NULL for backfilled owners and auto-provisioned memberships.",
        }),
    })
    .openapi({ description: "A user's role on a workspace (ADR 0004)." })
);

export const WorkspaceMembersEnvelopeSchema = z.object({
  members: z.array(WorkspaceMemberSchema),
});

// Phase 3.3 — workspace invitations.
export const WorkspaceInvitationEnvelopeSchema = z.object({
  invitations: z.array(WorkspaceInvitationSchema),
});

// Phase 4.2 — CLIP text-to-image search result envelope.
export const ClipSearchResultSchema = registry.register(
  "ClipSearchResult",
  z
    .object({
      asset: AssetSchema,
      similarity: z.number().openapi({
        description:
          "Cosine similarity ∈ [-1, 1] between the query text embedding " +
          "and the asset's image embedding. Higher = better match. CLIP " +
          "results typically fall in [0, 0.4] for related images.",
        example: 0.27,
      }),
    })
    .openapi({
      description:
        "A single hit from `/api/v1/search/clip`. The `asset` shape matches " +
        "the `Asset` component; `similarity` is the cosine score the hit was " +
        "ranked on.",
    })
);

export const ClipSearchEnvelopeSchema = z
  .object({
    results: z.array(ClipSearchResultSchema),
    unavailable: z.boolean().optional().openapi({
      description:
        "True when the vision service is unreachable or not configured. " +
        "The route degrades gracefully (200 with empty `results`) rather than " +
        "returning 5xx in that case.",
    }),
    reason: z.string().optional().openapi({
      description: "Human-readable explanation present whenever `unavailable` is true.",
    }),
  })
  .openapi({ description: "Response envelope for the CLIP text-to-image search route." });

// Phase 5.5 — manual stacks.
export const StackSchema = registry.register(
  "Stack",
  z
    .object({
      id: UuidSchema,
      workspaceId: UuidSchema,
      primaryAssetId: UuidSchema.openapi({
        description:
          "ID of the asset that represents this stack in the timeline. " +
          "Always one of the stack's members; updated automatically when " +
          "the primary is removed from the stack.",
      }),
      name: z.string().nullable().optional().openapi({
        description: "Optional display name. NULL = unnamed.",
      }),
      createdAt: IsoDateTimeSchema,
      updatedAt: IsoDateTimeSchema,
    })
    .openapi({
      description:
        "A group of related assets where one is 'primary' (RAW+JPEG, " +
        "burst, multiple edits). Members carry `stack_id` on their asset " +
        "row pointing here; the timeline default-hides non-primary members.",
    })
);

export const StackEnvelopeSchema = z.object({
  stack: StackSchema,
  assets: z.array(AssetSchema).openapi({
    description: "Members, sorted primary-first then capturedAt ascending.",
  }),
});

export const StackSuggestionSchema = registry.register(
  "StackSuggestion",
  z
    .object({
      assetIds: z.array(UuidSchema).openapi({
        description:
          "Assets the heuristic clusters together. The first id is the " +
          "suggested primary when no override is passed to `/accept`.",
      }),
      reason: z.enum(["raw+jpeg", "burst"]).openapi({
        description:
          "Which heuristic produced this suggestion. `raw+jpeg` = two " +
          "members within `STACK_RAW_JPEG_THRESHOLD_S` from the same " +
          "camera, one image/jpeg + one canonical RAW. `burst` = 3+ " +
          "members within `STACK_BURST_THRESHOLD_S` from the same camera.",
      }),
    })
    .openapi({
      description:
        "A candidate stack flagged by the auto-suggester (read-only). " +
        "The user confirms via `POST /api/v1/stacks/suggestions/accept`.",
    })
);

export const StackSuggestionsEnvelopeSchema = z.object({
  suggestions: z.array(StackSuggestionSchema),
  total: z.number().int().nonnegative().openapi({
    description: "Total suggestions found (vs. capped response length).",
  }),
});

// Phase 3.5 — folder listing.
export const FolderListingSchema = registry.register(
  "FolderListing",
  z
    .object({
      prefix: z.string().openapi({
        description:
          "The directory prefix this listing is for. Empty string = workspace root.",
        example: "/Photos",
      }),
      folders: z.array(
        z.object({
          name: z.string().openapi({
            description: "Display name (last segment of `path`).",
          }),
          path: z.string().openapi({
            description: "Full normalised path; pass as `?prefix=` to descend.",
            example: "/Photos/2024",
          }),
          assetCount: z.number().int().nonnegative().openapi({
            description:
              "Count of all active assets under this sub-folder (recursive).",
          }),
        })
      ),
      assetsAtThisLevel: z.number().int().nonnegative().openapi({
        description:
          "Count of assets whose `directory_path` equals `prefix` exactly " +
          "(i.e. sit at this level, not in a sub-folder).",
      }),
    })
    .openapi({
      description:
        "Listing of the immediate sub-folders + asset count at the given " +
        "prefix. Folders are virtual — see ADR/parity-plan Phase 3.5.",
    })
);

// --- Phase 5.3 — Memories ("On this day") ---------------------------------
//
// `MemoryYear` is one bucket of the `/api/v1/memories` response: every asset
// captured on the same MM-DD (±MEMORIES_DAY_WINDOW) within a single prior
// calendar year, plus a total count (which may exceed `assets.length` when
// the per-year cap clips the bucket).
export const MemoryYearSchema = registry.register(
  "MemoryYear",
  z
    .object({
      year: z.number().int().openapi({
        description: "Calendar year the bucket belongs to (e.g. 2021).",
      }),
      count: z
        .number()
        .int()
        .nonnegative()
        .openapi({
          description:
            "Total assets matched within the day window for this year " +
            "(may exceed assets.length when MEMORIES_MAX_PER_YEAR clips the list).",
        }),
      assets: z.array(AssetSchema).openapi({
        description:
          "Assets captured in this year on the requested MM-DD ± window, " +
          "newest first. Capped at MEMORIES_MAX_PER_YEAR (default 50).",
      }),
    })
    .openapi({
      description:
        "One year's bucket in the Memories (\"On this day\") response.",
    })
);

export const MemoriesEnvelopeSchema = z.object({
  years: z.array(MemoryYearSchema),
});
