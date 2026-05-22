// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Shared pino logger. Default level is `info`; set LOG_LEVEL=debug for verbose
// queue diagnostics. Pino emits newline-delimited JSON, which container log
// scrapers (loki, fluent-bit, etc.) can ingest without further parsing.

import pino from "pino";

export const logger = pino({
  name: "fonto",
  level: process.env.LOG_LEVEL ?? "info",
});

export type Logger = typeof logger;
