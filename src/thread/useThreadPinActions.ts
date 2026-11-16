import { useState, useSyncExternalStore } from "react";
import { ThreadPinActions } from "./threadActions";

export function useThreadPinActions() {
  const [actions] = useState(() => new ThreadPinActions());
  const pending = useSyncExternalStore(actions.subscribe, actions.isPending, actions.isPending);
  return { actions, pending };
}
