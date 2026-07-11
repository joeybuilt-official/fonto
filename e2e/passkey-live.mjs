// Live WebAuthn register -> login e2e against prod myfonto.com using a CDP
// virtual authenticator. Run from /workspace/fonto: node e2e/passkey-live.mjs
// Requires e2e/.auth/user.json (authed session for the register step).
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const ORIGIN = "https://myfonto.com";
const state = JSON.parse(readFileSync(new URL("./.auth/user.json", import.meta.url), "utf8"));
const sess = state.cookies.find((c) => c.name.includes("session_token"));
if (!sess) throw new Error("no session cookie in e2e/.auth/user.json");

const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext();
await context.addCookies([{ name: sess.name, value: sess.value, domain: "myfonto.com", path: "/", secure: true, httpOnly: true }]);
const page = await context.newPage();

const client = await context.newCDPSession(page);
await client.send("WebAuthn.enable");
await client.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });

// ---- REGISTER (authed) ----
const reg = await page.evaluate(async () => {
  const start = await (await fetch("/api/auth/passkey/register", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: "start" }),
  })).json();
  if (start.error) return { phase: "start", error: start.error };
  const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(start) });
  const finish = await (await fetch("/api/auth/passkey/register", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: "finish", response: cred.toJSON() }),
  })).json();
  return { phase: "finish", ...finish };
});
console.log("[register]", JSON.stringify(reg));
if (!reg.verified) { await browser.close(); process.exit(1); }

// ---- LOGIN (anon, discoverable credential) ----
await context.clearCookies();
const login = await page.evaluate(async () => {
  const start = await (await fetch("/api/auth/passkey/authenticate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: "start" }),
  })).json();
  if (start.error) return { phase: "start", error: start.error };
  const assertion = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(start) });
  const finish = await (await fetch("/api/auth/passkey/authenticate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step: "finish", response: assertion.toJSON() }),
  })).json();
  return { phase: "finish", ...finish };
});
console.log("[login]", JSON.stringify(login));

const cookies = await context.cookies(ORIGIN);
const newSess = cookies.find((c) => c.name.includes("session_token"));
console.log("[cookie]", newSess ? `minted (${newSess.name})` : "MISSING");

const who = await page.evaluate(async () => { const r = await fetch("/api/auth/get-session"); return { status: r.status, body: await r.json().catch(() => null) }; });
console.log("[get-session]", JSON.stringify(who));

const ok = login.verified === true && !!newSess && (who?.body?.user?.id ?? who?.body?.session?.userId) === login.userId;
console.log(ok ? "E2E PASS" : "E2E FAIL");
console.log("[cleanup-credential-id]", reg.credentialId ?? "none");
await browser.close();
process.exit(ok ? 0 : 1);
