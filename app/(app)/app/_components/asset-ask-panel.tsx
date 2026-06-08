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
import { Send, Sparkles, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

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

  return (
    <>
      {/* Backdrop — clickable to close, doesn't dim the underlying content
          much so the user can still see what they're asking about. */}
      <div
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-black/20 transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <aside
        className={cn(
          "fixed right-0 top-0 z-40 flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-xl transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full"
        )}
        // `inert` removes focusable descendants from the tab order AND
        // makes the subtree inert to screen readers — semantically what
        // we want when the panel is slid off-screen. aria-hidden alone
        // is a Lighthouse a11y failure (focusable children inside an
        // aria-hidden subtree); inert correctly handles both.
        {...(!open && { inert: "" })}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <div className="flex flex-col">
              <p className="text-sm font-semibold text-foreground">Ask</p>
              <p className="text-[11px] text-muted-foreground">
                {contextLabel ??
                  `${contextAssetIds.length} asset${
                    contextAssetIds.length === 1 ? "" : "s"
                  } in context`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close ask panel"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-4 py-3"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <Sparkles className="h-8 w-8 text-muted-foreground/40" />
              <p>Ask anything about these assets.</p>
              <p className="text-[11px]">
                Try: &ldquo;what photos here are blurry?&rdquo; ·
                &ldquo;summarize the receipts&rdquo; · &ldquo;what dates do
                these cover?&rdquo;
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {messages.map((m, i) => (
                <li
                  key={i}
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                    m.role === "user"
                      ? "ml-auto bg-primary text-primary-foreground"
                      : "mr-auto bg-muted text-foreground"
                  )}
                >
                  {m.stub && (
                    <span className="mr-1 inline-block rounded-full bg-yellow-500/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-yellow-700 dark:text-yellow-400">
                      Preview
                    </span>
                  )}
                  {m.content}
                </li>
              ))}
              {sending && (
                <li className="mr-auto flex items-center gap-1.5 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">
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
          className="flex items-end gap-2 border-t border-border bg-background/50 p-3"
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
            className="min-h-[2rem] flex-1 resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      </aside>
    </>
  );
}
