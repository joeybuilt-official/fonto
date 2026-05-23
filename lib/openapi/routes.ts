// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Per-route OpenAPI registrations for `/api/v1/*`. One block per route.
//
// We register routes centrally (rather than decorating each handler) because
// the Next.js App Router has no clean decorator hook and we want everything
// one `grep` away. Adding a new route means: write the handler in
// `app/api/v1/...`, then add a `registry.registerPath(...)` call below.
//
// Keep this file boring. Reach for ./registry.ts for shared schemas.
//
// The bare `import "./registry"` ensures `extendZodWithOpenApi(z)` runs and
// the `declare module 'zod'` augmentation in `@asteasolutions/zod-to-openapi`
// is in scope before we call `.openapi(...)` below. Without it, TS doesn't
// see the augmented methods even though they exist at runtime.
import "./registry";
import { z } from "zod";
import {
  registry,
  AssetSchema,
  AssetEnvelopeSchema,
  AssetsEnvelopeSchema,
  TagEnvelopeSchema,
  TagsEnvelopeSchema,
  CollectionEnvelopeSchema,
  CollectionsEnvelopeSchema,
  SmartCollectionEnvelopeSchema,
  SmartCollectionsEnvelopeSchema,
  ProjectEnvelopeSchema,
  ProjectsEnvelopeSchema,
  CorrespondentsEnvelopeSchema,
  DocumentTypesEnvelopeSchema,
  ShareLinkEnvelopeSchema,
  ShareLinksEnvelopeSchema,
  WorkspacesEnvelopeSchema,
  ErrorSchema,
  UuidSchema,
  HexColorSchema,
} from "./registry";

// Default security for endpoints requiring auth (any of the three works).
// Each object is an "OR" of credentials; OpenAPI uses an array of objects to
// mean "any of these schemes is sufficient". `string[]` is the scopes list
// (empty for non-OAuth schemes).
const AUTH_SECURITY: Array<Record<string, string[]>> = [
  { cookieAuth: [] },
  { bearerAuth: [] },
  { apiKeyAuth: [] },
];
const CRON_SECURITY: Array<Record<string, string[]>> = [
  { bearerAuth: [] },
  { apiKeyAuth: [] },
];

const json = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const errorResponse = (description: string) => json(ErrorSchema, description);

const PathIdParam = z.object({ id: UuidSchema });

// ---------------------------------------------------------------------------
// /api/v1/workspace
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/workspace",
  summary: "List workspaces accessible to the authenticated user",
  tags: ["Workspaces"],
  security: AUTH_SECURITY,
  responses: {
    200: json(WorkspacesEnvelopeSchema, "Workspaces the caller can access."),
    401: errorResponse("Not authenticated."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/assets
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/assets",
  summary: "List assets in the user's primary workspace",
  tags: ["Assets"],
  security: AUTH_SECURITY,
  request: {
    query: z.object({
      mime: z
        .string()
        .optional()
        .openapi({ description: "Prefix filter on MIME type, e.g. `image`." }),
      subtype: z
        .string()
        .optional()
        .openapi({ description: "Filter on the `classification` column." }),
      lifecycle: z
        .enum(["active", "archivable", "archived", "trashed"])
        .optional()
        .openapi({ description: "Lifecycle bucket (default `active`)." }),
    }),
  },
  responses: {
    200: json(AssetsEnvelopeSchema, "Assets, newest first."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/assets",
  summary: "Upload an asset via multipart form (deprecated; use /assets/init)",
  description:
    "Legacy multipart upload (max 50 MB). New clients should use the two-step " +
    "direct-to-R2 flow at `/api/v1/assets/init` + `/api/v1/assets/{id}/complete`.",
  deprecated: true,
  tags: ["Assets", "Uploads"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.string().openapi({ type: "string", format: "binary" }),
            source: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: json(AssetEnvelopeSchema, "Existing asset (idempotent upload)."),
    201: json(AssetEnvelopeSchema, "Newly created asset."),
    400: errorResponse("No file or no workspace."),
    401: errorResponse("Not authenticated."),
    413: errorResponse("File exceeds the 50 MB legacy limit."),
    500: errorResponse("R2 upload failed."),
  },
});

// /api/v1/assets/init -------------------------------------------------------
registry.registerPath({
  method: "post",
  path: "/api/v1/assets/init",
  summary: "Reserve a direct-to-R2 presigned upload",
  tags: ["Assets", "Uploads"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            filename: z.string(),
            mimeType: z.string().optional(),
            sizeBytes: z.number().int().positive(),
            clientChecksum: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: json(
      z.object({
        uploadId: UuidSchema,
        url: z.string().url(),
        storageKey: z.string(),
        expiresAt: z.string().datetime(),
      }),
      "Presigned URL and upload tracking id."
    ),
    400: errorResponse("Bad request."),
    401: errorResponse("Not authenticated."),
  },
});

// /api/v1/assets/{id} ------------------------------------------------------
registry.registerPath({
  method: "patch",
  path: "/api/v1/assets/{id}",
  summary: "Update mutable fields on an asset",
  tags: ["Assets"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              description: z.string().nullable().optional(),
              classification: z.string().nullable().optional(),
              correspondentId: UuidSchema.nullable().optional(),
              documentTypeId: UuidSchema.nullable().optional(),
              lifecycleState: z
                .enum(["active", "archivable", "archived", "trashed"])
                .optional(),
            })
            .openapi({ description: "Partial update payload." }),
        },
      },
    },
  },
  responses: {
    200: json(AssetEnvelopeSchema, "Updated asset."),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Forbidden."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/assets/{id}",
  summary: "Trash (soft-delete) an asset",
  tags: ["Assets"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Trashed."),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Forbidden."),
    404: errorResponse("Not found."),
  },
});

// /api/v1/assets/{id}/complete ---------------------------------------------
registry.registerPath({
  method: "post",
  path: "/api/v1/assets/{id}/complete",
  summary: "Finalize a direct-to-R2 upload into an asset row",
  description:
    "Called after the client PUTs the file to the presigned URL returned by " +
    "`/api/v1/assets/init`. `{id}` is the `uploadId` from that call.",
  tags: ["Assets", "Uploads"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(AssetEnvelopeSchema, "Existing (idempotent) asset."),
    201: json(AssetEnvelopeSchema, "Newly created asset."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Upload not found."),
    409: errorResponse("R2 object missing or checksum mismatch."),
  },
});

// /api/v1/assets/{id}/reprocess --------------------------------------------
registry.registerPath({
  method: "post",
  path: "/api/v1/assets/{id}/reprocess",
  summary: "Re-enqueue an asset through the processing pipeline",
  tags: ["Assets"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    202: json(z.object({ enqueued: z.literal(true) }), "Job enqueued."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

// /api/v1/assets/{id}/similar ----------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/assets/{id}/similar",
  summary: "Find perceptually similar assets",
  tags: ["Assets", "Search"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    query: z.object({
      threshold: z
        .coerce.number()
        .min(0)
        .max(64)
        .optional()
        .openapi({ description: "Max Hamming distance on the 64-bit pHash." }),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: json(
      z.object({
        assets: z.array(
          AssetSchema.extend({ distance: z.number().int().min(0).max(64) })
        ),
      }),
      "Candidates ordered by ascending Hamming distance."
    ),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Source asset not found."),
  },
});

// /api/v1/assets/{id}/share ------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/assets/{id}/share",
  summary: "List share links for an asset",
  tags: ["Assets", "Sharing"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(ShareLinksEnvelopeSchema, "Active share links."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Asset not found."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/assets/{id}/share",
  summary: "Create a time-bounded share link",
  tags: ["Assets", "Sharing"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            expiresAt: z.string().datetime().optional(),
            ttlSeconds: z.number().int().positive().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: json(ShareLinkEnvelopeSchema, "Created."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Asset not found."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/assets/{id}/share",
  summary: "Revoke all share links for an asset",
  tags: ["Assets", "Sharing"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Revoked."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Asset not found."),
  },
});

// /api/v1/assets/{id}/tags -------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/assets/{id}/tags",
  summary: "List tags applied to an asset",
  tags: ["Assets", "Tags"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(TagsEnvelopeSchema, "Tags."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Asset not found."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/assets/{id}/tags",
  summary: "Apply a tag to an asset",
  tags: ["Assets", "Tags"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ tagId: UuidSchema }),
        },
      },
    },
  },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Applied."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Asset or tag not found."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/assets/{id}/tags",
  summary: "Remove a tag from an asset",
  tags: ["Assets", "Tags"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    query: z.object({ tagId: UuidSchema }),
  },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Removed."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Asset or tag not found."),
  },
});

// /api/v1/assets/{id}/url --------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/assets/{id}/url",
  summary: "Get a short-lived signed URL for an asset's binary",
  tags: ["Assets"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    query: z.object({
      variant: z.enum(["original", "thumbnail", "preview"]).optional(),
    }),
  },
  responses: {
    200: json(
      z.object({
        url: z.string().url(),
        expiresAt: z.string().datetime(),
      }),
      "Presigned GET URL."
    ),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Asset or variant not found."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/tags
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/tags",
  summary: "List tags in the user's workspaces",
  tags: ["Tags"],
  security: AUTH_SECURITY,
  responses: {
    200: json(TagsEnvelopeSchema, "Tags."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/tags",
  summary: "Create a tag",
  tags: ["Tags"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            color: HexColorSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: json(TagEnvelopeSchema, "Created."),
    400: errorResponse("Missing name."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("No workspace."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/collections
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/collections",
  summary: "List collections",
  tags: ["Collections"],
  security: AUTH_SECURITY,
  responses: {
    200: json(CollectionsEnvelopeSchema, "Collections."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/collections",
  summary: "Create a collection",
  tags: ["Collections"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            projectId: UuidSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: json(CollectionEnvelopeSchema, "Created."),
    400: errorResponse("Bad request."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/collections/{id}",
  summary: "Get a collection",
  tags: ["Collections"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(CollectionEnvelopeSchema, "Collection."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/collections/{id}/assets",
  summary: "List assets in a collection",
  tags: ["Collections", "Assets"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(AssetsEnvelopeSchema, "Assets."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/collections/{id}/assets",
  summary: "Add an asset to a collection",
  tags: ["Collections", "Assets"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ assetId: UuidSchema }),
        },
      },
    },
  },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Added."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/collections/{id}/assets",
  summary: "Remove an asset from a collection",
  tags: ["Collections", "Assets"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    query: z.object({ assetId: UuidSchema }),
  },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Removed."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/smart-collections
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/smart-collections",
  summary: "List smart collections",
  tags: ["SmartCollections"],
  security: AUTH_SECURITY,
  responses: {
    200: json(SmartCollectionsEnvelopeSchema, "Smart collections."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/smart-collections",
  summary: "Create a smart collection",
  tags: ["SmartCollections"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            query: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
  },
  responses: {
    201: json(SmartCollectionEnvelopeSchema, "Created."),
    400: errorResponse("Bad request."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/smart-collections/{id}",
  summary: "Get a smart collection",
  tags: ["SmartCollections"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(SmartCollectionEnvelopeSchema, "Smart collection."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/smart-collections/{id}",
  summary: "Update a smart collection",
  tags: ["SmartCollections"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).optional(),
            query: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: json(SmartCollectionEnvelopeSchema, "Updated."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/smart-collections/{id}",
  summary: "Delete a smart collection",
  tags: ["SmartCollections"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Deleted."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/smart-collections/{id}/assets",
  summary: "Resolve a smart collection's query into assets",
  tags: ["SmartCollections", "Assets"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(AssetsEnvelopeSchema, "Assets."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/projects
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/projects",
  summary: "List projects",
  tags: ["Projects"],
  security: AUTH_SECURITY,
  responses: {
    200: json(ProjectsEnvelopeSchema, "Projects."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/projects",
  summary: "Create a project",
  tags: ["Projects"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            color: HexColorSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: json(ProjectEnvelopeSchema, "Created."),
    400: errorResponse("Bad request."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/projects/{id}",
  summary: "Get a project",
  tags: ["Projects"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(ProjectEnvelopeSchema, "Project."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/projects/{id}",
  summary: "Update a project",
  tags: ["Projects"],
  security: AUTH_SECURITY,
  request: {
    params: PathIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).optional(),
            description: z.string().optional(),
            color: HexColorSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: json(ProjectEnvelopeSchema, "Updated."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/projects/{id}",
  summary: "Delete a project",
  tags: ["Projects"],
  security: AUTH_SECURITY,
  request: { params: PathIdParam },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Deleted."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/correspondents
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/correspondents",
  summary: "List correspondents",
  tags: ["Correspondents"],
  security: AUTH_SECURITY,
  responses: {
    200: json(CorrespondentsEnvelopeSchema, "Correspondents."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/correspondents",
  summary: "Create a correspondent",
  tags: ["Correspondents"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            matchPattern: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: json(
      z.object({ correspondent: CorrespondentsEnvelopeSchema.shape.correspondents.element }),
      "Created."
    ),
    400: errorResponse("Bad request."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/correspondents",
  summary: "Delete a correspondent",
  tags: ["Correspondents"],
  security: AUTH_SECURITY,
  request: { query: z.object({ id: UuidSchema }) },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Deleted."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/document-types
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/document-types",
  summary: "List document types",
  tags: ["DocumentTypes"],
  security: AUTH_SECURITY,
  responses: {
    200: json(DocumentTypesEnvelopeSchema, "Document types."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/document-types",
  summary: "Create a document type",
  tags: ["DocumentTypes"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            matchPattern: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: json(
      z.object({ documentType: DocumentTypesEnvelopeSchema.shape.documentTypes.element }),
      "Created."
    ),
    400: errorResponse("Bad request."),
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/document-types",
  summary: "Delete a document type",
  tags: ["DocumentTypes"],
  security: AUTH_SECURITY,
  request: { query: z.object({ id: UuidSchema }) },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Deleted."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/search
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/search",
  summary: "Full-text + structured search across assets",
  tags: ["Search"],
  security: AUTH_SECURITY,
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: "Free-text query." }),
      mime: z.string().optional(),
      tag: z.string().optional(),
      correspondent: UuidSchema.optional(),
      documentType: UuidSchema.optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: json(AssetsEnvelopeSchema, "Matching assets."),
    401: errorResponse("Not authenticated."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/uploads/tus/{path}  (resumable uploads — Phase 1.4)
// ---------------------------------------------------------------------------
// The tus protocol uses non-standard HTTP semantics (Tus-Resumable header,
// PATCH bodies as raw bytes, etc.). We expose it in the spec as opaque
// endpoints so consumers know it exists; clients should use a tus library.
const tusHeaders = z.object({
  "Tus-Resumable": z.literal("1.0.0").openapi({ description: "tus protocol version." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/uploads/tus",
  summary: "Create a resumable upload (tus protocol)",
  description: "See https://tus.io/protocols/resumable-upload — use a tus client.",
  tags: ["Uploads", "Tus"],
  security: AUTH_SECURITY,
  request: { headers: tusHeaders },
  responses: {
    201: { description: "Created. `Location` header carries the upload URL." },
    401: errorResponse("Not authenticated."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/uploads/tus/{uploadId}",
  summary: "Append bytes to a resumable upload (tus protocol)",
  tags: ["Uploads", "Tus"],
  security: AUTH_SECURITY,
  request: {
    params: z.object({ uploadId: z.string() }),
    headers: tusHeaders,
  },
  responses: {
    204: { description: "Bytes accepted." },
    401: errorResponse("Not authenticated."),
    404: errorResponse("Upload not found."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/uploads/tus/{uploadId}",
  summary: "Get resumable-upload status (tus protocol — HEAD-equivalent)",
  tags: ["Uploads", "Tus"],
  security: AUTH_SECURITY,
  request: {
    params: z.object({ uploadId: z.string() }),
    headers: tusHeaders,
  },
  responses: {
    200: { description: "Upload status; see `Upload-Offset` / `Upload-Length` headers." },
    401: errorResponse("Not authenticated."),
    404: errorResponse("Upload not found."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/uploads/tus/{uploadId}",
  summary: "Abort a resumable upload (tus protocol)",
  tags: ["Uploads", "Tus"],
  security: AUTH_SECURITY,
  request: {
    params: z.object({ uploadId: z.string() }),
    headers: tusHeaders,
  },
  responses: {
    204: { description: "Aborted." },
    401: errorResponse("Not authenticated."),
    404: errorResponse("Upload not found."),
  },
});

// ---------------------------------------------------------------------------
// Cron endpoints (admin-only; called by Kubernetes/cron scheduler)
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "post",
  path: "/api/v1/cron/purge-trashed",
  summary: "Purge assets that have been in `trashed` past their retention window",
  tags: ["Cron"],
  security: CRON_SECURITY,
  responses: {
    200: json(z.object({ purged: z.number().int() }), "Count of purged assets."),
    401: errorResponse("Not authenticated or wrong cron secret."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/cron/ocr-backfill",
  summary: "Run an OCR pass on assets stuck in `ocrState=pending`",
  tags: ["Cron"],
  security: CRON_SECURITY,
  responses: {
    200: json(z.object({ enqueued: z.number().int() }), "Count of jobs enqueued."),
    401: errorResponse("Not authenticated or wrong cron secret."),
  },
});

// ---------------------------------------------------------------------------
// Coverage gate
// ---------------------------------------------------------------------------
// Routes registered above. The integration script (scripts/check-openapi-coverage.ts)
// diffs this against `find app/api -name route.ts`.
//
// Keys are "METHOD PATH" — uppercase method, literal OpenAPI path including
// `{param}` placeholders.
export const REGISTERED_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/v1/workspace",
  "GET /api/v1/assets",
  "POST /api/v1/assets",
  "POST /api/v1/assets/init",
  "PATCH /api/v1/assets/{id}",
  "DELETE /api/v1/assets/{id}",
  "POST /api/v1/assets/{id}/complete",
  "POST /api/v1/assets/{id}/reprocess",
  "GET /api/v1/assets/{id}/similar",
  "GET /api/v1/assets/{id}/share",
  "POST /api/v1/assets/{id}/share",
  "DELETE /api/v1/assets/{id}/share",
  "GET /api/v1/assets/{id}/tags",
  "POST /api/v1/assets/{id}/tags",
  "DELETE /api/v1/assets/{id}/tags",
  "GET /api/v1/assets/{id}/url",
  "GET /api/v1/tags",
  "POST /api/v1/tags",
  "GET /api/v1/collections",
  "POST /api/v1/collections",
  "GET /api/v1/collections/{id}",
  "GET /api/v1/collections/{id}/assets",
  "POST /api/v1/collections/{id}/assets",
  "DELETE /api/v1/collections/{id}/assets",
  "GET /api/v1/smart-collections",
  "POST /api/v1/smart-collections",
  "GET /api/v1/smart-collections/{id}",
  "PATCH /api/v1/smart-collections/{id}",
  "DELETE /api/v1/smart-collections/{id}",
  "GET /api/v1/smart-collections/{id}/assets",
  "GET /api/v1/projects",
  "POST /api/v1/projects",
  "GET /api/v1/projects/{id}",
  "PATCH /api/v1/projects/{id}",
  "DELETE /api/v1/projects/{id}",
  "GET /api/v1/correspondents",
  "POST /api/v1/correspondents",
  "DELETE /api/v1/correspondents",
  "GET /api/v1/document-types",
  "POST /api/v1/document-types",
  "DELETE /api/v1/document-types",
  "GET /api/v1/search",
  "POST /api/v1/uploads/tus",
  "PATCH /api/v1/uploads/tus/{uploadId}",
  "GET /api/v1/uploads/tus/{uploadId}",
  "DELETE /api/v1/uploads/tus/{uploadId}",
  "POST /api/v1/cron/purge-trashed",
  "POST /api/v1/cron/ocr-backfill",
]);
