import test from "node:test";
import assert from "node:assert/strict";
import { beginPdfExport, pdfPageSize, pdfRequestAllowed } from "../desktop/pdfExport.mjs";

test("only the export document and data urls are allowed", () => {
  const doc = "data:text/html;charset=utf-8,%3Chtml%3E";
  assert.equal(pdfRequestAllowed(doc, doc), true);
  assert.equal(pdfRequestAllowed("data:image/png;base64,aaa", doc), true);
  assert.equal(pdfRequestAllowed("https://example.com/x", doc), false);
  assert.equal(pdfRequestAllowed("file:///tmp/secret", doc), false);
  assert.equal(pdfRequestAllowed("http://127.0.0.1/", doc), false);
});

test("page size follows the locale", () => {
  assert.equal(pdfPageSize("en-US"), "Letter");
  assert.equal(pdfPageSize("en-GB"), "A4");
  assert.equal(pdfPageSize(""), "A4");
});

test("a timeout refuses a late write, and a second export is independent", async () => {
  const late = beginPdfExport();
  const other = beginPdfExport();
  await new Promise((resolve) => {
    late.arm(20, resolve);
  });
  assert.equal(late.commit(), false);
  assert.equal(other.commit(), true);
  const writes = [];
  if (late.commit()) writes.push("late");
  if (other.commit()) writes.push("other");
  assert.deepEqual(writes, []);
});
