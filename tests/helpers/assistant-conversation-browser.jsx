import React from 'react';
import { createRoot } from 'react-dom/client';
import { ApexAgentAll } from '/src/ApexAgentAll.tsx';
import { AssistantFloat } from '/src/AssistantFloatWindow.tsx';
import { PersonalWorkspaceTaskDetail } from '/src/PersonalWorkspaceTaskDetail.tsx';
import { assistantFloatState } from '/src/assistantFloat.ts';
import { personalTaskKey } from '/src/apexAgentTaskView.ts';

const prompt = 'Permanently delete these 2 threads in one batch: “One”; “Two”? This cannot be undone.';
const operation = { tool: 'room.deleteMany', host: 'local', cwd: '/project', argv: ['one', JSON.stringify([{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }])] };
const base = { id: 'bulk', goal: 'Delete the two selected chats', completionCriteria: [], targetHost: 'local', class: 'write', operation, fromEvent: 'request', createdAt: 4, updatedAt: 20, receipts: [] };
const decision = { id: 'approval', kind: 'approve', paramsHash: 'sha256:exact-batch', prompt, status: 'open', openedAt: 2 };
const message = (id, role, kind, text, at, taskId) => ({ id, role, kind, text, at, taskId });
const receipt = { opId: 'bulk-op-1', phase: 'verified', exitCode: 0, outputExcerpt: 'Permanently deleted all 2 selected threads.\nCompleted IDs: one, two\nRemaining IDs: none', rerunAfterRestart: false, startedAt: 10, finishedAt: 20 };
const failedReceipt = { ...receipt, phase: 'failed', exitCode: 1, outputExcerpt: 'Stopped: the deletion outcome is uncertain. No remaining threads were retried.\nCompleted IDs: one\nRemaining IDs: two' };
const resultMessage = source => message('result', 'assistant', 'result', `room.deleteMany exited with ${source.exitCode}.\n\`\`\`\n${source.outputExcerpt}\n\`\`\``, 20, 'bulk');
const fixtures = {
  routine: {
    tasks: [{ ...base, status: 'done', decision: { ...decision, status: 'approved' }, receipts: [receipt] }, { ...base, id: 'running', status: 'running' }, { ...base, id: 'queued', status: 'queued' }],
    messages: [message('human', 'human', 'chat', 'Delete those two chats.', 1), message('ask', 'system', 'approval', prompt, 2, 'bulk'), message('allowed', 'system', 'update', 'Approved.', 3, 'bulk'), message('running', 'system', 'update', 'Running room.deleteMany without asking.', 4, 'running'), message('queued', 'system', 'update', 'Approved.', 5, 'queued'), message('followup', 'human', 'chat', 'What next?', 15), resultMessage(receipt)],
  },
  ask: {
    tasks: [{ ...base, status: 'needsYou', decision }],
    messages: [message('human', 'human', 'chat', 'Delete those two chats.', 1), message('old', 'system', 'approval', 'An older approval.', 2, 'bulk'), message('ask', 'system', 'approval', prompt, 3, 'bulk')],
  },
  failed: {
    tasks: [{ ...base, status: 'failed', decision: { ...decision, status: 'approved' }, receipts: [failedReceipt] }],
    messages: [message('human', 'human', 'chat', 'Delete those two chats.', 1), resultMessage(failedReceipt)],
  },
  unverified: { tasks: [{ ...base, status: 'done' }], messages: [message('result', 'assistant', 'result', 'It is done.', 20, 'bulk')] },
  helperFailure: { tasks: [{ ...base, operation: undefined, kind: 'helper', status: 'failed', receipts: [{ ...receipt, phase: 'failed', exitCode: undefined, outputExcerpt: '', note: 'The provider is unavailable.' }] }], messages: [{ ...message('human', 'human', 'chat', 'Research this.', 1), eventId: 'request' }, { ...message('helpers', 'system', 'update', 'Sent helpers to look into this.', 3), eventId: 'request' }] },
  pruned: { tasks: [{ ...base, status: 'waiting', receipts: [{ ...receipt, opId: 'bulk-op-2', startedAt: 30, finishedAt: 40 }] }], messages: [] },
};
window.calls = [];
const listeners = new Set();
let current;
const laneFor = fixture => ({
  name: 'Alfred', hostName: 'This Mac', ref: { hostId: 'local', assistantId: 'alfred' }, offline: false,
  assistant: { id: 'alfred', hostId: 'local', name: 'Alfred', profile: null, allowedFolders: ['/project'], revision: 1, events: [{ id: 'request', requestId: 'human-request', state: 'done', receivedAt: 1 }], ...fixture },
  send: async () => {}, decide: async (...args) => window.calls.push(args), cancel: async () => {},
});
const floatState = () => ({ ...assistantFloatState({ lane: laneFor(current), ref: { hostId: 'local', assistantId: 'alfred' }, draft: '', error: '', alwaysOnTop: false, voice: { status: 'idle', muted: false } }), presentation: 'chat' });
window.apexDeck = { popout: {
  onUpdate: fn => (listeners.add(fn), () => listeners.delete(fn)), snapshot: async () => ({ float: floatState() }), assistantLayout: async () => {}, sendAction: async (_token, action) => window.calls.push(action),
} };
const companion = new URLSearchParams(location.search).has('companion');

function Harness() {
  const [fixture, setFixture] = React.useState(fixtures.routine);
  const [focus, setFocus] = React.useState(null);
  const [embedded, setEmbedded] = React.useState(true);
  const [sidebar, setSidebar] = React.useState(false);
  current = fixture;
  window.setScenario = name => { current = fixtures[name]; setFixture(current); listeners.forEach(fn => fn({ float: floatState() })); };
  window.openTask = () => setFocus({ key: personalTaskKey('local', 'bulk', 'alfred'), nonce: Date.now(), origin: 'work' });
  window.popup = () => setEmbedded(false);
  window.showTaskSidebar = () => setSidebar(true);
  if (companion) return <AssistantFloat token="isolated" />;
  if (sidebar) return <PersonalWorkspaceTaskDetail lane={laneFor(fixture)} row={{ source: 'personal', assistant: { hostId: 'local', assistantId: 'alfred' }, taskId: 'bulk', offline: false }} />;
  return <ApexAgentAll embedded={embedded} personal={laneFor(fixture)} workspaces={[]} monitors={[]} focusTask={focus} onReply={async () => {}} onMutate={async () => {}} onSetUp={() => {}} onClose={() => {}} />;
}
createRoot(document.getElementById('root')).render(<Harness />);
