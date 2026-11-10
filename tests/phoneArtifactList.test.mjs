import test from "node:test";
import assert from "node:assert/strict";
import { artifactListNote, artifactRows, sizeWords, versionLook, versionWords } from "../src/phone/artifactList.ts";

const file = {
  version: 1,
  artifacts: [
    { id: "old", title: "Pricing page", kind: "html", versions: [
      { n: 1, source: "<html><title>Pricing</title></html>", by: "null", seq: 3, at: 1_000 },
      { n: 2, source: "<html><title>Pricing</title> v2</html>", by: "null", seq: 9, at: 5_000 },
    ] },
    { id: "new", title: "Flow", kind: "svg", path: "diagrams/flow.svg", versions: [
      { n: 1, source: "<svg/>", by: "jigga", seq: 12, at: 9_000 },
    ] },
    { id: "doc", title: "Notes", kind: "markdown", versions: [
      { n: 1, source: "# Notes\n", by: null, seq: null, at: 7_000 },
    ] },
  ],
};

const now = 9_000 + 4 * 60_000;

test("the list is most recently changed first, not the order they were made", () => {
  assert.deepEqual(artifactRows(file, now).map((row) => row.id), ["new", "doc", "old"]);
});

test("a row names its kind, counts its versions and says when the newest came", () => {
  const [svg, , html] = artifactRows(file, now);
  assert.equal(svg.kind, "SVG");
  assert.equal(svg.versions, "1 version");
  assert.equal(svg.when, "4m ago");
  assert.equal(svg.path, "diagrams/flow.svg");
  assert.equal(html.kind, "HTML");
  assert.equal(html.versions, "2 versions");
  // The newest version came 4 minutes ago, not the first one 9 minutes ago.
  assert.equal(html.when, "4m ago");
  assert.equal(html.path, null);
});

test("nothing to show is said plainly, and says nothing at all when there is something", () => {
  assert.match(artifactListNote(0), /^No artifacts yet\./);
  assert.equal(artifactListNote(2), "");
});

test("a version line counts from one and carries the size and age", () => {
  const [svg] = artifactRows(file, now);
  const artifact = file.artifacts.find((item) => item.id === svg.id);
  assert.equal(versionWords(artifact, artifact.versions[0], now), "Version 1 of 1 · SVG · 6 B · 4m ago");
  const html = file.artifacts.find((item) => item.id === "old");
  assert.equal(versionWords(html, html.versions[1], now), "Version 2 of 2 · HTML · 38 B · 4m ago");
});

test("sizes read as bytes, then one decimal of KB under ten, then whole KB, then MB", () => {
  assert.equal(sizeWords(0), "0 B");
  assert.equal(sizeWords(840), "840 B");
  assert.equal(sizeWords(1_024), "1.0 KB");
  assert.equal(sizeWords(6_348), "6.2 KB");
  assert.equal(sizeWords(20_480), "20 KB");
  assert.equal(sizeWords(1_468_006), "1.4 MB");
  assert.equal(sizeWords(-5), "0 B");
});

test("markdown is shown as text; pages run in the Mac's sandboxed frame", () => {
  assert.equal(versionLook("markdown"), "text");
  assert.equal(versionLook("html"), "frame");
  assert.equal(versionLook("svg"), "frame");
});
