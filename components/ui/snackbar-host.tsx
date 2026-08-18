// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// App-wide Snackbar (toast) host. The server-rendered app-group layout can't
// itself hold the Base UI Toast context (it needs client hooks + a toast list
// that maps over the manager), so this client boundary wraps the app tree:
// any descendant calls `useSnackbar()` to push a toast, and this component
// renders them in the viewport.
"use client";

import { X } from "lucide-react";
import {
  Snackbar,
  SnackbarProvider,
  SnackbarViewport,
  SnackbarTitle,
  SnackbarDescription,
  SnackbarClose,
  useSnackbar,
} from "@/components/ui/snackbar";

function SnackbarList() {
  const { toasts } = useSnackbar();
  return (
    <>
      {toasts.map((toast) => (
        <Snackbar key={toast.id} toast={toast}>
          <div className="flex-1">
            {toast.title != null && <SnackbarTitle />}
            {toast.description != null && <SnackbarDescription />}
          </div>
          <SnackbarClose aria-label="Dismiss">
            <X className="h-4 w-4" />
          </SnackbarClose>
        </Snackbar>
      ))}
    </>
  );
}

export function SnackbarHost({ children }: { children: React.ReactNode }) {
  return (
    <SnackbarProvider>
      {children}
      <SnackbarViewport>
        <SnackbarList />
      </SnackbarViewport>
    </SnackbarProvider>
  );
}
