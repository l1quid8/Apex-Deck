import type { Backend } from "../backend";
import { fromPhone } from "./phoneTerminals.ts";

export async function renameTerminal(backend: Backend, id: string, name: string): Promise<void> {
  await backend.ptyRename(id, name);
}

export async function endTerminal(backend: Backend, id: string): Promise<void> {
  await backend.ptyKill(id);
}

export async function copyLastOutput(text: string, copy: (value: string) => Promise<boolean>): Promise<boolean> {
  return copy(text);
}

export async function resizePhoneTerminal(backend: Backend, id: string, cols: number, rows: number): Promise<boolean> {
  if (!fromPhone(id)) return false;
  await backend.ptyResize(id, cols, rows);
  return true;
}
