// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// UX-3 — slide-in right-rail AI ask panel. Mounted once per page; the
// toolbar opens it via the `open` prop and seeds it with the current
// view's contextAssetIds (selected ids if any, otherwise visible ids).
//
// Today the backend is the stub at /api/v1/ask — it returns a "coming
// soon" message with the context size. When the real chat backend lands,
// no UI changes are needed: the response shape (`message`, optional
// `citations`) is the seam.

"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  stub?: boolean;
}

interface AssetAskPanelProps {
  open: boolean;
  onClose: () => void;
  /** IDs the question is scoped to. Toolbar passes selected ids if any,
   *  otherwise the page's visible result set. */
  contextAssetIds: string[];
  /** Optional label shown in the header so the user knows what the
   *  question will see (e.g. "12 photos in Hawaii 2024"). */
  contextLabel?: string;
}

export function AssetAskPanel({
  open,
  onClose,
  contextAssetIds,
  contextLabel,
}: AssetAskPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    const userMsg: ChatMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);
    try {
      const r = await fetch("/api/v1/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          contextAssetIds,
        }),
      });
      const d = (await r.json()) as { message?: string; stub?: boolean };
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: d.message ?? "(no response)",
          stub: d.stub,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Network error. Try again." },
      ]);
    } finally {
      setSending(false);
    }
  }

  // Sheet primitive handles scrim + focus trap + a11y. Right-side
  // variant for the rail-style ask panel.
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full max-w-md p-0 gap-0">
        <SheetHeader className="flex flex-row items-center justify-between border-b border-[var(--ft-color-outline-variant)] px-[var(--ft-space-4)] py-[var(--ft-space-3)] gap-[var(--ft-space-2)]">
          <div className="flex items-center gap-[var(--ft-space-2)]">
            <Sparkles className="h-4 w-4 text-[var(--ft-color-primary-text)]" />
            <div className="flex flex-col">
              <SheetTitle className="text-[length:var(--ft-type-title-medium-size)] leading-[var(--ft-type-title-medium-line)] font-semibold text-[var(--ft-color-on-surface)]">
                Ask
              </SheetTitle>
              <SheetDescription>
                {contextLabel ??
                  `${contextAssetIds.length} asset${
                    contextAssetIds.length === 1 ? "" : "s"
                  } in context`}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-[var(--ft-space-4)] py-[var(--ft-space-3)]"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-[var(--ft-space-2)] text-center text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
              <Sparkles className="h-8 w-8 text-[var(--ft-color-on-surface-variant)] opacity-40" />
              <p>Ask anything about these assets.</p>
              <p className="text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)]">
                Try: &ldquo;what photos here are blurry?&rdquo; ·
                &ldquo;summarize the receipts&rdquo; · &ldquo;what dates do
                these cover?&rdquo;
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-[var(--ft-space-3)]">
              {messages.map((m, i) => (
                <li
                  key={i}
                  className={cn(
                    "max-w-[85%] rounded-[var(--ft-shape-large)] px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)]",
                    m.role === "user"
                      ? "ml-auto bg-[var(--ft-color-primary)] text-[var(--ft-color-on-primary)]"
                      : "mr-auto bg-[var(--ft-color-surface-container)] text-[var(--ft-color-on-surface)]"
                  )}
                >
                  {m.stub && (
                    <span className="mr-1 inline-block rounded-[var(--ft-shape-full)] bg-[var(--ft-color-tertiary-container)] px-1.5 py-0.5 text-[length:var(--ft-type-label-small-size)] leading-[var(--ft-type-label-small-line)] font-medium uppercase tracking-wide text-[var(--ft-color-on-tertiary-container)]">
                      Preview
                    </span>
                  )}
                  {m.content}
                </li>
              ))}
              {sending && (
                <li className="mr-auto flex items-center gap-1.5 rounded-[var(--ft-shape-large)] bg-[var(--ft-color-surface-container)] px-[var(--ft-space-3)] py-[var(--ft-space-2)] text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface-variant)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking…
                </li>
              )}
            </ul>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
          className="flex items-end gap-[var(--ft-space-2)] border-t border-[var(--ft-color-outline-variant)] bg-[var(--ft-color-surface-container-low)] p-[var(--ft-space-3)]"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Ask about these assets…"
            rows={1}
            className="min-h-[2rem] flex-1 resize-none rounded-[var(--ft-shape-small)] border border-[var(--ft-color-outline)] bg-[var(--ft-color-surface)] px-2.5 py-1.5 text-[length:var(--ft-type-body-medium-size)] leading-[var(--ft-type-body-medium-line)] text-[var(--ft-color-on-surface)] placeholder:text-[var(--ft-color-on-surface-variant)] outline-none focus:border-[var(--ft-color-primary)] focus:ring-2 focus:ring-[var(--ft-color-primary)]/40"
          />
          <Button
            type="submit"
            size="icon"
            disabled={sending || !input.trim()}
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
