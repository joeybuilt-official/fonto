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
      ocrState: z.enum(["pending", "ready", "failed", "skipped"]).or(z.string()),
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
        "`query` is a JSON predicate; see `lib/assets/smart-collections.ts`.",
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
