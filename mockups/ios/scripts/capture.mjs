import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "src/main.tsx"), "utf8");
const screens = [
  ...source.matchAll(/\[\s*['"]([a-z-]+)['"],\s*['"]([^'"]+)['"]\s*\]/g),
]
  .slice(0, 20)
  .map(([, id, title]) => ({ id, title }));
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  reducedMotion: "reduce",
});
const errors = [],
  violations = [],
  smallTargets = [],
  overflows = [];
page.on("pageerror", (e) => errors.push(e.message));
await fs.mkdir(path.join(root, "screenshots"), { recursive: true });
const base = process.env.MOCKUP_URL || "http://127.0.0.1:5187";
for (const theme of ["dark", "light"]) {
  for (const { id } of screens) {
    await page.goto(`${base}/#${id}`);
    await page.reload();
    if (theme === "light")
      await page.getByRole("button", { name: "Dark", exact: true }).click();
    await page.waitForTimeout(180);
    await page
      .locator(".phone")
      .screenshot({
        path: path.join(root, "screenshots", `${theme}-${id}.png`),
      });
    await page.addScriptTag({
      path: path.join(root, "node_modules/axe-core/axe.min.js"),
    });
    const result = await page.evaluate(
      async () =>
        await window.axe.run(".phone", {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        }),
    );
    if (result.violations.length)
      violations.push({
        theme,
        id,
        issues: result.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            summary: n.failureSummary,
          })),
        })),
      });
    const targets = await page.locator(".phone button").evaluateAll((nodes) =>
      nodes
        .filter((n) => {
          const r = n.getBoundingClientRect();
          return r.width < 44 || r.height < 44;
        })
        .map((n) => ({
          label: n.getAttribute("aria-label") || n.textContent,
          width: n.getBoundingClientRect().width,
          height: n.getBoundingClientRect().height,
        })),
    );
    if (targets.length) smallTargets.push({ theme, id, targets });
    const overflow = await page
      .locator(".phone-content")
      .evaluate((n) => n.scrollWidth > n.clientWidth + 1);
    if (overflow) overflows.push({ theme, id });
  }
}
await fs.writeFile(
  path.join(root, "verification-partial.json"),
  JSON.stringify({ violations, smallTargets, overflows }, null, 2),
);
await page.goto(`${base}/#chat`);
await page.getByRole("button", { name: "Type: default" }).click();
await page
  .locator(".phone")
  .screenshot({ path: path.join(root, "screenshots", "large-chat.png") });
await page.screenshot({
  path: path.join(root, "screenshots", "review-index.png"),
  fullPage: true,
});
await page.goto(`${base}/#hosts`);
await page.getByRole("button", { name: "Add a host", exact: true }).click();
await page.getByRole("button", { name: /Scan a QR code/ }).click();
await page.getByRole("button", { name: "Simulate QR scan" }).click();
await page.getByRole("button", { name: "Fingerprints match · pair" }).click();
await expect(page.locator(".phone h2")).toHaveText("Your hosts");
await page.goto(`${base}/#ssh`);
await page.getByRole("button", { name: "Generate a device key" }).click();
await expect(page.locator(".phone")).toContainText("iPhone · ed25519 (mock)");
await page.getByRole("button", { name: "Continue", exact: true }).click();
await expect(page.locator(".phone")).toContainText("SSH host key");
await page.goto(`${base}/#chat`);
await page
  .getByRole("button", { name: "Mention a participant", exact: true })
  .click();
await page.getByRole("button", { name: /Codex GPT/ }).click();
await expect(
  page.getByRole("textbox", { name: "Message the room" }),
).toHaveValue("@codex ");
await page.getByRole("button", { name: "Attach a mock image" }).click();
await page.getByRole("button", { name: /Navigation sketch Add/ }).click();
await page
  .getByRole("textbox", { name: "Message the room" })
  .fill("@codex review this layout");
await page.getByRole("button", { name: "Send mock message" }).click();
await expect(page.locator(".phone")).toContainText(
  "@codex review this layout [navigation-sketch.png]",
);
await page.goto(`${base}/#approval`);
await page.getByRole("button", { name: "Always allow…", exact: true }).click();
await expect(page.getByRole("dialog")).toBeVisible();
await page
  .locator(".phone")
  .screenshot({ path: path.join(root, "screenshots", "sheet-always.png") });
await page.keyboard.press("Escape");
await expect(page.getByRole("dialog")).toHaveCount(0);
await page.getByRole("button", { name: "Approve once" }).click();
await expect(page.locator(".result")).toContainText("Approved once");
await page.goto(`${base}/#command`);
await page.getByRole("button", { name: "Deny", exact: true }).click();
await expect(page.locator(".result")).toContainText("Denied");
await page.goto(`${base}/#browser`);
await page.getByRole("button", { name: "Take control", exact: true }).click();
await expect(page.locator(".phone")).toContainText("YOU HAVE CONTROL");
await page.getByRole("button", { name: "Give control back" }).click();
await expect(page.locator(".phone")).toContainText("FOLLOW THE HOST");
await page.goto(`${base}/#terminal-full`);
await page.getByRole("button", { name: "Terminal Esc", exact: true }).click();
await expect(page.getByRole("status")).toContainText(
  "Esc sent to mock terminal",
);
await page.goto(`${base}/#settings`);
await page.getByRole("button", { name: "Unpair from this host" }).click();
await page.getByRole("button", { name: "Unpair device", exact: true }).click();
await expect(page.locator(".host-cards")).not.toContainText("Tyler’s MacBook");
// Real phone viewport, larger type, all routes must remain horizontally scroll-free.
await page.setViewportSize({ width: 393, height: 852 });
for (const { id } of screens) {
  await page.goto(`${base}/#${id}`);
  await page.reload();
  await page.getByRole("button", { name: "Type: default" }).click();
  if (
    await page
      .locator(".phone-content")
      .evaluate((n) => n.scrollWidth > n.clientWidth + 1)
  )
    overflows.push({ theme: "large-mobile", id });
}
const report = {
  screens: screens.length,
  screenshots: 43,
  consoleErrors: errors,
  axeViolations: violations,
  undersizedPhoneTargets: smallTargets,
  horizontalOverflows: overflows,
  flows:
    "QR pairing, SSH key + fingerprint, mention + attach + send, approval once + deny, modal Escape, browser control, terminal toolbar, unpair",
};
await fs.writeFile(
  path.join(root, "verification.json"),
  JSON.stringify(report, null, 2),
);
const gallery = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apex Deck iOS screenshot review</title><style>body{background:#090d12;color:#e4eaf0;font:15px system-ui;padding:30px}h1{color:#71e6b5}section{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:45px}img{width:275px;border:1px solid #24303d;border-radius:24px}a{color:#71e6b5}figure{margin:0}figcaption{padding:12px 0;color:#91a0af}</style><h1>Apex Deck · iOS mockups</h1><p>20 screens · dark and light · design only. <a href="../README.md">Design decisions</a></p>${screens.map((s) => `<h2>${s.title}</h2><section>${["dark", "light"].map((t) => `<figure><a href="${t}-${s.id}.png"><img loading="lazy" src="${t}-${s.id}.png" alt="${s.title}, ${t} appearance"></a><figcaption>${t}</figcaption></figure>`).join("")}</section>`).join("")}<h2>Large type and scope confirmation</h2><section><img src="large-chat.png" alt="Large type chat"><img src="sheet-always.png" alt="Always allow confirmation"></section></html>`;
await fs.writeFile(path.join(root, "screenshots", "index.html"), gallery);
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (
  errors.length ||
  violations.length ||
  smallTargets.length ||
  overflows.length
)
  process.exitCode = 1;
