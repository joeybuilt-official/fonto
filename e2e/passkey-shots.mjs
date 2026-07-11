import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const OUT = process.env.OUT ?? "/tmp/shots";
const state = JSON.parse(readFileSync(new URL("./.auth/user.json", import.meta.url), "utf8"));
const sess = state.cookies.find((c) => c.name.includes("session_token"));
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const [w, h, tag] of [[390, 844, "390"], [1440, 900, "1440"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const p1 = await ctx.newPage();
  await p1.goto("https://myfonto.com/login", { waitUntil: "networkidle" });
  await p1.screenshot({ path: `${OUT}/login-${tag}.png`, fullPage: true });
  await ctx.addCookies([{ name: sess.name, value: sess.value, domain: "myfonto.com", path: "/", secure: true, httpOnly: true }]);
  const p2 = await ctx.newPage();
  await p2.goto("https://myfonto.com/app/settings", { waitUntil: "networkidle" }).catch(() => {});
  await p2.waitForTimeout(2500);
  const card = p2.locator("text=Passkeys").first();
  if (await card.count()) await card.scrollIntoViewIfNeeded().catch(() => {});
  await p2.screenshot({ path: `${OUT}/settings-${tag}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log("shots done");
