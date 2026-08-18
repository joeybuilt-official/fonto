// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
