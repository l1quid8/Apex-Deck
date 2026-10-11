# ApexAgent workspace interaction notes

## Surface contract

**Conversation** is the one place for ordinary messages: greetings, questions, answers, and proposals. A proposal can point to a draft task record without implying approval or execution. Once work exists, chat carries at most a short task or result link. The task record owns status, approvals, receipts, review material, worker history, and lifecycle details.

**Tasks** is the canonical browseable home for assistant work across personal jobs and delegated project tasks. A shared presentation can aggregate separate host-owned records while retaining each record's owning host, identifier, worker, and scope. Unresolved delivery receipts remain receipts with an explicit uncertain state; they must not appear as actionable tasks unless a task record actually exists.

**Worker history** is nested under its task as history. The worker gets a bounded task brief plus deliberately selected references. A source thread may show one concise link to the task or result. Do not copy the source conversation into a new worker chat by default, add lifecycle bookkeeping to ordinary chat, or imply existing records have been removed.

**Sources** describes context selection and retrieval, not permission. Make the project and machine clear; show what is selected, whether changes are saved, when sources were last read, and whether coverage is partial, missing, or bounded. Generated worker logs are excluded by default or clearly distinguished and explicitly selected. The mockup can explain bounded recent excerpts, but must not imply every message or the complete transcript is available.

## Interaction boundaries

- Keep the floating assistant and one conversation. Give Tasks a distinct destination in that workspace.
- Label the visible list filter and message destination separately. The filter only changes what the user is browsing; the “Send to” control says where an ordinary message will go.
- Opening a task is inspection. It does not change the ordinary chat destination or request another worker run.
- Put “Request changes” on the task detail as an explicit action. Its review state names the task, worker, host, and scope, and makes clear that submission requests another attempt.
- Result details expose a readable summary and direct artifact action. Identify the owning host and availability so a simulated link does not claim an artifact can be opened when the mockup cannot establish that.
- Back restores the prior list position. Move focus to the new view's title, keep the destination visible, and prevent the composer from obscuring newly opened content.
- Clear hides conversation history only. Task records, approvals, receipts, and unresolved findings stay accessible in Tasks.

## Mockup versus proposed runtime behavior

The prototype may simulate records, filters, focus, and navigation to make the intended experience reviewable. Mark those interactions as sample behavior where a viewer could mistake them for live execution. Backend proposals include unified aggregation, bounded worker context, host-scoped artifact resolution, source coverage reporting, and explicit task continuation. The mockup cannot establish these properties at runtime; retain existing records and host ownership while depicting the intended model.
