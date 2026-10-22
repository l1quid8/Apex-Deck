// Load the phone app's TypeScript in a node test. CSS is empty. JSX uses the automatic runtime.
import { readFileSync } from "node:fs";
import { transform } from "sucrase";

const extra = [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".css")) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  }
  const relatives = specifier.startsWith(".") || specifier.startsWith("/");
  const candidates = relatives && !/\.(tsx?|jsx?|mjs|css|json)$/.test(specifier)
    ? [specifier, ...extra.map((suffix) => specifier + suffix)]
    : [specifier];
  let last;
  for (const candidate of candidates) {
    try {
      return await nextResolve(candidate, context);
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".css")) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  if (url.endsWith(".ts") || url.endsWith(".tsx") || url.endsWith(".mts")) {
    const source = readFileSync(new URL(url), "utf8");
    const { code } = transform(source, { transforms: ["typescript", "jsx"], jsxRuntime: "automatic", production: true });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
