import { useEffect, useRef, type ReactNode } from 'react';
/** Native modal behavior keeps focus and Escape inside the creation flow. */
export function AssistantCreationDialog({onClose,children,title="Add a teammate"}:{onClose:()=>void;children:ReactNode;title?:string}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const element=dialog.current;if(element&&!element.open){element.showModal();element.querySelector<HTMLInputElement>('[aria-label="Assistant name"]')?.focus();}return()=>{if(element?.open)element.close();};},[]);
 return <dialog ref={dialog} className="assistant-creation" aria-labelledby="assistant-creation-title" onCancel={event=>{event.preventDefault();onClose();}}>
  <header className="assistant-creation-heading"><h2 id="assistant-creation-title">{title}</h2><button type="button" aria-label={title === "Add a teammate" ? "Close assistant creation" : "Close assistant settings"} onClick={onClose}>×</button></header>
  {children}
 </dialog>;
}
