import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_ARTIFACTS, addArtifact, kindForPath, readArtifacts, upsertFromFile } from "../src/artifacts.ts";
import { pathLike } from "../src/markdownText.ts";

const v = (source, extra = {}) => ({ source, by: "ada", seq: 4, at: 1000, ...extra });

test("file extensions map to the kinds the pane can show", () => {
  assert.equal(kindForPath("mockups/pill.html"), "html");
  assert.equal(kindForPath("/a/B.HTM"), "html");
  assert.equal(kindForPath("logo.svg"), "svg");
  assert.equal(kindForPath("docs/plan.md"), "markdown");
  assert.equal(kindForPath("README.markdown"), "markdown");
  assert.equal(kindForPath("src/app.ts"), null);
  assert.equal(kindForPath("html"), null);
});

test("a written file becomes an artifact that remembers its path", () => {
  const { file, artifact, added } = upsertFromFile(EMPTY_ARTIFACTS, "mockups/pill.html", v("<title>Pill</title>"), "a1");
  assert.equal(added, true);
  assert.equal(artifact.path, "mockups/pill.html");
  assert.equal(artifact.title, "Pill");
  assert.equal(artifact.kind, "html");
  assert.equal(file.artifacts.length, 1);
});

test("writing the same path again adds a version, not a second artifact", () => {
  let { file } = upsertFromFile(EMPTY_ARTIFACTS, "a.md", v("# One"), "a1");
  const again = upsertFromFile(file, "a.md", v("# Two", { seq: 6 }), "a2");
  assert.equal(again.added, true);
  assert.equal(again.file.artifacts.length, 1);
  assert.equal(again.artifact.versions.length, 2);
  const same = upsertFromFile(again.file, "a.md", v("# Two", { seq: 7 }), "a3");
  assert.equal(same.added, false);
  assert.equal(same.file, again.file);
});

test("a file of a kind the pane can't show is left alone", () => {
  const out = upsertFromFile(EMPTY_ARTIFACTS, "x.ts", v("let a"), "a1");
  assert.equal(out.added, false);
  assert.equal(out.artifact, null);
});

test("the path survives saving and reading back; artifacts from code have none", () => {
  const { file } = upsertFromFile(EMPTY_ARTIFACTS, "p.svg", v("<svg></svg>"), "a1");
  const both = addArtifact(file, "a2", "html", v("<p>")).file;
  const read = readArtifacts(JSON.parse(JSON.stringify(both)));
  assert.equal(read.artifacts[0].path, "p.svg");
  assert.equal(read.artifacts[1].path, undefined);
});

test("code spans that look like file paths", () => {
  for (const yes of ["mockups/tldr-pill.html", "src/app.rs:42", "./a.md", "~/notes/x.txt", "/Users/a/b.png", "README.md", "src/", "Cargo.toml"])
    assert.ok(pathLike(yes), yes);
  for (const no of ["useState", "npm run dev", "a.b", "1.5", "http://x.com/a.html", "foo()", "e.g.", "x => y", "", "v1.2.3", "obj.method"])
    assert.ok(!pathLike(no), no);
});
