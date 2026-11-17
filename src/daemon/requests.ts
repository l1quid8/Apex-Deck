import type { Commands, CommandName } from "../generated/protocol.ts";

// A union of tuples preserves the relation between a literal command and its
// fields even when a caller supplies an explicit result type.
export type HostCommandArgs<Name extends CommandName = CommandName> = {
  [K in Name]: {} extends Commands[K]
    ? [cmd: K, args?: Commands[K]]
    : [cmd: K, args: Commands[K]];
}[Name];

/** Arguments still needed after a caller binds fields such as the browser session or assistant ID. */
export type BoundCommandArgs<Name extends CommandName, Field extends string> = {
  [K in Name]: {} extends Omit<Commands[K], Field>
    ? [cmd: K, args?: Omit<Commands[K], Field>]
    : [cmd: K, args: Omit<Commands[K], Field>];
}[Name];

/** Restore the tuple correlation after merging the fields supplied by the owning route. */
export function completeCommand<Name extends CommandName, Field extends keyof Commands[Name] & string>(
  request: BoundCommandArgs<Name, Field>, fields: Required<Pick<Commands[Name], Field>>,
): HostCommandArgs<Name> {
  const args: Record<string, unknown> = { ...request[1], ...fields };
  return [request[0], args] as HostCommandArgs<Name>;
}
