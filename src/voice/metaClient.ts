/**
 * Meta Voice Transcribe realtime WebSocket client.
 * Endpoints: wss://api.meta.ai/v1/asr/realtime?sessionId=<id>
 * Auth: first JSON frame contains { authorization: { accessToken: "Bearer <META_API_KEY>" }, audioEncoding, model, mode, partialMode }
 * Audio: binary frames of raw PCM16 little-endian mono 24kHz (or 16kHz)
 * Events: speechStart, transcript (partial/final), speechEnd, speechComplete, speaker, audioProgress, error
 * Docs: https://dev.meta.ai/docs/speech-to-text
 */

export type MetaSessionMint = {
  token: string;
  model: string;
};

export type MetaClient = {
  /** Send raw PCM int16 bytes or control frame */
  sendPcm(pcmBytes: ArrayBuffer | Uint8Array): void;
  endStream(): void;
  close(): void;
};

type ConnectOpts = {
  signal?: AbortSignal;
};

export type MetaDependencies = {
  mintSession(args: {
    hostId: string;
    room: string;
    participant?: string;
    model?: string;
  }): Promise<MetaSessionMint>;
};

type TurnState = {
  turnId: number;
  transcript: string;
};

export async function connectMetaAsr(
  deps: MetaDependencies,
  scope: { hostId: string; roomId: string; participantId: string },
  events: {
    onEvent: (e: { type: string; [k: string]: unknown }) => void;
    onTranscript: (transcript: string, turnId: number, isFinal: boolean, utteranceId: string) => void;
    onSpeechStart: (turnId: number) => void;
    onSpeechEnd: (turnId: number) => void;
    onSpeechComplete: (transcript: string, turnId: number, utteranceId: string) => void;
    onError: (error: Error) => void;
    /** Meta ended the stream; closing or aborting from here does not fire this. */
    onClose: (reason: string) => void;
  },
  opts: ConnectOpts = {},
): Promise<MetaClient> {
  const signal = opts.signal;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const minted = await deps.mintSession({
    hostId: scope.hostId,
    room: scope.roomId,
    participant: scope.participantId,
  });

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const model = minted.model || "muse-voice-transcribe-1.0";
  const sessionId = `${scope.hostId}-${scope.roomId}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const uri = `wss://api.meta.ai/v1/asr/realtime?sessionId=${encodeURIComponent(sessionId)}`;

  let closed = false;
  let ws: WebSocket | undefined;
  let dropped = 0;

  // Track active turn for partial replacement logic (CUMULATIVE mode)
  const activeTurns = new Map<number, TurnState>();
  let currentTurnId: number | undefined;
  let utteranceCounter = 0;

  const connectWs = () => {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(uri);
      socket.binaryType = "arraybuffer";
      let handshakeAcked = false;

      const timeout = setTimeout(() => {
        try { socket.close(); } catch {}
        reject(new Error("Meta ASR handshake timeout"));
      }, 15000);

      socket.onopen = () => {
        // Send handshake as first JSON text frame within 10s
        // Capture worklet downsamples mic to 16kHz (see capture-worklet.js), so we
        // must declare PCM_16KHZ here – declaring PCM_24KHZ while sending 16kHz
        // would shift pitch and break endpointing. The wire format remains
        // little-endian int16 mono for both rates.
        const handshake = {
          authorization: { accessToken: `Bearer ${minted.token}` },
          audioEncoding: "PCM_16KHZ",
          model,
          mode: "ENDPOINTING",
          partialMode: "CUMULATIVE",
          emitAudioProgress: false,
        };
        try {
          socket.send(JSON.stringify(handshake));
        } catch (e) {
          clearTimeout(timeout);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };

      socket.onmessage = (msg) => {
        try {
          if (msg.data instanceof ArrayBuffer) return; // Meta server only sends JSON
          const text = typeof msg.data === "string" ? msg.data : "";
          if (!text) return;
          const event = JSON.parse(text) as Record<string, unknown>;

          // First message without type is handshake ack containing sessionId
          if (!handshakeAcked && !event.type && typeof (event as any).sessionId === "string") {
            handshakeAcked = true;
            clearTimeout(timeout);
            resolve(socket);
            events.onEvent({ type: "handshake", sessionId: (event as any).sessionId });
            return;
          }

          const type = event.type as string;
          if (!type) return;

          events.onEvent(event as any);

          if (type === "speechStart") {
            const tid = typeof event.turnId === "number" ? event.turnId : 0;
            currentTurnId = tid;
            activeTurns.set(tid, { turnId: tid, transcript: "" });
            events.onSpeechStart(tid);
          } else if (type === "transcript") {
            const transcript = typeof event.transcript === "string" ? event.transcript : "";
            const isFinal = event.final === true;
            const tid = currentTurnId ?? 0;
            if (activeTurns.has(tid)) {
              activeTurns.get(tid)!.transcript = transcript;
            } else {
              activeTurns.set(tid, { turnId: tid, transcript });
            }
            const utteranceId = `meta-${tid}-${utteranceCounter}`;
            events.onTranscript(transcript, tid, isFinal, utteranceId);
          } else if (type === "speechEnd") {
            const tid = typeof event.turnId === "number" ? event.turnId : currentTurnId ?? 0;
            events.onSpeechEnd(tid);
          } else if (type === "speechComplete") {
            const tid = typeof event.turnId === "number" ? event.turnId : currentTurnId ?? 0;
            const transcript = typeof event.transcript === "string" ? event.transcript : activeTurns.get(tid)?.transcript ?? "";
            activeTurns.delete(tid);
            if (currentTurnId === tid) currentTurnId = undefined;
            const utteranceId = `meta-${tid}-${utteranceCounter++}`;
            events.onSpeechComplete(transcript, tid, utteranceId);
          } else if (type === "error") {
            const msg = typeof event.message === "string" ? event.message : "Meta ASR error";
            events.onError(new Error(msg));
          }
        } catch (e) {
          // Ignore parse errors, keep compatible with future additive events
        }
      };

      socket.onerror = () => {
        if (!handshakeAcked) {
          clearTimeout(timeout);
          reject(new Error("Cannot connect to Meta ASR"));
        } else if (!closed) {
          events.onError(new Error("Meta ASR connection error"));
        }
      };

      socket.onclose = (ev) => {
        clearTimeout(timeout);
        if (!handshakeAcked) {
          reject(new Error(`Meta ASR closed before handshake ack (${ev.code})`));
          return;
        }
        if (!closed) {
          closed = true;
          events.onClose(ev.reason ? `${ev.code}: ${ev.reason}` : String(ev.code));
        }
      };
    });
  };

  ws = await connectWs();

  if (signal?.aborted) {
    closed = true;
    try { ws.close(); } catch {}
    throw new DOMException("Aborted", "AbortError");
  }

  // Wire abort signal
  if (signal) {
    signal.addEventListener("abort", () => {
      closed = true;
      try { ws?.close(); } catch {}
    }, { once: true });
  }

  return {
    sendPcm(data) {
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 32000) {
        if (++dropped === 1 || dropped % 32 === 0)
          console.warn("[voice meta event] " + JSON.stringify({ ts: new Date().toISOString(), event: "micSendDropped", dropped, bytes: data.byteLength, bufferedBytes: ws.bufferedAmount }));
        return;
      }
      try {
        ws.send(data as any);
      } catch {}
    },
    endStream() {
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: "endStream" }));
      } catch {}
    },
    close() {
      if (closed) return;
      closed = true;
      try { ws?.close(); } catch {}
    },
  };
}
