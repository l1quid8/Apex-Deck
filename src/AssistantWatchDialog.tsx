import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { ParticipantConfig } from './types';
import { compatibleMonitorProfiles, defaultMonitorProfileId, parseProjectFiles, type ProjectMonitor } from './apexAgentModel';
import './apex-agent-sources.css';

export type ProjectChat = { id: string; title: string };
export type WatchSettings = { text: string; files: string[]; threads: string[]; profile: ParticipantConfig };

/** A project's Watch form. Watching is optional: delegating never needs it, and Stop leaves running jobs alone. */
export function AssistantWatchDialog({ project, assistantName, monitor, profiles, chats, busy, error, onClose, onSubmit, onStop }: {
  project: string;
  assistantName: string;
  /** The project's coordinator, if it has one. Connected and stopped projects have checks off. */
  monitor: ProjectMonitor | null;
  profiles: ParticipantConfig[];
  chats: ProjectChat[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (settings: WatchSettings) => void;
  onStop: () => void;
}) {
  const on = !!monitor && !monitor.checksOff;
  const earlier = !!monitor?.responsibility;
  const choices = useMemo(() => compatibleMonitorProfiles(profiles), [profiles]);
  const [profileId, setProfileId] = useState(() => {
    if (earlier) return choices.some((profile) => profile.id === monitor!.profileId) ? monitor!.profileId : '';
    return defaultMonitorProfileId(choices, window.localStorage?.getItem('apex-agent-profile') ?? null);
  });
  const [duty, setDuty] = useState(monitor?.responsibility ?? '');
  const [threads, setThreads] = useState(() => earlier ? monitor!.threads : chats.slice(-3).map((chat) => chat.id));
  const [files, setFiles] = useState(monitor?.files ?? []);
  const [fileDraft, setFileDraft] = useState('');
  const profile = choices.find((item) => item.id === profileId);
  const addFile = () => {
    setFiles((all) => [...new Set([...all, ...parseProjectFiles(fileDraft)])]);
    setFileDraft('');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!profile || !duty.trim() || busy) return;
    window.localStorage?.setItem('apex-agent-profile', profile.id);
    onSubmit({ text: duty.trim(), files, threads, profile });
  };
  return <div className="assistant-project-dialog-backdrop" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-label={`Watch ${project}`} className="assistant-project-dialog">
      <header><h2>{on ? 'Watching' : 'Watch'} {project}</h2><button type="button" disabled={busy} aria-label="Close dialog" onClick={onClose}>×</button></header>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={submit}>
        <p className="assistant-project-note">{assistantName} looks over this project when its files or chats change and tells you about blockers. Each check uses the AI profile you pick here.</p>
        {!on && earlier && <p className="assistant-project-note">Your earlier settings are kept. Checks stay off until you click Start watching.</p>}
        {choices.length === 0 && <p role="status">Add an OpenAI-compatible HTTP or Claude Code profile in Agents before watching this project.</p>}
        <label>AI profile<select aria-label="AI profile" value={profileId} disabled={busy} onChange={(event) => setProfileId(event.target.value)}>
          {!profile && <option value="">Choose an AI profile</option>}
          {choices.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}
        </select></label>
        <label>What should {assistantName} keep on track in {project}?<textarea aria-label="What to keep on track" value={duty} disabled={busy} onChange={(event) => setDuty(event.target.value)} /></label>
        <section className="apex-agent-sources-section"><h3>Chats</h3>
          {chats.length === 0 && <p className="assistant-project-note">No chats in this project yet.</p>}
          {chats.map((chat) => <label className="apex-agent-sources-row assistant-watch-check" key={chat.id}><input type="checkbox" checked={threads.includes(chat.id)} disabled={busy} onChange={(event) => setThreads((all) => event.target.checked ? [...all, chat.id] : all.filter((id) => id !== chat.id))} /><span>{chat.title}</span></label>)}
        </section>
        <section className="apex-agent-sources-section"><h3>Files</h3>
          {files.map((file) => <div className="apex-agent-sources-row" key={file}><span>{file}</span><button type="button" className="apex-agent-sources-remove" aria-label={`Remove ${file}`} disabled={busy} onClick={() => setFiles((all) => all.filter((item) => item !== file))}>✕</button></div>)}
          <div className="apex-agent-sources-add"><input aria-label="Add a file path" placeholder="Path relative to the project" value={fileDraft} disabled={busy} onChange={(event) => setFileDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addFile(); } }} /><button type="button" disabled={busy || parseProjectFiles(fileDraft).length === 0} onClick={addFile}>Add file</button></div>
        </section>
        <p className="assistant-project-note">You don’t need this to delegate a job. Every delegated job already has the Watchdog.</p>
        <div className="assistant-watch-actions">
          {on && <button type="button" disabled={busy} onClick={onStop}>Stop watching</button>}
          <button className="primary" disabled={busy || !profile || !duty.trim()}>{on ? 'Save' : 'Start watching'}</button>
        </div>
      </form>
    </section>
  </div>;
}
