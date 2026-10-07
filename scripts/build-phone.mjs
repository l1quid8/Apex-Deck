// Builds only the phone app into dist-phone/, with phone.html as its index, for the iPhone wrapper.
import { build } from "vite";
import { renameSync } from "node:fs";

const outDir = new URL("../dist-phone/", import.meta.url).pathname;
await build({
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: new URL("../phone.html", import.meta.url).pathname },
  },
});
renameSync(`${outDir}phone.html`, `${outDir}index.html`);
