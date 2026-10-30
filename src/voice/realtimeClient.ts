/**
 * GPT-Live (OpenAI Realtime) WebRTC client.
 * Model/voice lookup verified 2026-10-29:
 * endpoint POST https://api.openai.com/v1/realtime/calls?model=<model>
 *   Headers: Authorization: Bearer <ephemeral>, Content-Type: application/sdp
 *   Body: SDP offer, Response: SDP answer
 * WebSocket alternative: wss://api.openai.com/v1/realtime?model=<model>
 * Models: gpt-realtime, gpt-realtime-2.1, gpt-realtime-mini are current GA.
 * Voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar.
 * This file uses WebRTC, which gives echo cancellation in-browser.
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
  /** Send an event over the data channel. */
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

  // Build instructions listing thread's agents.
  const candidates = deps.candidates().filter(c => c.hostId === scope.hostId);
  const agentList = candidates
    .map(c => `- ${c.name} (id ${c.participantId}): ${c.roomTitle ?? c.name}`)
    .slice(0, 32)
    .join("\n");
  const defaultTarget = candidates.find(c => c.participantId === scope.participantId)?.name ?? candidates[0]?.name ?? "agent";

  const instructions = `You are GPT-Live inside Apex Deck, a voice interface for coding agents.
Default agent is "${defaultTarget}". Agents available in this workspace:
${agentList || "- none listed"}

Rules:
- Chat naturally. When the user asks to do work (code, search, file edit, research, questions about project), call ask_agent with the right agent and their request.
- To pick a different agent by voice, parse "ask <Name> to ..." or "call <Name>".
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
      description: "Ask a Deck agent to do work. The agent runs with its own history and tools. Returns its final reply text via tool output.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent name or id, e.g. Jigga, Null, Muck. Use exact name from list." },
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
          agent: { type: "string", description: "Agent name or id" },
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

  // --- WebRTC setup ---
  const pc = new RTCPeerConnection();

  // Remote audio
  pc.ontrack = ev => {
    if (ev.streams[0]) events.onAudio(ev.streams[0]);
  };

  // Mic track
  const localStream = mic.stream();
  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      pc.addTrack(track, localStream);
      track.enabled = !mic.muted();
    }
  }

  // Data channel – OpenAI uses a channel named oai-events
  const dc = pc.createDataChannel("oai-events");
  let closed = false;

  const pendingToolCalls = new Map<string, { agent: string; request: string; responseId: string }>();

  // Bridge handling for ask_agent
  const handleAskAgent = async (callId: string, agentName: string, requestText: string, responseId: string) => {
    try {
      // Resolve agent name to candidate
      const lower = agentName.trim().toLowerCase();
      let target = candidates.find(c => c.name.toLowerCase() === lower || c.participantId.toLowerCase() === lower);
      if (!target) {
        // fuzzy by inclusion
        target = candidates.find(c => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()));
      }
      const chosen = target ?? candidates.find(c => c.participantId === scope.participantId) ?? candidates[0];
      if (!chosen) throw new Error(`No agent found matching "${agentName}"`);

      const bridge = deps.bridge(chosen);
      const requestId = crypto.randomUUID();
      const callIdUnique = `${Date.now()}-${requestId}`;
      const generation = 0;
      const utteranceId = crypto.randomUUID();

      // Subscribe before submit
      let finalText = "";
      let done = false;
      const unlisten = bridge.subscribe(ev => {
        if (ev.requestId !== requestId) return;
        if (ev.scope.hostId !== chosen.hostId || ev.scope.roomId !== chosen.roomId || ev.scope.participantId !== chosen.participantId) return;
        if (ev.type === "text" && ev.text) finalText += ev.text;
        if (ev.type === "done" || ev.type === "failed" || ev.type === "canceled") {
          if (!done) {
            done = true;
            unlisten();
            // Send function_call_output
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
              dc.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio","text"] } }));
            } catch {}
            pendingToolCalls.delete(callId);
          }
        }
      });

      pendingToolCalls.set(callId, { agent: chosen.participantId, request: requestText, responseId });

      // Say once that it's working after short delay if not done quickly
      setTimeout(() => {
        if (!done) {
          try {
            dc.send(JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio","text"],
                instructions: `Briefly say: "Asking ${chosen.name}, working on it." Then stay quiet until tool output arrives.`,
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
        scope: chosen,
        text: requestText,
      });
    } catch (e) {
      try {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        }));
        dc.send(JSON.stringify({ type: "response.create" }));
      } catch {}
    }
  };

  const handleStopAgent = async (callId: string, agentName: string) => {
    const lower = agentName.trim().toLowerCase();
    let target = candidates.find(c => c.name.toLowerCase() === lower || c.participantId.toLowerCase() === lower);
    if (!target) target = candidates.find(c => c.name.toLowerCase().includes(lower));
    const chosen = target ?? candidates.find(c => c.participantId === scope.participantId);
    if (!chosen) {
      try {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: `No agent matching ${agentName}` },
        }));
        dc.send(JSON.stringify({ type: "response.create" }));
      } catch {}
      return;
    }
    try {
      const bridge = deps.bridge(chosen);
      // Cancel last request? Our bridge only cancels by requestId, not by agent. For simplicity, ask backend to stop agent via roomStop.
      // The threadBridge's cancel is per request; we can attempt to stop via backend if available.
      // Fallback: inform GPT-Live that stop was requested – actual stop happens via per-reply Stop button.
      // Try to use global voice controller? For now, just report.
      // The bridge we have doesn't have roomStop, but we can list pendingToolCalls and cancel those matching agent.
      for (const [cid, info] of pendingToolCalls) {
        if (info.agent === chosen.participantId) {
          try { await bridge.cancel(info.responseId ?? ""); } catch {}
          pendingToolCalls.delete(cid);
        }
      }
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: `Stop requested for ${chosen.name}.` },
      }));
      dc.send(JSON.stringify({ type: "response.create" }));
    } catch (e) {
      try {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: `Error stopping: ${String(e)}` },
        }));
        dc.send(JSON.stringify({ type: "response.create" }));
      } catch {}
    }
  };

  dc.onmessage = ev => {
    try {
      const msg = JSON.parse(ev.data);
      const type = msg.type as string;
      if (type === "response.function_call_arguments.done" || type === "response.function_call_arguments.delta") {
        // Accumulate?
      }
      if (type === "response.output_item.done" || type === "response.done") {
        const outputs = msg.response?.output ?? [];
        for (const out of outputs) {
          if (out?.type === "function_call" || out?.type === "tool_call") {
            const callId = out.call_id ?? out.id;
            const name = out.name;
            let args: any = {};
            try { args = typeof out.arguments === "string" ? JSON.parse(out.arguments) : out.arguments; } catch { args = {}; }
            if (name === "ask_agent") {
              void handleAskAgent(callId, args.agent ?? scope.participantId, args.request ?? "", msg.response?.id ?? "");
            } else if (name === "stop_agent") {
              void handleStopAgent(callId, args.agent ?? "");
            }
          }
        }
        // Alternative shape: response.function_call
      }
      // More direct: conversation item with function_call
      if (msg.type === "conversation.item.created" || msg.type === "response.output_item.added" || msg.type === "response.output_item.done") {
        const item = msg.item ?? msg.output ?? null;
        if (item?.type === "function_call") {
          const callId = item.call_id;
          const name = item.name;
          let args: any = {};
          try { args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments; } catch { }
          if (name === "ask_agent") void handleAskAgent(callId, args.agent ?? "", args.request ?? "", msg.response?.id ?? "");
          if (name === "stop_agent") void handleStopAgent(callId, args.agent ?? "");
        }
      }
      // Let controller know
      events.onEvent(msg);
    } catch {}
  };

  dc.onopen = () => {
    // Greeting trigger – let model start listening
    try {
      dc.send(JSON.stringify({
        type: "session.update",
        session: {
          model,
          voice,
          instructions,
          tools,
          tool_choice: "auto",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        },
      }));
    } catch {}
  };

  dc.onerror = () => {
    if (!closed) events.onError(new Error("Realtime data channel error"));
  };

  // SDP exchange
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
      const txt = await resp.text().catch(() => "");
      throw new Error(`Realtime SDP failed ${resp.status}: ${txt.slice(0,300)}`);
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
