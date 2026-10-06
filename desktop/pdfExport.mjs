// One PDF export. A timeout destroys the hidden window and refuses a late write.
// Two exports do not share this state.

export function beginPdfExport() {
  let state = "open";
  let timer;
  return {
    arm(ms, onTimeout) {
      timer = setTimeout(() => {
        if (state !== "open") return;
        state = "timedout";
        onTimeout();
      }, ms);
    },
    /** True only the first time, and never after a timeout. */
    commit() {
      if (state !== "open") return false;
      state = "done";
      clearTimeout(timer);
      return true;
    },
    abort() {
      if (state === "open") state = "done";
      clearTimeout(timer);
    },
  };
}

/** The hidden window may load its own document and nothing else. */
export function pdfRequestAllowed(url, documentUrl) {
  return url === documentUrl || (typeof url === "string" && url.startsWith("data:"));
}

/** Letter in the US, A4 everywhere else. */
export function pdfPageSize(locale = "") {
  return /^en-US\b/i.test(locale) ? "Letter" : "A4";
}
