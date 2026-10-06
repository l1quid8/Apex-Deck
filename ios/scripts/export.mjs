import fs from "node:fs/promises";
import path from "node:path";
const assets = await fs.readdir("dist/assets");
const js = await fs.readFile(
  path.join(
    "dist/assets",
    assets.find((f) => f.endsWith(".js")),
  ),
  "utf8",
);
const css = await fs.readFile(
  path.join(
    "dist/assets",
    assets.find((f) => f.endsWith(".css")),
  ),
  "utf8",
);
// Scope every prototype selector, including .row/.badge, beneath the export root.
const { default: postcss } = await import("postcss");
const tree = postcss.parse(css);
tree.walkRules((rule) => {
  rule.selectors = rule.selectors.map((selector) => {
    if (selector === ":root" || selector === "body") return "#apex-ios-export";
    return `#apex-ios-export ${selector}`;
  });
});
const scoped = tree.toString();
const svg = await fs.readFile("public/preview.svg");
const bundled = js
  .replaceAll(
    "/preview.svg",
    `data:image/svg+xml;base64,${svg.toString("base64")}`,
  )
  .replaceAll("</script", "<\\/script");
const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Pick the machine · iPhone v1</title><style>${scoped}</style></head><body><div id="apex-ios-export"><div id="root"></div></div><script type="module">${bundled}</script></body></html>`;
await fs.writeFile("../docs/mockups/pick-the-machine-ios-v1.html", html);
console.log("Exported docs/mockups/pick-the-machine-ios-v1.html");
