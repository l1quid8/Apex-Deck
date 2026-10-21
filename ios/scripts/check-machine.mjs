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
// Verify Local chat session in main thread flow, status sheet, and Settings -> Local chat.
await page.goto(`${base}/#pick-one`);
await page.evaluate(() => {
  localStorage.removeItem("apex-deck.ios.gateway-config.v1");
  localStorage.removeItem("apex-deck.ios.thread-history.v1");
});
await page.reload();
await page.getByRole("button", {name:"Settings and Machines", exact:true}).click();
await page.getByRole("button", {name:"Local chat", exact:true}).click();
await expect(page.getByRole("heading", {name:"Local chat", exact:true})).toBeVisible();
// Verify /v1 normalization when pasting a raw host URL without /v1.
await page.getByRole("textbox", {name:"Local chat setup link"}).fill("https://tailscale-host:8787");
await page.getByRole("button", {name:"Save Local chat connection", exact:true}).click();
await expect(page.locator(".phone-content")).toContainText("https://tailscale-host:8787/v1");
await page.getByRole("button", {name:"Open Local chat session", exact:true}).click();
await expect(page.getByRole("button", {name:"Local chat status", exact:true})).toContainText("● Local chat (preview)");
await page.getByRole("button", {name:"Local chat status", exact:true}).click();
await expect(page.getByRole("dialog")).toContainText("Local chat session");
await page.getByRole("button", {name:"Simulate revoked key (401)", exact:true}).click();
await expect(page.getByRole("button", {name:"Local chat status", exact:true})).toContainText("○ Local chat paused — reconnect");
await expect(page.getByRole("button", {name:"Send local chat message", exact:true})).toBeDisabled();
await page.getByRole("button", {name:"Retry connection", exact:true}).click();
await expect(page.getByRole("button", {name:"Local chat status", exact:true})).toContainText("● Local chat (preview)");
await page.getByRole("textbox", {name:"Message local chat"}).fill("@grok test local persistence");
await page.getByRole("button", {name:"Send local chat message", exact:true}).click();
await expect(page.locator(".phone-content")).toContainText("@grok test local persistence");
await page.reload();
await page.getByRole("button", {name:/Weekend architecture/}).first().click();
await expect(page.locator(".phone-content")).toContainText("@grok test local persistence");

// Verify zero-models /v1/models response enters "no-models" state instead of green live pill.
let modelProbes = 0;
await page.route("**/v1/models", async (route) => {
  modelProbes += 1;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ object: "list", data: [] }),
  });
});
await page.evaluate(() => {
  localStorage.setItem(
    "apex-deck.ios.gateway-config.v1",
    JSON.stringify({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "apx_sk_zero_models_test",
      hostLabel: "Zero Host",
      keySuffix: "…est",
    }),
  );
});
await page.goto(`${base}/#local-chat`);
await page.reload();
await expect(page.getByRole("button", { name: "Local chat status", exact: true })).toContainText(
  "○ No models for this key",
);
await expect(page.getByRole("button", { name: "Send local chat message", exact: true })).toBeDisabled();
await expect(page.locator(".mf-banner")).toContainText("This key sees no models");
await page.getByRole("button", { name: "Retry connection", exact: true }).click();
await expect(page.getByRole("button", { name: "Local chat status", exact: true })).toContainText(
  "○ No models for this key",
);
expect(modelProbes).toBeGreaterThanOrEqual(2);
await page.getByRole("button", { name: "Mention a participant", exact: true }).click();
await expect(page.getByRole("dialog").locator("button.row").first()).toBeDisabled();
await page.getByRole("button", { name: "Close sheet", exact: true }).click();
await page.unroute("**/v1/models");
await page.evaluate(() => {
  localStorage.removeItem("apex-deck.ios.gateway-config.v1");
});

// Live daemon end-to-end verification (opt-in via APEX_LIVE_GATEWAY=1 so offline screenshot/capture runs stay self-contained).
if (process.env.APEX_LIVE_GATEWAY === "1") {
  const { spawn, execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const binCandidates = [
    process.env.APEX_DAEMON_BIN,
    path.join(repoRoot, "target/debug/apex-daemon"),
    "/Users/tylercaldwell/Downloads/apex-deck-worktrees/feat-ai-endpoint-wrapper/target/debug/apex-daemon",
    "/Users/tylercaldwell/Downloads/apex-deck/target/debug/apex-daemon",
  ].filter(Boolean);
  const daemonBin = binCandidates.find((p) => fs.existsSync(p));
  if (!daemonBin) {
    throw new Error(`APEX_LIVE_GATEWAY=1 set, but apex-daemon binary was not found in ${binCandidates.join(", ")}`);
  }

  const tempDataDir = fs.mkdtempSync("/tmp/apx-ios-gw-");
  fs.mkdirSync(path.join(tempDataDir, "saved-chats-v1"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDataDir, "saved-chats-v1", "session.json"),
    JSON.stringify({
      profiles: [
        {
          id: "codex-live",
          display_name: "Codex Live",
          access: "read",
          persona: "",
          backend: {
            kind: "scripted",
            lines: ["LIVE_GATEWAY_STREAM_OK 391"],
          },
        },
      ],
    }),
  );

  const gatewayPort = Number(process.env.APEX_LIVE_GATEWAY_PORT || 8788);
  const daemonProc = spawn(
    daemonBin,
    ["serve", "--port", "0", "--gateway-port", String(gatewayPort), "--data-dir", tempDataDir],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let daemonStderr = "";
  daemonProc.stderr?.on("data", (chunk) => {
    daemonStderr += chunk.toString();
  });

  try {
    // Wait for daemon.sock + gateway HTTP port to come up
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const probe = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
        if (probe.status === 401) {
          ready = true;
          break;
        }
      } catch {
        // Still starting
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) {
      throw new Error(`apex-daemon gateway did not start on port ${gatewayPort}: ${daemonStderr}`);
    }

    // Issue a real key over the live daemon socket scoped to `cli` so GET /v1/models returns `scripted/codex-live`
    const issueRaw = execFileSync(
      daemonBin,
      [
        "keys",
        "issue",
        "--label",
        "ios-playwright-live",
        "--scope",
        "cli",
        "--max-turns",
        "2",
        "--data-dir",
        tempDataDir,
      ],
      { encoding: "utf8" },
    );
    const issued = JSON.parse(issueRaw);
    const token = issued.token;
    const keyId = issued.key.id;

    // Seed localStorage with a host URL deliberately missing `/v1` to exercise normalization + live `/v1/models` probe
    const livePage = await browser.newPage();
    await livePage.addInitScript(
      ({ cfgKey, histKey, cfg }) => {
        localStorage.setItem(cfgKey, JSON.stringify(cfg));
        localStorage.removeItem(histKey);
      },
      {
        cfgKey: "apex-deck.ios.gateway-config.v1",
        histKey: "apex-deck.ios.thread-history.v1",
        cfg: {
          baseUrl: `http://127.0.0.1:${gatewayPort}`,
          apiKey: token,
          hostLabel: "Live Daemon",
          keySuffix: `…${token.slice(-3)}`,
        },
      },
    );

    await livePage.goto(`${base}/#local-chat`);
    await expect(livePage.getByRole("button", { name: "Local chat status", exact: true })).toContainText("● Local chat");
    await expect(livePage.getByRole("button", { name: "Local chat status", exact: true })).not.toContainText("(preview)");

    // Stream a real reply from the live daemon's `/v1/chat/completions` SSE endpoint
    await livePage.getByRole("textbox", { name: "Message local chat" }).fill("Verify live gateway SSE");
    await livePage.getByRole("button", { name: "Send local chat message", exact: true }).click();
    await expect(livePage.locator(".phone-content")).toContainText("Verify live gateway SSE");
    await expect(livePage.locator(".phone-content")).toContainText("LIVE_GATEWAY_STREAM_OK 391");
    await expect(livePage.locator(".phone-content")).not.toContainText("Preview reply from");

    // Revoke the key against the live daemon and verify the next send yields a real HTTP 401 and pauses the pill
    execFileSync(daemonBin, ["keys", "revoke", keyId, "--data-dir", tempDataDir], {
      encoding: "utf8",
    });

    await livePage.getByRole("textbox", { name: "Message local chat" }).fill("Message after revoke");
    await livePage.getByRole("button", { name: "Send local chat message", exact: true }).click();
    await expect(livePage.getByRole("button", { name: "Local chat status", exact: true })).toContainText(
      "○ Local chat paused — reconnect",
    );
    await expect(livePage.getByRole("button", { name: "Send local chat message", exact: true })).toBeDisabled();
    await livePage.close();

    // Prove a real `codex/...` subscription model through the iOS UI and exercise `@codex` + family prefix intersection (`matchingForFamily[0]`) without `preferredModels`
    const subIssueRaw = execFileSync(
      daemonBin,
      [
        "keys",
        "issue",
        "--label",
        "ios-playwright-real-codex",
        "--scope",
        "sub",
        "--max-turns",
        "2",
        "--data-dir",
        tempDataDir,
      ],
      { encoding: "utf8" },
    );
    const subIssued = JSON.parse(subIssueRaw);
    const subToken = subIssued.token;

    const codexPage = await browser.newPage();
    await codexPage.addInitScript(
      ({ cfgKey, histKey, cfg, sessions }) => {
        localStorage.setItem(cfgKey, JSON.stringify(cfg));
        localStorage.setItem(histKey, JSON.stringify(sessions));
      },
      {
        cfgKey: "apex-deck.ios.gateway-config.v1",
        histKey: "apex-deck.ios.thread-history.v1",
        cfg: {
          baseUrl: `http://127.0.0.1:${gatewayPort}`,
          apiKey: subToken,
          hostLabel: "Live Daemon",
          keySuffix: `…${subToken.slice(-3)}`,
        },
        sessions: [
          {
            id: "lc-real-codex",
            title: "Real Codex verification",
            bots: ["Claude", "Codex"],
            messages: [],
            updatedAt: "now",
            pinned: true,
          },
        ],
      },
    );

    await codexPage.goto(`${base}/#local-chat`);
    await expect(codexPage.getByRole("button", { name: "Local chat status", exact: true })).toContainText("● Local chat");
    await codexPage
      .getByRole("textbox", { name: "Message local chat" })
      .fill("@codex Reply with the exact text REAL_CODEX_IOS_OK 42 and nothing else.");
    await codexPage.getByRole("button", { name: "Send local chat message", exact: true }).click();
    await expect(codexPage.locator(".phone-content")).toContainText("gpt-6.1-sol", { timeout: 60000 });
    await expect(codexPage.locator(".phone-content")).toContainText("REAL_CODEX_IOS_OK 42", { timeout: 60000 });
    await codexPage.close();
    console.log("Live gateway Playwright block passed (scripted + real codex/...)");
  } finally {
    try {
      process.kill(-daemonProc.pid, "SIGTERM");
    } catch {
      daemonProc.kill("SIGTERM");
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
} else {
  console.log("Skipping live gateway daemon block (set APEX_LIVE_GATEWAY=1 to run)");
}
await browser.close();
console.log("Machine flows passed");
