import { resultNotice, updateActions, type UpdateStatus } from "./updates.ts";

/**
 * "X is ready" and, after reopening, how the last update went. They stay until
 * answered, so they are rows under the title bar that push the panes down,
 * never floating toasts over a chat's composer.
 */
export function UpdateNotices({ updates, onRestart }: { updates: UpdateStatus | null; onRestart: () => void }) {
  const ready = updates?.state === "ready" && !updates.dismissed;
  const notice = resultNotice(updates);
  return (
    <>
      {ready && (
        <div className="connection-banner update-banner" role="status">
          <span>Apex Deck {updates.available?.version} is ready.</span>
          <button className="primary" onClick={onRestart}>Restart to update</button>
          <button onClick={() => void updateActions.later()}>Later</button>
        </div>
      )}
      {notice && (
        <div className={`connection-banner update-banner${notice.problem ? " problem" : ""}`} role={notice.problem ? "alert" : "status"}>
          <span>{notice.text}</span>
          <button onClick={() => void updateActions.dismissResult()}>OK</button>
        </div>
      )}
    </>
  );
}
