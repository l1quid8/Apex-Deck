(() => {
  'use strict';

  const snapshot = window.THREAD_SNAPSHOT;
  if (!snapshot || !Array.isArray(snapshot.threads)) {
    console.error('Adaptive thread panes: THREAD_SNAPSHOT fixture is missing.');
    return;
  }

  const $ = (id) => document.getElementById(id);
  const ui = {
    dataset: $('dataset'), layout: $('layout-mode'), columns: $('columns'),
    composerMode: $('composer-mode'), search: $('search'), reset: $('reset'),
    list: $('thread-list'), grid: $('pane-grid'), shared: $('shared-composer'),
    destination: $('destination'), draft: $('shared-draft'), preview: $('preview-send'),
    feedback: $('feedback'), snapshotLabel: $('snapshot-label'), count: $('workspace-count')
  };
  const threads = snapshot.threads;
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const drafts = new Map(threads.map((thread) => [thread.id, '']));
  const previews = new Map(threads.map((thread) => [thread.id, []]));
  const originalOrder = threads.map((thread) => thread.id);
  const state = {
    dataset: 'history', layout: 'focus', columns: 4, composerMode: 'shared',
    query: '', selectedId: byId.has(snapshot.focusedId) ? snapshot.focusedId : (threads[0] && threads[0].id),
    order: [...originalOrder], spans: new Map(), collapsed: new Set(), drag: null,
    feedback: 'Local preview only. Nothing was sent.'
  };
  const valid = (id) => byId.has(id);
  const membersText = (thread) => (thread.members || []).map((member) => member.name).filter(Boolean).join(', ');
  const messages = (thread) => Array.isArray(thread.messages) ? thread.messages : [];
  const excerpt = (thread) => {
    const list = messages(thread);
    return list.length ? list[list.length - 1].text : 'No captured excerpt';
  };
  const safeText = (element, value) => { element.textContent = value == null ? '' : String(value); };
  const shownThreads = () => {
    const q = state.query.trim().toLocaleLowerCase();
    return state.order.map((id) => byId.get(id)).filter(Boolean).filter((thread) => {
      if (state.dataset === 'open' && thread.open === false) return false;
      return !q || `${thread.title || ''} ${membersText(thread)}`.toLocaleLowerCase().includes(q);
    });
  };
  const selected = () => byId.get(state.selectedId) || threads[0];

  function saveDraft(id, value) {
    if (valid(id)) drafts.set(id, value);
  }

  function syncSharedComposer() {
    const thread = selected();
    if (!thread) return;
    if (ui.destination) {
      ui.destination.replaceChildren(document.createTextNode(`To: ${thread.title || 'Untitled thread'}${membersText(thread) ? ` · ${membersText(thread)}` : ''}`));
      if (!shownThreads().some((item) => item.id === thread.id)) {
        const reason = state.dataset === 'open' && thread.open === false ? 'Open chats dataset' : 'current filter';
        ui.destination.append(make('span', 'hidden-selection', ` · Hidden by ${reason}`));
        const reveal = make('button', 'reveal-selection', 'Reveal selected thread');
        reveal.type = 'button'; reveal.addEventListener('click', () => { state.dataset = 'history'; state.query = ''; if (ui.search) ui.search.value = ''; render(); });
        ui.destination.append(reveal);
      }
    }
    if (ui.draft && document.activeElement !== ui.draft) ui.draft.value = drafts.get(thread.id) || '';
    if (ui.shared) ui.shared.hidden = state.composerMode !== 'shared';
  }

  function make(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) safeText(node, content);
    return node;
  }

  function threadRow(thread) {
    const row = make('button', `thread-row${thread.id === state.selectedId ? ' active' : ''}`);
    row.type = 'button'; row.dataset.threadId = thread.id;
    const title = make('span', 'thread-row-title', thread.title || 'Untitled thread');
    const meta = make('span', 'thread-row-meta', `${thread.closed ? 'Archived · ' : ''}${membersText(thread) || 'Participants unknown'}`);
    row.append(title, meta);
    row.addEventListener('click', () => selectThread(thread.id));
    return row;
  }

  function addButton(parent, label, action, className = '') {
    const button = make('button', className, label);
    button.type = 'button'; button.addEventListener('click', action); parent.append(button); return button;
  }

  function pane(thread, index, visibleCount) {
    const node = make('article', `pane${thread.id === state.selectedId ? ' selected' : ''}`);
    node.dataset.threadId = thread.id;
    const isCollapsed = state.collapsed.has(thread.id);
    if (isCollapsed) node.classList.add('collapsed');
    node.dataset.index = String(index);
    node.style.order = String(index);
    const span = state.spans.has(thread.id) ? state.spans.get(thread.id) : (state.layout === 'focus' && thread.id === state.selectedId ? 2 : 1);
    const fittedColumns = Math.max(1, Math.min(Number(state.columns), Math.floor((((ui.grid && ui.grid.clientWidth) || 1000) + 8) / 248)));
    const canSpan = fittedColumns > 1 && visibleCount > 1;
    if (state.layout === 'focus' && thread.id === state.selectedId) {
      node.classList.add('expanded');
      if (canSpan && span === 2) { node.style.gridColumn = 'span 2'; node.style.gridRow = 'span 2'; }
      if (!canSpan) node.style.minHeight = '360px';
    } else if (state.layout === 'grid' && span === 2 && canSpan) {
      node.style.gridColumn = 'span 2';
    }

    const header = make('header', 'pane-header');
    const drag = make('button', 'pane-drag', '⠿');
    drag.type = 'button'; drag.setAttribute('aria-label', `Move ${thread.title || 'thread'}`);
    drag.title = 'Drag to reorder; keyboard: Alt+←/→';
    drag.addEventListener('pointerdown', (event) => beginDrag(event, thread.id, node));
    const title = make('h2', 'pane-title', thread.title || 'Untitled thread');
    title.title = 'Select this thread';
    title.addEventListener('click', () => selectThread(thread.id));
    const menu = make('details', 'pane-menu');
    const summary = make('summary', '', '⋯'); summary.setAttribute('aria-label', `Layout actions for ${thread.title || 'thread'}`);
    const actions = make('div', 'pane-actions');
    if (thread.id !== state.selectedId) addButton(actions, 'Select', () => selectThread(thread.id));
    const previous = addButton(actions, '‹', () => moveThread(thread.id, -1));
    previous.title = 'Move earlier'; previous.setAttribute('aria-label', `Move ${thread.title || 'thread'} earlier`);
    const next = addButton(actions, '›', () => moveThread(thread.id, 1));
    next.title = 'Move later'; next.setAttribute('aria-label', `Move ${thread.title || 'thread'} later`);
    const minus = addButton(actions, '−', () => changeSpan(thread.id, 1)); minus.title = 'Use one column'; minus.setAttribute('aria-label', `Use one column for ${thread.title || 'thread'}`);
    const plus = addButton(actions, '+', () => changeSpan(thread.id, 2)); plus.title = 'Use two columns'; plus.setAttribute('aria-label', `Use two columns for ${thread.title || 'thread'}`);
    minus.disabled = !canSpan || span === 1; plus.disabled = !canSpan || span === 2;
    const fold = addButton(actions, isCollapsed ? 'Restore' : 'Collapse', () => toggleCollapsed(thread.id), 'pane-fold');
    fold.setAttribute('aria-label', `${isCollapsed ? 'Restore' : 'Collapse'} ${thread.title || 'thread'}`);
    fold.title = 'Same as double-clicking the title bar';
    menu.append(summary, actions);
    header.append(drag, title, menu);
    header.title = isCollapsed ? 'Double-click to restore' : 'Double-click to collapse';
    header.addEventListener('dblclick', (event) => {
      if (event.target.closest('.pane-drag, .pane-menu, button, summary')) return;
      event.preventDefault(); toggleCollapsed(thread.id);
    });

    const body = make('div', 'pane-body');
    body.addEventListener('click', (event) => { if (!event.target.closest('button, a, textarea')) selectThread(thread.id); });
    const meta = make('div', 'pane-meta', `${thread.closed ? 'Archived snapshot' : 'Open snapshot'} · ${membersText(thread) || 'Participants unknown'}`);
    body.append(meta);
    const transcript = messages(thread);
    const height = node.clientHeight || 320;
    const width = node.clientWidth || 420;
    const density = width < 240 || height < 180 ? 'tile' : (width >= 420 && height >= 300 ? 'full' : 'compact');
    node.classList.add(density);
    if (density === 'tile') {
      body.append(make('p', 'tile-excerpt', excerpt(thread)));
    } else {
      const count = density === 'full' ? transcript.length : Math.min(2, transcript.length);
      transcript.slice(-count).forEach((message) => {
        const line = make('p', 'message');
        line.append(make('span', 'speaker', message.speaker || 'Unknown'), document.createTextNode(': '), document.createTextNode(message.text || ''));
        body.append(line);
      });
      if (!transcript.length) body.append(make('p', 'message', 'No captured transcript excerpt.'));
    }

    const footer = make('footer', 'pane-footer');
    const previewList = previews.get(thread.id) || [];
    if (previewList.length) previewList.forEach((item) => footer.append(make('p', 'message preview-message', `Local preview · ${item}`)));
    const status = make('span', 'pane-status', 'Snapshot excerpt · local only');
    footer.append(status);
    if (state.composerMode === 'per-pane') {
      const draft = make('textarea', 'pane-draft');
      draft.value = drafts.get(thread.id) || '';
      draft.setAttribute('aria-label', `Draft for ${thread.title || 'thread'}`);
      draft.addEventListener('input', () => saveDraft(thread.id, draft.value));
      footer.append(draft);
      addButton(footer, 'Preview send', () => previewThread(thread.id, draft), 'pane-preview-send');
    }
    node.append(header, body, footer);
    node.addEventListener('keydown', (event) => {
      if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault(); moveThread(thread.id, event.key === 'ArrowLeft' ? -1 : 1);
      } else if (event.altKey && event.key === 'Enter') {
        event.preventDefault(); toggleCollapsed(thread.id);
      } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault(); changeSpan(thread.id, event.key === 'ArrowUp' ? 2 : 1);
      }
    });
    return node;
  }

  function render() {
    if (!ui.grid) return;
    const focused = capturePaneFocus();
    const items = shownThreads();
    ui.grid.replaceChildren();
    ui.grid.classList.toggle('has-dock', items.some((thread) => state.collapsed.has(thread.id)));
    if (!items.length) ui.grid.append(make('div', 'empty-results', 'No threads match this view. Clear the search or switch to History study.'));
    const openItems = items.filter((thread) => !state.collapsed.has(thread.id));
    const foldedItems = items.filter((thread) => state.collapsed.has(thread.id));
    if (foldedItems.length) {
      const dock = make('div', 'pane-dock');
      dock.setAttribute('aria-label', `${foldedItems.length} collapsed ${foldedItems.length === 1 ? 'thread' : 'threads'}`);
      foldedItems.forEach((thread) => dock.append(pane(thread, items.indexOf(thread), openItems.length)));
      ui.grid.append(dock);
    }
    openItems.forEach((thread, index) => ui.grid.append(pane(thread, index, openItems.length)));
    if (ui.list) { ui.list.replaceChildren(); items.forEach((thread) => ui.list.append(threadRow(thread))); }
    if (ui.count) safeText(ui.count, `${items.length} ${state.dataset === 'history' ? 'saved threads' : 'open threads'}${state.query ? ' · filtered' : ''}`);
    if (ui.snapshotLabel) safeText(ui.snapshotLabel, `Snapshot captured ${snapshot.capturedAt || 'at an unknown time'} · design study`);
    syncSharedComposer();
    if (ui.columns) ui.columns.value = String(state.columns);
    if (ui.dataset) ui.dataset.value = state.dataset;
    if (ui.layout) ui.layout.value = state.layout;
    if (ui.composerMode) ui.composerMode.value = state.composerMode;
    const fitted = Math.max(1, Math.min(state.columns, 4, Math.floor(((ui.grid.clientWidth || 1000) + 8) / 248)));
    ui.grid.style.setProperty('--requested-columns', String(state.columns));
    ui.grid.style.setProperty('--actual-columns', String(fitted));
    if (ui.feedback) safeText(ui.feedback, state.feedback);
    observePanes();
    restorePaneFocus(focused);
  }

  function capturePaneFocus() {
    const active = document.activeElement;
    const paneNode = active && active.closest && active.closest('.pane');
    const menu = active.closest && active.closest('.pane-menu');
    return paneNode ? { id: paneNode.dataset.threadId, label: active.getAttribute('aria-label'), cls: active.className, menuOpen: !!(menu && menu.open) } : null;
  }
  function restorePaneFocus(saved) {
    if (!saved) return;
    const paneNode = [...ui.grid.querySelectorAll('.pane')].find((node) => node.dataset.threadId === saved.id);
    if (!paneNode) return;
    const menu = paneNode.querySelector('.pane-menu'); if (menu && saved.menuOpen) menu.open = true;
    let target = saved.label ? [...paneNode.querySelectorAll('[aria-label]')].find((node) => node.getAttribute('aria-label') === saved.label) : null;
    if (!target && typeof saved.cls === 'string') target = [...paneNode.querySelectorAll('*')].find((node) => node.className === saved.cls);
    if (target && target.focus) target.focus({ preventScroll: true });
  }

  function toggleCollapsed(id) {
    if (!valid(id)) return;
    const name = byId.get(id).title || 'Thread';
    if (state.collapsed.has(id)) { state.collapsed.delete(id); state.feedback = `${name} restored.`; }
    else { state.collapsed.add(id); state.feedback = `${name} collapsed to its title bar. Double-click it to restore.`; }
    render();
  }

  function selectThread(id) {
    if (!valid(id)) return;
    if (ui.draft && state.composerMode === 'shared') saveDraft(state.selectedId, ui.draft.value);
    state.selectedId = id;
    render();
  }

  function changeSpan(id, span) {
    const fitted = Math.max(1, Math.min(state.columns, 4, Math.floor(((ui.grid.clientWidth || 1000) + 8) / 248)));
    if (fitted < 2 || shownThreads().length < 2) {
      state.feedback = 'Span changes need at least two available columns and two visible threads.';
      if (ui.feedback) safeText(ui.feedback, state.feedback);
      return;
    }
    state.spans.set(id, span === 2 ? 2 : 1);
    state.feedback = `${byId.get(id).title || 'Thread'} now uses ${span === 2 ? 'two columns' : 'one column'}.`;
    render();
  }

  function previewThread(id, textarea) {
    const text = textarea ? textarea.value.trim() : '';
    if (!text) { state.feedback = 'Add a draft before previewing it.'; if (ui.feedback) safeText(ui.feedback, state.feedback); return; }
    const list = previews.get(id) || [];
    list.push(text); previews.set(id, list);
    saveDraft(id, '');
    state.feedback = 'Local preview added. Nothing was sent.';
    render();
  }

  function moveThread(id, delta) {
    const order = state.order;
    const from = order.indexOf(id); const to = Math.max(0, Math.min(order.length - 1, from + delta));
    if (from < 0 || to === from) return;
    order.splice(from, 1); order.splice(to, 0, id);
    state.feedback = `Moved ${byId.get(id).title || 'thread'} ${delta < 0 ? 'earlier' : 'later'}.`; render();
  }

  function beginDrag(event, id, node) {
    if (event.button !== 0) return;
    event.preventDefault();
    state.drag = { id, node, handle: event.currentTarget, startX: event.clientX, startY: event.clientY, target: null, moved: false, pointerId: event.pointerId };
    const ghost = make('div', 'snap-preview', `Moving: ${byId.get(id).title || 'thread'}`);
    ghost.setAttribute('aria-live', 'polite');
    ui.grid.append(ghost); state.drag.ghost = ghost;
    node.classList.add('dragging');
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) { /* capture is optional */ }
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
    document.addEventListener('pointercancel', cancelDrag);
    document.addEventListener('keydown', onDragKey);
  }

  function onDragMove(event) {
    if (!state.drag) return;
    if (Math.hypot(event.clientX - state.drag.startX, event.clientY - state.drag.startY) > 6) state.drag.moved = true;
    if (!state.drag.moved) return;
    const gridRect = ui.grid.getBoundingClientRect();
    if (event.clientX < gridRect.left || event.clientX > gridRect.right || event.clientY < gridRect.top || event.clientY > gridRect.bottom) {
      state.drag.target = null; state.drag.ghost.textContent = 'Drop inside a thread pane to reorder'; return;
    }
    const candidates = [...ui.grid.querySelectorAll('.pane')].filter((paneNode) => paneNode.dataset.threadId !== state.drag.id);
    let nearest = null; let distance = Infinity;
    candidates.forEach((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const d = Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2));
      if (d < distance) { distance = d; nearest = candidate; }
    });
    if (nearest) {
      state.drag.target = nearest.dataset.threadId;
      const rect = nearest.getBoundingClientRect();
      state.drag.after = event.clientX > rect.left + rect.width / 2;
      state.drag.ghost.style.position = 'fixed'; state.drag.ghost.style.pointerEvents = 'none';
      state.drag.ghost.style.left = `${rect.left}px`; state.drag.ghost.style.top = `${rect.top}px`;
      state.drag.ghost.style.width = `${rect.width}px`; state.drag.ghost.style.height = `${rect.height}px`;
      state.drag.ghost.textContent = `Drop ${state.drag.after ? 'after' : 'before'}: ${byId.get(state.drag.target).title || 'thread'}`;
    } else state.drag.target = null;
  }

  function finishDrag(commit) {
    const drag = state.drag; if (!drag) return;
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    document.removeEventListener('pointercancel', cancelDrag);
    document.removeEventListener('keydown', onDragKey);
    drag.node.classList.remove('dragging'); drag.ghost.remove();
    try { if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId); } catch (_) { /* pointer capture may have ended */ }
    state.drag = null;
    if (commit && drag.moved && drag.target && drag.target !== drag.id) {
      const from = state.order.indexOf(drag.id); const target = state.order.indexOf(drag.target);
      if (from >= 0 && target >= 0) {
        state.order.splice(from, 1);
        const destination = state.order.indexOf(drag.target) + (drag.after ? 1 : 0);
        state.order.splice(destination, 0, drag.id);
      }
      state.feedback = `Moved ${byId.get(drag.id).title || 'thread'} ${drag.after ? 'after' : 'before'} ${byId.get(drag.target).title || 'thread'}.`;
    }
    render();
  }
  function onDragEnd(event) { if (state.drag && event.pointerId !== state.drag.pointerId) return; finishDrag(true); }
  function cancelDrag() { finishDrag(false); }
  function onDragKey(event) { if (event.key === 'Escape') { event.preventDefault(); finishDrag(false); } }

  function observePanes() {
    if (!('ResizeObserver' in window)) return;
    if (window.__adaptiveThreadPaneObserver) window.__adaptiveThreadPaneObserver.disconnect();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const paneNode = entry.target; const { width, height } = entry.contentRect;
        const density = width < 240 || height < 180 ? 'tile' : (width >= 420 && height >= 300 ? 'full' : 'compact');
        if (paneNode.dataset.density !== density) {
          paneNode.dataset.density = density;
          const thread = byId.get(paneNode.dataset.threadId);
          const body = paneNode.querySelector('.pane-body');
          if (thread && body) {
            body.replaceChildren(make('div', 'pane-meta', `${thread.closed ? 'Archived snapshot' : 'Open snapshot'} · ${membersText(thread) || 'Participants unknown'}`));
            const transcript = messages(thread);
            if (density === 'tile') {
              body.append(make('p', 'tile-excerpt', excerpt(thread)));
            } else {
              const count = density === 'full' ? transcript.length : Math.min(2, transcript.length);
              transcript.slice(-count).forEach((message) => {
                const line = make('p', 'message');
                line.append(make('span', 'speaker', message.speaker || 'Unknown'), document.createTextNode(': '), document.createTextNode(message.text || ''));
                body.append(line);
              });
              if (!transcript.length) body.append(make('p', 'message', 'No captured transcript excerpt.'));
            }
          }
        }
        paneNode.classList.remove('full', 'compact', 'tile'); paneNode.classList.add(density);
      }
    });
    ui.grid.querySelectorAll('.pane').forEach((node) => observer.observe(node));
    window.__adaptiveThreadPaneObserver = observer;
  }

  function reset() {
    threads.forEach((thread) => { drafts.set(thread.id, ''); previews.set(thread.id, []); });
    state.dataset = 'history'; state.layout = 'focus'; state.columns = 4; state.composerMode = 'shared';
    state.feedback = 'Study reset. Drafts and local previews cleared.';
    state.query = ''; state.order = [...originalOrder]; state.spans.clear(); state.collapsed.clear();
    state.selectedId = byId.has(snapshot.focusedId) ? snapshot.focusedId : (threads[0] && threads[0].id);
    if (ui.search) ui.search.value = '';
    render();
  }

  if (ui.dataset) ui.dataset.addEventListener('change', () => { state.dataset = ui.dataset.value === 'history' ? 'history' : 'open'; render(); });
  if (ui.layout) ui.layout.addEventListener('change', () => { state.layout = ui.layout.value === 'grid' ? 'grid' : 'focus'; render(); });
  if (ui.columns) ui.columns.addEventListener('change', () => { state.columns = Math.max(1, Math.min(4, Number(ui.columns.value) || 1)); render(); });
  if (ui.composerMode) ui.composerMode.addEventListener('change', () => {
    if (ui.draft && state.composerMode === 'shared') saveDraft(state.selectedId, ui.draft.value);
    state.composerMode = ui.composerMode.value === 'per-pane' ? 'per-pane' : 'shared'; render();
  });
  if (ui.search) ui.search.addEventListener('input', () => { state.query = ui.search.value; render(); });
  if (ui.draft) ui.draft.addEventListener('input', () => saveDraft(state.selectedId, ui.draft.value));
  if (ui.preview) ui.preview.addEventListener('click', () => previewThread(state.selectedId, ui.draft));
  if (ui.reset) ui.reset.addEventListener('click', reset);

  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(() => {
    const availableWidth = ui.grid ? ui.grid.clientWidth : window.innerWidth;
    const fittedColumns = Math.max(1, Math.min(state.columns, 4, Math.floor((availableWidth + 8) / 248)));
    ui.grid && ui.grid.style.setProperty('--requested-columns', String(state.columns));
    ui.grid && ui.grid.style.setProperty('--actual-columns', String(fittedColumns));
    if (ui.grid) ui.grid.querySelectorAll(':scope > .pane').forEach((node) => {
      const id = node.dataset.threadId;
      const span = state.spans.has(id) ? state.spans.get(id) : (state.layout === 'focus' && id === state.selectedId ? 2 : 1);
      const canSpan = fittedColumns > 1 && shownThreads().filter((t) => !state.collapsed.has(t.id)).length > 1;
      const expanded = state.layout === 'focus' && id === state.selectedId && canSpan && span === 2;
      const wide = (expanded || (state.layout === 'grid' && canSpan && span === 2));
      node.style.gridColumn = wide ? 'span 2' : '';
      node.style.gridRow = expanded ? 'span 2' : '';
      const buttons = node.querySelectorAll('.pane-actions button');
      buttons.forEach((button) => { if (button.textContent === '−') button.disabled = !canSpan || span === 1; if (button.textContent === '+') button.disabled = !canSpan || span === 2; });
    });
  }) : null;
  if (ui.grid && resizeObserver) resizeObserver.observe(ui.grid);
  render();
})();
