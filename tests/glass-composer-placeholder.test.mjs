import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/glass-theme.css", import.meta.url), "utf8");

test("Liquid's composer placeholder follows the theme's muted colour", () => {
  const rule = /:root:is\(\[data-deck-theme="glass"\], \[data-deck-theme="flat"\]\) \.composer:not\(\.tldr, \.plan\) \.composer-box textarea::placeholder\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "Liquid needs its own composer placeholder rule");
  assert.match(rule[1], /color:\s*var\(--deck-muted\)/);
});
