import type { AssistantTask } from './assistantTaskModel';
import type { PersonalMessage, PersonalReceipt, PersonalTask } from './personalAssistant';

export type AssistantConversationMessage = PersonalMessage & { taskProblem?: boolean };

const firstLine = (text?: string) => text?.split('\n').find(line => line.trim())?.replace(/`/g, '').trim().slice(0, 500) ?? '';

/** Summaries describe the receipt, never turn a proposed goal into a success claim. */
function verifiedOutcome(task: PersonalTask, receipt: PersonalReceipt): string {
  const operation = task.operation;
  const argv = operation?.argv ?? [];
  switch (operation?.tool) {
    case 'room.create': return argv[2] ? `Created the chat “${argv[2]}”.` : 'Created the chat.';
    case 'room.rename': return argv[1] ? `Renamed the chat to “${argv[1]}”.` : 'Renamed the chat.';
    case 'room.addParticipant': return 'Added the participant to the chat.';
    case 'room.removeParticipant': return 'Removed the participant from the chat.';
    case 'room.send': case 'room.assign': case 'room.resume': return 'Sent the message to the chat.';
    case 'room.read': return 'Read the chat. Its saved messages are in Tasks.';
    case 'room.readFile': return 'Read the file. Its contents are in Tasks.';
  }
  // Native actions already return a short outcome before any receipt metadata.
  if (operation?.tool.startsWith('room.')) return firstLine(receipt.outputExcerpt) || 'The action finished.';
  const output = receipt.outputExcerpt.trim();
  if (output && !output.includes('\n') && output.length <= 280 && !/[`{}\[\]<>]/.test(output)) return output;
  return 'The action finished. Its output is in Tasks.';
}

/** One conversational result or decision per task. The original ledger stays in Tasks. */
export function assistantConversationMessages(messages: readonly PersonalMessage[], tasks: readonly PersonalTask[], visibleFrom = 0, delegatedTasks: readonly AssistantTask[] = []): AssistantConversationMessage[] {
  const byId = new Map(tasks.filter(task => task.deletedAt == null).map(task => [task.id, task]));
  const visibleEvents = new Set(messages.filter(message => message.at > visibleFrom && message.eventId).map(message => message.eventId));
  const executionLines = new Map<string, PersonalMessage[]>();
  for (const message of messages) {
    if (message.taskId && byId.has(message.taskId) && message.role !== 'human' && (message.kind === 'approval' || message.kind === 'result' || message.role === 'system')) {
      const lines = executionLines.get(message.taskId) ?? [];
      lines.push(message); executionLines.set(message.taskId, lines);
    }
  }
  const projected = new Map<string, AssistantConversationMessage>();
  const added: AssistantConversationMessage[] = [];
  for (const [id, task] of byId) {
    const lines = executionLines.get(id) ?? [];
    const latest = lines.at(-1);
    // A later failure must not resurrect a helper from a cleared conversation.
    if (!lines.some(line => line.at > visibleFrom) && !(task.fromEvent && visibleEvents.has(task.fromEvent))) continue;
    const origin: PersonalMessage = latest ?? { id: `task:${id}`, role: 'system', kind: 'update', text: '', at: task.updatedAt, taskId: id };
    if (task.status === 'needsYou' && task.decision?.status === 'open') {
      const approval = [...lines].reverse().find(line => line.kind === 'approval') ?? origin;
      const message: AssistantConversationMessage = { ...approval, kind: 'approval', text: task.decision.prompt || approval.text };
      if (latest) projected.set(approval.id, message); else added.push(message);
      continue;
    }
    // Successful helpers already return their written report as an ordinary message.
    if (task.kind === 'helper' && task.status === 'done') continue;
    const receipt = task.receipts.at(-1);
    // A cost receipt records authorization consumption, before the actual provider call.
    const permissionOnly = ['model.reply', 'model.summary', 'computer.reply'].includes(task.operation?.tool ?? '');
    if (task.status === 'done' && task.decision?.status === 'approved' && (permissionOnly || task.decision.kind === 'handOff' || (!receipt && task.decision.kind === 'spend'))) continue;
    const verified = receipt?.phase === 'verified' && (receipt.exitCode === undefined || receipt.exitCode === 0);
    const problem = task.status === 'failed' || task.status === 'blocked' || receipt?.phase === 'uncertain' || (task.status === 'done' && !verified) || (task.status === 'waiting' && receipt?.phase === 'failed');
    let text: string;
    if (problem) {
      const reason = firstLine(receipt?.note) || (receipt?.phase === 'failed' || receipt?.phase === 'uncertain' ? firstLine(receipt.outputExcerpt) : '') || firstLine(task.lastUpdate);
      text = task.status === 'done' && !verified
        ? 'I couldn’t verify the outcome. Review the task before trying again.'
        : reason || 'The action couldn’t finish. Review the task for details.';
    } else if (task.status === 'done' && receipt && verified) text = verifiedOutcome(task, receipt);
    else continue;
    const result = [...lines].reverse().find(line => line.kind === 'result') ?? origin;
    const message: AssistantConversationMessage = { ...result, role: 'assistant', kind: 'update', text, at: Math.max(result.at, task.updatedAt), ...(problem ? { taskProblem: true } : {}) };
    if (latest) projected.set(result.id, message); else added.push(message);
  }
  const eventIds = new Set(messages.map(m => m.id));
  for (const job of delegatedTasks) {
    const source = job.lineage?.sourceEventId;
    if (!source || !visibleEvents.has(source) || job.resultData?.deletedAtMs != null) continue;
    for (const event of job.conversationEvents ?? []) {
      if (event.taskId !== job.id || event.atMs <= visibleFrom || !['milestone', 'question', 'watchdog'].includes(event.kind)) continue;
      const id = `handoff:${job.id}:${event.id}`;
      if (eventIds.has(id)) continue;
      eventIds.add(id);
      const name = event.workerId ? job.workerNames?.[event.workerId] || event.workerId : 'Worker';
      added.push({id, role:'system',kind:'update',text:`${name}: ${event.text}`,at:event.atMs,taskId:job.id,eventId:source});
    }
  }
  return [...messages.flatMap(message => {
    if (!message.taskId || !executionLines.get(message.taskId)?.includes(message)) return [message];
    const replacement = projected.get(message.id);
    return replacement ? [replacement] : [];
  }), ...added].sort((a, b) => a.at - b.at);
}
