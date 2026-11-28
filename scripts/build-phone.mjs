// Builds only the phone app into dist-phone/, with phone.html as its index, for the iPhone wrapper.
import { build } from "vite";
import { buildWrapperDocument } from "../desktop/generated-ui/frame-content.mjs";
import { renameSync, writeFileSync } from "node:fs";

const outDir = new URL("../dist-phone/", import.meta.url).pathname;
await build({
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: new URL("../phone.html", import.meta.url).pathname },
  },
});
renameSync(`${outDir}phone.html`, `${outDir}index.html`);
// The dedicated native WebView loads only this trusted template from the bundle.
writeFileSync(`${outDir}generated-widget.html`, buildWrapperDocument({
  runId: "APEX_NATIVE_RUN_ID", revisionDigest: "0".repeat(64),
}, { webKit: true }));
