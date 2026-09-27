import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const ORIGIN = (process.env.PLAYWRIGHT_BASE_URL ?? "").replace(/\/+$/, "");
if (!ORIGIN) throw new Error("PLAYWRIGHT_BASE_URL is required (the live instance origin, e.g. https://fonto.example.com)");
const state = JSON.parse(readFileSync(new URL("./.auth/user.json", import.meta.url), "utf8"));
const sess = state.cookies.find((c) => c.name.includes("session_token"));
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });

// Mint link from an authed context
const authed = await browser.newContext();
await authed.addCookies([{ name: sess.name, value: sess.value, domain: new URL(ORIGIN).hostname, path: "/", secure: true, httpOnly: true }]);
const p1 = await authed.newPage();
await p1.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });
const mint = await p1.evaluate(async () => (await fetch("/api/auth/passkey/one-time-link", { method: "POST" })).json());
console.log("[mint]", JSON.stringify(mint));
await authed.close();
if (!mint.link) { await browser.close(); process.exit(1); }

// Consume in a FRESH context via the login page UI effect
const fresh = await browser.newContext();
const p2 = await fresh.newPage();
await p2.goto(`${ORIGIN}${mint.link}`, { waitUntil: "domcontentloaded" });
await p2.waitForURL("**/app/home**", { timeout: 20000 }).catch(() => {});
const url = p2.url();
const scrubbed = !url.includes("token=");
const who = await p2.evaluate(async () => { const r = await fetch("/api/auth/get-session"); return (await r.json().catch(() => null))?.user?.id ?? null; });
console.log("[landed]", url, "| token-scrubbed:", scrubbed, "| user:", who);

// Reuse must fail (single-use)
const p3 = await (await browser.newContext()).newPage();
await p3.goto(`${ORIGIN}${mint.link}`, { waitUntil: "domcontentloaded" });
await p3.waitForTimeout(4000);
const reuseBlocked = !p3.url().includes("/app/home");
console.log("[reuse-blocked]", reuseBlocked);

const ok = url.includes("/app/home") && who && reuseBlocked;
console.log(ok ? "OTL E2E PASS" : "OTL E2E FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
