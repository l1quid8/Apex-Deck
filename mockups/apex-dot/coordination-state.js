(function exposeCoordination(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApexCoordination = api;
})(typeof globalThis === 'object' ? globalThis : this, function coordinationModule() {
  'use strict';

  const STORAGE_KEY = 'apex-coordination-preview-v1';
  const STATUSES = new Set(['working', 'paused', 'needs_review', 'failed', 'cancelled', 'done']);
  const PROJECTS = [
    { id: 'apex-deck', name: 'apex-deck', host: 'This Mac', path: '/Users/tylercaldwell/Downloads/apex-deck', goal: 'Prepare a reviewed Apex Deck release.' },
    { id: 'REA', name: 'REA', host: 'This Mac', path: '/Users/tylercaldwell/Downloads/REA', goal: 'Explore the assistant workspace and document the design.' },
    { id: 'apex_terminal', name: 'apex_terminal', host: 'APEX-TERMINAL', path: '/workspace/apex_terminal', goal: 'Review terminal reliability and capture the handoff.' },
  ];
  const clone = value => JSON.parse(JSON.stringify(value));
  const timestamp = () => new Date().toISOString();
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  const validEvents = value => Array.isArray(value) ? value.filter(event => event && typeof event.at === 'string' && typeof event.text === 'string').map(event => ({ ...event })) : [];

  function newId(prefix) {
    const suffix = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    return prefix + '-' + suffix;
  }

  function worktreeFor(project, taskId, attempt) {
    return project.path + '/.apex-preview-worktrees/' + taskId.replace(/[^a-zA-Z0-9_-]/g, '-') + '-attempt-' + attempt;
  }

  function recordEvent(state, task, text) {
    const event = { at: timestamp(), text };
    task.events.push(event);
    state.events.push({ ...event, taskId: task.id, ownerId: task.ownerId, projectId: task.projectId });
  }

  function seedState(primaryId, secondaryId) {
    const state = { version: 1, revision: 0, projects: clone(PROJECTS), tasks: [], notes: [], events: [] };
    const seeds = [
      ['t-deck', primaryId, 'apex-deck', 'Review release readiness', 'Sol', 'Collect the release checks and keep packaging pending for owner review.', 'working'],
      ['t-rea', primaryId, 'REA', 'Inspect workspace navigation', 'Local worker', 'Trace the mockup navigation and leave a concise design handoff.', 'working'],
      ['t-terminal', secondaryId, 'apex_terminal', 'Review connection recovery', 'DeepGeek', 'Inspect the terminal recovery concept and summarize the open decisions.', 'working'],
      ['t-review', primaryId, 'apex-deck', 'Release checklist handoff', 'Sol', 'Prepare a checklist for review; do not start packaging.', 'needs_review'],
      ['t-failed', secondaryId, 'apex_terminal', 'Check remote workspace', 'Local worker', 'Inspect the remote workspace connection in this simulation.', 'failed'],
      ['t-done', primaryId, 'REA', 'Document pane behavior', 'Sol', 'Record the assistant main-pane and global-sidebar behavior.', 'done'],
    ];
    for (const [id, ownerId, projectId, title, worker, brief, status] of seeds) {
      const task = {
        id, ownerId, projectId, title, worker, brief, status, step: status === 'working' || status === 'failed' ? 0 : 2,
        attempt: 1, threadId: 'thread-' + id, worktree: worktreeFor(state.projects.find(project => project.id === projectId), id, 1),
        scratch: id === 't-review' ? {
          title: 'Release review preferences',
          text: 'Illustrative worker notes: review the changes and installed-app smoke test before packaging. Save this to the Apex Deck notebook only after explicit review.',
        } : null,
        events: [], pauseReason: null,
      };
      state.tasks.push(task);
      recordEvent(state, task, status === 'failed' ? 'Preview connection check failed. Retry starts a new attempt.'
        : status === 'done' ? 'Illustrative handoff completed.'
          : status === 'needs_review' ? 'Worker handoff is ready for owner review; scratch notes are unpublished.'
            : 'Delegated to ' + worker + ' in this design preview.');
    }
    const at = timestamp();
    const personalOwners = [...new Set([primaryId, secondaryId])];
    for (const ownerId of personalOwners) {
      state.notes.push({ id: newId('note'), scope: 'assistant', ownerId, title: 'How I work',
        text: ownerId === primaryId ? 'Keep decisions visible, preserve project context, and ask for review before promoting worker notes.' : 'Keep terminal follow-ups concise and include a clear recovery step.',
        version: 1, updatedAt: at });
    }
    for (const project of state.projects) {
      state.notes.push({ id: newId('note'), scope: 'project', ownerId: project.id, title: project.name + ' notebook',
        text: project.id === 'apex-deck' ? 'Keep release packaging pending until the owner has reviewed the changes and smoke test.'
          : project.id === 'REA' ? 'This workspace contains an isolated design preview. Keep production integration separate.'
            : 'Capture recovery observations and leave the final terminal decisions for the project owner.',
        version: 1, updatedAt: at });
    }
    return state;
  }

  // Stored data is untrusted browser-local preview data, never an execution request.
  function normalizeState(value) {
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Array.isArray(value.projects) || !Array.isArray(value.tasks) || !Array.isArray(value.notes) || !Array.isArray(value.events)) return null;
    const state = { version: 1, revision: value.revision, projects: clone(PROJECTS), tasks: [], notes: [], events: validEvents(value.events) };
    for (const saved of value.projects) {
      const index = state.projects.findIndex(project => project.id === saved?.id);
      if (index !== -1 && nonempty(saved.name) && nonempty(saved.path) && typeof saved.goal === 'string'
        && ['This Mac', 'APEX-TERMINAL'].includes(saved.host)) state.projects[index] = { id: saved.id, name: saved.name, host: saved.host, path: saved.path, goal: saved.goal };
    }
    const taskIds = new Set();
    for (const task of value.tasks) {
      if (!task || !nonempty(task.id) || taskIds.has(task.id) || !nonempty(task.ownerId)
        || !state.projects.some(project => project.id === task.projectId) || !nonempty(task.title)
        || !nonempty(task.worker) || typeof task.brief !== 'string' || !STATUSES.has(task.status)
        || !Number.isInteger(task.step) || task.step < 0 || task.step > 2
        || !Number.isSafeInteger(task.attempt) || task.attempt < 1 || !nonempty(task.threadId) || !nonempty(task.worktree)) continue;
      taskIds.add(task.id);
      const scratch = task.scratch && nonempty(task.scratch.title) && typeof task.scratch.text === 'string' ? {
        title: task.scratch.title, text: task.scratch.text,
        ...(nonempty(task.scratch.promotedId) ? { promotedId: task.scratch.promotedId } : {}),
        ...(task.scratch.dismissed === true ? { dismissed: true } : {}),
      } : null;
      state.tasks.push({ id: task.id, ownerId: task.ownerId, projectId: task.projectId, title: task.title,
        worker: task.worker, brief: task.brief, status: task.status, step: task.step, attempt: task.attempt,
        threadId: task.threadId, worktree: task.worktree, scratch, events: validEvents(task.events),
        pauseReason: task.status === 'paused' ? (task.pauseReason === 'assistant' ? 'assistant' : 'manual') : null });
    }
    const noteIds = new Set();
    for (const note of value.notes) {
      if (!note || !nonempty(note.id) || noteIds.has(note.id) || !['assistant', 'project'].includes(note.scope)
        || !nonempty(note.ownerId) || (note.scope === 'project' && !state.projects.some(project => project.id === note.ownerId))
        || !nonempty(note.title) || typeof note.text !== 'string' || !Number.isSafeInteger(note.version)
        || note.version < 1 || typeof note.updatedAt !== 'string') continue;
      noteIds.add(note.id);
      state.notes.push({ id: note.id, scope: note.scope, ownerId: note.ownerId, title: note.title, text: note.text,
        version: note.version, updatedAt: note.updatedAt, ...(nonempty(note.sourceTaskId) ? { sourceTaskId: note.sourceTaskId } : {}) });
    }
    return state;
  }

  function create(options = {}) {
    const storage = options.storage ?? null;
    const primaryId = nonempty(options.primaryId) ? options.primaryId : 'demo-null';
    const secondaryId = nonempty(options.secondaryId) ? options.secondaryId : 'demo-secondary';
    let available = storage !== null;
    let storageReadable = false;
    let state;
    const listeners = new Set();

    function readStored() {
      if (!storage) return null;
      let raw;
      try { raw = storage.getItem(STORAGE_KEY); storageReadable = true; }
      catch { storageReadable = false; available = false; return null; }
      try { return raw ? normalizeState(JSON.parse(raw)) : null; }
      catch { return null; }
    }

    function persist() {
      if (!storage) { available = false; return; }
      try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); available = storageReadable; }
      catch { available = false; }
    }

    state = readStored();
    if (!state) { state = seedState(primaryId, secondaryId); persist(); }

    function mutate(change) {
      // A stale tab reloads the latest complete revision before changing an entity.
      // Failed writes leave the newer in-memory revision usable for this session.
      const latest = readStored();
      if (latest && latest.revision >= state.revision) state = latest;
      const draft = clone(state);
      const result = change(draft);
      if (result.changed === false) return result.value;
      draft.revision = state.revision + 1;
      state = draft;
      persist();
      for (const listener of listeners) {
        try { listener(state); } catch { /* A view callback cannot roll back saved preview state. */ }
      }
      return result.value;
    }

    function requireTask(draft, id) {
      const task = draft.tasks.find(candidate => candidate.id === id);
      if (!task) throw new Error('Task not found.');
      return task;
    }

    function requireState(task, allowed, action) {
      if (!allowed.includes(task.status)) throw new Error('Cannot ' + action + ' a task that is ' + task.status + '.');
    }

    return {
      get state() { return state; },
      get available() { return available; },
      subscribe(listener) {
        if (typeof listener !== 'function') throw new Error('A subscriber must be a function.');
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      project(id) { return state.projects.find(project => project.id === id); },
      task(id) { return state.tasks.find(task => task.id === id); },
      tasksForAssistant(id) { return state.tasks.filter(task => task.ownerId === id); },
      notesFor(scope, ownerId) { return state.notes.filter(note => note.scope === scope && note.ownerId === ownerId); },
      contextForTask(id) {
        const task = requireTask(state, id);
        return {
          assistantNotes: state.notes.filter(note => note.scope === 'assistant' && note.ownerId === task.ownerId),
          projectNotes: state.notes.filter(note => note.scope === 'project' && note.ownerId === task.projectId),
          brief: task.brief,
        };
      },
      delegate({ ownerId, projectId, title, worker, brief = '', paused = false } = {}) {
        return mutate(draft => {
          const project = draft.projects.find(candidate => candidate.id === projectId);
          if (!project) throw new Error('Choose an existing project.');
          if (![ownerId, title, worker].every(nonempty) || typeof brief !== 'string') throw new Error('Owner, task title, worker and a text brief are required.');
          const id = newId('task');
          const task = { id, ownerId, projectId, title: title.trim(), worker: worker.trim(), brief: brief.trim(),
            status: paused ? 'paused' : 'working', step: 0, attempt: 1, threadId: 'thread-' + id,
            worktree: worktreeFor(project, id, 1), scratch: null, events: [], pauseReason: paused ? 'assistant' : null };
          draft.tasks.push(task);
          recordEvent(draft, task, 'Delegated to ' + task.worker + (paused ? '; waiting for the owning assistant to resume.' : ' in this design preview.'));
          return { value: task };
        });
      },
      transition(id, action) {
        return mutate(draft => {
          const task = requireTask(draft, id);
          let message;
          if (action === 'pause') {
            requireState(task, ['working'], action); task.status = 'paused'; task.pauseReason = 'manual'; message = 'Worker paused manually.';
          } else if (action === 'resume') {
            requireState(task, ['paused'], action); task.status = 'working'; task.pauseReason = null; message = 'Worker resumed.';
          } else if (action === 'cancel') {
            requireState(task, ['working', 'paused', 'needs_review', 'failed'], action); task.status = 'cancelled'; task.pauseReason = null; message = 'Attempt cancelled. Its thread and history are preserved.';
          } else if (action === 'retry') {
            requireState(task, ['failed', 'cancelled'], action);
            task.status = 'working'; task.step = 0; task.attempt += 1; task.pauseReason = null; task.scratch = null;
            task.worktree = worktreeFor(draft.projects.find(project => project.id === task.projectId), task.id, task.attempt);
            message = 'Started attempt ' + task.attempt + ' in a new preview worktree. Previous events are preserved.';
          } else if (action === 'approve') {
            requireState(task, ['needs_review'], action); task.status = 'done'; task.pauseReason = null; message = 'Owner approved the illustrative handoff. Scratch promotion remains a separate decision.';
          } else throw new Error('Unknown task action: ' + action + '.');
          recordEvent(draft, task, message);
          return { value: task };
        });
      },
      advance() {
        return mutate(draft => {
          const changed = draft.tasks.filter(task => task.status === 'working');
          for (const task of changed) {
            task.step = Math.min(2, task.step + 1);
            if (task.step === 2) {
              task.status = 'needs_review';
              task.scratch = { title: task.title + ' handoff', text: 'Illustrative worker result from ' + task.worker + ': ' + task.brief + '\n\nThe preview handoff is ready for owner review. These scratch notes are not yet part of the shared project notebook.' };
              recordEvent(draft, task, 'Illustrative result ready for owner review. Scratch notes remain unpublished.');
            } else recordEvent(draft, task, 'Preview progress: inspected the brief and scoped project context.');
          }
          return { value: changed, changed: changed.length > 0 };
        });
      },
      syncAssistant(ownerId, paused) {
        return mutate(draft => {
          const changed = [];
          for (const task of draft.tasks) {
            if (task.ownerId !== ownerId) continue;
            if (paused === true && task.status === 'working') {
              task.status = 'paused'; task.pauseReason = 'assistant'; changed.push(task);
              recordEvent(draft, task, 'Paused with the owning assistant.');
            } else if (paused === false && task.status === 'paused' && task.pauseReason === 'assistant') {
              task.status = 'working'; task.pauseReason = null; changed.push(task);
              recordEvent(draft, task, 'Resumed with the owning assistant.');
            }
          }
          return { value: changed, changed: changed.length > 0 };
        });
      },
      saveNote({ scope, ownerId, title, text, id, expectedVersion } = {}) {
        return mutate(draft => {
          if (!['assistant', 'project'].includes(scope) || ![ownerId, title, text].every(nonempty)) throw new Error('A note needs a scope, owner, title and text.');
          if (scope === 'project' && !draft.projects.some(project => project.id === ownerId)) throw new Error('Project notebook not found.');
          let note;
          if (id !== undefined) {
            const index = draft.notes.findIndex(candidate => candidate.id === id);
            if (index === -1) throw new Error('This note no longer exists.');
            const previous = draft.notes[index];
            if (previous.scope !== scope || previous.ownerId !== ownerId) throw new Error('A note cannot change its memory scope or owner.');
            if (!Number.isSafeInteger(expectedVersion) || previous.version !== expectedVersion) throw new Error('This note changed in another view. Reload its latest version before saving.');
            note = { ...previous, title: title.trim(), text: text.trim(), version: previous.version + 1, updatedAt: timestamp() };
            draft.notes[index] = note;
          } else {
            note = { id: newId('note'), scope, ownerId, title: title.trim(), text: text.trim(), version: 1, updatedAt: timestamp() };
            draft.notes.push(note);
          }
          draft.events.push({ at: note.updatedAt, text: (id === undefined ? 'Created' : 'Updated') + ' ' + (scope === 'project' ? 'project notebook' : 'personal memory') + ' note: ' + note.title,
            ...(scope === 'project' ? { projectId: ownerId } : { ownerId }) });
          return { value: note };
        });
      },
      promote(taskId) {
        return mutate(draft => {
          const task = requireTask(draft, taskId);
          requireState(task, ['needs_review', 'done'], 'promote scratch notes for');
          if (!task.scratch || task.scratch.dismissed) throw new Error('No unpublished scratch notes are available to promote.');
          const previous = draft.notes.find(note => note.sourceTaskId === task.id && note.scope === 'project' && note.ownerId === task.projectId);
          if (previous) {
            const changed = task.scratch.promotedId !== previous.id;
            task.scratch.promotedId = previous.id;
            return { value: previous, changed };
          }
          if (task.scratch.promotedId) throw new Error('The promoted project note is unavailable.');
          const note = { id: newId('note'), scope: 'project', ownerId: task.projectId, title: task.scratch.title,
            text: task.scratch.text, version: 1, updatedAt: timestamp(), sourceTaskId: task.id };
          draft.notes.push(note);
          task.scratch.promotedId = note.id;
          recordEvent(draft, task, 'Owner reviewed and promoted worker scratch to the shared project notebook.');
          return { value: note };
        });
      },
      dismissScratch(taskId) {
        return mutate(draft => {
          const task = requireTask(draft, taskId);
          if (!task.scratch) throw new Error('No scratch notes are available.');
          if (task.scratch.promotedId) throw new Error('These scratch notes have already been promoted.');
          if (task.scratch.dismissed) return { value: task, changed: false };
          task.scratch.dismissed = true;
          recordEvent(draft, task, 'Owner dismissed worker scratch. The shared project notebook was not changed.');
          return { value: task };
        });
      },
    };
  }

  return { create };
});
