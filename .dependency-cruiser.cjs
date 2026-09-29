// ADR-002 (adr/jex/ADR-002-intelligence-port-catalog.md) Enforcement rules.
// Paths translated from the ADR's lib/jex/** to the real tree: lib/intelligence/**.
//
// Fleet decoupling (2026-09): the sibling SDK and its facades are gone. The
// rules now enforce the APP-OWNED boundary instead:
//   - the AI connection resolver (`lib/ai/connections.ts`) is the only place
//     that touches `fonto.ai_connections` credentials;
//   - adapters are reached only through the intelligence facade
//     (`lib/intelligence/client.ts` + `lib/intelligence/prompts.ts`);
//   - the vision sidecar client is adapter-internal.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      // R1: only the intelligence adapters may import the Anthropic SDK — it is
      // the embedded Completion tier floor, not a general-purpose client.
      name: "no-sdk-outside-adapters",
      severity: "error",
      from: {
        pathNot: [
          "^lib/intelligence/adapters/",
        ],
      },
      to: { path: "@anthropic-ai/sdk" },
    },
    {
      // R2: the vision sidecar client is adapter-internal. The intelligence
      // module is the tier composition root (it wires the adapter Layers), and
      // lib/faces/cluster.ts is the one grandfathered caller (GPU neighbour
      // query through the adapter module by design).
      name: "no-vision-outside-adapters",
      severity: "error",
      from: {
        pathNot: [
          "^lib/intelligence/",
          "^lib/faces/cluster\\.ts$",
        ],
      },
      to: { path: "^lib/intelligence/adapters/vision-sidecar" },
    },
    {
      // R3: adapters are reached only via the intelligence facade. Processing
      // tests may import adapters to fake them, and face clustering reaches the
      // GPU neighbour query through the vision adapter by design.
      name: "adapters-behind-facade",
      severity: "error",
      from: {
        pathNot: [
          "^lib/intelligence/",
          "^lib/processing/__tests__/",
          "^lib/faces/cluster\\.ts$",
        ],
      },
      to: { path: "^lib/intelligence/adapters/" },
    },
    {
      // R4: credentials at rest have ONE encryption implementation. The two
      // credential stores (AI connections, Google integration tokens) are the
      // only modules allowed to import the secret box.
      name: "secret-box-single-home",
      severity: "error",
      from: {
        pathNot: [
          "^lib/ai/",
          "^lib/integrations/",
          "^lib/crypto/",
        ],
      },
      to: { path: "^lib/crypto/secret-box" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
