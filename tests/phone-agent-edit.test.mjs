import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The Agents tab creates, changes and deletes the agents saved on the Mac. These run its rules: a save
// writes the fields the sheet shows and keeps the rest, a name another agent answers to is refused, and
// the agent list ends up exactly as the sheet left it.
const mod = await import(new URL('../src/phone/agentEdit.ts', import.meta.url).href);
const { agentAccessChoices, agentDraft, agentFromDraft, agentProblem, agentReasoning, agentTemplateDraft, agentTool, mergeAgentDraft, removeAgent, saveAgentDraft, upsertAgent } = mod;
const { accessOptions } = await import(new URL('../src/accessChange.ts', import.meta.url).href);

const agent = (over = {}) => ({
  id: 'claude', display_name: 'Claude',
  backend: { kind: 'agent', tool: 'claude_code', model: 'opus' },
  persona: 'Writes the code.', access: 'read', effort: 'medium',
  voice: 'alloy', can_read_images: true, media: null, appearance: { seed: 'seed-1', color: '#8ab4f8' },
  ...over,
});

test('an agent saves back exactly as it was when nothing changed', () => {
  const saved = agent();
  const built = agentFromDraft(saved, agentDraft(saved), { editing: saved.id, others: [] });
  assert.equal(typeof built, 'object');
  for (const field of ['id', 'display_name', 'persona', 'access', 'effort', 'voice', 'can_read_images']) assert.deepEqual(built[field], saved[field], field);
  assert.deepEqual(built.backend, saved.backend);
  assert.deepEqual(built.appearance, saved.appearance);
});

test('a rename keeps the id the agent was saved under, so old @mentions still reach it', () => {
  const saved = agent();
  const built = agentFromDraft(saved, { ...agentDraft(saved), name: 'Claude the Reviewer' }, { editing: saved.id, others: [] });
  assert.equal(built.id, 'claude');
  assert.equal(built.display_name, 'Claude the Reviewer');
});

test('a new agent takes its name as its id, and a name another agent answers to is refused', () => {
  const template = agent();
  const built = agentFromDraft(template, { ...agentTemplateDraft(template), name: 'Scout' }, { editing: null, others: [], appearance: null });
  assert.equal(built.id, 'scout');
  assert.equal(built.display_name, 'Scout');
  // The look is the new one the save was given, not the template's: two agents made in a row differ.
  assert.deepEqual(built.appearance, null);
  // Same name again is a mention clash, worded for the Agents tab.
  assert.equal(agentProblem({ ...agentDraft(template), name: 'Scout' }, [built], null), 'Your agent Scout already answers to @scout. Pick a different name.');
  // A name with nothing to mention is refused, and one cannot be called everyone.
  // Digits are enough to be mentioned by (a name of just "123" is allowed); punctuation is not.
  assert.match(agentProblem({ ...agentDraft(template), name: '!!!' }, [], null), /letter or a number/);
  assert.equal(agentProblem({ ...agentDraft(template), name: '123' }, [], null), '');
  assert.match(agentProblem({ ...agentDraft(template), name: 'everyone' }, [], null), /means everyone/);
  assert.equal(agentProblem({ ...agentDraft(template), name: '   ' }, [], null), 'Give the agent a name.');
});

test('editing may keep its own name, but not take another agent’s', () => {
  const saved = agent();
  const other = agent({ id: 'scout', display_name: 'Scout' });
  assert.equal(agentProblem(agentDraft(saved), [other], saved.id), '');
  assert.match(agentProblem({ ...agentDraft(saved), name: 'Scout' }, [other], saved.id), /already answers to @scout/);
});

test('a model that takes no reasoning level is not sent one', () => {
  const saved = agent();
  // Claude's Haiku takes none (the catalogue says so), so a level picked for Opus can't follow it.
  assert.deepEqual(agentReasoning(saved, 'haiku'), []);
  const built = agentFromDraft(saved, { ...agentDraft(saved), model: 'haiku', effort: 'high' }, { editing: saved.id, others: [] });
  assert.equal(built.effort, null);
  assert.equal(built.backend.model, 'haiku');
  // Opus does, and the chosen level is written.
  const kept = agentFromDraft(saved, { ...agentDraft(saved), model: 'opus', effort: 'high' }, { editing: saved.id, others: [] });
  assert.equal(kept.effort, 'high');
});

test('Speed is written only for a tool that has one, and clearing it follows the tool', () => {
  const saved = agent();
  const fast = agentFromDraft(saved, { ...agentDraft(saved), speed: 'fast' }, { editing: saved.id, others: [] });
  assert.equal(fast.speed, 'fast');
  const plain = agentFromDraft(saved, { ...agentDraft(saved), speed: '' }, { editing: saved.id, others: [] });
  assert.equal(plain.speed, null);
  // Gemini has no speed setting, so the field never reaches its config.
  const gemini = agent({ backend: { kind: 'agent', tool: 'gemini', model: 'pro' } });
  const built = agentFromDraft(gemini, { ...agentDraft(gemini), speed: 'fast' }, { editing: gemini.id, others: [] });
  assert.equal('speed' in built, false);
});

test('fields the sheet does not show are kept as the Mac has them', () => {
  const saved = agent({ media: { aspect_ratio: '1:1' }, can_read_images: true, voice: 'shimmer' });
  const built = agentFromDraft(saved, { ...agentDraft(saved), brief: 'Reviews pull requests.', access: 'edits' }, { editing: saved.id, others: [] });
  assert.deepEqual(built.media, { aspect_ratio: '1:1' });
  assert.equal(built.can_read_images, true);
  assert.equal(built.voice, 'shimmer');
  assert.equal(built.persona, 'Reviews pull requests.');
  assert.equal(built.access, 'edits');
});

test('Grok and Muse have no Ask, as on the Mac; the rest do', () => {
  assert.deepEqual(agentAccessChoices('grok').map((choice) => choice.id), ['read', 'edits', 'full']);
  assert.deepEqual(agentAccessChoices('muse').map((choice) => choice.id), ['read', 'edits', 'full']);
  assert.deepEqual(agentAccessChoices('claude_code').map((choice) => choice.id), ['read', 'ask', 'edits', 'full']);
  // A scripted agent runs no tool, so it keeps every choice.
  assert.equal(agentTool(agent({ backend: { kind: 'cli', program: 'say', args: [] } })), '');
  assert.equal(agentAccessChoices('').length, 4);
});

test('each access choice carries the Mac’s own explanation, so the phone explains it the same way', () => {
  const [read, ask] = agentAccessChoices('claude_code');
  assert.match(read.text, /^Read-only$/);
  assert.match(read.title, /Read files/);
  assert.match(ask.title, /Ask before edits/);
  // The Mac's wording, not a second copy of it: the list comes from accessOptions.
  assert.deepEqual(
    agentAccessChoices('claude_code').map((choice) => choice.title),
    accessOptions('claude_code').map((choice) => choice.title),
  );
});

test('the saved list gains an agent at the end, replaces one where it was, and drops one on delete', () => {
  const first = agent();
  const second = agent({ id: 'scout', display_name: 'Scout' });
  const added = upsertAgent([first], second);
  assert.deepEqual(added.map((item) => item.id), ['claude', 'scout']);
  const renamed = { ...first, display_name: 'Claude the Reviewer' };
  const replaced = upsertAgent(added, renamed);
  assert.deepEqual(replaced.map((item) => item.id), ['claude', 'scout']);
  assert.equal(replaced[0].display_name, 'Claude the Reviewer');
  assert.deepEqual(removeAgent(added, 'claude').map((item) => item.id), ['scout']);
});

test('a draft carries the name, brief, access, model and speed the sheet shows', () => {
  const saved = agent({ effort: null, speed: 'fast' });
  assert.deepEqual(agentDraft(saved), { name: 'Claude', brief: 'Writes the code.', access: 'read', model: 'opus', effort: '', speed: 'fast' });
  // A new agent starts from the bot as it is, with its name left blank.
  assert.equal(agentTemplateDraft(saved).name, '');
  assert.equal(agentTemplateDraft(saved).model, 'opus');
});

test('PhoneApp saves agents through the session it reads fresh from the Mac', () => {
  const source = fs.readFileSync(new URL('../src/phone/PhoneApp.tsx', import.meta.url), 'utf8');
  // Through saveSession, which loads the Mac's session first, and the change is applied to that fresh
  // copy rather than replacing the agent with the sheet's older one.
  assert.match(source, /await saveSession\(\(current\) => \{\s*const next = saveAgentDraft\(current\.profiles, change\)/);
  assert.doesNotMatch(source, /profiles: upsertAgent\(current\.profiles, config\)/, 'the sheet\'s whole copy is never written over the Mac\'s agent');
  assert.match(source, /await saveSession\(\(current\) => \(\{ \.\.\.current, profiles: removeAgent\(current\.profiles, id\) \}\)\)/);
  // The Agents tab opens the sheet for a new agent and for one that exists.
  assert.match(source, /onNewAgent=\{newAgent\}/);
  assert.match(source, /onEditAgent=\{changeAgent\}/);
  assert.match(source, /onClick=\{\(\) => onEditAgent\(bot\.id\)\}/);
  // Making an agent needs Full access on the Mac, and the sheet says so instead of failing on save.
  assert.match(source, /if \(!canSeeNewThread\(macHost\.access\(\)\)\) \{ setNotice\(`Making an agent needs Full access/);
});

test('the sheet hands back what it opened with, so the save can tell what was touched', () => {
  const source = fs.readFileSync(new URL('../src/phone/AgentSheet.tsx', import.meta.url), 'utf8');
  assert.match(source, /initial,/);
  assert.match(source, /draft,/);
  assert.doesNotMatch(source, /props\.onSave\(built\)/, 'no finished agent is built from the stale copy');
});

test('the agent sheet asks once before deleting and never deletes on the first tap', () => {
  const source = fs.readFileSync(new URL('../src/phone/AgentSheet.tsx', import.meta.url), 'utf8');
  assert.match(source, /onClick=\{\(\) => setConfirm\(true\)\}>Delete agent…/);
  assert.match(source, /can't be undone/);
  // The delete button only exists in the confirmed branch, and the sheet keeps it or goes back.
  assert.match(source, /\{props\.agent && \(confirm/);
  assert.doesNotMatch(source, /window\.confirm/);
});

// ---- The sheet's copy is stale the moment it opens ------------------------------------------------
// Reviewed blocker: saving from the sheet used to replace the whole agent with the copy the sheet was
// given, so anything changed on the Mac while it was open was put back to what the phone last saw.
// A save now merges the fields the person touched into the Mac's own copy, read fresh at save time.

/** The sheet as it was opened, and the change as the person left it. */
const sheetOn = (opened, edit = {}) => ({ initial: agentDraft(opened), draft: { ...agentDraft(opened), ...edit } });

test('a setting changed on the Mac while the sheet was open survives a save from the phone', () => {
  const opened = agent({ access: 'read', persona: 'Writes the code.', voice: 'alloy' });
  const { initial } = sheetOn(opened);
  // While the sheet sits open, the Mac gives the agent Full access, rewrites its brief and changes its voice.
  const asMacHasIt = agent({ access: 'full', persona: 'Reviews every change before it lands.', voice: 'verse' });
  const next = saveAgentDraft([asMacHasIt], { id: 'claude', template: opened, initial, draft: { ...initial, name: 'Reviewer' }, appearance: null });
  assert.equal(typeof next, 'object');
  const saved = next.find((item) => item.id === 'claude');
  assert.equal(saved.display_name, 'Reviewer', 'the name the person typed is written');
  assert.equal(saved.access, 'full', 'the access the Mac was given is kept, not the Read-only the phone last saw');
  assert.equal(saved.persona, 'Reviews every change before it lands.', 'the Mac\'s newer brief is kept');
  assert.equal(saved.voice, 'verse', 'a field the sheet does not show is untouched');
});

test('a field the person did change on the phone is the one that saves', () => {
  const opened = agent({ access: 'read', persona: 'Writes the code.' });
  const { initial } = sheetOn(opened);
  const asMacHasIt = agent({ access: 'full', persona: 'Reviews every change.' });
  const next = saveAgentDraft([asMacHasIt], { id: 'claude', template: opened, initial, draft: { ...initial, access: 'edits', brief: 'Builds the thing.' }, appearance: null });
  const saved = next.find((item) => item.id === 'claude');
  assert.equal(saved.access, 'edits', 'the level the person picked wins over the one on the Mac');
  assert.equal(saved.persona, 'Builds the thing.');
});

test('a model changed on the Mac is not put back by a sheet opened on the old one', () => {
  const opened = agent({ backend: { kind: 'agent', tool: 'claude_code', model: 'opus' }, effort: 'high' });
  const { initial } = sheetOn(opened);
  // The Mac moves the agent to a model that takes no reasoning level, so its effort is cleared there too.
  const asMacHasIt = agent({ backend: { kind: 'agent', tool: 'claude_code', model: 'haiku' }, effort: null });
  const next = saveAgentDraft([asMacHasIt], { id: 'claude', template: opened, initial, draft: { ...initial, brief: 'Only reads now.' }, appearance: null });
  const saved = next.find((item) => item.id === 'claude');
  assert.deepEqual(saved.backend, { kind: 'agent', tool: 'claude_code', model: 'haiku' }, 'the Mac\'s model is kept');
  assert.equal(saved.effort, null, 'and the reasoning level that model dropped is not sent back to it');
});

test('an agent deleted on the Mac while the sheet was open is not brought back', () => {
  const opened = agent();
  const { initial } = sheetOn(opened);
  const next = saveAgentDraft([], { id: 'claude', template: opened, initial, draft: { ...initial, name: 'Claude 2' }, appearance: null });
  assert.equal(typeof next, 'string');
  assert.match(next, /deleted on your Mac/);
});

test('a name taken on the Mac while the sheet was open is refused, against the fresh list', () => {
  const opened = agent();
  const madeMeanwhwhile = agent({ id: 'scout', display_name: 'Scout' });
  const start = agentTemplateDraft(opened);
  const next = saveAgentDraft([opened, madeMeanwhwhile], { id: null, template: opened, initial: start, draft: { ...start, name: 'Scout' }, appearance: null });
  assert.equal(typeof next, 'string');
  assert.match(next, /Scout/);
});

test('a new agent writes every field it was given, from the bot it started from', () => {
  const template = agent({ persona: 'Writes the code.', access: 'read' });
  const start = agentTemplateDraft(template);
  const next = saveAgentDraft([], { id: null, template, initial: start, draft: { ...start, name: 'Scout', access: 'edits' }, appearance: { seed: 'seed-2', color: '#f28b82' } });
  assert.equal(typeof next, 'object');
  const saved = next[0];
  assert.equal(saved.id, 'scout');
  assert.equal(saved.access, 'edits');
  assert.equal(saved.persona, 'Writes the code.', 'the brief it started from is kept');
  assert.deepEqual(saved.backend, template.backend, 'and so is the tool it runs');
  assert.deepEqual(saved.appearance, { seed: 'seed-2', color: '#f28b82' }, 'with a look of its own');
});

test('merging without a starting draft writes everything, which is what a new agent needs', () => {
  const template = agent();
  const built = mergeAgentDraft(template, { ...agentDraft(template), name: 'Scout' }, { editing: null, others: [], appearance: null });
  assert.equal(built.display_name, 'Scout');
  assert.equal(built.id, 'scout');
});
