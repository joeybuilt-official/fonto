import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  // Plexo SDK uses node:crypto for HMAC; keep it external (Node import resolution)
  // instead of bundling into webpack's edge graph which doesn't grok the node: scheme.
  serverExternalPackages: ["@joeybuilt/plexo-sdk"],
  // serverExternalPackages only applies to RSC bundle. instrumentation.ts is built
  // for BOTH nodejs + edge runtimes; the edge build can't resolve `node:crypto`.
  // Force the SDK external across every webpack pass.
  webpack: (config) => {
    const externals = config.externals;
    const externalize = ["@joeybuilt/plexo-sdk", "@joeybuilt/plexo-sdk/connect"];
    const externalsArr = Array.isArray(externals) ? externals : externals ? [externals] : [];
    externalsArr.push(
      (
        { request }: { request?: string },
        callback: (err?: Error | null, result?: string) => void,
      ) => {
        if (request && externalize.some((m) => request === m || request.startsWith(`${m}/`))) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      },
    );
    config.externals = externalsArr;
    return config;
  },
};

export default nextConfig;
