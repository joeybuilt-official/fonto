// SPDX-License-Identifier: MIT
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
  // The config file holds the PAT (a bearer token). Restrict it to the
  // owner so other local users can't read the credential (conf defaults
  // to 0o666, i.e. world/group-readable after umask).
  configFileMode: 0o600,
  // baseUrl has NO default: this repo is public, so a baked production
  // hostname would silently point every third-party install at an instance they
  // do not own. `fonto login --base-url <url>` (or FONTO_BASE_URL) is required;
  // request() fails with an actionable message until it is set.
  defaults: {
    baseUrl: "",
    pat: "",
  },
});

export interface CliConfig {
  baseUrl: string;
  pat: string;
}

export function getConfig(): CliConfig {
  // Strip any trailing slash from the env override so we don't build
  // `…//api/v1` double-slash paths later.
  const envBase = process.env.FONTO_BASE_URL?.replace(/\/+$/, "");
  return {
    baseUrl: envBase ?? store.get("baseUrl"),
    pat: process.env.FONTO_PAT ?? store.get("pat"),
  };
}

export function setBaseUrl(url: string): void {
  const trimmed = url.trim();
  // Prepend a scheme when the user gives a bare host (e.g. `fonto.example.com`)
  // so every later `fetch()` gets a parseable absolute URL.
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid base URL: ${url}`);
  }
  store.set("baseUrl", parsed.href.replace(/\/+$/, ""));
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
