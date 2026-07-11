// ADR-002 (adr/jex/ADR-002-intelligence-port-catalog.md) Enforcement rules.
// Paths translated from the ADR's lib/jex/** to the real tree: lib/intelligence/**.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      // R1: only intelligence adapters (+ legacy facade lib/plexo.ts and the app-registration edge) may import the Plexo SDK directly.
      name: "no-sdk-outside-adapters",
      severity: "error",
      from: {
        pathNot: [
          "^lib/intelligence/adapters/",
          "^lib/plexo\\.ts$",
          "^lib/plexo-registration\\.ts$",
        ],
      },
      to: { path: "@joeybuilt/plexo-sdk" },
    },
    {
      // R2: lib/plexo-vision.ts is adapter-internal (facade-recursion gotcha); lib/faces/cluster.ts stays grandfathered for neighborsViaGPU (no port yet).
      name: "no-vision-outside-adapters",
      severity: "error",
      from: {
        pathNot: [
          "^lib/intelligence/adapters/",
          "^lib/faces/cluster\\.ts$",
        ],
      },
      to: { path: "^lib/plexo-vision\\.ts$" },
    },
    {
      // R3: adapters are reached only via lib/intelligence/client; lib/plexo.ts is the legacy facade delegating to the unified adapter, processing tests may import adapters to fake them.
      name: "adapters-behind-facade",
      severity: "error",
      from: {
        pathNot: [
          "^lib/intelligence/",
          "^lib/plexo\\.ts$",
          "^lib/processing/__tests__/",
        ],
      },
      to: { path: "^lib/intelligence/adapters/" },
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
