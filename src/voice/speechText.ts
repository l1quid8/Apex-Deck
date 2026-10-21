/** Incremental markdown scanner. Retain trailing delimiters until the next delta. */
export class SpeechText {
  private raw = "";
  private cursor = 0;
  private ticks = 0;
  private fenced = false;
  private inline = false;
  private prose = "";
  private spoken = false;
  private ended = false;
  push(delta: string, final = false): string[] {
    if (this.ended) return [];
    this.raw += delta;
    const out: string[] = [];
    while (this.cursor < this.raw.length) {
      const c = this.raw[this.cursor];
      if (c === "`") {
        let end = this.cursor;
        while (this.raw[end] === "`") end++;
        if (end === this.raw.length && !final) break;
        this.ticks = end - this.cursor;
        if (this.ticks >= 3) {
          this.fenced = !this.fenced;
          if (this.fenced) {
            this.cursor = end;
            const nl = this.raw.indexOf("\n", end);
            if (nl < 0 && !final) {
              this.cursor -= this.ticks;
              this.fenced = false;
              break;
            }
            this.cursor = nl < 0 ? this.raw.length : nl + 1;
            continue;
          }
        } else if (!this.fenced) this.inline = !this.inline;
        this.cursor = end;
        continue;
      }
      this.cursor++;
      if (!this.fenced && !this.inline) this.prose += c;
    }
    // Strip markup, paths and URLs without voicing tool arguments or code.
    this.prose = this.prose
      .replace(/https?:\/\/\S+|(?:\/[\w.-]+){2,}\S*/g, "")
      .replace(/(?:^|\n)\s*(?:#{1,6}|[-*>]|\d+\.)\s+/g, " ")
      .replace(/\*\*/g, "");
    while (this.prose.trim()) {
      const text = this.prose.trimStart();
      const words = [...text.matchAll(/\S+/g)];
      const sentence = /[.!?](?:\s|$)/.exec(text);
      const bound = words.length > 22 ? words[22].index! : Infinity;
      let cut = sentence
        ? Math.min(sentence.index + sentence[0].length, bound)
        : bound;
      if (!Number.isFinite(cut)) {
        if (!final) break;
        cut = text.length;
      }
      if (
        cut === text.length &&
        !final &&
        !/\s$/.test(text) &&
        words.length <= 22
      )
        break;
      const part = text.slice(0, cut).trim();
      this.prose = text.slice(cut);
      if (/[\p{L}\p{N}]/u.test(part)) {
        out.push(part);
        this.spoken = true;
      }
    }
    // Keep parsing memory bounded while preserving the current delimiter state.
    if (this.cursor > 8192) {
      this.raw = this.raw.slice(this.cursor);
      this.cursor = 0;
    }
    if (final) {
      this.ended = true;
      if (!this.spoken) out.push("The result is in the thread.");
    }
    return out;
  }
}
