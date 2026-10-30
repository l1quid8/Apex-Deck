/**
/**
 * GPT-Live (OpenAI Realtime) WebRTC client – GA schema 2026-10-29+
 * Endpoints: POST /v1/realtime/client_secrets (daemon, Bearer api key -> ek_)
 *            POST /v1/realtime/calls?model=<model> (browser, Bearer ek_ -> SDP answer)
 * GA nested: session.type=realtime, session.audio.input.transcription, turn_detection,
 *            audio.output.voice, expires_after. Response uses output_modalities.
 * Models: gpt-realtime, gpt-realtime-2.1, gpt-realtime-mini.
 * Voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar.
 * Verified via OpenAI Realtime docs client_secrets reference 2026-10-29.
 */

import type { VoiceCandidate, CallScope, VoiceSettings } from "./types.ts";

export const REALTIME_MODEL_DEFAULT = "gpt-realtime";
export const REALTIME_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
] as const;

export type RealtimeSessionMint = {
  client_secret: string;
  expires_at?: number;
  model: string;
  voice: string;
};

export interface RealtimeClient {
  send(event: Record<string, unknown>): void;
  close(reason?: string): void;
}

export type RealtimeDependencies = {
  mintSession(args: {
    room: string;
    participant?: string;
    model?: string;
    voice?: string;
    instructions?: string;
    tools?: unknown[];
  }): Promise<RealtimeSessionMint>;
  candidates(): VoiceCandidate[];
  bridge(scope: CallScope): import("./types.ts").ThreadVoiceBridge;
  voiceSettings(): VoiceSettings;
};

type ToolCallInfo = {
  argumentJson: string;
  name?: string;
};

export async function connectRealtime(
  deps: RealtimeDependencies,
  scope: CallScope,
  events: {
    onEvent: (e: { type: string; [k: string]: unknown }) => void;
    onAudio: (stream: MediaStream) => void;
    onError: (error: Error) => void;
    onClose: (reason: string) => void;
  },
  mic: { muted(): boolean; stream(): MediaStream | null },
): Promise<RealtimeClient> {
  const settings = deps.voiceSettings();
  const model = REALTIME_MODEL_DEFAULT;
  const realtimeVoice = (settings.realtimeVoice ?? "verse").toLowerCase();
  const voice = REALTIME_VOICES.includes(realtimeVoice as any) ? realtimeVoice : "verse";

  // Strictly same thread – prevents routing across rooms.
  const all = deps.candidates();
  const candidates = all.filter(c => c.hostId === scope.hostId && c.roomId === scope.roomId);
  const agentList = candidates
    .map(c => `- ${c.name} (id ${c.participantId})`)
    .slice(0, 32)
    .join("\n");
  const defaultTarget = candidates.find(c => c.participantId === scope.participantId)?.name ?? candidates[0]?.name ?? "agent";

  const instructions = `You are GPT-Live inside Apex Deck, a voice interface for coding agents.
Default agent is "${defaultTarget}". Agents available in THIS thread only:
${agentList || "- none listed"}

Rules:
- Chat naturally. When the user asks to do work (code, search, file edit, research, questions about project), call ask_agent with the right agent and their request.
- To pick a different agent by voice, parse "ask <Name> to ..." or "call <Name>".
- If the user mentions an agent not in this thread's list, say that agent is not in this thread and ask who to use from the list.
- Keep your own small talk brief. Do not invent file contents.
- When an agent is working, say once that it's working, then stay quiet until the result arrives. Do not spam "On it."
- Speak the agent's final result closely, not adding extra facts.
- If you need to stop an agent's current reply, call stop_agent.
- Ending or muting the call never cancels agent work.
`;

  const tools = [
    {
      type: "function",
      name: "ask_agent",
      description: "Ask a Deck agent to do work. The agent runs with its own history and tools.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name or id from thread list" },
          request: { type: "string", description: "The user request to send to that agent." },
        },
        required: ["agent", "request"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "stop_agent",
      description: "Stop a specific agent's current reply, per-reply Stop.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name or id from thread list" },
        },
        required: ["agent"],
        additionalProperties: false,
      },
    },
  ];

  let minted: RealtimeSessionMint;
  try {
    minted = await deps.mintSession({
      room: scope.roomId,
      participant: scope.participantId,
      model,
      voice,
      instructions,
      tools,
    });
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }

  const pc = new RTCPeerConnection();

  pc.ontrack = ev => {
    if (ev.streams[0]) events.onAudio(ev.streams[0]);
  };

  const localStream = mic.stream();
  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      pc.addTrack(track, localStream);
      track.enabled = !mic.muted();
    }
  }

  const dc = pc.createDataChannel("oai-events");
  let closed = false;

  // Deduplication + argument accumulation for function calls
  const pendingArgs = new Map<string, ToolCallInfo>();
  const handledCalls = new Set<string>();
  type PendingSubmission = { requestId: string; bridgeScope: CallScope };
  const pendingSubmissions = new Map<string, PendingSubmission>();

  const resolveAgent = (nameRaw: string): VoiceCandidate | { ambiguous: true; names: string[] } | null => {
    const lower = nameRaw.trim().toLowerCase();
    if (!lower) return null;
    const byExact = candidates.filter(c => c.name.toLowerCase() === lower || c.participantId.toLowerCase() === lower);
    if (byExact.length === 1) return byExact[0];
    if (byExact.length > 1) return { ambiguous: true, names: byExact.map(c => c.name) };
    // For voice routing we allow no fuzzy include to avoid cross-name collisions; require exact.
    // If user typed "Ask j" we still want default.
    return null;
  };

  const handleAskAgent = async (callId: string, agentName: string, requestText: string) => {
    if (handledCalls.has(callId)) return;
    handledCalls.add(callId);
    try {
      const resolved = resolveAgent(agentName);
      if (resolved && "ambiguous" in resolved) {
        throw new Error(`Ambiguous agent "${agentName}": ${resolved.names.join(", ")}. Say exactly one name from this thread.`);
      }
      let target: VoiceCandidate | undefined;
      if (resolved && !("ambiguous" in resolved)) target = resolved as VoiceCandidate;
      else {
        // If user didn't specify or name unknown, use default participant if present
        target = candidates.find(c => c.participantId === scope.participantId) ?? candidates[0];
        if (agentName && agentName.trim().toLowerCase() !== (target?.name.toLowerCase() ?? "") && agentName.trim().toLowerCase() !== (target?.participantId.toLowerCase() ?? "")) {
          throw new Error(`No agent named "${agentName}" in this thread. Available: ${candidates.map(c => c.name).join(", ") || "none"}.`);
        }
      }
      if (!target) throw new Error(`No agent found matching "${agentName}"`);

      const bridge = deps.bridge(target);
      const requestId = crypto.randomUUID();
      const callIdUnique = `${Date.now()}-${requestId}`;
      const generation = 0;
      const utteranceId = crypto.randomUUID();

      let finalText = "";
      let done = false;
      const unlisten = bridge.subscribe(ev => {
        if (ev.requestId !== requestId) return;
        if (ev.scope.hostId !== target.hostId || ev.scope.roomId !== target.roomId || ev.scope.participantId !== target.participantId) return;
        if (ev.type === "text" && ev.text) finalText += ev.text;
        if (ev.type === "done" || ev.type === "failed" || ev.type === "canceled") {
          if (!done) {
            done = true;
            unlisten();
            pendingSubmissions.delete(callId);
            const output = ev.type === "failed" ? `Agent failed: ${ev.text ?? ""}` : finalText || "(no reply)";
            try {
              dc.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output,
                },
              }));
              dc.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio","text"] } }));
            } catch {}
          }
        }
      });

      pendingSubmissions.set(callId, { requestId, bridgeScope: target });

      setTimeout(() => {
        if (!done) {
          try {
            dc.send(JSON.stringify({
              type: "response.create",
              response: {
                instructions: `Briefly say: "Asking ${target!.name}, working on it." Then stay quiet until tool output arrives.`,
                output_modalities: ["audio","text"],
              },
            }));
          } catch {}
        }
      }, 800);

      await bridge.submit({
        callId: callIdUnique,
        generation,
        utteranceId,
        requestId,
        scope: target,
        text: requestText,
      });
    } catch (e) {
      pendingSubmissions.delete(callId);
      try {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        }));
        dc.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio","text"] } }));
      } catch {}
    }
  };

  const handleStopAgent = async (callId: string, agentName: string) => {
    if (handledCalls.has(callId)) return;
    handledCalls.add(callId);
    const resolved = resolveAgent(agentName);
    if (resolved && "ambiguous" in resolved) {
      try {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: `Ambiguous agent "${agentName}": ${resolved.names.join(", ")}` },
        }));
        dc.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio","text"] } }));
      } catch {}
      return;
    }
    let target: VoiceCandidate | undefined;
    if (resolved) target = resolved as VoiceCandidate;
    else {
      // No exact match – reject, don't stop default implicitly for stop
      try {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: `No agent named "${agentName}" in this thread. Available: ${candidates.map(c => c.name).join(", ") || "none"}.` },
        }));
        dc.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio","text"] } }));
      } catch {}
      return;
    }

    try {
      const bridge = deps.bridge(target);
      let canceled = 0;
      for (const [cId, info] of [...pendingSubmissions.entries()]) {
        if (info.bridgeScope.participantId === target.participantId) {
          try { await bridge.cancel(info.requestId); canceled++; } catch {}
          pendingSubmissions.delete(cId);
        }
      }
      if (canceled === 0) {
        // Also try last request via bridge cancel with no id interpreted as latest? We only have requestId map.
        // Tell user nothing pending.
      }
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: canceled > 0 ? `Stop requested for ${target.name}.` : `No pending work for ${target.name}.` },
      }));
      dc.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio","text"] } }));
    } catch (e) {
      try {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: `Error stopping: ${String(e)}` },
        }));
        dc.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio","text"] } }));
      } catch {}
    }
  };

  const dispatchFunctionCall = (callId: string, name: string, rawArgs: string | object) => {
    if (!callId) return;
    let args: any = {};
    try { args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs ?? {}; } catch { args = {}; }
    if (name === "ask_agent") void handleAskAgent(callId, args.agent ?? "", args.request ?? "");
    else if (name === "stop_agent") void handleStopAgent(callId, args.agent ?? "");
  };

  dc.onmessage = ev => {
    try {
      const msg = JSON.parse(ev.data);
      const type = msg.type as string;

      // Argument delta accumulation (server_vad tool call streaming)
      if (type === "response.function_call_arguments.delta") {
        const callId = msg.call_id ?? msg.item_id ?? "";
        if (callId) {
          const prev = pendingArgs.get(callId) ?? { argumentJson: "" };
          prev.argumentJson += msg.delta ?? "";
          if (msg.name) prev.name = msg.name;
          pendingArgs.set(callId, prev);
        }
      } else if (type === "response.function_call_arguments.done") {
        const callId = msg.call_id ?? "";
        const info = pendingArgs.get(callId);
        const name = msg.name ?? info?.name ?? "";
        const argsStr = msg.arguments ?? info?.argumentJson ?? "{}";
        pendingArgs.delete(callId);
        dispatchFunctionCall(callId, name, argsStr);
      } else if (type === "response.output_item.done" || type === "response.output_item.added" || type === "response.done" || type === "conversation.item.created") {
        // GA shapes – output items
        const response = msg.response ?? null;
        const items: any[] = (() => {
          if (response?.output) return response.output as any[];
          if (msg.item) return [msg.item];
          if (msg.output) return [msg.output];
          return [];
        })();
        for (const out of items) {
          if (out?.type === "function_call") {
            const callId = out.call_id ?? out.id;
            const name = out.name;
            const args = out.arguments;
            if (callId && name && !handledCalls.has(callId)) {
              dispatchFunctionCall(callId, name, args);
            }
          }
        }
      }

      events.onEvent(msg);
    } catch {}
  };

  dc.onopen = () => {
    try {
      dc.send(JSON.stringify({
        type: "session.update",
        session: {
          model,
          instructions,
          audio: {
            input: {
              transcription: { model: "whisper-1" },
              turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
            },
            output: { voice },
          },
          tools,
          tool_choice: "auto",
        },
      }));
    } catch {}
  };

  dc.onerror = () => {
    if (!closed) events.onError(new Error("Realtime data channel error"));
  };

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
  await pc.setLocalDescription(offer);

  let answerSdp: string;
  try {
    const resp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${minted.client_secret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp ?? "",
    });
    if (!resp.ok) {
      throw new Error(`Realtime SDP failed ${resp.status}`);
    }
    answerSdp = await resp.text();
  } catch (e) {
    pc.close();
    throw e instanceof Error ? e : new Error(String(e));
  }

  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  return {
    send(event) {
      try { dc.send(JSON.stringify(event)); } catch {}
    },
    close(reason = "closed") {
      if (closed) return;
      closed = true;
      try { dc.close(); } catch {}
      try { pc.close(); } catch {}
      events.onClose(reason);
    },
  };
}
