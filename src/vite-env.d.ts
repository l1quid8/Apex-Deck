/// <reference types="vite/client" />

/** package.json's version, set in vite.config.ts. */
declare const __APP_VERSION__: string;
/** The commit this interface was built from, set in vite.config.ts; "unknown" without git. */
declare const __APP_BUILD__: { commit: string; dirty: boolean };
