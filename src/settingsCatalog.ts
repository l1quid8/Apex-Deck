// Shared catalog for grouped navigation, search, scope, anchors
export type SettingsScope = 'app' | 'host' | 'new-thread' | 'all';
export type SettingsSectionId = 
  | 'general' | 'appearance' | 'calls' | 'threads' | 'terminal'
  | 'models' | 'computers' | 'phones' | 'computer' | 'extensions' | 'gateway' | 'data' | 'about' | 'shortcuts';

export interface CatalogSection {
  id: SettingsSectionId;
  label: string;
  aliases?: string[]; // old names: Hosts -> Computers, Mods -> Extensions
  group: 'everyday' | 'work' | 'connections' | 'capabilities' | 'maintenance';
  purpose: string;
  scope: SettingsScope;
  scopeLabel: string;
}

export interface CatalogEntry {
  id: string; // anchor
  section: SettingsSectionId;
  label: string;
  keywords: string[];
  scope: SettingsScope;
  scopeLabel: string;
  advanced?: boolean;
  anchorId: string;
  aliases?: string[];
}

export const CATALOG_SECTIONS: CatalogSection[] = [
  { id: 'general', label: 'General', group: 'everyday', purpose: 'Daily behavior', scope: 'all', scopeLabel: 'All chats' },
  { id: 'appearance', label: 'Appearance', group: 'everyday', purpose: 'Look and feel, Light/Dark/System', scope: 'all', scopeLabel: 'All chats' },
  { id: 'calls', label: 'Calls', group: 'everyday', purpose: 'Voice and call behavior', scope: 'host', scopeLabel: 'This Mac' },
  { id: 'threads', label: 'New threads', group: 'work', purpose: 'Creation defaults and work preferences', scope: 'new-thread', scopeLabel: 'New threads only' },
  { id: 'terminal', label: 'Terminal', group: 'work', purpose: 'Make the terminal comfortable', scope: 'all', scopeLabel: 'All terminals' },
  { id: 'shortcuts', label: 'Shortcuts', group: 'work', purpose: 'Keep the things you use close at hand', scope: 'host', scopeLabel: 'This Mac' },
  { id: 'models', label: 'Models & providers', aliases: ['providers'], group: 'connections', purpose: 'Provider configuration and connected models', scope: 'host', scopeLabel: 'This Mac' },
  { id: 'computers', label: 'Computers', aliases: ['hosts'], group: 'connections', purpose: 'The machines where your work happens', scope: 'host', scopeLabel: 'This Mac' },
  { id: 'phones', label: 'Phones', group: 'connections', purpose: 'Your paired devices', scope: 'host', scopeLabel: 'This Mac' },
  { id: 'computer', label: 'Unified Computer Use', group: 'capabilities', purpose: 'Let agents work with apps on this Mac', scope: 'host', scopeLabel: 'This Mac' },
  { id: 'extensions', label: 'Extensions', aliases: ['mods'], group: 'capabilities', purpose: 'Add capabilities', scope: 'host', scopeLabel: 'This Mac' },
  { id: 'gateway', label: 'Model gateway', group: 'capabilities', purpose: 'Use your model stack from other apps', scope: 'host', scopeLabel: 'This Mac' },
  { id: 'data', label: 'Data & storage', group: 'maintenance', purpose: 'Migration, locations, maintenance', scope: 'host', scopeLabel: 'This Mac' },
  { id: 'about', label: 'About & updates', group: 'maintenance', purpose: 'Version and diagnostics', scope: 'host', scopeLabel: 'This Mac' },
];

const SCOPE_LABEL: Record<SettingsScope, string> = {
  'app': 'All chats',
  'host': 'This Mac',
  'new-thread': 'New threads only',
  'all': 'All chats'
};

// Full control coverage — every existing feature mapped to location + keywords
export const CATALOG_ENTRIES: CatalogEntry[] = [
  // Appearance - full coverage from mockup README
  { id: 'mode', section: 'appearance', label: 'Appearance mode - Light, Dark, System', keywords: ['dark','light','theme','mode','system','appearance'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'mode' },
  { id: 'skin', section: 'appearance', label: 'Current preset', keywords: ['skin','preset','theme','classic','gallery'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'skin' },
  { id: 'skin-gallery', section: 'appearance', label: 'Built-in and saved presets', keywords: ['gallery','classic','smoked','tide','dusk','rose','frost','liquid','clay','saved','delete'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'skin-gallery' },
  { id: 'accent', section: 'appearance', label: 'Accent color and exact hex', keywords: ['accent','color','hex','picker','custom'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'accent' },
  { id: 'clay-presets', section: 'appearance', label: 'Accent colors Terracotta Sage Slate', keywords: ['clay','terracotta','sage','slate','preset','ember','paper'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'clay-presets', advanced: true },
  { id: 'corners', section: 'appearance', label: 'Corners radius', keywords: ['corners','radius','round'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'corners', advanced: true },
  { id: 'glow', section: 'appearance', label: 'Glow strength', keywords: ['glow','glass','active'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'glow', advanced: true },
  { id: 'frost', section: 'appearance', label: 'Frost blur', keywords: ['frost','blur','glass'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'frost', advanced: true },
  { id: 'surface', section: 'appearance', label: 'Opacity', keywords: ['surface','opacity','transparency'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'surface', advanced: true },
  { id: 'backdrop', section: 'appearance', label: 'Backdrop strength', keywords: ['backdrop','glass','strength'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'backdrop', advanced: true },
  { id: 'flat', section: 'appearance', label: 'Solid panels', keywords: ['flat','solid','glass'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'flat', advanced: true },
  { id: 'reply', section: 'appearance', label: 'Reply text serif or sans', keywords: ['reply','text','font','serif','sans','typeface'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'reply' },
  { id: 'edges', section: 'appearance', label: 'Panel edges', keywords: ['panel','edges','dividers','lines','strong','soft'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'edges' },
  { id: 'density', section: 'appearance', label: 'Density', keywords: ['density','compact','roomy','comfortable','rows'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'density' },
  { id: 'effects', section: 'appearance', label: 'Background effects', keywords: ['background','effects','pattern','glow','blur','ripple','animation','advanced','aurora','halo','mesh','horizon','stripes','rings','dots','spotlight','none','blobs'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'effects', advanced: true },
  { id: 'match-accent', section: 'appearance', label: 'Match accent', keywords: ['match','accent','glow','colors'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'match-accent', advanced: true },
  { id: 'glow-count', section: 'appearance', label: 'Number of glows', keywords: ['count','glows','add','remove'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'glow-count', advanced: true },
  { id: 'glow-colors', section: 'appearance', label: 'Glow colors', keywords: ['glow','colors'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'glow-colors', advanced: true },
  { id: 'glow-size', section: 'appearance', label: 'Glow size', keywords: ['size','glow','wide','tight'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'glow-size', advanced: true },
  { id: 'field-enable', section: 'appearance', label: 'Empty-thread field', keywords: ['empty','thread','field','glyph','animation'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'field-enable', advanced: true },
  { id: 'field-color', section: 'appearance', label: 'Field color and hex', keywords: ['field','color','hex','single'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'field-color', advanced: true },
  { id: 'rainbow-speed', section: 'appearance', label: 'Rainbow speed', keywords: ['rainbow','speed','hues','cycle'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'rainbow-speed', advanced: true },
  { id: 'ripple-shape', section: 'appearance', label: 'Third-click ripple shape', keywords: ['ripple','diamond','circle','logo','shape','click'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'ripple-shape', advanced: true },
  { id: 'chips', section: 'appearance', label: 'Agent chip style', keywords: ['chips','bot','agent','style','effort','usage','classic','dashed','tinted','stamp','stack','mono','ticket','keycap','tab','ledger','terminal','tiles'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'chips' },
  { id: 'effort', section: 'appearance', label: 'Show effort', keywords: ['effort','thinking'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'effort' },
  { id: 'usage', section: 'appearance', label: 'Show usage', keywords: ['usage','context','plan'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'usage' },
  { id: 'saved-skins', section: 'appearance', label: 'Save named preset', keywords: ['save','skin','preset','name','gallery'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'saved-skins', advanced: true },
  { id: 'skin-transfer', section: 'appearance', label: 'Preset import export JSON', keywords: ['import','export','json','copy','paste','file','share'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'skin-transfer', advanced: true },
  { id: 'ai-prompt', section: 'appearance', label: 'Copy AI prompt', keywords: ['ai','prompt','generate','skin'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'ai-prompt', advanced: true },

  // General
  { id: 'user-name', section: 'general', label: 'Name', keywords: ['name','profile','you','me'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'user-name' },
  { id: 'user-nickname', section: 'general', label: 'What agents should call you', keywords: ['nickname','name','profile','call','address'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'user-nickname' },
  { id: 'artifacts', section: 'general', label: 'New artifacts Open pane / Just notify', keywords: ['artifacts','files','pane','open','notify','new'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'artifacts' },
  { id: 'run-buttons', section: 'general', label: 'Run buttons on code blocks', keywords: ['run','code','blocks','shell'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'run-buttons' },
  { id: 'storage', section: 'general', label: 'Saved in / Show in Finder', keywords: ['saved','folder','location','finder','storage','data'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'storage' },
  { id: 'remembered', section: 'general', label: 'Remembered models', keywords: ['remembered','models','clear','suggestions'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'remembered' },
  { id: 'import', section: 'general', label: 'Older records / Review import', keywords: ['import','legacy','older','records','migration'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'import' },
  { id: 'version', section: 'general', label: 'Version, check updates', keywords: ['version','updates','check','about'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'version' },
  { id: 'theme-shortcut', section: 'general', label: 'Theme / Appearance shortcut', keywords: ['theme','appearance','skin'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'theme-shortcut' },

  // Calls
  { id: 'engine', section: 'calls', label: 'Call engine Local / GPT-Live', keywords: ['calls','engine','local','realtime','gpt-live','voice','microphone'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'engine' },
  { id: 'voice', section: 'calls', label: 'Voice for calls', keywords: ['voice','default','speaking','audio'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'voice' },
  { id: 'pause', section: 'calls', label: 'Pause before reply', keywords: ['pause','silence','reply'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'pause' },
  { id: 'call-controls', section: 'calls', label: 'Call controls Bar / Pill / Top bar', keywords: ['call','controls','bar','pill','layout'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'call-controls' },
  { id: 'live-voice', section: 'calls', label: 'GPT-Live voice and model', keywords: ['live','realtime','voice','model','openai'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'live-voice' },

  // Threads
  { id: 'answers', section: 'threads', label: 'Who answers', keywords: ['answers','who','addressed','turn','policy','mention','everyone','round robin'], scope: 'new-thread', scopeLabel: SCOPE_LABEL['new-thread'], anchorId: 'answers' },
  { id: 'rounds', section: 'threads', label: 'Model-to-model rounds', keywords: ['rounds','model','unlimited','hops','agent'], scope: 'new-thread', scopeLabel: SCOPE_LABEL['new-thread'], anchorId: 'rounds' },
  { id: 'access', section: 'threads', label: 'Access for new bots Read/Ask/Edits/Full', keywords: ['access','read','ask','edits','full','permissions'], scope: 'new-thread', scopeLabel: SCOPE_LABEL['new-thread'], anchorId: 'access' },
  { id: 'steer', section: 'threads', label: 'Confirm before steering', keywords: ['steer','confirm','interrupting'], scope: 'new-thread', scopeLabel: SCOPE_LABEL['new-thread'], anchorId: 'steer' },

  // Terminal
  { id: 'terminal-font', section: 'terminal', label: 'Terminal font size', keywords: ['terminal','font','size','text','monospace'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'terminal-font' },
  { id: 'scrollback', section: 'terminal', label: 'Scrollback lines', keywords: ['scrollback','terminal','lines'], scope: 'all', scopeLabel: SCOPE_LABEL.all, anchorId: 'scrollback' },

  // Providers / Models & providers
  { id: 'provider-list', section: 'models', label: 'Provider connections', keywords: ['providers','api','models','claude','codex','deepseek','ollama','configured','installed','hidden'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'provider-list' },
  { id: 'api-key', section: 'models', label: 'API keys and status', keywords: ['api','key','credentials','keychain','openai','deepseek','xai','venice','image','usage'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'api-key' },
  { id: 'all-tools', section: 'models', label: 'All tools & provider visibility', keywords: ['all','tools','visibility','show','hide','installed','enable'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'all-tools', advanced: true },

  // Computers (Hosts)
  { id: 'connections', section: 'computers', label: 'SSH connections', keywords: ['hosts','computers','remote','ssh','key','disconnected','connected','status'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'connections' },
  { id: 'computer-add', section: 'computers', label: 'Add computer', keywords: ['add','host','computer','ssh'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'computer-add' },
  { id: 'computer-edit', section: 'computers', label: 'Edit / Remove computer', keywords: ['edit','remove','ssh','diagnostic'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'computer-edit', advanced: true },

  // Phones
  { id: 'paired', section: 'phones', label: 'Paired phones', keywords: ['phones','paired','devices','rename','access','full','chat'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'paired' },
  { id: 'phone-remote', section: 'phones', label: 'Remote connections and network', keywords: ['remote','network','addresses','port','udp','endpoint','advertised'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'phone-remote', advanced: true },
  { id: 'phone-tier', section: 'phones', label: 'Phone access tier and revoke', keywords: ['access','tier','revoke','phone','chat','full'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'phone-tier', advanced: true },

  // Unified Computer Use
  { id: 'ucu-enable', section: 'computer', label: 'Enable Unified Computer Use', keywords: ['computer','use','enable','desktop','tools'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'ucu-enable' },
  { id: 'ucu-status', section: 'computer', label: 'Computer use status, refresh, setup', keywords: ['status','refresh','setup','permissions','accessibility','screen','recording','input','monitoring'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'ucu-status' },
  { id: 'ucu-away', section: 'computer', label: "Keep working while I'm away", keywords: ['away','lock','locked','idle','sleep','awake','shield','unattended','untethered'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'ucu-away' },
  { id: 'thread-grants', section: 'computer', label: 'Approval per Work thread', keywords: ['thread','grants','approval','allow','apps','permissions'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'thread-grants' },
  { id: 'cursor', section: 'computer', label: 'Cursor indicator and labels', keywords: ['cursor','pointer','mouse','labels','bubble','duration','indicator'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'cursor' },
  { id: 'cursor-style', section: 'computer', label: 'Cursor style presets', keywords: ['cursor','style','preset','default','simple','ring','pointer','custom'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'cursor' },
  { id: 'cursor-colors', section: 'computer', label: 'Cursor colors fill accent outline', keywords: ['cursor','colors','fill','accent','outline','rim','hex'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'cursor' },
  { id: 'cursor-size', section: 'computer', label: 'Cursor size', keywords: ['cursor','size','scale','large','small'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'cursor' },
  { id: 'cursor-effects', section: 'computer', label: 'Cursor ripple highlight', keywords: ['cursor','ripple','highlight','target','effect','click'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'cursor' },
  { id: 'cursor-image', section: 'computer', label: 'Custom cursor PNG image', keywords: ['cursor','image','png','custom','upload','reset'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'cursor' },
  { id: 'cursor-motion', section: 'computer', label: 'Cursor motion travel dwell timing', keywords: ['cursor','motion','travel','dwell','linger','bow','overshoot','tremor','speed'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'cursor-customize' },
  { id: 'cursor-labels', section: 'computer', label: 'Cursor action labels', keywords: ['cursor','labels','action','description'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'cursor' },
  { id: 'ucu-stop', section: 'computer', label: 'Stop and privacy', keywords: ['stop','privacy','model','screenshots'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'ucu-stop', advanced: true },

  // Gateway
  { id: 'gateway-endpoint', section: 'gateway', label: 'Gateway endpoint and URL', keywords: ['gateway','endpoint','url','network','localhost','port','save'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'gateway-endpoint' },
  { id: 'gateway-network', section: 'gateway', label: 'Network configuration', keywords: ['listen','address','port','http','https','advanced'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'gateway-network', advanced: true },
  { id: 'gateway-keys', section: 'gateway', label: 'Gateway API keys and providers', keywords: ['gateway','keys','providers','access','key','creation','revoke','usage','spend','scope','daily'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'gateway-keys', advanced: true },

  // Extensions (Mods)
  { id: 'extension-list', section: 'extensions', label: 'Installed extensions', keywords: ['extensions','mods','plugin','status','purpose','commands','capabilities','permissions'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'extension-list' },
  { id: 'extension-manage', section: 'extensions', label: 'Manage extension & permissions', keywords: ['add','reload','reinstall','remove','enable','options','file','folder','picker'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'extension-manage', advanced: true },

  // Data & storage
  { id: 'storage-location', section: 'data', label: 'Saved work location', keywords: ['storage','saved','work','location','folder','data'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'storage-location' },
  { id: 'older-records', section: 'data', label: 'Older records / Import', keywords: ['older','records','import','migration','legacy'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'older-records' },
  { id: 'maintenance', section: 'data', label: 'Maintenance remembered models', keywords: ['maintenance','remembered','models','clear','suggestions'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'maintenance', advanced: true },

  // Shortcuts
  { id: 'shortcut-list', section: 'shortcuts', label: 'Keyboard shortcuts', keywords: ['shortcuts','hotkeys','keyboard','navigation','threads','panes','composer'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'shortcut-list' },

  // About
  { id: 'updates', section: 'about', label: 'App updates', keywords: ['version','updates','release','check','restart','about'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'updates' },
  { id: 'build-details', section: 'about', label: 'Build details and diagnostics', keywords: ['build','diagnostics','channel','test','local'], scope: 'host', scopeLabel: SCOPE_LABEL.host, anchorId: 'build-details', advanced: true },
];

export function searchSettings(query: string, entries: CatalogEntry[], visibleSectionIds?: Set<SettingsSectionId>): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  let filtered = entries;
  if (visibleSectionIds) {
    filtered = filtered.filter(e => visibleSectionIds.has(e.section));
  }
  const scored = filtered.map(e => {
    const hay = `${e.label} ${e.keywords.join(' ')} ${e.section}`.toLowerCase();
    const aliasHay = (e.aliases||[]).join(' ').toLowerCase();
    let score = 0;
    // exact label match highest
    if (e.label.toLowerCase().includes(q)) score += 100;
    if (hay.includes(q)) score += 50;
    if (aliasHay.includes(q)) score += 40;
    for (const tok of tokens) {
      if (e.label.toLowerCase().includes(tok)) score += 20;
      if (e.keywords.some(k=>k.includes(tok))) score += 10;
      if (hay.includes(tok)) score += 5;
    }
    return { entry: e, score };
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0, 30);
  return scored.map(s=>s.entry);
}

export function groupSections(): { title: string; sections: CatalogSection[] }[] {
  return [
    { title: 'Everyday', sections: CATALOG_SECTIONS.filter(s=>s.group==='everyday') },
    { title: 'Work', sections: CATALOG_SECTIONS.filter(s=>s.group==='work') },
    { title: 'Connections', sections: CATALOG_SECTIONS.filter(s=>s.group==='connections') },
    { title: 'Capabilities', sections: CATALOG_SECTIONS.filter(s=>s.group==='capabilities') },
    { title: 'Maintenance', sections: CATALOG_SECTIONS.filter(s=>s.group==='maintenance') },
  ];
}

// Back-compat: old section ids
export function resolveSectionId(input: string): SettingsSectionId | null {
  const lower = input.toLowerCase();
  const exact = CATALOG_SECTIONS.find(s=>s.id===lower);
  if (exact) return exact.id;
  const alias = CATALOG_SECTIONS.find(s=>s.aliases?.includes(lower));
  if (alias) return alias.id;
  // legacy: providers -> models, hosts -> computers, mods -> extensions
  if (lower==='providers') return 'models';
  if (lower==='hosts') return 'computers';
  if (lower==='mods') return 'extensions';
  if (lower==='gateway') return 'gateway';
  return null;
}

export type StudioTab = "customize" | "material" | "details" | "share";

/** Where each Appearance search result lives on the Studio page. A key with no
 *  `control` entry is the control's own data-ctl name. */
export const STUDIO_ANCHORS: Record<string, { tab: StudioTab; control?: string }> = {
  mode: { tab: "customize" }, skin: { tab: "customize", control: "preset" }, "skin-gallery": { tab: "customize", control: "preset" },
  accent: { tab: "customize" }, "clay-presets": { tab: "customize", control: "accent" }, corners: { tab: "customize" }, density: { tab: "customize" }, reply: { tab: "customize" },
  edges: { tab: "material" }, glow: { tab: "material" }, frost: { tab: "material" }, surface: { tab: "material" }, backdrop: { tab: "material" }, flat: { tab: "material" },
  effects: { tab: "material", control: "pattern" }, "match-accent": { tab: "material", control: "glow-colors" }, "glow-count": { tab: "material" }, "glow-colors": { tab: "material" }, "glow-size": { tab: "material" },
  "field-enable": { tab: "details", control: "field" }, "field-color": { tab: "details", control: "field" }, "rainbow-speed": { tab: "details", control: "field" }, "ripple-shape": { tab: "details", control: "field" },
  chips: { tab: "details" }, effort: { tab: "details" }, usage: { tab: "details" },
  "saved-skins": { tab: "customize", control: "preset" }, "skin-transfer": { tab: "share", control: "transfer" }, "ai-prompt": { tab: "share" },
};
