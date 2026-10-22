'use strict';

// Browser-only interaction model for reviewing the proposed Apex workflow.
// All execution, threads, context and results in this file are illustrative.
(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const UI_KEY = 'apex-coordination-layout-v1';
  let storage = null;
  try { storage = localStorage; } catch { /* In-memory preview remains usable. */ }
  let hadSavedProgress = false;
  try { hadSavedProgress = Boolean(storage?.getItem('apex-coordination-preview-v1')); } catch { storage = null; }
  const primary = profileState.profiles.find(profile => profile.id === 'demo-null') || profileState.profiles[0];
  if (profileState.profiles.length === 1 && !hadSavedProgress) {
    const second = makeProfile('demo-ada', 'Ada');
    second.connections = ['apex_terminal'];
    profileState.profiles.push(second);
    if (primary.connections.length === 3) primary.connections = ['apex-deck', 'REA'];
    persistProfiles();
  }
  const secondary = profileState.profiles.find(profile => profile.id !== primary.id) || primary;
  const store = ApexCoordination.create({storage, primaryId:primary.id, secondaryId:secondary.id});
  const defaults = {page:'assistant', tab:'projects', lastAssistantTab:'projects', sidebarOpen:true, rightTab:'dashboard', collapsed:{}, projectFilter:'all', memoryScope:'assistant', projectId:'apex-deck', taskId:null, workView:'project', placement:'Main pane', taskOwner:'all', taskProject:'all', taskQuery:''};
  let ui = {...defaults};
  try { ui = {...defaults, ...JSON.parse(storage?.getItem(UI_KEY) || '{}')}; } catch { /* Retain default layout. */ }
  if (!ui.collapsed || typeof ui.collapsed !== 'object') ui.collapsed = {};
  if (!['chat','projects','activity','memory','settings'].includes(ui.tab)) ui.tab = 'projects';
  if (!store.project(ui.projectId)) ui.projectId = 'apex-deck';
  if (ui.taskId && !store.task(ui.taskId)) ui.taskId = null;
  let memoryQuery = '';
  let taskContextId = null;
  const nameOf = id => profileState.profiles.find(profile => profile.id === id)?.name || 'Saved assistant';
  const profileOf = id => profileState.profiles.find(profile => profile.id === id);
  const statusNames = {working:'Working', paused:'Paused', needs_review:'Needs review', failed:'Stopped', cancelled:'Cancelled', done:'Done'};
  const activeStatuses = ['working','paused','needs_review'];
  const tasksForProject = id => store.state.tasks.filter(task => task.projectId === id);
  const assignedProjects = () => store.state.projects.filter(project => currentProfile().connections.includes(project.id));
  const action = (label, type, id = '', extra = '') => `<button type="button" class="small-button${extra.includes('primary')?' primary':''}" data-coord="${type}" data-id="${esc(id)}" ${extra.replace(/class="[^"]*"/g,'')}>${esc(label)}</button>`;
  const status = task => `<span class="status-label status-${esc(task.status)}">${statusNames[task.status] || esc(task.status)}</span>`;
  const date = at => new Date(at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  const saveLayout = () => { try { storage?.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* Preview state remains in this tab. */ } };
  const teamProjects = owner => store.state.projects.filter(project => profileOf(owner)?.connections.includes(project.id));
  const availableWorkers = () => {
    const workers = new Map();
    for (const name of ['Codex', 'Claude Code', 'deepgeek', ...store.state.tasks.map(task => task.worker)]) {
      if (!workers.has(name.toLowerCase())) workers.set(name.toLowerCase(), name);
    }
    return [...workers.values()];
  };

  // Reusable workers have their own top-level destination; assistants stay in Your team.
  const agentsPanel = document.createElement('section');
  agentsPanel.className = 'agents-view';
  agentsPanel.setAttribute('aria-label', 'Agents');
  agentsPanel.innerHTML = '<div class="scroll-page"><div class="page-inner" id="agents-content"></div></div>';
  $('.workspace').append(agentsPanel);

  function renderAgents() {
    $('#agents-content').innerHTML = `<div class="coord-intro"><h1>Agents</h1><p>Reusable workers your assistants can delegate to. Manage your assistants under Your team in the left sidebar.</p></div>${availableWorkers().map(worker => {
      const tasks = store.state.tasks.filter(task => task.worker.toLowerCase() === worker.toLowerCase());
      const working = tasks.filter(task => task.status === 'working').length;
      return `<section class="coord-project"><div class="project-top"><span class="project-glyph">${icon('code')}</span><div><h2>${esc(worker)}</h2><p>${working ? `${working} working ${working === 1 ? 'assignment' : 'assignments'}` : 'No running assignments'}</p></div></div><div class="coord-actions">${action('Delegate a task', 'delegate-worker', worker)}</div>${tasks.length ? `<details class="agent-assignments"><summary>Assignments (${tasks.length})</summary>${tasks.map(taskRow).join('')}</details>` : '<p class="coord-note">Available for a new assignment.</p>'}</section>`;
    }).join('')}<p class="coord-note">Preview workers and assignments only. No models or coding tools are connected.</p>`;
  }

  // Add a main-pane Projects section. Memory and settings remain menu destinations.
  const projectTab = document.createElement('button');
  projectTab.type = 'button'; projectTab.id = 'tab-projects'; projectTab.dataset.tab = 'projects';
  projectTab.setAttribute('role','tab'); projectTab.setAttribute('aria-controls','panel-projects');
  projectTab.setAttribute('aria-selected','false'); projectTab.tabIndex = -1; projectTab.textContent = 'Projects';
  $('#tab-activity').before(projectTab);
  const projectPanel = document.createElement('section');
  projectPanel.id = 'panel-projects'; projectPanel.className = 'tab-content'; projectPanel.hidden = true;
  projectPanel.setAttribute('role','tabpanel'); projectPanel.setAttribute('aria-labelledby','tab-projects');
  projectPanel.innerHTML = '<div class="scroll-page"><div class="page-inner" id="projects-content"></div></div>';
  $('#panel-activity').before(projectPanel);
  projectTab.addEventListener('click', () => setTab('projects'));
  $('.settings-description').textContent = 'Assign projects to this assistant. Each project has its own shared notebook. Finish or cancel active work before removing an assignment.';
  const oldMemoryFilter = filterProfileMemories;
  $('#memory-search').removeEventListener('input', oldMemoryFilter);
  $('#memory-search').setAttribute('aria-label','Search notes');
  $('#panel-memory').querySelectorAll('[data-note],.provenance').forEach(node => node.remove());
  const memoryControls = document.createElement('div'); memoryControls.className = 'memory-controls';
  memoryControls.innerHTML = '<select id="memory-scope" aria-label="Memory notebook"></select><button class="small-button" type="button" data-coord="new-note">'+icon('plus')+' Add note</button>';
  $('#memory-search').before(memoryControls);
  const memoryInfo = document.createElement('p'); memoryInfo.className = 'memory-scope-info'; memoryInfo.id = 'memory-scope-info';
  $('#memory-search').before(memoryInfo);
  const memoryNotes = document.createElement('div'); memoryNotes.id = 'memory-notes';
  $('#memory-search').after(memoryNotes);
  $('#panel-memory .page-subtitle').textContent = 'Personal notes stay with the assistant. Project notebooks are shared only within that project.';
  $('#panel-memory .page-heading .tag').textContent = 'Preview notebooks';
  $('#panel-activity .page-inner').innerHTML = '<div class="page-heading"><h2 id="activity-heading"></h2><span class="tag">Preview activity</span></div><p class="page-subtitle">Assignments, worker updates, and decisions with an owner and a project.</p><div class="timeline coord-activity" id="coord-activity"></div>';
  $('#right-panel-tasks').innerHTML = '<h2>Tasks</h2><p class="right-muted">Across your workspace</p><div class="task-filters"><select id="task-owner-filter" aria-label="Filter tasks by assistant"></select><select id="task-project-filter" aria-label="Filter tasks by project"></select><input type="search" class="search" id="task-query" aria-label="Search tasks" placeholder="Find a task…"></div><div id="sidebar-task-list"></div>';
  const contextMenu = document.createElement('div'); contextMenu.id = 'dashboard-context-menu'; contextMenu.className = 'context-menu';
  contextMenu.setAttribute('popover','auto'); contextMenu.setAttribute('aria-label','Open dashboard task');
  contextMenu.innerHTML = '<button data-coord="place-new">Open in new pane</button><button data-coord="place-external">Open in external pane</button><button data-coord="place-select">Open in selected pane…</button>';
  document.body.append(contextMenu);
  const placement = document.createElement('div'); placement.className = 'preview-pane-label'; placement.id = 'pane-placement'; placement.hidden = true;
  $('.work-pane .pane-top').after(placement);

  function taskRow(task) {
    return `<button type="button" class="coord-task-row" data-coord="open-task" data-id="${esc(task.id)}" aria-label="${esc(task.title)}, ${esc(nameOf(task.ownerId))}, ${esc(store.project(task.projectId).name)}, ${statusNames[task.status]}"><span><strong>${esc(task.title)}</strong><small>${esc(store.project(task.projectId).name)} · ${esc(nameOf(task.ownerId))} → ${esc(task.worker)}</small></span>${status(task)}</button>`;
  }

  function projectBlock(project) {
    const tasks = tasksForProject(project.id);
    const working = tasks.filter(task => task.status === 'working').length;
    const waiting = tasks.filter(task => task.status === 'needs_review').length;
    const owners = profileState.profiles.filter(profile => profile.connections.includes(project.id));
    return `<article class="coord-project" data-project="${esc(project.id)}"><div class="project-top"><span class="project-glyph">${icon('folder')}</span><div><h3>${esc(project.name)}</h3><p>${esc(project.host)} · ${esc(project.path)}</p></div><span class="tag ${waiting && !working ? 'pending' : ''}">${working ? `${working} working` : waiting ? 'Needs review' : 'Ready'}</span></div><p class="project-summary">${esc(project.goal)}</p><div class="project-owners">${owners.map(profile => `<span class="coord-person">${assistantAvatarMarkup(profile)}${esc(profile.name)}</span>`).join('') || '<span class="right-muted">No assistant assigned</span>'}</div><div>${tasks.filter(task => task.status !== 'done').slice(0,3).map(taskRow).join('') || '<p class="right-muted">No active assignments.</p>'}</div><div class="coord-actions">${action('Open project','open-project',project.id)}${action('Delegate a task','delegate',project.id)}${action('Project notebook','project-notebook',project.id)}</div></article>`;
  }

  function renderProjects() {
    const mine = ui.projectFilter === 'mine';
    const projects = mine ? assignedProjects() : store.state.projects;
    const tasks = store.state.tasks.filter(task => !mine || task.ownerId === currentProfile().id);
    $('#projects-content').innerHTML = `<div class="coord-intro"><h2>${mine ? `${esc(currentProfile().name)}’s projects` : 'Your projects, moving together.'}</h2><p>Give each project a clear goal. Your assistants coordinate the workers and bring the results back here.</p></div>${hadSavedProgress ? '<div class="recovery-banner">Saved progress restored. Working tasks keep their status; no demo task was restarted.</div>' : ''}<div class="coord-overview"><span><strong>${projects.length}</strong> projects</span><span><strong>${tasks.filter(task => task.status === 'working').length}</strong> working</span><span><strong>${tasks.filter(task => task.status === 'needs_review').length}</strong> need review</span></div><div class="coord-toolbar"><select id="project-view-filter" aria-label="Projects to show"><option value="all" ${!mine?'selected':''}>All projects</option><option value="mine" ${mine?'selected':''}>Assigned to ${esc(currentProfile().name)}</option></select><div class="actions">${action('Assign projects','assign')}${action('Delegate a task','delegate','','class="small-button primary"')}</div></div>${projects.map(projectBlock).join('') || '<p class="coord-empty">No projects assigned yet. Choose Assign projects to give this assistant a place to work.</p>'}<p class="coord-note">Workers use their assignment, this assistant’s notes, and their own project notebook. Worker scratch notes become shared project knowledge only after review.</p>`;
  }

  function renderSummary() {
    $('#conversation .coord-welcome')?.remove();
    // Replace the old release-only greeting, retaining every saved demo message.
    if (currentProfile().id === 'demo-null') {
      const nodes = [...$('#conversation').children];
      // The original seed has four top-level nodes. Remove only that seed.
      if (nodes[0]?.classList.contains('day')) nodes.slice(0,4).forEach(node => node.remove());
    } else $('#conversation .profile-welcome')?.remove();
    const tasks = store.tasksForAssistant(currentProfile().id);
    const working = tasks.filter(task => task.status === 'working');
    const waiting = tasks.filter(task => task.status === 'needs_review');
    const block = document.createElement('section'); block.className = 'coord-welcome';
    block.innerHTML = `<h2>${working.length ? `${working.length} ${working.length===1?'task is':'tasks are'} moving forward.` : waiting.length ? 'A few things need your eye.' : `Ready when you are, ${esc(currentProfile().name)}.`}</h2><p>${esc(currentProfile().name)} has ${teamProjects(currentProfile().id).length} assigned projects. Each project keeps its own work and notes.</p>${tasks.filter(task => activeStatuses.includes(task.status)).slice(0,4).map(taskRow).join('')}<div class="coord-actions">${action('View projects','projects')}${action('Delegate a task','delegate')}${action('Assign projects','assign')}</div>`;
    $('#conversation').prepend(block);
  }

  function renderMemory() {
    const profile = currentProfile();
    const scopes = assignedProjects();
    if (ui.memoryScope !== 'assistant' && !scopes.some(project => project.id === ui.memoryScope)) ui.memoryScope = 'assistant';
    $('#memory-scope').innerHTML = `<option value="assistant">${esc(profile.name)}’s personal notes</option>${scopes.map(project => `<option value="${esc(project.id)}">Project · ${esc(project.name)}</option>`).join('')}`;
    $('#memory-scope').value = ui.memoryScope;
    const personal = ui.memoryScope === 'assistant';
    $('#assistant-memory-heading').textContent = personal ? `${profile.name}’s memory` : store.project(ui.memoryScope).name + ' notebook';
    $('#memory-scope-info').textContent = personal ? `Used by ${profile.name} and its delegated workers. Other assistants have separate personal notes.` : 'Shared by assistants and workers assigned to this project. Notes from other projects are excluded.';
    const notes = store.notesFor(personal ? 'assistant' : 'project', personal ? profile.id : ui.memoryScope);
    const query = memoryQuery.toLowerCase();
    const visible = notes.filter(note => `${note.title} ${note.text}`.toLowerCase().includes(query));
    $('#memory-notes').innerHTML = visible.map(note => `<article class="memory-note" data-note-id="${esc(note.id)}"><div class="note-title">${icon('memory')}<strong>${esc(note.title)}</strong>${action('Edit','edit-note',note.id)}</div><p>${esc(note.text)}</p><div class="note-meta"><span>${personal ? 'Personal · '+esc(profile.name) : 'Shared · '+esc(store.project(note.ownerId).name)}</span><span>Version ${note.version} · ${new Date(note.updatedAt).toLocaleDateString()}</span></div><details><summary>Record and source</summary><pre>Record: ${esc(note.id)}\nUpdated: ${esc(note.updatedAt)}\nSource: ${esc(note.sourceTaskId ? 'Reviewed worker note · '+note.sourceTaskId : 'Saved note in this preview')}</pre></details></article>`).join('');
    $('#memory-empty').hidden = Boolean(visible.length);
    $('#memory-empty').textContent = notes.length ? 'No notes match your search.' : 'No notes in this notebook yet. Add a note to get started.';
  }

  function renderActivity() {
    const events = store.state.events.filter(event => event.ownerId === currentProfile().id).slice().reverse();
    $('#activity-heading').textContent = `What ${currentProfile().name} has been doing`;
    $('#activity-count').textContent = events.length;
    $('#coord-activity').innerHTML = events.slice(0,30).map(event => `<article class="timeline-item"><time>${date(event.at)}</time><strong>${esc(event.text)}</strong><p>${esc(nameOf(event.ownerId))}${event.projectId ? ' · '+esc(store.project(event.projectId)?.name || event.projectId) : ''}</p>${event.taskId ? action('Open worker thread','open-task',event.taskId) : ''}</article>`).join('') || '<p class="coord-empty">No activity yet. Delegate a task to start a worker in an assigned project.</p>';
  }

  function renderDashboard() {
    const groups = [
      ['working','Working',store.state.tasks.filter(task => task.status === 'working')],
      ['attention','Needs you',store.state.tasks.filter(task => ['needs_review','failed'].includes(task.status))],
      ['paused','Paused',store.state.tasks.filter(task => task.status === 'paused')],
      ['idle','Idle',[]],
      ['finished','Finished',store.state.tasks.filter(task => ['done','cancelled'].includes(task.status))],
    ];
    $('#right-panel-dashboard').innerHTML = '<h2>Dashboard</h2><p class="right-muted">All assistants · all projects</p>' + groups.map(([id,label,tasks]) => {
      const idle = id === 'idle' ? profileState.profiles.filter(profile => !store.tasksForAssistant(profile.id).some(task => activeStatuses.includes(task.status))) : [];
      const count = id === 'idle' ? idle.length : tasks.length;
      return `<section class="dashboard-group"><button type="button" class="dashboard-heading" data-coord="collapse" data-id="${id}" aria-expanded="${!ui.collapsed[id]}" aria-controls="dashboard-group-${id}">${icon('down')}${label}<span class="group-count">${count}</span></button><div id="dashboard-group-${id}" ${ui.collapsed[id]?'hidden':''}>${tasks.map(taskRow).join('')}${idle.map(profile => `<button type="button" class="dashboard-idle" data-coord="open-assistant" data-id="${esc(profile.id)}">${esc(profile.name)}<small>No active assignments</small></button>`).join('')}${!count ? '<p class="right-muted dashboard-idle">'+(id==='working'?'No workers running.':id==='attention'?'Nothing waiting for you.':id==='paused'?'No paused tasks.':id==='idle'?'Everyone has an assignment.':'No finished work yet.')+'</p>' : ''}</div></section>`;
    }).join('') + '<p class="coord-run-note">Working follows the task’s run state, including time spent thinking.</p>';
    renderTaskFilters();
    renderTaskList();
  }

  function renderTaskFilters() {
    $('#task-owner-filter').innerHTML = '<option value="all">All assistants</option>'+profileState.profiles.map(profile => `<option value="${esc(profile.id)}">${esc(profile.name)}</option>`).join('');
    if (!profileOf(ui.taskOwner)) ui.taskOwner = 'all';
    $('#task-owner-filter').value = ui.taskOwner;
    $('#task-project-filter').innerHTML = '<option value="all">All projects</option>'+store.state.projects.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('');
    $('#task-project-filter').value = ui.taskProject;
    $('#task-query').value = ui.taskQuery;
  }

  function renderTaskList() {
    const tasks = store.state.tasks.filter(task => (ui.taskOwner === 'all' || task.ownerId === ui.taskOwner) && (ui.taskProject === 'all' || task.projectId === ui.taskProject) && `${task.title} ${task.worker} ${nameOf(task.ownerId)}`.toLowerCase().includes(ui.taskQuery.toLowerCase()));
    $('#sidebar-task-list').innerHTML = tasks.map(taskRow).join('') || '<p class="coord-empty">No tasks match these filters.</p>';
  }

  function renderProfileRunStatus() {
    const profile = currentProfile();
    const working = store.tasksForAssistant(profile.id).filter(task => task.status === 'working').length;
    $('#status-text').textContent = profile.paused ? 'Paused' : working ? `Working on ${working} ${working===1?'task':'tasks'}` : 'Ready';
    for (const entry of document.querySelectorAll('[data-profile-id]')) {
      const owner = profileOf(entry.dataset.profileId);
      const count = store.tasksForAssistant(owner.id).filter(task => task.status === 'working').length;
      entry.querySelector('small').textContent = owner.paused ? 'Paused' : count ? `${count} working` : 'Ready';
    }
    $('#preview-save-status').textContent = store.available && profileStorageAvailable ? 'Saved in this browser' : 'This tab only · storage unavailable';
  }

  function taskActions(task) {
    const ownerPaused = profileOf(task.ownerId)?.paused;
    return `<div class="coord-actions">${task.status === 'working' ? action('Pause task','pause-task',task.id) : ''}${task.status === 'paused' ? action('Resume task','resume-task',task.id,ownerPaused?'disabled title="Resume the assistant first"':'') : ''}${['failed','cancelled'].includes(task.status) ? action('Retry task','retry-task',task.id,ownerPaused?'disabled title="Resume the assistant first"':'') : ''}${task.status === 'needs_review' ? action('Accept result','approve-task',task.id) : ''}${activeStatuses.includes(task.status) ? action('Cancel task','cancel-task',task.id) : ''}</div>`;
  }

  function renderTask(task) {
    const project = store.project(task.projectId);
    const context = store.contextForTask(task.id);
    const scratch = task.scratch;
    const scratchBlock = scratch ? `<section class="task-outcome"><h3>Worker scratch note</h3><p>${esc(scratch.text)}</p><p class="right-muted">${scratch.promotedId ? 'Reviewed and saved to this project’s notebook.' : scratch.dismissed ? 'Dismissed. This note stays out of shared memory.' : 'Not in shared memory. Review before saving this note to '+esc(project.name)+'.'}</p><div class="coord-actions">${!scratch.promotedId && !scratch.dismissed && ['needs_review','done'].includes(task.status) ? action('Review & save to project','review-scratch',task.id)+action('Dismiss note','dismiss-scratch',task.id) : ''}${scratch.promotedId ? action('View project notebook','project-notebook',project.id) : ''}</div></section>` : '';
    return `<article class="task-detail"><div class="task-breadcrumb">${action(project.name,'open-project',project.id)}<span>/</span><span>Worker thread</span></div><h1>${esc(task.title)}</h1>${status(task)}<div class="task-identity"><span>Assistant <strong>${esc(nameOf(task.ownerId))}</strong></span><span>Worker <strong>${esc(task.worker)}</strong></span><span>Project <strong>${esc(project.name)}</strong></span><span>Attempt <strong>${task.attempt}</strong></span></div><p class="task-lead">${esc(task.brief)}</p><div class="task-steps">${['Read context','Carry out task','Return for review'].map((step,i)=>`<div class="task-step ${task.step > i || ['needs_review','done'].includes(task.status) ? 'complete' : task.step===i ? 'current' : ''}">${step}</div>`).join('')}</div>${taskActions(task)}${task.status==='failed'?'<div class="task-outcome"><h3>Worker stopped</h3><p>The preview check could not reach its test service. Retry creates a new attempt and keeps the earlier record.</p></div>':''}${scratchBlock}<details><summary>Context available to this worker</summary><p>Its assignment, ${esc(nameOf(task.ownerId))}’s personal notes, and ${esc(project.name)}’s shared notebook. Other assistants’ personal notes and other project notebooks are excluded.</p><pre>${esc(JSON.stringify(context,null,2))}</pre></details><details><summary>Thread & isolated workspace</summary><pre>Thread: ${esc(task.threadId)}\nWorkspace: ${esc(task.worktree)}\nProject: ${esc(project.path)}\nAssistant ID: ${esc(task.ownerId)}\nTask ID: ${esc(task.id)}\nAttempt: ${task.attempt}</pre><p>Illustrative paths. This preview creates no files or real worker processes.</p></details><section class="task-transcript"><h3>Worker thread</h3>${task.events.map(event=>`<div class="task-event"><time>${date(event.at)}</time><p>${esc(event.text)}</p></div>`).join('')}</section><p class="coord-note">Use Advance demo to move every working task forward one step. Progress here is simulated; no model or code execution is connected.</p></article>`;
  }

  function renderProjectNotebook(project) {
    const notes = store.notesFor('project',project.id);
    return `<article class="task-detail"><div class="task-breadcrumb">${action(project.name,'open-project',project.id)}<span>/ Project notebook</span></div><h1>${esc(project.name)} notebook</h1><p class="task-lead">Shared decisions for this project. Personal assistant notes and other projects’ notes stay separate.</p>${action('Add project note','new-project-note',project.id)}${notes.map(note=>`<article class="memory-note"><div class="note-title">${icon('memory')}<strong>${esc(note.title)}</strong>${action('Edit','edit-note',note.id)}</div><p>${esc(note.text)}</p><div class="note-meta"><span>Shared project note · version ${note.version}</span><span>${esc(note.sourceTaskId?'Reviewed worker note':'Saved in preview')}</span></div><details><summary>Record and source</summary><pre>${esc(note.id)}\n${esc(note.updatedAt)}${note.sourceTaskId?'\nSource task: '+esc(note.sourceTaskId):''}</pre></details></article>`).join('')||'<p class="coord-empty">No shared notes yet.</p>'}</article>`;
  }

  function renderWorkspace() {
    const task = ui.workView === 'task' && ui.taskId ? store.task(ui.taskId) : null;
    const project = store.project(task?.projectId || ui.projectId);
    if (!project) return;
    $('#work-project').textContent = project.name;
    $('#work-title').textContent = task ? task.title : ui.workView === 'notebook' ? 'Project notebook' : 'Project overview';
    $('#detail-project').textContent = project.name;
    $('#detail-thread').textContent = task ? task.threadId : project.name;
    const detailRows = [...document.querySelectorAll('#right-panel-details .setting-row')];
    for (const row of detailRows) {
      const label=row.firstElementChild.textContent;
      if(label==='Model') { row.firstElementChild.textContent='Worker'; row.lastElementChild.textContent=task?.worker || 'Project overview'; }
      if(label==='Worker') row.lastElementChild.textContent=task?.worker || 'Project overview';
      if(label==='Machine') row.lastElementChild.textContent=project.host;
      if(label==='Status') row.lastElementChild.textContent=task ? statusNames[task.status] : 'Project overview';
    }
    const headerStatus=$('.work-pane .pane-top .online');
    headerStatus.setAttribute('aria-label',task ? statusNames[task.status] : 'Project overview');
    headerStatus.classList.toggle('task-is-paused',task?.status==='paused');
    $('.work-pane .pane-top .spacer+small').textContent=task ? task.worker+' thread' : 'Project workspace';
    $('.work-pane>.mock-compose').hidden = true;
    $('#pane-placement').hidden = ui.placement === 'Main pane';
    $('#pane-placement').textContent = ui.placement + ' · placement preview in the main pane';
    $('.work-chat').innerHTML = task ? renderTask(task) : ui.workView === 'notebook' ? renderProjectNotebook(project) : `<article class="task-detail"><div class="task-breadcrumb">${esc(project.host)} / ${esc(project.path)}</div><h1>${esc(project.name)}</h1><p class="task-lead">${esc(project.goal)}</p><div class="coord-actions">${action('Delegate a task','delegate',project.id)}${action('Project notebook','project-notebook',project.id)}</div><section class="task-transcript"><h3>Assignments</h3>${tasksForProject(project.id).map(taskRow).join('')||'<p class="coord-empty">No assignments yet.</p>'}</section><p class="coord-note">Each assignment has an owning assistant, a worker thread, and an isolated workspace. Notes stay within this project.</p></article>`;
  }

  function renderAll() {
    renderProjects(); renderSummary(); renderMemory(); renderActivity(); renderDashboard(); renderProfileRunStatus(); renderAgents();
    if (ui.page === 'workspace') renderWorkspace();
  }

  // Integrate with existing profile forms without replacing their saved records.
  const originalActiveProfile = renderActiveProfile;
  renderActiveProfile = function() { originalActiveProfile(); memoryQuery=''; renderAll(); };
  const originalConversation = renderConversation;
  renderConversation = function() { originalConversation(); renderSummary(); renderProfileRunStatus(); };
  const originalProfileStatus = renderProfileStatus;
  renderProfileStatus = function() { originalProfileStatus(); renderProfileRunStatus(); };
  const originalProfileList = renderProfileList;
  renderProfileList = function() { originalProfileList(); renderProfileRunStatus(); };
  filterProfileMemories = renderMemory;
  const originalSetPage = setPage;
  setPage = function(page) { originalSetPage(page); ui.page=app.dataset.page; saveLayout(); if(ui.page==='workspace')renderWorkspace(); };
  const originalSetTab = setTab;
  setTab = function(tab) { originalSetTab(tab); ui.tab=tab; if(!['memory','settings'].includes(tab))ui.lastAssistantTab=tab; saveLayout(); if(tab==='projects')renderProjects(); if(tab==='memory')renderMemory(); if(tab==='activity')renderActivity(); };
  const originalToggleSidebar = toggleSidebar;
  toggleSidebar = function(open) { originalToggleSidebar(open); ui.sidebarOpen=open; saveLayout(); };
  const originalSetRightTab = setRightTab;
  setRightTab = function(tab) { originalSetRightTab(tab); ui.rightTab=tab; saveLayout(); };

  function openTask(id, placement = 'Main pane') {
    const task = store.task(id); if(!task)return;
    ui.taskId=id; ui.projectId=task.projectId; ui.workView='task'; ui.placement=placement;
    setPage('workspace');
    $('.work-chat').scrollTop=0;
  }
  function openProject(id, notebook = false) {
    if (!store.project(id)) return;
    ui.projectId=id; ui.taskId=null; ui.workView=notebook?'notebook':'project'; ui.placement='Main pane';
    setPage('workspace'); $('.work-chat').scrollTop=0;
  }

  function openAssignments() {
    closeAssistantMenu();
    const profile = currentProfile();
    openDialog(`Assign projects to ${profile.name}`,`<form id="assign-projects" class="coord-assign">${store.state.projects.map(project=>`<label class="setting-row"><span>${esc(project.name)}<small>${esc(project.host)} · Shared project notebook</small></span><input type="checkbox" name="project" value="${esc(project.id)}" ${profile.connections.includes(project.id)?'checked':''}></label>`).join('')}<p class="coord-note">Personal memory stays with ${esc(profile.name)}. Assigning another assistant to a project shares its project notebook, not either assistant’s personal notes.</p><p role="alert" id="assignment-error"></p><button type="submit" class="small-button primary">Save assignments</button></form>`);
  }

  function openDelegation(projectId, worker) {
    const suggested = store.project(projectId) ? projectId : teamProjects(currentProfile().id)[0]?.id;
    openDialog('Delegate a project task',`<form id="delegate-form" class="coord-form"><label>Owning assistant<select id="delegate-owner" aria-label="Owning assistant">${profileState.profiles.map(profile=>`<option value="${esc(profile.id)}" ${profile.id===currentProfile().id?'selected':''}>${esc(profile.name)}</option>`).join('')}</select></label><label>Project<select id="delegate-project" aria-label="Task project"></select></label><label>Task<input id="delegate-title" aria-label="Task title" required maxlength="120" placeholder="e.g. Review the startup changes"></label><label>Worker<select id="delegate-worker" aria-label="Worker"><option>Codex</option><option>Claude Code</option><option>deepgeek</option></select></label><label>Brief<textarea id="delegate-brief" aria-label="Task brief" required maxlength="2000" placeholder="What should be done, and what does a good result look like?"></textarea></label><p class="coord-note" id="delegate-context"></p><p role="alert" id="delegate-error"></p><button type="submit" class="small-button primary" id="delegate-submit">Delegate task · preview</button></form>`);
    fillDelegationProjects(suggested);
    $('#delegate-worker').innerHTML = availableWorkers().map(name => `<option>${esc(name)}</option>`).join('');
    if (availableWorkers().includes(worker)) $('#delegate-worker').value = worker;
  }
  function fillDelegationProjects(suggested) {
    const owner=profileOf($('#delegate-owner').value);
    const projects=teamProjects(owner.id);
    $('#delegate-project').innerHTML=projects.map(project=>`<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('');
    if(projects.some(project=>project.id===suggested))$('#delegate-project').value=suggested;
    $('#delegate-submit').disabled=!projects.length||owner.paused;
    $('#delegate-context').textContent=!projects.length?`${owner.name} has no assigned projects. Close this dialog and use Assign projects first.`:owner.paused?`${owner.name} is paused. Resume this assistant before delegating.`:'The worker gets this brief, its assistant’s personal notes, and the selected project notebook. It uses a separate thread and isolated workspace.';
  }

  function openNoteEditor(id, projectId) {
    const note=id?store.state.notes.find(item=>item.id===id):null;
    const scope=note?.scope || (projectId || ui.memoryScope!=='assistant'?'project':'assistant');
    const ownerId=note?.ownerId || (scope==='assistant'?currentProfile().id:projectId||ui.memoryScope);
    const label=scope==='assistant'?nameOf(ownerId)+'’s personal notes':store.project(ownerId).name+' project notebook';
    openDialog(note?'Edit saved note':'Add a note',`<form id="note-editor" class="coord-form" data-note-id="${esc(note?.id||'')}" data-scope="${scope}" data-owner="${esc(ownerId)}" data-version="${note?.version||''}"><p>Saving to <b>${esc(label)}</b>.</p><label>Title<input id="note-title" aria-label="Note title" required maxlength="100" value="${esc(note?.title||'')}"></label><label>Note<textarea id="note-text" aria-label="Note text" required maxlength="4000">${esc(note?.text||'')}</textarea></label><p class="coord-note">${scope==='assistant'?'Available to this assistant and its delegated workers.':'Assigned assistants and workers can use this project note.'}</p><p role="alert" id="note-error"></p><button type="submit" class="small-button primary">Save note</button></form>`);
    $('#note-title').focus();
  }

  function reviewScratch(id) {
    const task=store.task(id); if(!task?.scratch)return;
    openDialog('Review project memory',`<form id="promote-form" class="coord-form" data-task-id="${esc(id)}"><p><b>${esc(task.scratch.title)}</b></p><p>${esc(task.scratch.text)}</p><div class="setting-row"><span>Destination</span><strong>${esc(store.project(task.projectId).name)} notebook</strong></div><div class="setting-row"><span>Source</span><span>${esc(nameOf(task.ownerId))} → ${esc(task.worker)}</span></div><label class="setting-row"><span>I’ve reviewed this note for the project.</span><input id="confirm-promotion" type="checkbox" required></label><p class="coord-note">Saves one shared project note with its source task and version. It does not change personal memory.</p><button class="small-button primary" type="submit">Save to project notebook</button></form>`);
  }

  function handleAction(type,id,element) {
    if(type==='advance') { const tasks=store.advance(); notify(tasks.length?`Advanced ${tasks.length} working demo ${tasks.length===1?'task':'tasks'}.`:'No working tasks to advance. Delegate or retry a task.'); }
    if(type==='restart') { saveLayout(); location.reload(); }
    if(type==='projects')openAssistantTab('projects');
    if(type==='open-assistant')switchProfile(id);
    if(type==='assign')openAssignments();
    if(type==='delegate')openDelegation(id);
    if(type==='delegate-worker')openDelegation(undefined,id);
    if(type==='open-task')openTask(id);
    if(type==='open-project')openProject(id);
    if(type==='project-notebook')openProject(id,true);
    if(type==='new-note')openNoteEditor();
    if(type==='new-project-note')openNoteEditor(null,id);
    if(type==='edit-note')openNoteEditor(id);
    if(type==='collapse') {ui.collapsed[id]=!ui.collapsed[id];saveLayout();renderDashboard();}
    if(type==='review-scratch')reviewScratch(id);
    if(type==='dismiss-scratch') {store.dismissScratch(id);notify('Worker note kept out of shared memory.');}
    const transitions={'pause-task':'pause','resume-task':'resume','cancel-task':'cancel','retry-task':'retry','approve-task':'approve'};
    if(transitions[type]) {
      const task=store.task(id);
      if(['resume-task','retry-task'].includes(type)&&profileOf(task.ownerId)?.paused)throw Error('Resume the owning assistant first.');
      store.transition(id,transitions[type]);
      notify(({pause:'Task paused.',resume:'Task resumed.',cancel:'Task cancelled. Other assignments continue.',retry:'New attempt started. Previous history preserved.',approve:'Result accepted. Memory is saved separately after review.'})[transitions[type]]);
    }
    if(type==='place-new'||type==='place-external') {contextMenu.hidePopover();openTask(taskContextId,type==='place-new'?'New pane':'External pane');notify('Placement preview only. Production pane routing is not connected.');}
    if(type==='place-select') {contextMenu.hidePopover();openDialog('Open in selected pane','<p>Choose a demo destination. Your task keeps the same owner and worker thread.</p><button class="context-button" data-coord="place-target" data-id="Main pane">Main pane</button><button class="context-button" data-coord="place-target" data-id="Work pane 2">Work pane 2</button><p class="coord-note">Placement is illustrated in the main pane in this preview.</p>');}
    if(type==='place-target') {dialog.close();openTask(taskContextId,id);}
  }

  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-coord]');
    if(button){try{handleAction(button.dataset.coord,button.dataset.id,button);}catch(error){notify(error.message);}}
  });
  // Replace the old label-only navigation before its delegated handler runs.
  document.addEventListener('click',event=>{
    const work=event.target.closest('[data-work]');
    if(work){event.stopImmediatePropagation(); const id=store.project(work.dataset.work)?work.dataset.work:ui.projectId;openProject(id);}
    const nav=event.target.closest('[data-nav]');
    if(nav){event.stopImmediatePropagation();if(nav.dataset.nav==='agents')setPage('agents');else if(nav.dataset.nav==='library'){ui.workView='notebook';openProject(ui.projectId,true);}else openProject(ui.projectId);}
  },true);
  document.addEventListener('contextmenu',event=>{
    const row=event.target.closest('#right-panel-dashboard [data-coord="open-task"]');
    if(!row)return;event.preventDefault();taskContextId=row.dataset.id;
    contextMenu.style.left=Math.max(8,Math.min(innerWidth-235,event.clientX))+'px';
    contextMenu.style.top=Math.max(8,Math.min(innerHeight-155,event.clientY))+'px';
    contextMenu.showPopover();
  });
  document.addEventListener('change',event=>{
    const input=event.target;
    if(input.id==='project-view-filter'){ui.projectFilter=input.value;saveLayout();renderProjects();}
    if(input.id==='memory-scope'){ui.memoryScope=input.value;memoryQuery='';$('#memory-search').value='';saveLayout();renderMemory();}
    if(input.id==='task-owner-filter'){ui.taskOwner=input.value;saveLayout();renderTaskList();}
    if(input.id==='task-project-filter'){ui.taskProject=input.value;saveLayout();renderTaskList();}
    if(input.id==='delegate-owner')fillDelegationProjects();
    if(input.matches('[data-connection]')){
      const blocked=!input.checked&&store.tasksForAssistant(currentProfile().id).some(task=>task.projectId===input.dataset.connection&&activeStatuses.includes(task.status));
      if(blocked){input.checked=true;if(!currentProfile().connections.includes(input.dataset.connection))currentProfile().connections.push(input.dataset.connection);persistProfiles();notify('Finish or cancel active work before removing this project.');}
      renderProjects();renderMemory();
    }
  });
  $('#memory-search').addEventListener('input',event=>{memoryQuery=event.target.value;renderMemory();});
  $('#task-query').addEventListener('input',event=>{ui.taskQuery=event.target.value;saveLayout();renderTaskList();});
  $('#pause-button').addEventListener('click',()=>{store.syncAssistant(currentProfile().id,currentProfile().paused);renderAll();});
  $('#profile-settings-form').addEventListener('submit',()=>{renderAll();});
  dialog.addEventListener('submit',event=>{
    const form=event.target;
    if(!['assign-projects','delegate-form','note-editor','promote-form'].includes(form.id))return;
    event.preventDefault();
    try {
      if(form.id==='assign-projects'){
        const selected=[...form.querySelectorAll('input:checked')].map(input=>input.value);
        const busy=store.tasksForAssistant(currentProfile().id).find(task=>activeStatuses.includes(task.status)&&!selected.includes(task.projectId));
        if(busy)throw Error(`Finish or cancel ${store.project(busy.projectId).name}’s active work before removing it.`);
        currentProfile().connections=selected;persistProfiles();dialog.close();renderAll();notify('Project assignments saved. Personal notes stay separate.');
      }
      if(form.id==='delegate-form'){
        const owner=profileOf($('#delegate-owner').value);const projectId=$('#delegate-project').value;
        if(!owner.connections.includes(projectId))throw Error('Assign this project to the assistant first.');
        if(owner.projectTools==='Off')throw Error('Project tools are off for this assistant. Change them in Settings before delegating.');
        if(owner.paused)throw Error('Resume this assistant before delegating.');
        const title=$('#delegate-title').value.trim(),brief=$('#delegate-brief').value.trim();
        if(!title||!brief)throw Error('Enter a task title and a brief.');
        const task=store.delegate({ownerId:owner.id,projectId,title,brief,worker:$('#delegate-worker').value});
        dialog.close();openTask(task.id);notify('Demo worker assigned. No model or code execution started.');
      }
      if(form.id==='note-editor'){
        const title=$('#note-title').value.trim(),text=$('#note-text').value.trim();
        if(!title||!text)throw Error('Enter a title and note.');
        store.saveNote({scope:form.dataset.scope,ownerId:form.dataset.owner,title,text,...(form.dataset.noteId?{id:form.dataset.noteId,expectedVersion:Number(form.dataset.version)}:{})});
        dialog.close();notify('Note saved in this browser.');
      }
      if(form.id==='promote-form'){
        if(!$('#confirm-promotion').checked)return;
        store.promote(form.dataset.taskId);dialog.close();notify('Reviewed note saved to this project’s notebook.');
      }
    }catch(error){const target=form.querySelector('[role=alert]');if(target)target.textContent=error.message;else notify(error.message);}
  });
  window.addEventListener('storage',event=>{
    if(event.key===PROFILE_STORAGE_KEY){profileState=loadProfiles();renderActiveProfile();}
  });
  store.subscribe(renderAll);
  for(const profile of profileState.profiles)if(profile.paused)store.syncAssistant(profile.id,true);
  renderProfileList();
  renderAll();
  // Restore independently: opening an assistant never selects or replaces a sidebar tab.
  const saved={...ui};lastAssistantTab=['chat','projects','activity'].includes(saved.lastAssistantTab)?saved.lastAssistantTab:'projects';setRightTab(saved.rightTab);toggleSidebar(saved.sidebarOpen);setPage(saved.page);
  if(saved.page==='assistant')setTab(saved.tab);
})();
