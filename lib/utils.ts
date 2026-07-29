// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
