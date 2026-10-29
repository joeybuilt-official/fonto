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
    // ---------------------------------------------------------------------------------------
    // The four-layer map, from `.claude/rules/clean-architecture.md` -> "This project's layers".
    // Measured 2026-10-28 over 627 modules: the three rules marked `error` are clean today, so they
    // block from day one. The three marked `warn` carry a real backlog (46 / 24 / 172 violations)
    // and are the report-only ramp the doctrine prescribes: visible in every run, counted, and
    // promoted to `error` the moment their count reaches zero. Nothing here is a claim that the
    // tree conforms — the counts say exactly how far it does not.
    // ---------------------------------------------------------------------------------------
    {
      // The UI may reach lib/; lib/ may never reach the UI — a hook or component imported from a
      // feature module drags React and the router into code that must run in a worker and a script.
      name: "lib-no-ui",
      severity: "error",
      from: { path: "^lib/" },
      to: { path: "^(components|app)/" },
    },
    {
      // Drivers never depend on the layers above them. db/queue/storage importing a feature module
      // inverts the arrow: the driver would then change when the business changes.
      //
      // `lib/<feature>/store.ts` is that feature's repository — the one file allowed to import the
      // drivers, which is the whole point of moving a query out of a route handler. It is named here
      // because nothing else matches the path: `lib-no-ui` only forbids `lib/` reaching the UI, so
      // without this line a driver importing a feature's store would pass every rule in the map. The
      // target is a SHAPE, not a list, so a new feature repository is covered the day it is created.
      name: "drivers-no-upward",
      severity: "error",
      from: { path: "^lib/(db|queue|storage)/" },
      to: {
        path: "^(lib/(processing|fusion|evidence|temporal|stacks|classify|faces)/|lib/[a-z0-9-]+/store\\.ts$)",
      },
    },
    {
      // A cycle means no layer ordering exists at all. This rule found one real cycle when it
      // landed (`lib/storage/index.ts -> read.ts -> index.ts`) and it is fixed, not baselined.
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      // Domain purity, written as a path exclusion rather than a dependencyTypes list: a type list
      // is silently incomplete (a devDependency classifies as `npm-dev`), a path rule is not.
      // Backlog: 39 violations in 11 files, the largest being drizzle-orm imports in lib/fusion/ and
      // lib/evidence/ — recorded in .dependency-cruiser-known-violations.json when this rule was
      // promoted from `warn`. Anything not in that file fails the gate. lib/classify/ is at zero.
      name: "domain-stays-pure",
      severity: "error",
      from: {
        path: "^lib/(fusion|evidence|temporal|stacks|classify|faces)/",
        // A test file naming its own runner is not a production dependency: the rule exists to keep
        // SHIPPED code free of outward imports, and a `describe` that imports `vitest` points the
        // harness, not the product, at a devDependency. This exception covers test files only — the
        // production modules beside them stay policed, which is where the 40 remaining violations are.
        pathNot: "\\.(test|spec)\\.tsx?$",
      },
      to: { pathNot: "^lib/(fusion|evidence|temporal|stacks|classify|faces)/" },
    },
    {
      // Use cases reach persistence and the queue through ports, not by importing the driver.
      // Backlog: 24 violations in 13 files, all `@/lib/db`, `@/lib/queue/*` and `@/lib/storage`,
      // recorded in .dependency-cruiser-known-violations.json when this rule was promoted from `warn`.
      name: "application-no-drivers",
      severity: "error",
      from: { path: "^lib/processing/" },
      to: { path: "^lib/(db|storage|queue|intelligence/adapters)/" },
    },
    {
      // Route handlers translate transport; they own authz and DTOs, not queries. Backlog: 172
      // violations in 132 of 161 route files — the largest gap in the map and the next ratchet.
      // Recorded in .dependency-cruiser-known-violations.json when this rule was promoted from `warn`.
      name: "adapters-no-drivers",
      severity: "error",
      from: { path: "^(app/api|lib/openapi)/" },
      to: { path: "^lib/(db|storage|queue)/" },
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
