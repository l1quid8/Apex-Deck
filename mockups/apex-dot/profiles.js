'use strict';

// Preview-only records. Stable IDs keep names, drafts and conversations independent.
const PROFILE_STORAGE_KEY = 'apex-assistant-preview-v1';
// Static demo choices, not a live or verified provider catalog.
const PROFILE_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', models: [
    { name: 'GPT-6.1 Sol', reasoning: ['Low', 'Medium', 'High', 'Extra high'], defaultReasoning: 'Medium' },
    { name: 'GPT-5', reasoning: ['Minimal', 'Low', 'Medium', 'High'], defaultReasoning: 'Medium' },
    { name: 'GPT-4.1', reasoning: [] },
  ] },
  { id: 'anthropic', name: 'Anthropic', models: [
    { name: 'Claude Sonnet 4.5', reasoning: ['Standard', 'Extended'], defaultReasoning: 'Standard' },
    { name: 'Claude Opus 4.5', reasoning: ['Standard', 'Extended'], defaultReasoning: 'Standard' },
  ] },
  { id: 'google', name: 'Google', models: [
    { name: 'Gemini 2.5 Pro', reasoning: ['Automatic', 'Low budget', 'High budget'], defaultReasoning: 'Automatic' },
    { name: 'Gemini 2.5 Flash', reasoning: ['Off', 'Automatic', 'High budget'], defaultReasoning: 'Automatic' },
  ] },
  { id: 'deepseek', name: 'DeepSeek', models: [
    { name: 'DeepSeek R1', reasoning: ['On'], defaultReasoning: 'On', reasoningNote: 'This demo model always reasons; no effort level is exposed.' },
    { name: 'DeepSeek V3', reasoning: [] },
  ] },
  { id: 'compatible', name: 'OpenAI-compatible', models: [
    { name: 'DeepGeek', reasoning: [], reasoningNote: 'Reasoning depends on the configured endpoint. No endpoint is connected in this preview.' },
    { name: 'Custom endpoint model', reasoning: [], reasoningNote: 'Reasoning depends on the configured endpoint. No endpoint is connected in this preview.' },
  ] },
  { id: 'local', name: 'Local model', models: [
    { name: 'Local model', reasoning: [], reasoningNote: 'Choose a demo model with thinking support to preview reasoning.' },
    { name: 'Qwen3.5-9B', reasoning: ['Off', 'On'], defaultReasoning: 'On' },
  ] },
];
const PROFILE_ACCESS = ['Ask first', 'Full access', 'Off'];

function normalizeAssistantControls(value = {}) {
  const inferredProvider = PROFILE_PROVIDERS.find(provider => provider.models.some(model => model.name === value.model));
  const provider = PROFILE_PROVIDERS.find(provider => provider.id === value.provider) || inferredProvider || PROFILE_PROVIDERS[0];
  const model = provider.models.find(model => model.name === value.model) || provider.models[0];
  return {
    provider: provider.id,
    model: model.name,
    reasoning: model.reasoning.includes(value.reasoning) ? value.reasoning : model.defaultReasoning || model.reasoning[0] || '',
  };
}

function assistantControls(prefix) {
  const modelId = prefix === 'profile' ? 'model-select' : prefix + '-model';
  return `<div class="assistant-controls" id="${prefix}-assistant-config"><fieldset class="assistant-config"><legend>AI model</legend>
    <p class="assistant-catalog-note">Demo choices. No provider is connected.</p>
    <label class="setting-row" for="${prefix}-provider"><span>Provider</span><select id="${prefix}-provider" data-assistant-provider></select></label>
    <label class="setting-row" for="${modelId}"><span>Model</span><select id="${modelId}" data-assistant-model></select></label>
    <label class="setting-row" for="${prefix}-reasoning"><span>Reasoning</span><select id="${prefix}-reasoning" data-assistant-reasoning aria-describedby="${prefix}-reasoning-note"></select></label>
    <p class="assistant-control-note" id="${prefix}-reasoning-note" data-reasoning-note></p>
  </fieldset><fieldset class="assistant-config"><legend>Access</legend>
    <label class="setting-row" for="${prefix}-access"><span>Project tools</span><select id="${prefix}-access" data-assistant-access>${PROFILE_ACCESS.map(access => `<option>${access}</option>`).join('')}</select></label>
    <label class="setting-row" for="${prefix}-browser"><span>Browser<small>Borrow a tab for a requested task</small></span><select id="${prefix}-browser" data-assistant-browser><option>Ask first</option><option>Off</option></select></label>
    <p class="assistant-control-note">${prefix === 'profile' ? 'Access choices save immediately in this preview.' : 'Choose how project tools and browser access can be used.'}</p>
  </fieldset></div>`;
}

function mountAssistantControls(prefix, value) {
  const controls = document.querySelector('#' + prefix + '-assistant-config');
  const providerSelect = controls.querySelector('[data-assistant-provider]');
  const modelSelect = controls.querySelector('[data-assistant-model]');
  const reasoningSelect = controls.querySelector('[data-assistant-reasoning]');
  const accessSelect = controls.querySelector('[data-assistant-access]');
  const browserSelect = controls.querySelector('[data-assistant-browser]');
  const settings = normalizeAssistantControls(value);
  providerSelect.replaceChildren(...PROFILE_PROVIDERS.map(provider => new Option(provider.name, provider.id)));
  providerSelect.value = settings.provider;
  const populateReasoning = preferred => {
    const provider = PROFILE_PROVIDERS.find(provider => provider.id === providerSelect.value);
    const model = provider.models.find(model => model.name === modelSelect.value);
    reasoningSelect.replaceChildren(...(model.reasoning.length ? model.reasoning.map(level => new Option(level, level)) : [new Option('Not supported', '')]));
    reasoningSelect.value = model.reasoning.includes(preferred) ? preferred : model.defaultReasoning || model.reasoning[0] || '';
    reasoningSelect.disabled = model.reasoning.length < 2;
    controls.querySelector('[data-reasoning-note]').textContent = model.reasoningNote || (model.reasoning.length ? 'Reasoning choices follow the selected demo model.' : 'This demo model does not expose a reasoning control.');
  };
  const populateModels = (preferredModel, preferredReasoning) => {
    const provider = PROFILE_PROVIDERS.find(provider => provider.id === providerSelect.value);
    modelSelect.replaceChildren(...provider.models.map(model => new Option(model.name, model.name)));
    modelSelect.value = provider.models.some(model => model.name === preferredModel) ? preferredModel : provider.models[0].name;
    populateReasoning(preferredReasoning);
  };
  providerSelect.onchange = () => populateModels();
  modelSelect.onchange = () => populateReasoning();
  accessSelect.value = PROFILE_ACCESS.includes(value.projectTools) ? value.projectTools : PROFILE_ACCESS[0];
  browserSelect.value = ['Ask first', 'Off'].includes(value.browser) ? value.browser : 'Ask first';
  for (const [select, key] of [[accessSelect, 'projectTools'], [browserSelect, 'browser']]) {
    select.onchange = prefix === 'profile' ? () => {
      currentProfile()[key] = select.value;
      const saved = persistProfiles();
      document.querySelector('#profile-save-status').textContent = saved ? 'Access saved in this browser. Save any other changes below.' : 'Access changed for this tab only. Browser storage is unavailable.';
    } : null;
  }
  populateModels(settings.model, settings.reasoning);
}

function readAssistantControls(prefix) {
  const controls = document.querySelector('#' + prefix + '-assistant-config');
  return {
    ...normalizeAssistantControls({
      provider: controls.querySelector('[data-assistant-provider]').value,
      model: controls.querySelector('[data-assistant-model]').value,
      reasoning: controls.querySelector('[data-assistant-reasoning]').value,
    }),
    projectTools: controls.querySelector('[data-assistant-access]').value,
    browser: controls.querySelector('[data-assistant-browser]').value,
  };
}
const PROJECT_NAMES = ['apex-deck', 'REA', 'apex_terminal'];
const seedConversation = document.querySelector('#conversation').innerHTML;
let profileStorageAvailable = true;
let profileState = loadProfiles();
let persistedProfiles = new Map(profileState.profiles.map(profile => [profile.id, JSON.stringify(profile)]));

function makeProfile(id, name) {
  return {
    id, name, appearance: defaultAssistantAppearance(id), ...normalizeAssistantControls(), messages: [], draft: '',
    paused: false, approved: false, attachment: '', connections: [],
    projectTools: 'Ask first', browser: 'Ask first',
  };
}

function loadProfiles() {
  const fallback = { activeId: 'demo-null', profiles: [{...makeProfile('demo-null', 'Null'), connections: [...PROJECT_NAMES]}] };
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || 'null');
    if (!saved || !Array.isArray(saved.profiles)) return fallback;
    const ids = new Set();
    const profiles = saved.profiles.flatMap(value => {
      if (!value || typeof value.id !== 'string' || !value.id || ids.has(value.id)
        || typeof value.name !== 'string' || !value.name.trim()) return [];
      ids.add(value.id);
      const profile = makeProfile(value.id, value.name.trim().slice(0, 64));
      // Retain legacy preview metadata without presenting it as a capability choice.
      if (typeof value.typeLabel === 'string') profile.typeLabel = value.typeLabel;
      profile.appearance = normalizeAssistantAppearance(value.appearance, profile.appearance);
      Object.assign(profile, normalizeAssistantControls(value));
      profile.messages = Array.isArray(value.messages) ? value.messages.filter(message =>
        message && ['human', 'assistant'].includes(message.role) && typeof message.text === 'string'
      ).map(message => ({ role: message.role, text: message.text })) : [];
      profile.draft = typeof value.draft === 'string' ? value.draft : '';
      profile.paused = value.paused === true;
      profile.approved = value.id === 'demo-null' && value.approved === true;
      profile.attachment = value.attachment === 'Example checklist attached' ? value.attachment : '';
      profile.connections = Array.isArray(value.connections) ? PROJECT_NAMES.filter(name => value.connections.includes(name)) : profile.connections;
      profile.projectTools = PROFILE_ACCESS.includes(value.projectTools) ? value.projectTools : profile.projectTools;
      profile.browser = ['Ask first', 'Off'].includes(value.browser) ? value.browser : profile.browser;
      return [profile];
    });
    if (!profiles.length) return fallback;
    return { profiles, activeId: profiles.some(profile => profile.id === saved.activeId) ? saved.activeId : profiles[0].id };
  } catch {
    profileStorageAvailable = false;
    return fallback;
  }
}

function currentProfile() {
  return profileState.profiles.find(profile => profile.id === profileState.activeId);
}

function persistProfiles() {
  try {
    // A stale preview tab must not erase profiles created or edited in another tab.
    // Merge only records changed here; simultaneous edits of one record use the last save.
    const merged = new Map(loadProfiles().profiles.map(profile => [profile.id, profile]));
    for (const profile of profileState.profiles) {
      if (!merged.has(profile.id) || persistedProfiles.get(profile.id) !== JSON.stringify(profile)) {
        merged.set(profile.id, profile);
      }
    }
    profileState.profiles = [...merged.values()];
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profileState));
    persistedProfiles = new Map(profileState.profiles.map(profile => [profile.id, JSON.stringify(profile)]));
    profileStorageAvailable = true;
    return true;
  } catch {
    profileStorageAvailable = false;
    return false;
  }
}

function updateProfileSelection() {
  document.querySelectorAll('[data-profile-id]').forEach(button => {
    button.setAttribute('aria-current', app.dataset.page === 'assistant' && button.dataset.profileId === profileState.activeId ? 'page' : 'false');
  });
}

function renderProfileList() {
  const list = document.querySelector('#assistant-list');
  list.replaceChildren();
  for (const profile of profileState.profiles) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dot-entry';
    button.dataset.profileId = profile.id;
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    paintAssistantAvatar(avatar, profile.appearance);
    const identity = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = profile.name;
    const label = document.createElement('small');
    label.textContent = profile.paused ? 'Paused' : 'Ready';
    identity.append(name, label);
    button.append(avatar, identity);
    button.title = profile.name;
    list.append(button);
  }
  updateProfileSelection();
}

function renderProfileStatus() {
  const profile = currentProfile();
  document.querySelector('#status-text').textContent = profile.paused ? 'Paused' : 'Ready';
  const button = document.querySelector('#pause-button');
  button.innerHTML = icon(profile.paused ? 'play' : 'pause');
  button.setAttribute('aria-label', (profile.paused ? 'Resume ' : 'Pause ') + profile.name);
  button.title = button.getAttribute('aria-label');
}

function renderProfileText() {
  const profile = currentProfile();
  document.querySelectorAll('[data-profile-name]').forEach(element => element.textContent = profile.name);
  document.querySelector('.dot-view').setAttribute('aria-label', profile.name + ', your assistant');
  document.querySelector('#profile-descriptor').textContent = 'Ongoing conversation';
  document.querySelector('#activity-heading').textContent = 'What ' + profile.name + ' has been doing';
  document.querySelector('#assistant-memory-heading').textContent = 'What ' + profile.name + ' remembers';
  document.querySelector('#profile-settings-subtitle').textContent = 'Make ' + profile.name + ' yours.';
  document.querySelector('#dot-input').placeholder = 'Message ' + profile.name + '…';
  document.querySelector('#dot-input').setAttribute('aria-label', 'Message ' + profile.name);
  document.querySelector('#dot-form [type=submit]').setAttribute('aria-label', 'Send demo message to ' + profile.name);
}

function renderApproval() {
  if (currentProfile().id !== 'demo-null' || !document.querySelector('#activity-task-status')) return;
  document.querySelectorAll('[data-review]').forEach(button => button.textContent = approved ? 'View approved checklist' : 'Review checklist');
  document.querySelector('#activity-task-status').textContent = approved
    ? 'Release checks approved in this preview. No packaging task was started.'
    : 'Collected the review and smoke-test steps. Packaging is pending your approval.';
  const tag = document.querySelector('#review-tag');
  if (!tag) return;
  tag.textContent = approved ? 'Approved · demo' : 'Needs your review';
  tag.classList.toggle('pending', !approved);
  document.querySelector('#activity-review-tag').textContent = approved ? 'Approved · demo' : 'Waiting for you';
  document.querySelector('#activity-review-tag').classList.toggle('pending', !approved);
  document.querySelector('.result-footer .muted').textContent = approved ? 'Demo decision only' : 'Nothing dispatched';
  document.querySelector('.message-actions>span').textContent = approved ? 'Checklist approved · demo' : 'Checklist prepared · waiting for you';
}

function renderConversation() {
  const profile = currentProfile();
  const conversation = document.querySelector('#conversation');
  conversation.innerHTML = profile.id === 'demo-null' ? seedConversation : '';
  if (profile.id !== 'demo-null' && !profile.messages.length) {
    const welcome = document.createElement('div');
    welcome.className = 'profile-welcome';
    const heading = document.createElement('h2');
    heading.textContent = 'A fresh start with ' + profile.name;
    const text = document.createElement('p');
    text.textContent = 'An ongoing conversation for your projects. Tell ' + profile.name + ' what to focus on.';
    welcome.append(heading, text);
    conversation.append(welcome);
  }
  for (const message of profile.messages) {
    const element = document.createElement('div');
    element.className = message.role === 'human' ? 'user-message' : 'assistant-message';
    if (message.role === 'assistant') {
      const identity = document.createElement('div');
      identity.className = 'message-identity';
      const avatar = document.createElement('span');
      avatar.className = 'avatar small';
      avatar.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.dataset.profileName = '';
      name.textContent = profile.name;
      const time = document.createElement('time');
      time.textContent = 'Demo reply';
      identity.append(avatar, name, time);
      const text = document.createElement('p');
      text.textContent = message.text;
      element.append(identity, text);
    } else element.textContent = message.text;
    conversation.append(element);
  }
  renderProfileText();
  renderProfileAvatars();
  renderApproval();
}

function filterProfileMemories() {
  const seed = currentProfile().id === 'demo-null';
  const query = document.querySelector('#memory-search').value.toLowerCase();
  let found = false;
  document.querySelectorAll('[data-note]').forEach(note => {
    note.hidden = !seed || !note.textContent.toLowerCase().includes(query);
    if (!note.hidden) found = true;
  });
  const empty = document.querySelector('#memory-empty');
  empty.hidden = found;
  empty.textContent = seed ? 'No example notes match that search.' : 'No saved notes for ' + currentProfile().name + ' yet.';
}

function fillProfileSettings() {
  const profile = currentProfile();
  const form = document.querySelector('#profile-settings-form');
  form.reset();
  form.querySelector('#profile-name').value = profile.name;
  form.querySelectorAll('[data-connection]').forEach(input => input.checked = profile.connections.includes(input.dataset.connection));
  const controlsSlot = form.querySelector('#profile-controls-slot');
  if (!controlsSlot.firstElementChild) controlsSlot.innerHTML = assistantControls('profile');
  mountAssistantControls('profile', profile);
  if (!form.querySelector('#profile-appearance')) form.querySelector('.profile-form-footer').insertAdjacentHTML('beforebegin', appearanceEditor('profile'));
  mountAppearanceEditor('profile', { ...profile.appearance });
  document.querySelector('#profile-save-status').textContent = profileStorageAvailable
    ? 'Name, model, and avatar changes save below.' : 'Browser storage is unavailable. Changes last for this tab only.';
}

function readProfileIdentity(prefix) {
  const nameInput = document.querySelector('#' + prefix + '-name');
  nameInput.setCustomValidity(nameInput.value.trim() ? '' : 'Enter a name.');
  if (!nameInput.reportValidity()) return null;
  return { name: nameInput.value.trim() };
}

function renderActiveProfile() {
  const profile = currentProfile();
  paused = profile.paused;
  approved = profile.approved;
  document.querySelectorAll('[data-seed-only]').forEach(element => element.hidden = profile.id !== 'demo-null');
  if (document.querySelector('#activity-empty')) document.querySelector('#activity-empty').hidden = profile.id === 'demo-null';
  document.querySelector('#activity-count').textContent = profile.id === 'demo-null' ? '3' : '0';
  document.querySelector('#dot-input').value = profile.draft;
  document.querySelector('#compose-context').textContent = profile.attachment || 'All your projects';
  document.querySelector('#memory-search').value = '';
  renderProfileList();renderProfileStatus();renderConversation();filterProfileMemories();fillProfileSettings();
}

function switchProfile(id) {
  if (!profileState.profiles.some(profile => profile.id === id)) return;
  profileState.activeId = id;
  persistProfiles();
  renderActiveProfile();
  openAssistantTab('chat');
}

function openCreateProfile() {
  closeAssistantMenu();
  openDialog('Add a team member', `
    <form id="create-profile-form">
      <label class="setting-row" for="create-name"><span>Name</span><input id="create-name" required maxlength="64" autocomplete="off" placeholder="Choose a name"></label>
      <p class="assistant-setup-intro">Each assistant has its own conversation, memory, and projects. Give it a work brief in Conversation after creating it.</p>
      ${assistantControls('create')}
      ${appearanceEditor('create')}
      <p class="mockup-note">Design preview. Saved in this browser only.</p>
      <button class="small-button primary" type="submit">Create</button>
    </form>`);
  const usedColors = new Set(profileState.profiles.map(profile => profile.appearance.color));
  const appearance = defaultAssistantAppearance(globalThis.crypto?.randomUUID?.() || String(Date.now()));
  appearance.color = ASSISTANT_AVATAR_COLORS.find(color => !usedColors.has(color)) || appearance.color;
  mountAppearanceEditor('create', appearance);
  mountAssistantControls('create', makeProfile('creation-preview', ''));
  document.querySelector('#create-name').focus();
}

function openProfileSwitcher() {
  closeAssistantMenu();
  openDialog('Your team', '<div id="profile-switch-list"></div>');
  const list = document.querySelector('#profile-switch-list');
  for (const profile of profileState.profiles) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-button';
    button.innerHTML = assistantAvatarMarkup(profile);
    button.append(document.createTextNode(profile.name));
    button.setAttribute('aria-pressed', String(profile.id === profileState.activeId));
    button.addEventListener('click', () => { dialog.close(); switchProfile(profile.id); });
    list.append(button);
  }
}

function initializeProfiles() {
  document.querySelector('#add-assistant').addEventListener('click', openCreateProfile);
  document.querySelector('#menu-add-assistant').addEventListener('click', openCreateProfile);
  document.querySelector('#switch-assistant').addEventListener('click', openProfileSwitcher);
  document.querySelector('#profile-settings-form').addEventListener('input', event => event.target.setCustomValidity?.(''));
  document.querySelector('#profile-settings-form').addEventListener('submit', event => {
    event.preventDefault();
    const identity = readProfileIdentity('profile');
    if (!identity) return;
    Object.assign(currentProfile(), identity, readAssistantControls('profile'), { appearance: readAppearanceEditor('profile') });
    const saved = persistProfiles();
    renderConversation();renderProfileStatus();renderProfileList();filterProfileMemories();
    document.querySelector('#profile-save-status').textContent = saved ? 'Changes saved in this browser.' : 'Changed for this tab only. Browser storage is unavailable.';
    notify(saved ? 'Profile saved.' : 'Changed for this tab only. Browser storage is unavailable.');
  });
  document.querySelector('#dot-input').addEventListener('input', event => { currentProfile().draft = event.target.value; persistProfiles(); });
  document.querySelectorAll('[data-connection]').forEach(input => input.addEventListener('change', () => {
    currentProfile().connections = [...document.querySelectorAll('[data-connection]:checked')].map(checkbox => checkbox.dataset.connection);
    persistProfiles();
  }));
  dialog.addEventListener('input', event => event.target.setCustomValidity?.(''));
  dialog.addEventListener('submit', event => {
    if (event.target.id !== 'create-profile-form') return;
    event.preventDefault();
    const identity = readProfileIdentity('create');
    if (!identity) return;
    const id = globalThis.crypto?.randomUUID?.() || 'preview-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    profileState.profiles.push({ ...makeProfile(id, identity.name), ...readAssistantControls('create'), appearance: readAppearanceEditor('create') });
    dialog.close();switchProfile(id);
    notify(profileStorageAvailable ? identity.name + ' added to your team.' : 'Added for this tab only. Browser storage is unavailable.');
    document.querySelector('#dot-input').focus();
  });
  renderActiveProfile();
  if (!profileStorageAvailable) notify('Browser storage is unavailable. Changes last for this tab only.');
}
