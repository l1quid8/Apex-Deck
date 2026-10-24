// The assistant's Details sidebar: who it is, the browser it drives, what it
// makes for you, and the way into its sections. Outputs are deliverables from
// the session's task threads — documents, exports, pages — never repo diffs.

import { useState } from 'react';
import type { PersonalLane } from './personalAssistant';
import { assistantAppearance } from './assistantIdentity';
import { Avatar } from './Avatar';
import { OUTPUT_LABEL, OUTPUT_MARK, outputsLine, previewSource, type AssistantOutput } from './assistantOutputs';
import type { AssistantSection } from './assistantWorkspaceModel';
import './assistant-details.css';

export function AssistantDetails({ lane, outputs, outputsLoading = false, outputsProblem = '', onClose, onNavigate, onOpenBrowser, onOpenFile }: {
  lane: PersonalLane;
  outputs: AssistantOutput[];
  outputsLoading?: boolean;
  outputsProblem?: string;
  onClose: () => void;
  onNavigate: (section: AssistantSection) => void;
  onOpenBrowser?: () => void;
  onOpenFile?: (path: string, cwd: string | null) => void;
}) {
  const record = lane.assistant;
  const ref = lane.ref ?? { hostId: record?.hostId ?? lane.hostName, assistantId: record?.id ?? lane.name };
  const look = assistantAppearance(ref, record?.look);
  /** Which folds are closed. Everything except Model and access starts open. */
  const [folded, setFolded] = useState<Record<string, boolean>>({ browser: false, outputs: false });
  /** The one output whose text is showing. */
  const [shown, setShown] = useState<string | null>(null);
  const fold = (name: string) => (folded[name] ? {} : { open: true });
  const toggle = (name: string) => setFolded((now) => ({ ...now, [name]: !now[name] }));

  return (
    <aside className="assistant-details" id="assistant-details" aria-label={`${lane.name} details`}>
      <header className="assistant-details-head">
        <Avatar seed={look.seed} color={look.color} image={look.kind === 'image' ? look.image : undefined} assistant={ref} size="md" />
        <div className="assistant-details-id">
          <h2 className="assistant-details-name">{lane.name}</h2>
          <p className="assistant-details-role">Apex assistant</p>
        </div>
        <button type="button" className="assistant-details-close" aria-label="Close details" onClick={onClose}>×</button>
      </header>

      <div className="assistant-details-body">
        <section className="assistant-details-card">
          <h3 className="assistant-details-card-title">Browser</h3>
          <p className="assistant-details-note">{onOpenBrowser ? 'Opens beside this sidebar. Take over whenever you like.' : 'This machine does not show the assistant browser.'}</p>
          {onOpenBrowser ? <button type="button" className="assistant-details-action" onClick={onOpenBrowser}>Open browser</button> : null}
        </section>

        <section className="assistant-details-fold">
          <button type="button" className="assistant-details-fold-head" aria-expanded={!folded.outputs} aria-controls="assistant-outputs" onClick={() => toggle('outputs')}>
            <span className="assistant-details-fold-name">Outputs</span>
            <span className="assistant-details-fold-count">{outputsLine(outputs)}</span>
            <span className="assistant-details-fold-arrow" aria-hidden="true">{folded.outputs ? '▸' : '▾'}</span>
          </button>
          <div id="assistant-outputs" className="assistant-details-fold-body" {...fold('outputs')}>
            {outputsLoading ? <p className="assistant-details-note" role="status">Reading this session’s outputs…</p> : null}
            {outputsProblem ? <p className="assistant-details-note" role="status">{outputsProblem}</p> : null}
            {!outputsLoading && !outputsProblem && outputs.length === 0 ? (
              <p className="assistant-details-note">When a task writes a document, an export or a page, it appears here.</p>
            ) : null}
            {outputs.map((output) => {
              const open = shown === output.id;
              return (
                <div className="assistant-output" key={output.id}>
                  <button
                    type="button"
                    className="assistant-output-row"
                    aria-expanded={output.artifact ? open : undefined}
                    title={output.path ?? output.name}
                    onClick={() => {
                      if (output.artifact) setShown(open ? null : output.id);
                      else if (output.path && onOpenFile) onOpenFile(output.path, output.cwd ?? null);
                    }}
                  >
                    <span className={`assistant-output-mark is-${output.kind}`} aria-hidden="true">{OUTPUT_MARK[output.kind]}</span>
                    <span className="assistant-output-text">
                      <span className="assistant-output-name">{output.name}</span>
                      <span className="assistant-output-where">
                        {output.folder ? `${output.folder} · ` : ''}
                        {OUTPUT_LABEL[output.kind]}
                        {output.artifact ? ` · v${output.artifact.versions.length}` : ''}
                      </span>
                    </span>
                  </button>
                  {open && output.artifact ? (
                    <pre className="assistant-output-source" aria-label={`${output.name} content`}>{previewSource(output.artifact)}</pre>
                  ) : null}
                </div>
              );
            })}
            <p className="assistant-details-footnote">From the threads these tasks worked in. Code changes stay in Review.</p>
          </div>
        </section>
      </div>

      <footer className="assistant-details-links">
        <button type="button" onClick={() => onNavigate('memory')}>Memory</button>
        <button type="button" onClick={() => onNavigate('projects')}>Projects &amp; access</button>
        <button type="button" onClick={() => onNavigate('settings')}>Settings</button>
      </footer>
    </aside>
  );
}
