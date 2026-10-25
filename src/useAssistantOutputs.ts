// Reads an assistant session's outputs once per set of threads, so the Details
// sidebar can render them without the assistant view caring how they arrived.
//
// It also keeps the assistant's own room current: every new reply in its chat is
// promoted with the same rules a thread's replies get (HTML and SVG become
// artifacts with versions; markdown waits, because a fence is usually an
// example). Promotion is best-effort and never breaks the chat — a refused save
// leaves the outputs list as it was rather than throwing into the render.

import { useEffect, useMemo, useRef, useState } from 'react';
import { parseBlocks } from './markdownText';
import { EMPTY_ARTIFACTS, readArtifacts } from './artifacts';
import { assistantRoomId, loadOutputs, mergeOutputs, outputsFromArtifacts, promoteReply, type AssistantOutput, type OutputReply, type OutputsBackend, type OutputsTask } from './assistantOutputs';

export interface AssistantOutputsState {
  outputs: AssistantOutput[];
  loading: boolean;
  problem: string;
}

/** What promotion needs beyond reading: somewhere to put the artifacts. */
export interface OutputsStore extends OutputsBackend {
  artifactsSave(room: string, artifacts: unknown): Promise<void>;
}

const newArtifactId = () => `art-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function useAssistantOutputs(backend: (OutputsBackend & Partial<OutputsStore>) | null | undefined, tasks: OutputsTask[], assistantId?: string, messages: OutputReply[] = []): AssistantOutputsState {
  // Tasks arrive as a fresh array each render; the threads behind them rarely move.
  const key = tasks.map((task) => `${task.id}:${task.destination?.threadId ?? ''}`).join(',');
  const stable = useMemo(() => tasks, [key]);
  const [state, setState] = useState<AssistantOutputsState>({ outputs: [], loading: Boolean(backend) && (Boolean(key) || Boolean(assistantId)), problem: '' });
  useEffect(() => {
    let live = true;
    if (!backend || (!key && !assistantId)) {
      setState({ outputs: [], loading: false, problem: '' });
      return;
    }
    setState((now) => ({ ...now, loading: true, problem: '' }));
    loadOutputs(backend, stable, assistantId)
      .then((outputs) => { if (live) setState({ outputs, loading: false, problem: '' }); })
      .catch(() => { if (live) setState({ outputs: [], loading: false, problem: 'Could not read this session’s outputs.' }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for `stable`.
  }, [backend, key, assistantId]);

  // Replies are promoted once each, tracked by id, so a re-render adds nothing.
  const seen = useRef(new Set<string>());
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : '';
  const messageKey = `${messages.length}:${lastId}`;
  useEffect(() => {
    const writer = backend?.artifactsSave ? (backend as OutputsStore) : null;
    if (!writer || !assistantId) return;
    const fresh = messages.filter((message) => message.role === 'assistant' && !seen.current.has(message.id));
    if (fresh.length === 0) return;
    const room = assistantRoomId(assistantId);
    let live = true;
    void (async () => {
      try {
        const raw = await writer.artifactsLoad(room).catch(() => null);
        let file = raw === null ? EMPTY_ARTIFACTS : readArtifacts(raw);
        let changed = false;
        for (const message of fresh) {
          const code = parseBlocks(message.text).flatMap((block) => (block.kind === 'code' ? [{ language: block.language, text: block.text }] : []));
          const out = promoteReply(file, seen.current, message, code, assistantId, newArtifactId());
          if (out.added) { file = out.file; changed = true; }
        }
        if (!changed) return;
        await writer.artifactsSave(room, file);
        if (!live) return;
        const made = outputsFromArtifacts(file, room);
        setState((now) => ({ ...now, outputs: mergeOutputs(made, now.outputs) }));
      } catch {
        // A refused or failed save leaves the list alone; the reply still shows.
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `messageKey` stands in for `messages`.
  }, [backend, assistantId, messageKey]);
  return state;
}
