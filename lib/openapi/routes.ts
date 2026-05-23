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
  WorkspaceMembersEnvelopeSchema,
  WorkspaceInvitationSchema,
  WorkspaceInvitationEnvelopeSchema,
  PublicInvitationViewSchema,
  FolderListingSchema,
  ClipSearchEnvelopeSchema,
  MemoriesEnvelopeSchema,
  MapAssetsEnvelopeSchema,
  StackSchema,
  StackEnvelopeSchema,
  StackSuggestionsEnvelopeSchema,
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
// /api/v1/workspace/members
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/workspace/members",
  summary: "List members + roles of the caller's primary workspace",
  description:
    "Phase 3.1 — returns the workspace_memberships rows for the caller's " +
    "primary workspace. Viewer or higher is sufficient. The Phase 3.3 " +
    "invitation flow adds POST/DELETE handlers on the parallel /invitations path.",
  tags: ["Workspaces"],
  security: AUTH_SECURITY,
  responses: {
    200: json(WorkspaceMembersEnvelopeSchema, "Members of the workspace."),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Caller is not a member of any workspace."),
    404: errorResponse("Workspace not found or caller has no membership."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/workspace/invitations (Phase 3.3)
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/workspace/invitations",
  summary: "List pending invitations for the caller's primary workspace",
  tags: ["Workspaces", "Invitations"],
  security: AUTH_SECURITY,
  responses: {
    200: json(
      WorkspaceInvitationEnvelopeSchema,
      "Pending invitations (not yet accepted, revoked, or expired)."
    ),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Caller is not the workspace owner."),
    404: errorResponse("Workspace not found."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/workspace/invitations",
  summary: "Invite a user to the workspace by email",
  description:
    "Generates a plaintext URL-safe token, persists the invitation with a " +
    "7-day default TTL (`WORKSPACE_INVITATION_TTL_DAYS`), and returns the " +
    "`{ id, token, url }`. Email delivery is intentionally stubbed in Phase " +
    "3.3 — the inviter is expected to share the URL until Phase 7.3 lands " +
    "an email transport.",
  tags: ["Workspaces", "Invitations"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email(),
            role: z.enum(["editor", "viewer"]),
          }),
        },
      },
    },
  },
  responses: {
    200: json(WorkspaceInvitationSchema, "Invitation created."),
    400: errorResponse("Invalid body."),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Caller cannot invite to this workspace."),
    404: errorResponse("No workspace for caller."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/workspace/invitations/{token}",
  summary: "Public lookup of an invitation by token",
  description:
    "Returns minimal metadata for the acceptance page to render before the " +
    "recipient signs in. Does not require authentication. Includes the " +
    "invitation `state` so the page can render expired/revoked/used states.",
  tags: ["Workspaces", "Invitations"],
  request: {
    params: z.object({ token: z.string() }),
  },
  responses: {
    200: json(PublicInvitationViewSchema, "Invitation found."),
    404: errorResponse("Invitation not found."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/workspace/invitations/{token}",
  summary: "Revoke an invitation",
  description:
    "Revokes a pending invitation. The path parameter accepts either the " +
    "invitation id (UUID) or the public token; the handler disambiguates " +
    "at runtime. Already-accepted or already-revoked invitations return 409.",
  tags: ["Workspaces", "Invitations"],
  security: AUTH_SECURITY,
  request: {
    params: z.object({ token: z.string() }),
  },
  responses: {
    200: json(
      z.object({ ok: z.literal(true), id: UuidSchema }),
      "Invitation revoked."
    ),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Caller is not the workspace owner."),
    404: errorResponse("Invitation not found."),
    409: errorResponse("Invitation already accepted or revoked."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/workspace/invitations/{token}/accept",
  summary: "Accept an invitation",
  description:
    "Claims an invitation and adds the caller as a member of the target " +
    "workspace. The caller's email must match the invited address. If the " +
    "caller is unauthenticated the response is `401 { signupRequired: true }`; " +
    "clients are expected to redirect to the signup flow with the token " +
    "preserved so the same call can be re-issued post-signup.",
  tags: ["Workspaces", "Invitations"],
  security: AUTH_SECURITY,
  request: {
    params: z.object({ token: z.string() }),
  },
  responses: {
    200: json(
      z.object({
        ok: z.literal(true),
        workspaceId: UuidSchema,
        role: z.enum(["editor", "viewer"]),
        acceptedAt: z.string().datetime().nullable(),
      }),
      "Invitation accepted; membership created."
    ),
    401: errorResponse("Not authenticated (signup required)."),
    403: errorResponse(
      "Caller's email does not match the invited address."
    ),
    404: errorResponse("Invitation not found."),
    409: errorResponse("Concurrent state change."),
    410: errorResponse("Invitation expired, revoked, or already accepted."),
    500: errorResponse(
      "Membership table not available (Phase 3.1 migration pending)."
    ),
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
      // Phase 5.5 — stack expansion override.
      expandStacks: z
        .enum(["true", "1"])
        .optional()
        .openapi({
          description:
            "Phase 5.5 — opt-in to 'show every stacked asset' mode. " +
            "Default is primary-only: members of a stack are hidden " +
            "unless they ARE the stack's primary.",
        }),
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
            path: z
              .string()
              .optional()
              .openapi({
                description:
                  "Phase 3.5 — optional virtual folder path. Normalised " +
                  "server-side; invalid input becomes NULL (root).",
                example: "/Photos/2024/Iceland",
              }),
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
              // Phase 3.4 — favorites + 0..5 star ratings.
              isFavorite: z.boolean().optional().openapi({
                description: "Toggle the heart/favorite flag.",
              }),
              rating: z
                .number()
                .int()
                .min(0)
                .max(5)
                .optional()
                .openapi({ description: "Set the star rating. 0 clears." }),
              // Phase 0 — soft-delete / restore shortcuts used by the UI.
              trash: z.boolean().optional(),
              restore: z.boolean().optional(),
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
// /api/v1/folders (Phase 3.5 — virtual folder view)
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/folders",
  summary: "List immediate sub-folders + asset count under a directory prefix",
  description:
    "Folders are virtual: computed at read time by GROUP BY-ing the " +
    "`directory_path` column on `assets`. Pass `prefix` to descend; empty " +
    "prefix lists top-level folders.",
  tags: ["Folders"],
  security: AUTH_SECURITY,
  request: {
    query: z.object({
      prefix: z
        .string()
        .optional()
        .openapi({
          description:
            "Directory prefix in canonical form (leading `/`, no trailing " +
            "`/`). Empty/omitted = workspace root.",
          example: "/Photos/2024",
        }),
      workspaceId: UuidSchema.optional().openapi({
        description:
          "Workspace to scope the listing to. Defaults to the caller's first workspace.",
      }),
    }),
  },
  responses: {
    200: json(FolderListingSchema, "Folder listing."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Workspace not accessible."),
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
// /api/v1/search/clip (Phase 4.2 — CLIP text-to-image search)
// ---------------------------------------------------------------------------
const ClipSearchQuery = z.object({
  q: z.string().openapi({
    description: "Free-text query, e.g. 'dog on beach' or 'sunset over mountains'.",
    example: "dog on beach",
  }),
  limit: z
    .string()
    .optional()
    .openapi({
      description: "Max results (1..200). Default 50.",
      example: "50",
    }),
  workspaceId: UuidSchema.optional().openapi({
    description:
      "Optional explicit workspace id. If omitted, the caller's first " +
      "accessible workspace is used (matching `/api/v1/search` defaults).",
  }),
});

registry.registerPath({
  method: "get",
  path: "/api/v1/search/clip",
  summary: "Semantic image search via CLIP text-to-image embeddings",
  description:
    "Phase 4.2 — embeds the query text via the Plexo vision service and " +
    "runs a pgvector nearest-neighbour scan against `assets.clip_vec`. " +
    "Results are sorted by cosine similarity descending. When the vision " +
    "service is not configured or unreachable the route degrades to " +
    "`{ results: [], unavailable: true }` instead of returning 5xx.",
  tags: ["Search"],
  security: AUTH_SECURITY,
  request: { query: ClipSearchQuery },
  responses: {
    200: json(ClipSearchEnvelopeSchema, "Matching assets ranked by similarity."),
    400: errorResponse("Missing or invalid query."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Workspace not accessible to caller."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/search/clip",
  summary: "Semantic image search via CLIP (JSON body form)",
  description:
    "Alternate JSON-body form of the CLIP search route. Identical behaviour " +
    "and response shape; useful for clients that prefer not to URL-encode " +
    "long natural-language queries.",
  tags: ["Search"],
  security: AUTH_SECURITY,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            q: z.string(),
            limit: z.number().int().positive().optional(),
            workspaceId: UuidSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: json(ClipSearchEnvelopeSchema, "Matching assets ranked by similarity."),
    400: errorResponse("Missing or invalid body."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Workspace not accessible to caller."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/memories — Phase 5.3 "On this day"
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/memories",
  summary: "Assets captured on the same calendar day in prior years",
  description:
    "Returns active assets whose `captured_at` falls on the requested MM-DD " +
    "(±MEMORIES_DAY_WINDOW days, default 3) in any year *before* the current " +
    "one. Grouped by year, newest year first. Each year's bucket is capped " +
    "at MEMORIES_MAX_PER_YEAR (default 50). Defaults to today when `date` is " +
    "omitted.",
  tags: ["Memories"],
  security: AUTH_SECURITY,
  request: {
    query: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .openapi({
          description: "Target calendar day (YYYY-MM-DD). Defaults to today.",
          example: "2026-05-23",
        }),
    }),
  },
  responses: {
    200: json(
      MemoriesEnvelopeSchema,
      "One bucket per prior year containing assets, newest year first."
    ),
    400: errorResponse("Malformed `date` parameter."),
    401: errorResponse("Not authenticated."),
  },
});

// ---------------------------------------------------------------------------
// /api/v1/assets/within-bbox — Phase 5.2 map viewport query
// ---------------------------------------------------------------------------
registry.registerPath({
  method: "get",
  path: "/api/v1/assets/within-bbox",
  summary: "List geo-tagged assets inside a lat/lon bounding box",
  description:
    "Drives the map page's marker / supercluster rendering. Scoped to the " +
    "caller's primary workspace; reads `assets_lat_lon_idx` for the range " +
    "scan. Returns a trimmed projection (id, lat, lon, thumbnailUrl, " +
    "capturedAt, placeName) — capped at 5000 rows; default 2000. Pan/zoom " +
    "the client far enough out that the cap kicks in and the front end " +
    "shows a 'zoom in to load' nudge rather than spamming.",
  tags: ["Assets"],
  security: AUTH_SECURITY,
  request: {
    query: z.object({
      minLat: z.string().openapi({ example: "51.40" }),
      maxLat: z.string().openapi({ example: "51.60" }),
      minLon: z.string().openapi({ example: "-0.20" }),
      maxLon: z.string().openapi({ example: "0.00" }),
      limit: z
        .string()
        .optional()
        .openapi({
          description: "Max rows returned (default 2000, hard cap 5000).",
          example: "2000",
        }),
    }),
  },
  responses: {
    200: json(
      MapAssetsEnvelopeSchema,
      "Assets in the requested bbox, capturedAt desc."
    ),
    400: errorResponse(
      "Missing/malformed bbox params or out-of-range coordinates."
    ),
    401: errorResponse("Not authenticated."),
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
// /api/v1/stacks (Phase 5.5 — manual stacks)
// ---------------------------------------------------------------------------
const StackPathIdParam = z.object({ id: UuidSchema });
const StackAssetPathParams = z.object({ id: UuidSchema, assetId: UuidSchema });

registry.registerPath({
  method: "post",
  path: "/api/v1/stacks",
  summary: "Create a stack from a confirmed asset group",
  description:
    "Editor role required. All assets must live in the caller's primary " +
    "workspace and not already belong to another stack. `primaryAssetId` " +
    "must be one of `assetIds` — it's the row the timeline will surface.",
  tags: ["Stacks"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            assetIds: z.array(UuidSchema).min(1),
            primaryAssetId: UuidSchema,
            name: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: json(
      z.object({
        stack: StackSchema,
        assetIds: z.array(UuidSchema),
        primaryAsset: AssetSchema.nullable(),
      }),
      "Stack created."
    ),
    400: errorResponse("Bad request (missing primary, foreign asset, etc.)."),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Editor role required."),
    404: errorResponse("Workspace or assets not found."),
    409: errorResponse("One or more assets already belong to another stack."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/stacks/{id}",
  summary: "Get a stack with its members",
  description:
    "Returns the stack row plus its members sorted primary-first then by " +
    "ascending capturedAt. Viewer role is sufficient.",
  tags: ["Stacks"],
  security: AUTH_SECURITY,
  request: { params: StackPathIdParam },
  responses: {
    200: json(StackEnvelopeSchema, "Stack + members."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/v1/stacks/{id}",
  summary: "Update stack name and/or primary",
  description:
    "Changing `primaryAssetId` moves the cover image; the new primary must " +
    "already be a member. `name` can be set to null to clear.",
  tags: ["Stacks"],
  security: AUTH_SECURITY,
  request: {
    params: StackPathIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            primaryAssetId: UuidSchema.optional(),
            name: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: json(StackEnvelopeSchema, "Updated stack + members."),
    400: errorResponse("Primary not a member, or invalid body."),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Editor role required."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/stacks/{id}",
  summary: "Un-stack all members and delete the stack",
  tags: ["Stacks"],
  security: AUTH_SECURITY,
  request: { params: StackPathIdParam },
  responses: {
    200: json(z.object({ ok: z.literal(true) }), "Stack deleted."),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Editor role required."),
    404: errorResponse("Not found."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/stacks/{id}/assets",
  summary: "Add assets to an existing stack",
  description:
    "Idempotent against assets already in this stack; conflicts if any " +
    "asset already belongs to a different stack.",
  tags: ["Stacks"],
  security: AUTH_SECURITY,
  request: {
    params: StackPathIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ assetIds: z.array(UuidSchema).min(1) }),
        },
      },
    },
  },
  responses: {
    200: json(StackEnvelopeSchema, "Updated stack + members."),
    400: errorResponse("Bad request."),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Editor role required."),
    404: errorResponse("Stack not found."),
    409: errorResponse("Asset already in another stack."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/stacks/{id}/assets/{assetId}",
  summary: "Remove one asset from a stack",
  description:
    "If the removed asset was the primary, the next-oldest member is " +
    "promoted; if no members remain, the stack itself is deleted.",
  tags: ["Stacks"],
  security: AUTH_SECURITY,
  request: { params: StackAssetPathParams },
  responses: {
    200: json(
      z.object({
        ok: z.literal(true),
        deleted: z.boolean().openapi({
          description: "True if the stack was deleted (no members remained).",
        }),
        newPrimaryAssetId: UuidSchema.nullable(),
      }),
      "Asset removed."
    ),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Editor role required."),
    404: errorResponse("Stack or asset membership not found."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/stacks/suggestions",
  summary: "List auto-suggested stack candidates",
  description:
    "Read-only. Runs `suggestStacks()` over the caller's primary workspace " +
    "and returns the first 50 candidate clusters. Reasons: `raw+jpeg` " +
    "(2 assets, mixed JPEG + RAW within `STACK_RAW_JPEG_THRESHOLD_S`) or " +
    "`burst` (3+ shots within `STACK_BURST_THRESHOLD_S` from the same " +
    "camera). Bursts suppress overlapping pairs.",
  tags: ["Stacks"],
  security: AUTH_SECURITY,
  responses: {
    200: json(StackSuggestionsEnvelopeSchema, "Candidate stacks."),
    401: errorResponse("Not authenticated."),
    404: errorResponse("No workspace for caller."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/stacks/suggestions/accept",
  summary: "Accept a suggestion and create the stack",
  description:
    "Convenience wrapper over `POST /api/v1/stacks` for suggestions. " +
    "`primaryAssetId` defaults to the first id in `assetIds` if not " +
    "specified.",
  tags: ["Stacks"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            assetIds: z.array(UuidSchema).min(1),
            primaryAssetId: UuidSchema.optional(),
            name: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: json(
      z.object({ stack: StackSchema, assetIds: z.array(UuidSchema) }),
      "Stack created from suggestion."
    ),
    400: errorResponse("Bad request."),
    401: errorResponse("Not authenticated."),
    403: errorResponse("Editor role required."),
    404: errorResponse("Workspace or assets not found."),
    409: errorResponse("One or more assets already in another stack."),
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
  "GET /api/v1/workspace/invitations",
  "POST /api/v1/workspace/invitations",
  "GET /api/v1/workspace/invitations/{token}",
  "DELETE /api/v1/workspace/invitations/{token}",
  "POST /api/v1/workspace/invitations/{token}/accept",
  "GET /api/v1/assets",
  "POST /api/v1/assets",
  "POST /api/v1/assets/init",
  "GET /api/v1/assets/within-bbox",
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
  "GET /api/v1/folders",
  "GET /api/v1/search",
  "GET /api/v1/search/clip",
  "POST /api/v1/search/clip",
  "POST /api/v1/uploads/tus",
  "PATCH /api/v1/uploads/tus/{uploadId}",
  "GET /api/v1/uploads/tus/{uploadId}",
  "DELETE /api/v1/uploads/tus/{uploadId}",
  "GET /api/v1/memories",
  // Phase 5.5 — manual stacks.
  "POST /api/v1/stacks",
  "GET /api/v1/stacks/{id}",
  "PATCH /api/v1/stacks/{id}",
  "DELETE /api/v1/stacks/{id}",
  "POST /api/v1/stacks/{id}/assets",
  "DELETE /api/v1/stacks/{id}/assets/{assetId}",
  "GET /api/v1/stacks/suggestions",
  "POST /api/v1/stacks/suggestions/accept",
  "POST /api/v1/cron/purge-trashed",
  "POST /api/v1/cron/ocr-backfill",
]);
