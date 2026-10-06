import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage();
const base = process.env.MOCKUP_URL || "http://127.0.0.1:5187";
await page.goto(`${base}/#pick-fifteen`);
await expect(page.getByRole("dialog")).toContainText("Fork this thread");
await page.getByRole("button", { name: "Cancel", exact: true }).click();
await expect(page.getByRole("button", { name: /Work in/ })).toContainText(
  "Hetzner-EU",
);
await page.goto(`${base}/#pick-nine`);
await page
  .getByRole("textbox", { name: "Message this thread" })
  .fill("Keep my draft");
await page
  .getByRole("button", { name: "Threads", exact: true })
  .first()
  .click();
await page.getByRole("button", { name: /Draft · New thread/ }).first().click();
await expect(
  page.getByRole("textbox", { name: "Message this thread" }),
).toHaveValue("Keep my draft");
await page.goto(`${base}/#pick-seventeen`);
await expect(
  page.getByRole("button", { name: "Send to machine" }),
).toBeDisabled();
await page
  .getByRole("button", { name: "Threads", exact: true })
  .first()
  .click();
await page
  .getByRole("button", { name: /Signing check/ })
  .first()
  .click();
await page
  .getByRole("textbox", { name: "Message this thread" })
  .fill("Mac still works");
await expect(
  page.getByRole("button", { name: "Send to machine" }),
).toBeEnabled();
await page.goto(`${base}/#pick-nineteen`);
await expect(
  page.getByRole("button", { name: "Send to machine" }),
).toBeDisabled();
await page.getByRole("button", { name: "Open Hetzner-EU thread" }).click();
await page
  .getByRole("textbox", { name: "Message this thread" })
  .fill("Server still works");
await expect(
  page.getByRole("button", { name: "Send to machine" }),
).toBeEnabled();
await page.goto(`${base}/#pick-fourteen`);
await page
  .getByRole("button", { name: "Copy folder path", exact: true })
  .click();
await expect(page.getByRole("status")).toContainText("Pretend clipboard");
await page.goto(`${base}/#pick-four`);
await page
  .getByRole("textbox", { name: "SSH destination" })
  .fill("root@hetzner-eu");
await page
  .getByRole("button", { name: "Save connection", exact: true })
  .click();
await expect(page.getByRole("alert")).toContainText("different machine");
await page
  .getByRole("textbox", { name: "SSH destination" })
  .fill("l1quid8@203.0.113.24");
await page
  .getByRole("button", { name: "Save connection", exact: true })
  .click();
await expect(page.getByRole("status")).toContainText("same machine");
await expect(page.getByRole("heading", {name:"Threads", exact:true})).toBeVisible();
await page.getByRole("button", {name:"Settings and Machines",exact:true}).click();
await page.getByRole("button", {name:"Machines",exact:true}).click();
await expect(page.locator(".phone-content")).toContainText("l1quid8@203.0.113.24");
await page.goto(`${base}/#pick-eleven`);
await page
  .getByRole("button", { name: "Docker · Claude", exact: true })
  .click();
await expect(
  page.getByRole("textbox", { name: "Message this thread" }),
).toHaveValue("Run the load test on the Hetzner copy. !docker ");
await page.getByRole("button", { name: "Send to machine" }).click();
await expect(
  page.getByRole("region", { name: "Load test approval" }),
).toBeVisible();
await page.getByRole("button", { name: "Work in Hetzner-EU" }).click();
await page.getByRole("button", { name: /Tyler’s MacBook/ }).click();
await expect(page.getByRole("dialog")).toContainText("Fork this thread");
await page
  .getByRole("button", { name: "Fork this thread", exact: true })
  .click();
await expect(page.locator(".phone-content")).toContainText("Forked from");
await expect(page.locator(".phone-content")).toContainText("You");
await page
  .getByRole("textbox", { name: "Message this thread" })
  .fill("Unsent fork");
await page
  .getByRole("navigation", { name: "Workspace sections" })
  .getByRole("button", { name: "Code", exact: true })
  .click();
await page
  .getByRole("navigation", { name: "Workspace sections" })
  .getByRole("button", { name: "Threads", exact: true })
  .click();
await page
  .getByRole("button", {
    name: /Draft · .*\(fork\)/,
  })
  .first().click();
await expect(
  page.getByRole("textbox", { name: "Message this thread" }),
).toHaveValue("Unsent fork");
// Review regressions: reject unavailable projects, derive titles, and scope tabs.
await page.goto(`${base}/#pick-six`);
await expect(page.getByRole("button", {name:/staging-api Staging/})).toBeDisabled();
await page.getByRole("button", {name:"Close sheet"}).click();
await page.getByRole("textbox", {name:"Message this thread"}).fill("Fix the typo in README");
await page.getByRole("button", {name:"Send to machine"}).click();
await expect(page.locator(".chat-heading h2")).toHaveText("Fix the typo in README");
await expect(page.locator(".approval-card")).toHaveCount(0);
await page.goto(`${base}/#pick-nine`);
await page.getByRole("textbox", {name:"Message this thread"}).fill("Fix the typo in README");
await page.getByRole("button", {name:"Send to machine"}).click();
await expect(page.locator(".chat-heading h2")).toHaveText("Fix the typo in README");
await expect(page.locator(".approval-card")).toHaveCount(0);
await page.getByRole("navigation").getByRole("button", {name:"Agents", exact:true}).click();
await expect(page.locator(".agent-card")).toHaveCount(1);
await expect(page.locator(".agent-card")).toContainText("Claude");
await expect(page.locator(".connection")).toContainText("SSH");
await page.getByRole("navigation").getByRole("button", {name:"Code", exact:true}).click();
await expect(page.locator(".phone-content")).toContainText("/root/apex-deck");
await page.goto(`${base}/#pick-nineteen`);
await page.getByRole("button", {name:/^Project /}).click();
await expect(page.getByRole("button", {name:/apex-deck Tyler’s MacBook/})).toBeDisabled();
await page.goto(`${base}/#pick-three`);
await page.getByRole("button", {name:"Pin project", exact:true}).click();
await expect(page.locator(".mf-project-group").first()).toContainText("Apex-Terminal");
await expect(page.locator(".group").first()).not.toContainText("Daemon logs");
await page.getByRole("button", {name:"Project actions apex-deck Apex-Terminal"}).click();
await page.getByRole("button", {name:"Edit project", exact:true}).click();
await page.getByRole("textbox", {name:"Project name"}).fill("Renamed project");
await page.getByRole("button", {name:"Save project name"}).click();
await expect(page.locator(".mf-project-group").first()).toContainText("Renamed project");
await page.goto(`${base}/#pick-twelve`);
const deny = await page.getByRole("button", {name:"Deny", exact:true}).boundingBox();
const composer = await page.locator(".mf-composer").boundingBox();
expect(deny.y + deny.height).toBeLessThanOrEqual(composer.y);
await page.goto(`${base}/#pick-seventeen`);
await expect(page.getByRole("textbox", {name:"Message this thread"})).toHaveValue("Check the migration row counts.");
await page.goto(`${base}/#pick-fourteen`);
let realWrites = 0;
await page.exposeFunction("realClipboardWrite", () => {realWrites++;});
await page.evaluate(() => { navigator.clipboard.writeText = window.realClipboardWrite; });
await page.getByRole("button", {name:"Copy thread ID", exact:true}).click();
expect(realWrites).toBe(0);
await browser.close();
console.log("Machine flows passed");
