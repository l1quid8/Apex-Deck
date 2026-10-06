import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 720, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const source = await fs.readFile(
  "../docs/mockups/pick-the-machine-ios-v1.html",
  "utf8",
);
const policy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
const document = source.replace(
  /<head>/i,
  `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`,
);
await page.setContent(
  '<style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style><iframe sandbox="allow-scripts"></iframe>',
);
await page.locator("iframe").evaluate((node, html) => {
  node.srcdoc = html;
}, document);
const frame = page.frameLocator("iframe");
await expect(
  frame.getByRole("heading", { name: "Threads", exact: true }),
).toBeVisible();
await frame.getByRole("combobox", {name:"Review step"}).selectOption("pick-seven");
await expect(frame.getByRole("dialog", { name: "Work in" })).toBeVisible();
await page.screenshot({ path: "screenshots/export-deck-frame.png" });
await frame.getByRole("combobox", {name:"Review step"}).selectOption("pick-eighteen");
await expect(frame.getByRole("button", {name:"Type: large",exact:true})).toBeVisible();
await expect(frame.locator(".mf-name-short")).toBeVisible();
if (errors.length) throw Error(errors.join("\n"));
console.log("Export runs inside Deck sandbox and its review links work");
await browser.close();
