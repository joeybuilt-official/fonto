// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Persistent config — base URL + PAT live in conf's standard location:
//   macOS:   ~/Library/Preferences/fonto-cli-nodejs/config.json
//   Linux:   ~/.config/fonto-cli-nodejs/config.json
//   Windows: %APPDATA%/fonto-cli-nodejs/Config/config.json
//
// Override at call time via FONTO_BASE_URL + FONTO_PAT env vars so CI
// (and ad-hoc shells) can skip the config-file step.

import Conf from "conf";

interface Schema {
  baseUrl: string;
  pat: string;
}

const store = new Conf<Schema>({
  projectName: "fonto-cli",
  defaults: {
    baseUrl: "https://myfonto.com",
    pat: "",
  },
});

export interface CliConfig {
  baseUrl: string;
  pat: string;
}

export function getConfig(): CliConfig {
  return {
    baseUrl: process.env.FONTO_BASE_URL ?? store.get("baseUrl"),
    pat: process.env.FONTO_PAT ?? store.get("pat"),
  };
}

export function setBaseUrl(url: string): void {
  store.set("baseUrl", url.replace(/\/+$/, ""));
}

export function setPat(pat: string): void {
  store.set("pat", pat);
}

export function clearConfig(): void {
  store.clear();
}

export function configPath(): string {
  return store.path;
}
