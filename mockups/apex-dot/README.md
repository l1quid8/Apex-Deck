# Apex assistant workspace preview

Open `index.html` directly, or run:

```sh
python3 -m http.server 8742 --bind 127.0.0.1 --directory mockups/apex-dot
```

Then open http://127.0.0.1:8742/. No install or build is required.

This is an interactive design preview. Assistant replies, workers, task results, workspace paths, and context are simulated. The notes are real browser-local preview records; they are not production Apex memory or OpenAI Dot memory. No model, backend, filesystem editing, packaging, microphone, phone, or browser control is connected.

## The agreed layout

Assistants open only in the main pane, with borderless entries under Your team. There is no Mini or alongside-work view. Conversation, Projects, and Activity are the assistant's main tabs. Memory and Settings open in the main pane through the top-right three-dot menu, with Back returning to the previous section.

The top-level **Agents** tab is a separate reusable-worker roster, with assignment lists and delegation actions. There is no top-level Assistants tab. Manage named assistants through **Your team**, its **+** button, and the selected assistant's **three dots → Settings**. The Agents roster and delegation picker use the same preview worker list.

The ordinary right sidebar remains independent across assistant, project, notebook, worker-thread, and settings views. Dashboard and Tasks cover the entire workspace. Opening assistant settings or memory never replaces it. Its selected tab, open/closed state, task filters, and collapsed Dashboard categories persist across reloads.

Creation follows **Name → AI model (Provider, Model, Reasoning) → Access (Project tools, Browser) → Avatar → Create**. Settings uses the same order, with Connected context and Skills & tools between Access and Avatar, then Save changes. Give work briefs in Conversation; there is no separate brief field.

## Try the complete workflow

1. Choose an assistant on the left. Use **+** to add another, or **three dots → Settings** to change its name, avatar, provider, model, reasoning, and project-tool access. The provider/model catalog is a static demo; reasoning follows the selected demo model and disables when unsupported. Access includes Ask first, Full access, and Off, shown once alongside Browser in the Access section. Settings access changes save immediately; identity, model and avatar changes use Save changes. Pixel avatars use the same seeded 5×5 pattern and color palette as Apex’s existing agents. Choose a palette color, use the custom color picker or enter a six-digit hex color, or choose New pattern. **AI generate** adds a prompt and sample candidate: Generate preview → Apply avatar → Create/Save. Generate and Discard leave the selected avatar unchanged; Use pixel pattern restores the retained seed and color. The demo always returns the bundled owl sample, regardless of prompt; no live image-generation request or charge occurs. Renaming keeps the avatar unchanged. There is no Team Member Type selector. Give each assistant a name, and describe its job in Conversation. Legacy preview labels remain saved as hidden metadata. IDs stay stable when renamed. Existing preview profiles and conversations are preserved; a clean browser starts with Null and Ada.
2. Open **Projects**. Three sample projects demonstrate concurrent work: apex-deck, REA, and apex_terminal. Use **Assign projects** to connect the selected assistant. Active work must be finished or cancelled before removing an assignment.
3. Choose **Delegate a task**. Select an owning assistant, one of its assigned projects, a worker, and a brief. The resulting assignment opens its own illustrative worker thread and isolated workspace. Project tools include Ask first, Full access, and Off; Off blocks new delegation.
4. Inspect **Context available to this worker**. It includes the assignment, only the owning assistant's personal notes, and only the selected project's shared notes. It represents the preview's context-selection rule, not a captured request to a real model.
5. Use **Advance demo** to move every Working task forward one step. A second step returns results for review. There are no timers that turn a thinking task Idle. Pause an assistant to pause its running workers; other assistants continue. Pause, resume, cancel, retry, and accept an individual task in its main-pane thread. Retry preserves event history and uses a new attempt workspace. An assistant resume leaves manually paused tasks paused.
6. Open a result's **Review & save to project** action. Confirm that you reviewed the scratch note before saving it to the named project's notebook. Accepting a result does not automatically promote memory. Dismissed scratch notes stay out of shared memory. Promoted records identify their source task.
7. Open **three dots → Memory**. Choose personal notes or an assigned project's notebook. Search, add, edit, and inspect a record's ID, version, timestamp, and source. Other assistants' personal notes and unrelated project notebooks are excluded from that assistant's memory list. A project can also open its notebook directly in the main pane. Editing checks the saved version to reject stale overwrites.
8. Use the global **Dashboard** and **Tasks** while navigating. Dashboard categories collapse. Tasks filter by assistant, project, and text. Right-click a Dashboard task for New Pane, External Pane, and selected-pane placement previews; these illustrate routing in the main pane and do not create real panes or windows.
9. Click **Test restart** to reload the page and recover saved task status, attempts, notes, history, and layout. This tests browser-local recovery, not daemon or remote-worker restart. On narrow screens the three-dot menu includes a team switcher.

## Persistence and limits

Profiles retain the existing `apex-assistant-preview-v1` storage key. Coordination records use `apex-coordination-preview-v1`; layout uses `apex-coordination-layout-v1`. The state module reads the newest stored revision before a mutation and checks note versions when editing. This is a single-browser prototype, not a transactional multi-client backend. Simultaneous cross-tab writes are not guaranteed safe; live execution and cross-device synchronization are not implemented.

If storage fails, the preview remains usable in memory and reports that changes last only for the current tab. Clearing browser storage removes the preview records. No production profiles, memories, or tasks are changed.

## Files and validation

- `index.html`, `profiles.js`, `profiles.css`, `avatars.js`, `avatar-generation.css`: shell, identities, conversations, provider/model/reasoning/access controls, and browser-local pixel or sample-image avatars. The preview pattern algorithm matches `src/identicon.ts`; production should reuse the existing `Avatar` component.
- `assets/avatar-owl.png`, `assets/avatar-owl-prompt.txt`: one transparent pixel-art sample generated with the built-in image-generation tool, and its exact prompt. This is an illustrative candidate, not live prompt-driven generation.
- `coordination-ui.js`, `coordination.css`: projects, assignment forms, notebooks, worker threads, activity, and global sidebar.
- `coordination-state.js`: browser-local task and memory model, also importable from Node for state checks.
- `package.json`: marks the standalone classic-script preview as CommonJS for its Node checks, independent of the parent repository's module setting. No dependencies or installation.
- `coordination-state.smoke.cjs`: run `node mockups/apex-dot/coordination-state.smoke.cjs` from the REA root. Covers context isolation, parallel progression, pause ownership, retries, explicit promotion, version conflicts, reload, and storage failure.
- `setup-order-verification.json` and `reordered-setup.png`: current creation/Settings order, single Access controls, save/reload and sample-avatar verification.
- `simplified-identity-verification.json` and `assistant-creation.jpg`: historical checks after removing the cosmetic type selector, before reordering the form.
- `coordination-verification.json`: earlier coordination browser and state-check results.
- `coordinated-projects.png`, `worker-context.png`, `project-memory.png`: current captured views. Older screenshots and verification files are historical and may show superseded layouts.

The shell retains Apex Deck's existing Clay/Ember theme and optional Classic theme. The design follows recovered Dot client integration patterns and the user's Apex layout decisions; it is not an exact reconstruction of OpenAI's rendered interface.
