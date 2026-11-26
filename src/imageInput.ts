import type { ApiModel, ParticipantConfig } from "./types.ts";

type ApiBackend = Extract<ParticipantConfig["backend"], { kind: "open_ai_compatible" }>;

export function imageInputNotice(targets: string[], roster: ParticipantConfig[], lookup: (backend: ApiBackend) => ApiModel | undefined) {
  const unsupported: string[] = [];
  const unknown: string[] = [];
  for (const agent of roster.filter(p => targets.includes(p.id))) {
    const backend = agent.backend;
    if (backend.kind === "agent") continue;
    if (backend.kind !== "open_ai_compatible") {
      unsupported.push(agent.display_name);
      continue;
    }
    const model = lookup(backend);
    const supported = model?.kind === "image" ? Boolean(model.media?.edit_model)
      : model?.kind === "video" ? Boolean(model.media?.image_model || model.media?.needs_image)
      : model?.image_input;
    if (supported === false) unsupported.push(agent.display_name);
    else if (supported == null) unknown.push(agent.display_name);
  }
  if (unsupported.length) return { blocked: true, text: `${unsupported.join(", ")} can’t receive images. Remove the image or choose another model.` };
  if (unknown.length) return { blocked: false, text: `Deck couldn’t confirm image support for ${unknown.join(", ")}. The provider may reject this attachment.` };
  return null;
}
