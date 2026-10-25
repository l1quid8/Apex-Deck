import { assistantIdentityKey, projectIdentityKey, type AssistantRef, type ProjectRef } from "./assistantIdentity.ts";
import type { Backend } from "./backend";

export const PROJECT_MEMORY_CAPABILITY = "assistant_project_memory_v1";
export type ProjectNoteKind = "fact" | "preference" | "decision" | "commitment";
export type ProjectNote = {
  id: string; project: ProjectRef; text: string; kind: ProjectNoteKind; version: number;
  createdAt: number; updatedAt: number; author: AssistantRef | null;
  source: { taskId?: string; attempt?: number; runId?: string; scratchId?: string; messageId?: string };
  expiresAt?: number; supersededBy?: string; deletedAt?: number;
};
export type ProjectMemorySource = { id: string; text: string; kind: string; readOnly: true; source: "monitor"; updatedAt: number };
export type ProjectMemoryRead = { project: ProjectRef; notes: ProjectNote[]; sources: ProjectMemorySource[]; readAt: number };
export type ProjectMemorySave = { project: ProjectRef; id?: string; expectedVersion?: number; text: string; kind: ProjectNoteKind; expiresAt?: number };
export type ProjectMemoryForget = { project: ProjectRef; id: string; expectedVersion: number };
export type ProjectScratchInput = { project: ProjectRef; taskId: string; attempt: number; runId: string; expectedTaskRevision: number; text: string; kind: ProjectNoteKind };
export type ProjectScratch = ProjectScratchInput & { id: string; assistant: AssistantRef; createdAt: number; expiresAt: number };
export type ProjectPromotionInput = Pick<ProjectScratchInput, 'project' | 'taskId' | 'attempt' | 'runId' | 'expectedTaskRevision'> & { id: string; promotionId: string; expectedVersion?: number };
export type ProjectPromotionReceipt = { project: ProjectRef; assistant: AssistantRef; taskId: string; attempt: number; runId: string; scratchId: string; expectedTaskRevision: number; promotionId: string; noteId: string; noteVersion: number; promotedAt: number };
export type ProjectMemoryApi = {
  stage?(input: ProjectScratchInput): Promise<ProjectScratch>;
  promote?(input: ProjectPromotionInput): Promise<ProjectPromotionReceipt>;
  /** Explains unavailable reads without probing a host or issuing a mutation. */
  unavailable(project: ProjectRef): string | undefined;
  list(project: ProjectRef): Promise<ProjectMemoryRead>;
  save(input: ProjectMemorySave): Promise<ProjectNote>;
  forget(input: ProjectMemoryForget): Promise<ProjectNote>;
};

const kinds = new Set<ProjectNoteKind>(["fact", "preference", "decision", "commitment"]);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();

function checkNote(note: ProjectNote, project: ProjectRef): ProjectNote {
  if (!note || projectIdentityKey(note.project) !== projectIdentityKey(project)) throw new Error("The machine returned a note for a different project.");
  if (!nonempty(note.id) || typeof note.text !== "string" || !kinds.has(note.kind) || !version(note.version)
    || !timestamp(note.createdAt) || !timestamp(note.updatedAt) || !note.source || typeof note.source !== "object"
    || Array.isArray(note.source) || (note.expiresAt !== undefined && !timestamp(note.expiresAt))
    || (note.deletedAt !== undefined && !timestamp(note.deletedAt))
    || (note.supersededBy !== undefined && !nonempty(note.supersededBy))) throw new Error("The machine returned an invalid project note or version.");
  for (const field of ["taskId", "runId", "scratchId", "messageId"] as const) {
    if (note.source[field] !== undefined && !nonempty(note.source[field])) throw new Error("The machine returned invalid project note source provenance.");
  }
  if (note.source.attempt !== undefined && (!Number.isSafeInteger(note.source.attempt) || note.source.attempt <= 0)) throw new Error("The machine returned an invalid project note source attempt.");
  if (note.author !== null) assistantIdentityKey(note.author);
  return structuredClone(note);
}

/** A notebook keeps its authenticated transport and both owners when views change.
 * Cross-machine project assignments remain unavailable until verified routing is supported. */
export function createProjectMemoryClient({ assistant: owner, route, assertAvailable, assertBinding }: {
  assistant: AssistantRef; route: Pick<Backend, "call" | "supports">;
  assertAvailable: () => void; assertBinding: (project: ProjectRef) => void;
}): ProjectMemoryApi {
  assistantIdentityKey(owner);
  const assistant = Object.freeze({ ...owner });
  const need = (project: ProjectRef) => {
    assertAvailable();
    if (route.supports?.(PROJECT_MEMORY_CAPABILITY) !== true) throw new Error("Update this machine's service to use project memory.");
    projectIdentityKey(project);
    if (project.hostId !== assistant.hostId) throw new Error("Project memory is currently available only when the assistant and project are on the same machine.");
    assertBinding(project);
  };
  const capturedProject = (project: ProjectRef) => { projectIdentityKey(project); return { hostId: project.hostId, workspaceId: project.workspaceId, cwd: project.cwd }; };
  return {
    unavailable: project => { try { need(project); return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); } },
    list: async projectRef => {
      const project = capturedProject(projectRef); need(project);
      const result = await route.call<ProjectMemoryRead>("project_memory_list", { assistant: { ...assistant }, project });
      need(project);
      if (!result || projectIdentityKey(result.project) !== projectIdentityKey(project) || !Array.isArray(result.notes)
        || !Array.isArray(result.sources) || !timestamp(result.readAt)) throw new Error("The machine returned an invalid project memory read.");
      const notes = result.notes.map(note => checkNote(note, project));
      const sources = result.sources.map(source => {
        if (!source || !nonempty(source.id) || typeof source.text !== "string" || typeof source.kind !== "string"
          || source.source !== "monitor" || source.readOnly !== true || !timestamp(source.updatedAt)) throw new Error("The machine returned an invalid read-only monitor source.");
        return structuredClone(source);
      });
      return { project, notes, sources, readAt: result.readAt };
    },
    save: async input => {
      const project = capturedProject(input.project); need(project);
      if (input.id !== undefined && (!nonempty(input.id) || !version(input.expectedVersion))) throw new Error("Correcting a project note requires its inspected version.");
      if (input.id === undefined && input.expectedVersion !== undefined) throw new Error("A new project note cannot include an existing version.");
      if (!nonempty(input.text) || !kinds.has(input.kind)) throw new Error("Enter a project note and a valid note kind.");
      if (input.expiresAt !== undefined && !timestamp(input.expiresAt)) throw new Error("Project note expiry must be a valid timestamp.");
      const args = { assistant: { ...assistant }, project, text: input.text.trim(), kind: input.kind,
        ...(input.id === undefined ? {} : { id: input.id, expectedVersion: input.expectedVersion }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) };
      const result = await route.call<ProjectNote>("project_memory_save", args);
      need(project);
      return checkNote(result, project);
    },
    stage: async input => {
      const project = capturedProject(input.project); need(project);
      if (!nonempty(input.taskId) || !nonempty(input.runId) || !version(input.attempt) || !version(input.expectedTaskRevision) || !nonempty(input.text) || !kinds.has(input.kind)) throw new Error("Choose a completed result excerpt with its inspected task revision and attempt.");
      const result = await route.call<ProjectScratch>("project_memory_stage", {assistant:{...assistant},project,taskId:input.taskId,attempt:input.attempt,runId:input.runId,expectedTaskRevision:input.expectedTaskRevision,text:input.text.trim(),kind:input.kind});
      need(project);
      if (!result || projectIdentityKey(result.project)!==projectIdentityKey(project) || assistantIdentityKey(result.assistant)!==assistantIdentityKey(assistant) || !nonempty(result.id) || result.taskId!==input.taskId || result.runId!==input.runId || result.attempt!==input.attempt || result.expectedTaskRevision!==input.expectedTaskRevision || result.text!==input.text.trim()) throw new Error("The host returned scratch evidence for a different task or revision.");
      return structuredClone(result);
    },
    promote: async input => {
      const project = capturedProject(input.project); need(project);
      if (!nonempty(input.id) || !nonempty(input.promotionId) || !nonempty(input.taskId) || !nonempty(input.runId) || !version(input.attempt) || !version(input.expectedTaskRevision) || (input.expectedVersion!==undefined&&!version(input.expectedVersion))) throw new Error("Review the staged note and its task revision before saving.");
      const result = await route.call<ProjectPromotionReceipt>("project_memory_promote", {assistant:{...assistant},project,taskId:input.taskId,attempt:input.attempt,runId:input.runId,scratchId:input.id,expectedTaskRevision:input.expectedTaskRevision,promotionId:input.promotionId,...(input.expectedVersion===undefined?{}:{expectedVersion:input.expectedVersion})});
      need(project);
      if (!result || projectIdentityKey(result.project)!==projectIdentityKey(project) || assistantIdentityKey(result.assistant)!==assistantIdentityKey(assistant) || result.taskId!==input.taskId || result.runId!==input.runId || result.attempt!==input.attempt || result.scratchId!==input.id || result.expectedTaskRevision!==input.expectedTaskRevision || result.promotionId!==input.promotionId || !nonempty(result.noteId) || !version(result.noteVersion)) throw new Error("The host returned a promotion receipt for different evidence.");
      return structuredClone(result);
    },
    forget: async input => {
      const project = capturedProject(input.project); need(project);
      if (!nonempty(input.id) || !version(input.expectedVersion)) throw new Error("Forgetting a project note requires its inspected version.");
      const result = await route.call<ProjectNote>("project_memory_forget", { assistant: { ...assistant }, project, id: input.id, expectedVersion: input.expectedVersion });
      need(project);
      return checkNote(result, project);
    },
  };
}
