import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ToolServer } from './types';
import type { Command } from './commands';
import { ComposerMenu, type ComposerMenuHandle } from './ComposerTools';
import { insertAt, type MenuItem, type MenuPerson, type Trigger } from './composerMenu';
import { attachmentName, isImage, withAttachments } from './attachments';
import './apex-agent-composer.css';

export type ApexAgentComposerToolsHandle = {
  paths: () => string[];
  pending: () => boolean;
  hasErrors: () => boolean;
  decorate: (text: string) => string;
  clear: (paths?: string[]) => void;
};
export type ApexAgentAttachmentState = { paths: string[]; pending: boolean; hasErrors: boolean };
type PendingAttachment = { id: string; name: string; file?: File; save?: (name: string, bytes: Uint8Array) => Promise<string>; folder?: boolean; pickFolder?: () => Promise<string | null>; path?: string; preview?: string; error?: string; busy: boolean };

/** Shared ApexAgent composer controls. The host owns file persistence and
 *  command execution because each lane may have a different machine/destination. */
export const ApexAgentComposerTools = forwardRef<ApexAgentComposerToolsHandle, {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  menuRef?: RefObject<ComposerMenuHandle | null>;
  participants: readonly MenuPerson[];
  servers?: (ToolServer & { agent: string })[];
  serverStatus?: string;
  mods?: { mod: string; name: string; description: string }[];
  planOn?: boolean;
  onCommand: (command: Command) => void;
  saveAttachment?: (name: string, bytes: Uint8Array) => Promise<string>;
  pickFolder?: () => Promise<string | null>;
  onChooseAttachment?: () => void;
  onChooseFolder?: () => void;
  onTools?: () => void;
  onAttachmentState?: (state: ApexAgentAttachmentState) => void;
  includeAll?: boolean;
  allMentionDetail?: string;
  folderUnavailableReason?: string;
  filesUnavailableReason?: string;
  disabledCommands?: Record<string, string>;
  disabled?: boolean;
  trigger: Trigger | null;
}>(({
  value, onChange, inputRef, menuRef, participants, servers = [], serverStatus, mods = [], planOn = false,
  onCommand, saveAttachment, pickFolder, onChooseAttachment, onChooseFolder, onTools, onAttachmentState, includeAll = true, allMentionDetail,
  folderUnavailableReason, filesUnavailableReason, disabledCommands, disabled = false, trigger,
}, ref) => {
  const chooser = useRef<HTMLInputElement>(null);
  const caret = useRef(0);
  const chooserId = useRef<string | null>(null);
  const chooserSave = useRef(saveAttachment);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const attachmentStateCallback = useRef(onAttachmentState);
  attachmentStateCallback.current = onAttachmentState;
  useEffect(() => {
    const paths = attachments.flatMap(item => item.path ? [item.path] : []);
    attachmentStateCallback.current?.({ paths, pending: attachments.some(item => item.busy), hasErrors: attachments.some(item => !!item.error) });
  }, [attachments]);
  useEffect(() => {
    const input = chooser.current;
    if (!input) return;
    const cancel = () => {
      const selection = chooserId.current;
      chooserId.current = null;
      if (selection) setAttachments(previous => previous.filter(item => item.id !== selection));
    };
    input.addEventListener('cancel', cancel);
    return () => input.removeEventListener('cancel', cancel);
  }, []);
  useImperativeHandle(ref, () => ({
    paths: () => attachmentsRef.current.flatMap(item => item.path ? [item.path] : []),
    pending: () => attachmentsRef.current.some(item => item.busy),
    hasErrors: () => attachmentsRef.current.some(item => !!item.error),
    decorate: (text) => withAttachments(text, attachmentsRef.current.flatMap(item => item.path ? [item.path] : [])),
    clear: (paths) => {
      const selected = paths ? new Set(paths) : null;
      const kept = attachmentsRef.current.filter(item => selected ? !item.path || !selected.has(item.path) : false);
      attachmentsRef.current.filter(item => !kept.includes(item)).forEach(item => item.preview && URL.revokeObjectURL(item.preview));
      attachmentsRef.current = kept;
      setAttachments(kept);
    },
  }), []);
  const trackFile = async (file: File, save = saveAttachment) => {
    const id = `${Date.now()}-${Math.random()}`;
    const name = attachmentName(file.name, file.type);
    const tooLarge = file.size > 20 * 1024 * 1024;
    const preview = !tooLarge && isImage(name) ? URL.createObjectURL(file) : undefined;
    const pending: PendingAttachment = { id, name, file, save, preview, busy: !tooLarge, error: tooLarge ? 'Files must be 20 MB or smaller.' : undefined };
    setAttachments(previous => [...previous, pending]);
    if (tooLarge) return;
    try {
      if (!save) throw new Error('Attachments are unavailable for this destination.');
      const path = await save(name, new Uint8Array(await file.arrayBuffer()));
      setAttachments(previous => previous.map(item => item.id === id ? { ...item, path, busy: false, error: undefined } : item));
    } catch (error) {
      setAttachments(previous => previous.map(item => item.id === id ? { ...item, busy: false, error: String(error) } : item));
    }
  };
  const retry = (item: PendingAttachment) => { if (item.file) void trackRetry(item); else if (item.folder) void attachFolder(item.id); };
  const trackRetry = async (item: PendingAttachment) => {
    setAttachments(previous => previous.map(current => current.id === item.id ? { ...current, busy: true, error: undefined } : current));
    try {
      if (!item.save || !item.file) throw new Error('Attachments are unavailable for this destination.');
      const path = await item.save(item.name, new Uint8Array(await item.file.arrayBuffer()));
      setAttachments(previous => previous.map(current => current.id === item.id ? { ...current, path, busy: false } : current));
    } catch (error) { setAttachments(previous => previous.map(current => current.id === item.id ? { ...current, busy: false, error: String(error) } : current)); }
  };
  const attachFolder = async (existingId?: string) => {
    const id = existingId ?? `${Date.now()}-${Math.random()}`;
    const picker = existingId ? attachmentsRef.current.find(item => item.id === id)?.pickFolder : pickFolder;
    if (!picker) return;
    setAttachments(previous => existingId
      ? previous.map(item => item.id === id ? { ...item, name: 'Selecting folder…', error: undefined, busy: true } : item)
      : [...previous, { id, name: 'Selecting folder…', folder: true, pickFolder, busy: true }]);
    try {
      const path = await picker?.();
      setAttachments(previous => path
        ? previous.map(item => item.id === id ? { ...item, name: `${path.split('/').filter(Boolean).at(-1) ?? path}/`, path, folder: true, pickFolder: picker, busy: false } : item)
        : existingId
          ? previous.map(item => item.id === id ? { ...item, name: 'Folder', error: 'Folder selection canceled.', busy: false } : item)
          : previous.filter(item => item.id !== id));
    } catch (error) {
      setAttachments(previous => previous.map(item => item.id === id ? { ...item, name: 'Folder', folder: true, error: `Could not attach folder: ${String(error)}`, busy: false } : item));
    }
  };
  const insert = (text: string, trigger: Trigger | null) => {
    const field = inputRef.current;
    const position = field ? field.selectionStart : caret.current;
    const next = insertAt(value, trigger, position, text);
    onChange(next.text);
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(next.caret, next.caret);
    });
  };
  const chooseItem = (item: MenuItem, activeTrigger: Trigger | null) => {
    if (disabled || (item.kind === 'attach' && !saveAttachment) || (item.kind === 'attach-folder' && !pickFolder)) return;
    choose(item, activeTrigger);
  };
  const choose = (item: MenuItem, activeTrigger: Trigger | null) => {
    if (item.kind === 'attach') {
      if (disabled) return;
      chooserSave.current = saveAttachment;
      onChooseAttachment?.();
      const id = `${Date.now()}-${Math.random()}`;
      chooserId.current = id;
      setAttachments(previous => [...previous, { id, name: 'Selecting files…', busy: true }]);
      chooser.current?.click(); return;
    }
    if (item.kind === 'attach-folder') { onChooseFolder?.(); void attachFolder(); return; }
    if (item.kind === 'command') { if (item.command) onCommand(item.command); else insert(item.label + ' ', activeTrigger); return; }
    if (item.kind === 'mention') { insert(item.label + ' ', activeTrigger); return; }
    if (item.kind === 'server') { insert(item.label + ' ', activeTrigger); return; }
    if (item.kind === 'tools') { if (onTools) onTools(); else insert('!', activeTrigger); }
  };
  return <>
    <div onPointerDown={() => { const field = inputRef.current; if (field) caret.current = field.selectionStart; }}>
      <ComposerMenu ref={menuRef} participants={participants} servers={servers} serverStatus={serverStatus} mods={mods} planOn={planOn} disabled={disabled}
        trigger={trigger} choose={chooseItem} canAttach={!!saveAttachment} canAttachFolder={!!pickFolder}
        includeAll={includeAll} allMentionDetail={allMentionDetail} folderUnavailableReason={folderUnavailableReason} filesUnavailableReason={filesUnavailableReason}
        canUseTools={servers.length > 0 || !!serverStatus || !!onTools} disabledCommands={disabledCommands} />
    </div>
    <input ref={chooser} type="file" multiple hidden disabled={disabled} onChange={(event) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = '';
      const selection = chooserId.current;
      chooserId.current = null;
      if (selection) setAttachments(previous => previous.filter(item => item.id !== selection));
      files.forEach(file => void trackFile(file, chooserSave.current));
    }} />
    {!!attachments.length && <div className="attachments" aria-label="ApexAgent attachments">{attachments.map(item => <div className="attachment" key={item.id} aria-busy={item.busy}>
      {item.preview ? <img src={item.preview} alt={item.name} /> : <span className="attachment-name">{item.name}</span>}
      {item.error && <small role="alert" title={item.error}>Failed · <button className="attachment-retry" type="button" disabled={disabled} onClick={() => retry(item)}>Retry</button></small>}
      <button className="attachment-remove" type="button" disabled={disabled || item.busy} aria-label={`Remove ${item.name}`} onClick={() => { if (item.preview) URL.revokeObjectURL(item.preview); setAttachments(previous => previous.filter(current => current.id !== item.id)); }}>×</button>
    </div>)}</div>}
  </>;
});
