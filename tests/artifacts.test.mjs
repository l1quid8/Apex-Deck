import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_ARTIFACTS, MAX_SOURCE, addArtifact, addVersion, ago, codeChoices, exportName, kindOf, newestFirst, pickVersion, readArtifacts, titleFor } from "../src/artifacts.ts";

const v = (source, extra = {}) => ({ source, by: "ada", seq: 1, at: 1000, ...extra });

test("code block languages map to the kinds that can open", () => {
  assert.equal(kindOf("html", "<p>"), "html");
  assert.equal(kindOf("HTM", "<p>"), "html");
  assert.equal(kindOf("svg", "<svg>"), "svg");
  assert.equal(kindOf("xml", '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>'), "svg");
  assert.equal(kindOf("", '  <svg width="1"></svg>'), "svg");
  assert.equal(kindOf("", "<!DOCTYPE html><html></html>"), "html");
  assert.equal(kindOf("markdown", "# Hi"), "markdown");
  assert.equal(kindOf("md", "# Hi"), "markdown");
  for (const [language, text] of [["js", "alert(1)"], ["", "plain text"], ["xml", "<note/>"], ["mermaid", "flowchart LR"]]) {
    assert.equal(kindOf(language, text), null, language);
  }
});

test("titles come from the page, a heading, or the kind", () => {
  assert.equal(titleFor("html", "<html><head><title>Welcome &amp; hello</title></head><body><h1>Other</h1></body></html>"), "Welcome & hello");
  assert.equal(titleFor("html", '<body><h1 class="x">Your next <em>idea</em>.</h1></body>'), "Your next idea.");
  assert.equal(titleFor("markdown", "Intro\n\n## Launch *checklist*\n"), "Launch checklist");
  assert.equal(titleFor("svg", "<svg><title>App icon</title></svg>"), "App icon");
  assert.equal(titleFor("svg", "<svg></svg>"), "SVG image");
  assert.equal(titleFor("html", "<p>no heading</p>"), "HTML page");
  assert.equal(titleFor("markdown", "no heading"), "Document");
  assert.equal(titleFor("html", `<title>${"x".repeat(80)}</title>`), `${"x".repeat(59)}…`);
});

test("a new artifact starts at v1, and a new version is numbered after the last", () => {
  const { file, artifact } = addArtifact(EMPTY_ARTIFACTS, "a", "html", v("<title>Page</title>"));
  assert.deepEqual(artifact, { id: "a", title: "Page", kind: "html", versions: [{ n: 1, source: "<title>Page</title>", by: "ada", seq: 1, at: 1000 }] });
  const second = addVersion(file, "a", v("<title>Page</title><p>2</p>", { by: "ben", seq: 4, at: 2000 }));
  assert.equal(second.n, 2);
  assert.equal(second.file.artifacts[0].versions[1].by, "ben");
  assert.equal(second.file.artifacts[0].title, "Page", "the title stays what v1 gave it");
});

test("the same text as the newest version adds nothing, and an unknown artifact is left alone", () => {
  const { file } = addArtifact(EMPTY_ARTIFACTS, "a", "html", v("<p>1</p>"));
  const same = addVersion(file, "a", v("<p>1</p>", { seq: 9 }));
  assert.equal(same.file, file);
  assert.equal(same.n, 1);
  assert.deepEqual(addVersion(file, "missing", v("<p>2</p>")), { file, n: 0 });
});

test("a code block knows the version it was opened as", () => {
  const { file } = addArtifact(EMPTY_ARTIFACTS, "a", "html", v("<p>1</p>", { seq: 3 }));
  assert.deepEqual(codeChoices(file, 3, "html", "<p>1</p>").opened, { artifactId: "a", n: 1 });
  assert.equal(codeChoices(file, 4, "html", "<p>1</p>").opened, null, "the same text in another reply hasn't been opened");
  assert.equal(codeChoices(file, 3, "js", "x"), null);
});

test("a block can become a new version of up to three artifacts of its kind, newest first", () => {
  let file = EMPTY_ARTIFACTS;
  for (const [id, at] of [["a", 1], ["b", 4], ["c", 2], ["d", 3]]) file = addArtifact(file, id, "html", v(`<p>${id}</p>`, { at })).file;
  file = addArtifact(file, "s", "svg", v("<svg></svg>", { at: 9 })).file;
  const choices = codeChoices(file, 99, "html", "<p>new</p>");
  assert.deepEqual(choices.targets.map((t) => t.id), ["b", "d", "c"]);
  assert.deepEqual(choices.targets[0], { id: "b", title: "HTML page", next: 2 });
  assert.equal(choices.tooLarge, false);
  assert.equal(codeChoices(file, 99, "html", "x".repeat(MAX_SOURCE + 1)).tooLarge, true);
});

test("a saved file is read back, and damage loses only the damaged parts", () => {
  const raw = { version: 1, artifacts: [
    { id: "a", title: "Page", kind: "html", versions: [{ source: "<p>1</p>", by: "ada", seq: 2, at: 5 }, { source: 42 }, { source: "<p>2</p>", by: 7, seq: "x" }] },
    { id: "a", title: "Repeat", kind: "html", versions: [{ source: "x" }] },
    { id: "b", kind: "mermaid", versions: [{ source: "x" }] },
    { id: "c", kind: "svg", versions: [] },
    { id: "d", title: "  ", kind: "markdown", versions: [{ source: "# Notes" }] },
    "junk",
  ] };
  const file = readArtifacts(raw);
  assert.deepEqual(file.artifacts.map((a) => a.id), ["a", "d"]);
  assert.deepEqual(file.artifacts[0].versions, [
    { n: 1, source: "<p>1</p>", by: "ada", seq: 2, at: 5 },
    { n: 2, source: "<p>2</p>", by: null, seq: null, at: 0 },
  ]);
  assert.equal(file.artifacts[1].title, "Notes", "a missing title comes from the first version");
  assert.deepEqual(readArtifacts(null), EMPTY_ARTIFACTS);
  assert.deepEqual(readArtifacts({ artifacts: "nope" }), EMPTY_ARTIFACTS);
});

test("the panel shows the asked-for version, or the newest", () => {
  let file = addArtifact(EMPTY_ARTIFACTS, "a", "html", v("<p>1</p>", { at: 1 })).file;
  file = addVersion(file, "a", v("<p>2</p>", { at: 3 })).file;
  file = addArtifact(file, "b", "svg", v("<svg></svg>", { at: 2 })).file;
  assert.equal(pickVersion(file, "a", 1).version.source, "<p>1</p>");
  assert.equal(pickVersion(file, "a", null).version.n, 2);
  assert.equal(pickVersion(file, "a", 7).version.n, 2);
  assert.equal(pickVersion(file, null, null).artifact.id, "a", "the most recently changed");
  assert.equal(pickVersion(file, "gone", null).artifact.id, "a");
  assert.equal(pickVersion(EMPTY_ARTIFACTS, null, null), null);
  assert.deepEqual(newestFirst(file).map((a) => a.id), ["a", "b"]);
});

test("times read as a few words, and export names are safe file names", () => {
  assert.equal(ago(0, 30_000), "just now");
  assert.equal(ago(0, 2 * 60_000), "2m ago");
  assert.equal(ago(0, 3 * 3_600_000), "3h ago");
  assert.equal(ago(0, 2 * 86_400_000), "2d ago");
  assert.equal(ago(5000, 0), "just now");
  assert.equal(exportName({ title: "Welcome email!", kind: "html" }, 3), "welcome-email-v3.html");
  assert.equal(exportName({ title: "App icon", kind: "svg" }, 1), "app-icon-v1.svg");
  assert.equal(exportName({ title: "✓✓", kind: "markdown" }, 2), "artifact-v2.md");
});

test("a finished reply's last HTML or SVG fence becomes an artifact", async () => {
  const { fromReply } = await import("../src/artifacts.ts");
  const code = [{ language: "html", text: "<p>one</p>" }, { language: "js", text: "x()" }, { language: "svg", text: "<svg></svg>" }];
  const out = fromReply(EMPTY_ARTIFACTS, code, v(""), "a1");
  assert.equal(out.artifact.kind, "svg");
  assert.equal(out.artifact.versions[0].source, "<svg></svg>");
  assert.equal(out.artifact.versions[0].seq, 1);
  assert.equal(fromReply(out.file, code, v(""), "a2").artifact, null, "the same reply adds nothing twice");
});

test("markdown, other languages and oversized fences don't open on their own", async () => {
  const { fromReply } = await import("../src/artifacts.ts");
  assert.equal(fromReply(EMPTY_ARTIFACTS, [{ language: "md", text: "# Hi" }], v(""), "a").artifact, null);
  assert.equal(fromReply(EMPTY_ARTIFACTS, [{ language: "ts", text: "<p>" }], v(""), "a").artifact, null);
  assert.equal(fromReply(EMPTY_ARTIFACTS, [{ language: "html", text: "x".repeat(MAX_SOURCE + 1) }], v(""), "a").artifact, null);
});
