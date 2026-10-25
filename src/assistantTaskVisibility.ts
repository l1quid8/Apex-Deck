import type { PersonalMessage, PersonalTask } from './personalAssistant';
import type { AssistantTask } from './assistantTaskModel';
export function taskMessageDeleted(message: Pick<PersonalMessage,'taskId'>,personal:readonly PersonalTask[],delegated:readonly AssistantTask[],purged:readonly string[]=[]):boolean {
 const id=message.taskId;if(!id)return false;if(purged.includes(id))return true;
 if(personal.some(t=>t.id===id&&t.deletedAt!=null)||delegated.some(t=>t.id===id&&t.resultData?.deletedAtMs!=null))return true;
 try{const tuple=JSON.parse(id);if(!Array.isArray(tuple)||tuple.length!==3)return false;const [project,task]=tuple;if(purged.includes(task))return true;return delegated.some(t=>t.id===task&&t.resultData?.deletedAtMs!=null&&t.lineage?.project.hostId===project?.hostId&&t.lineage?.project.workspaceId===project?.workspaceId&&t.lineage?.project.cwd===project?.cwd);}catch{return false;}
}
