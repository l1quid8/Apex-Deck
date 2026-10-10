// Speech for the voice call: listening turns the voice into text on this device, and speaking reads replies aloud.
// Only the text ever leaves the device; the assistant never receives audio.

export type Speech = {
  canListen: boolean;
  /** Resolves with the final text once the person stops talking. `onPartial` gets the words so far. */
  listen(onPartial: (text: string) => void): Promise<string>;
  /** Ends listening early, which makes `listen` resolve with what it has. */
  stop(): void;
  speak(text: string): Promise<void>;
  cancelSpeak(): void;
};

type CapacitorSpeech = {
  available(): Promise<{ available: boolean }>;
  requestPermissions(): Promise<{ speechRecognition?: string } | undefined>;
  start(options: { language: string; partialResults: boolean; popup: boolean }): Promise<{ matches?: string[] } | void>;
  addListener(event: "partialResults", callback: (data: { matches?: string[] }) => void): Promise<{ remove(): Promise<void> | void }>;
  stop(): Promise<void> | void;
};

type WebRecognizer = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
};

/** Code fences become a short pointer to the chat; markdown marks are dropped. */
export function spokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " I've put the output in the chat. ")
    .replace(/[`*#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function listenNative(plugin: CapacitorSpeech, onPartial: (text: string) => void): Promise<string> {
  const permission = await plugin.requestPermissions();
  if (permission?.speechRecognition === "denied") throw new Error("Microphone or speech permission is off. Turn it on in Settings.");
  const { available } = await plugin.available();
  if (!available) throw new Error("Speech recognition is not available on this device.");
  let latest = "";
  const handle = await plugin.addListener("partialResults", ({ matches }) => {
    latest = matches?.[0] ?? latest;
    onPartial(latest);
  });
  try {
    const result = await plugin.start({ language: "en-US", partialResults: true, popup: false });
    return ((result && result.matches?.[0]) || latest).trim();
  } finally {
    await handle.remove();
  }
}

function listenWeb(Recognition: new () => WebRecognizer, onPartial: (text: string) => void, keep: (recognizer: WebRecognizer | null) => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const recognizer = new Recognition();
    recognizer.continuous = false;
    recognizer.interimResults = true;
    recognizer.lang = "en-US";
    let latest = "";
    recognizer.onresult = (event) => {
      latest = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join(" ").trim();
      onPartial(latest);
    };
    recognizer.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") resolve(latest);
      else reject(new Error(`Speech recognition stopped: ${event.error ?? "unknown error"}`));
    };
    recognizer.onend = () => {
      keep(null);
      resolve(latest);
    };
    keep(recognizer);
    recognizer.start();
  });
}

/** Picks the best speech support this runtime has, or reports that listening is unavailable. */
export function getSpeech(): Speech {
  const win = globalThis as unknown as Record<string, unknown>;
  const plugin = (win.Capacitor as { Plugins?: { SpeechRecognition?: CapacitorSpeech } } | undefined)?.Plugins?.SpeechRecognition;
  const Recognition = (win.SpeechRecognition ?? win.webkitSpeechRecognition) as (new () => WebRecognizer) | undefined;
  const synth = win.speechSynthesis as { speak(u: unknown): void; cancel(): void } | undefined;
  const Utterance = win.SpeechSynthesisUtterance as (new (text: string) => { onend: (() => void) | null; onerror: (() => void) | null }) | undefined;

  let recognizer: WebRecognizer | null = null;
  let resolveSpeak: (() => void) | null = null;

  return {
    canListen: !!plugin || !!Recognition,
    listen(onPartial) {
      if (plugin) return listenNative(plugin, onPartial);
      if (Recognition) return listenWeb(Recognition, onPartial, (next) => { recognizer = next; });
      return Promise.reject(new Error("Speech recognition is not available here."));
    },
    stop() {
      recognizer?.stop();
      if (plugin) void plugin.stop();
    },
    speak(text) {
      return new Promise<void>((resolve) => {
        const spoken = spokenText(text);
        if (!synth || !Utterance || !spoken) { resolve(); return; }
        const done = () => { if (resolveSpeak === done) resolveSpeak = null; resolve(); };
        resolveSpeak = done;
        const utterance = new Utterance(spoken);
        utterance.onend = done;
        utterance.onerror = done;
        try { synth.speak(utterance); } catch { done(); }
      });
    },
    cancelSpeak() {
      synth?.cancel();
      const pending = resolveSpeak;
      resolveSpeak = null;
      pending?.();
    },
  };
}
