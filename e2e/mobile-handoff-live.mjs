import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const ORIGIN = (process.env.PLAYWRIGHT_BASE_URL ?? "").replace(/\/+$/, "");
if (!ORIGIN) throw new Error("PLAYWRIGHT_BASE_URL is required (the live instance origin, e.g. https://fonto.example.com)");
const state = JSON.parse(readFileSync(new URL("./.auth/user.json", import.meta.url), "utf8"));
const sess = state.cookies.find((c) => c.name.includes("session_token"));
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });

const authed = await browser.newContext();
await authed.addCookies([{ name: sess.name, value: sess.value, domain: new URL(ORIGIN).hostname, path: "/", secure: true, httpOnly: true }]);
const p1 = await authed.newPage();
await p1.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });
const mint = await p1.evaluate(async () => (await fetch("/api/auth/passkey/one-time-link", { method: "POST" })).json());
await authed.close();
console.log("[mint]", !!mint.link);

const fresh = await browser.newContext();
const p2 = await fresh.newPage();
await p2.goto(`${ORIGIN}${mint.link}&mobile=1`, { waitUntil: "domcontentloaded" });
await p2.waitForURL("**/mobile/auth-callback**", { timeout: 25000 }).catch(() => {});
const url = p2.url();
const hasPat = /[?&]pat=/.test(url);
console.log("[landed]", url.replace(/pat=[^&]+/, "pat=<redacted>"));
console.log(hasPat && url.includes("/mobile/auth-callback") ? "HANDOFF E2E PASS" : "HANDOFF E2E FAIL");
await browser.close();
process.exit(hasPat ? 0 : 1);
