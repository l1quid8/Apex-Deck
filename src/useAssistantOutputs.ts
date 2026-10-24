// Reads an assistant session's outputs once per set of threads, so the Details
// sidebar can render them without the assistant view caring how they arrived.

import { useEffect, useMemo, useState } from 'react';
import { loadOutputs, type AssistantOutput, type OutputsBackend, type OutputsTask } from './assistantOutputs';

export interface AssistantOutputsState {
  outputs: AssistantOutput[];
  loading: boolean;
  problem: string;
}

export function useAssistantOutputs(backend: OutputsBackend | null | undefined, tasks: OutputsTask[]): AssistantOutputsState {
  // Tasks arrive as a fresh array each render; the threads behind them rarely move.
  const key = tasks.map((task) => `${task.id}:${task.destination?.threadId ?? ''}`).join(',');
  const stable = useMemo(() => tasks, [key]);
  const [state, setState] = useState<AssistantOutputsState>({ outputs: [], loading: Boolean(backend) && Boolean(key), problem: '' });
  useEffect(() => {
    let live = true;
    if (!backend || !key) {
      setState({ outputs: [], loading: false, problem: '' });
      return;
    }
    setState((now) => ({ ...now, loading: true, problem: '' }));
    loadOutputs(backend, stable)
      .then((outputs) => { if (live) setState({ outputs, loading: false, problem: '' }); })
      .catch(() => { if (live) setState({ outputs: [], loading: false, problem: 'Could not read this session’s outputs.' }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in for `stable`.
  }, [backend, key]);
  return state;
}
