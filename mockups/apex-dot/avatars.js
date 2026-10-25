'use strict';

// Same FNV-1a seed and mirrored 5x5 pattern as Apex Deck's src/identicon.ts.
// Preview adapter only. Production should reuse Avatar and createAppearance.
const ASSISTANT_AVATAR_COLORS = ['#a78bfa', '#60a5fa', '#f472b6', '#2dd4bf', '#a3e635'];
const ASSISTANT_SAMPLE_AVATAR = 'assets/avatar-owl.png';
const appearanceEditorValues = new WeakMap();

function normalizeAssistantAppearance(value, fallback) {
  const appearance = { seed: fallback.seed, color: fallback.color };
  if (typeof value?.seed === 'string' && value.seed.length > 0 && value.seed.length <= 256) appearance.seed = value.seed;
  if (/^#[0-9a-f]{6}$/i.test(value?.color || '')) appearance.color = value.color.toLowerCase();
  // Preview assets are local and allowlisted. Never load a saved arbitrary URL.
  if (value?.kind === 'generated' && value.image === ASSISTANT_SAMPLE_AVATAR) {
    Object.assign(appearance, { kind: 'generated', image: ASSISTANT_SAMPLE_AVATAR,
      prompt: typeof value.prompt === 'string' ? value.prompt.slice(0, 500) : '', sample: true });
  }
  return appearance;
}

function avatarHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function assistantAvatarCells(seed) {
  const halfFrom = bits => Array.from({ length: 15 }, (_, i) => ((bits >>> i) & 1) === 1);
  let half = halfFrom(avatarHash(seed));
  for (let attempt = 1; attempt < 16; attempt++) {
    const lit = half.reduce((count, on, i) => count + (on ? (i % 3 === 2 ? 1 : 2) : 0), 0);
    if (lit >= 7 && lit <= 18) break;
    half = halfFrom(avatarHash(seed + '#' + attempt));
  }
  return Array.from({ length: 25 }, (_, i) => {
    const row = Math.floor(i / 5), col = i % 5;
    return half[row * 3 + (col < 3 ? col : 4 - col)];
  });
}

function defaultAssistantAppearance(id) {
  return { seed: id, color: ASSISTANT_AVATAR_COLORS[avatarHash(id) % ASSISTANT_AVATAR_COLORS.length] };
}

function paintAssistantAvatar(element, appearance) {
  element.style.setProperty('--who', appearance.color);
  element.dataset.avatarSeed = appearance.seed;
  element.classList.toggle('image-avatar', appearance.kind === 'generated');
  if (appearance.kind === 'generated' && appearance.image === ASSISTANT_SAMPLE_AVATAR) {
    const image = document.createElement('img');
    image.src = appearance.image;
    image.alt = '';
    image.addEventListener('error', () => paintAssistantAvatar(element, { seed: appearance.seed, color: appearance.color }), { once: true });
    element.replaceChildren(image);
    return;
  }
  element.replaceChildren(...assistantAvatarCells(appearance.seed).map(on => {
    const cell = document.createElement('i');
    if (on) cell.className = 'on';
    return cell;
  }));
}

function assistantAvatarMarkup(profile) {
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  paintAssistantAvatar(avatar, profile.appearance);
  return avatar.outerHTML;
}

function renderProfileAvatars() {
  const profile = currentProfile();
  document.querySelectorAll('.dot-header > .avatar, #conversation .avatar').forEach(avatar => paintAssistantAvatar(avatar, profile.appearance));
}

function appearanceEditor(prefix) {
  return `<fieldset class="appearance-editor" id="${prefix}-appearance"><legend>Avatar</legend>
    <div class="avatar-editor-intro"><span class="avatar large" id="${prefix}-avatar-preview" aria-hidden="true"></span><div><strong>Your assistant's look</strong><p>Keep a pixel pattern or create something of your own.</p></div></div>
    <div class="avatar-modes" role="group" aria-label="Avatar style"><button type="button" class="small-button" data-avatar-mode="pixel" aria-pressed="true">Pixel pattern</button><button type="button" class="small-button" data-avatar-mode="ai" aria-pressed="false">AI generate</button></div>
    <div data-avatar-panel="pixel"><div class="avatar-colors" role="group" aria-label="Avatar color">${ASSISTANT_AVATAR_COLORS.map((color, index) => `<button type="button" class="avatar-color" data-color="${color}" style="--swatch:${color}" aria-label="${['Violet','Blue','Pink','Teal','Lime'][index]}" aria-pressed="false"></button>`).join('')}</div>
    <div class="avatar-custom-color"><label for="${prefix}-avatar-color">Custom color</label><input type="color" id="${prefix}-avatar-color" aria-label="Avatar custom color"><label for="${prefix}-avatar-hex">Hex</label><input type="text" id="${prefix}-avatar-hex" aria-label="Avatar hex color" placeholder="#A78BFA" pattern="#[0-9a-fA-F]{6}" maxlength="7" required spellcheck="false" autocomplete="off"></div>
    <div class="avatar-button-row"><button type="button" class="small-button" data-new-avatar>New pattern</button><button type="button" class="small-button" data-use-pixel hidden>Use pixel pattern</button></div>
    <p>Same style as your agents. Renaming keeps your avatar.</p></div>
    <div data-avatar-panel="ai" hidden><label class="avatar-prompt-label" for="${prefix}-avatar-prompt">Describe your avatar</label><textarea id="${prefix}-avatar-prompt" maxlength="500" rows="2" placeholder="A friendly teal pixel-art owl"></textarea>
    <p class="avatar-demo-note">Simulated preview — sample artwork; no provider request or charge.</p>
    <div class="avatar-button-row"><button type="button" class="small-button" data-generate-avatar>Generate preview</button><button type="button" class="small-button" data-cancel-avatar hidden>Cancel</button></div>
    <div class="avatar-generated-result" hidden><span class="avatar generated-candidate" aria-hidden="true"></span><div><strong>Sample result</strong><p>Preview it before changing your avatar.</p><div class="avatar-button-row"><button type="button" class="small-button primary" data-apply-avatar>Apply avatar</button><button type="button" class="small-button" data-discard-avatar>Discard</button></div></div></div></div>
    <p class="avatar-feedback" role="status" aria-live="polite"></p></fieldset>`;
}

function mountAppearanceEditor(prefix, appearance) {
  const editor = document.querySelector('#' + prefix + '-appearance');
  const preview = editor.querySelector('#' + prefix + '-avatar-preview');
  const colorPicker = editor.querySelector('input[type=color]');
  const hexInput = editor.querySelector('#' + prefix + '-avatar-hex');
  const prompt = editor.querySelector('textarea');
  const feedback = editor.querySelector('.avatar-feedback');
  const generate = editor.querySelector('[data-generate-avatar]');
  const cancel = editor.querySelector('[data-cancel-avatar]');
  const result = editor.querySelector('.avatar-generated-result');
  let candidate = null, request = 0;
  appearanceEditorValues.set(editor, appearance);
  prompt.value = appearance.prompt || 'A friendly teal pixel-art owl';
  const stop = () => { request++; generate.disabled = false; generate.textContent = 'Generate preview'; cancel.hidden = true; };
  const showMode = mode => {
    editor.querySelectorAll('[data-avatar-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.avatarMode === mode)));
    editor.querySelectorAll('[data-avatar-panel]').forEach(panel => panel.hidden = panel.dataset.avatarPanel !== mode);
    // A hidden invalid hex value must not prevent saving an image avatar.
    colorPicker.disabled = hexInput.disabled = mode !== 'pixel';
  };
  const repaint = () => {
    paintAssistantAvatar(preview, appearance);
    colorPicker.value = appearance.color;
    hexInput.value = appearance.color.toUpperCase();
    editor.querySelector('[data-use-pixel]').hidden = appearance.kind !== 'generated';
    editor.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color.toLowerCase() === appearance.color.toLowerCase())));
  };
  const usePixel = () => { delete appearance.kind; delete appearance.image; delete appearance.prompt; delete appearance.sample; };
  editor.oninput = event => {
    if (event.target === prompt) {
      stop(); candidate = null; result.hidden = true;
      feedback.textContent = 'Prompt changed. Generate a new preview.';
      return;
    }
    if (event.target !== colorPicker && event.target !== hexInput) return;
    const color = event.target.value.trim();
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    usePixel();
    appearance.color = color.toLowerCase();
    paintAssistantAvatar(preview, appearance);
    colorPicker.value = appearance.color;
    if (event.target === colorPicker) hexInput.value = color.toUpperCase();
    editor.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color.toLowerCase() === appearance.color)));
  };
  editor.onclick = async event => {
    const modeButton = event.target.closest('[data-avatar-mode]');
    if (modeButton) { stop(); showMode(modeButton.dataset.avatarMode); return; }
    if (event.target.closest('[data-cancel-avatar], [data-discard-avatar]')) {
      stop(); candidate = null; result.hidden = true; feedback.textContent = 'Preview discarded. Your avatar is unchanged.'; return;
    }
    if (event.target.closest('[data-generate-avatar]')) {
      const description = prompt.value.trim();
      if (!description) { feedback.textContent = 'Describe an avatar first.'; prompt.focus(); return; }
      const thisRequest = ++request;
      candidate = null; result.hidden = true; generate.disabled = true; generate.textContent = 'Loading preview…'; cancel.hidden = false;
      feedback.textContent = 'Loading the sample result. Your current avatar stays in place.';
      const image = new Image(); image.src = ASSISTANT_SAMPLE_AVATAR;
      try { await image.decode(); }
      catch {
        if (request === thisRequest && editor.isConnected) { stop(); feedback.textContent = 'Could not load the sample avatar. Try again.'; }
        return;
      }
      if (request !== thisRequest || !editor.isConnected || appearanceEditorValues.get(editor) !== appearance) return;
      stop(); candidate = { ...appearance, kind: 'generated', image: ASSISTANT_SAMPLE_AVATAR, prompt: description, sample: true };
      paintAssistantAvatar(result.querySelector('.avatar'), candidate); result.hidden = false;
      generate.textContent = 'Regenerate preview'; feedback.textContent = 'Sample ready. Apply it or keep your current avatar.'; return;
    }
    if (event.target.closest('[data-apply-avatar]') && candidate) {
      Object.assign(appearance, candidate); candidate = null; result.hidden = true; repaint();
      feedback.textContent = prefix === 'create' ? 'Avatar applied. Create your assistant to keep it.' : 'Avatar applied. Save changes to keep it.'; return;
    }
    const color = event.target.closest('[data-color]');
    if (color) { usePixel(); appearance.color = color.dataset.color; }
    if (event.target.closest('[data-use-pixel]')) { usePixel(); feedback.textContent = 'Pixel pattern restored. Save to keep it.'; }
    if (event.target.closest('[data-new-avatar]')) {
      usePixel();
      appearance.seed = globalThis.crypto?.randomUUID?.() || 'avatar-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }
    repaint();
  };
  showMode(appearance.kind === 'generated' ? 'ai' : 'pixel');
  repaint();
}

function readAppearanceEditor(prefix) {
  return { ...appearanceEditorValues.get(document.querySelector('#' + prefix + '-appearance')) };
}
