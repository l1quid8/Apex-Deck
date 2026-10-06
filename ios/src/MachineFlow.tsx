import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Command,
  Folder,
  Files,
  FileText,
  Image,
  Plug,
  Globe,
  Laptop,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Settings,
  Terminal,
  X,
} from "lucide-react";

type Machine = {
  id: string;
  name: string;
  home: string;
  address: string;
  color: string;
  offline?: boolean;
};
export const machines: Machine[] = [
  {
    id: "mac",
    name: "Tyler’s MacBook",
    home: "~/Downloads",
    address: "Nearby · paired with this phone",
    color: "#71e6b5",
  },
  {
    id: "at",
    name: "Apex-Terminal",
    home: "/home/l1quid8",
    address: "l1quid8@apex-terminal",
    color: "#1ed7ee",
  },
  {
    id: "hz",
    name: "Hetzner-EU",
    home: "/root",
    address: "root@hetzner-eu",
    color: "#a78bfa",
  },
  {
    id: "lab",
    name: "Lab-Pi",
    home: "/home/pi",
    address: "pi@lab-pi.local",
    color: "#f472b6",
  },
  {
    id: "st",
    name: "Staging",
    home: "/srv",
    address: "deploy@staging.internal",
    color: "#f2c14e",
    offline: true,
  },
];
type Project = {
  id: string;
  name: string;
  host: string;
  path: string;
  hidden?: boolean;
  pinned?: boolean;
};
const projects0: Project[] = [
  { id: "deck", name: "apex-deck", host: "mac", path: "~/Downloads/apex-deck" },
  {
    id: "ios",
    name: "apex-deck-ios",
    host: "mac",
    path: "~/Downloads/apex-deck-ios",
  },
  {
    id: "deckAT",
    name: "apex-deck",
    host: "at",
    path: "/home/l1quid8/apex-deck",
  },
  {
    id: "smoke",
    name: "apex-smoke-test",
    host: "at",
    path: "/home/l1quid8/apex-smoke-test",
  },
  { id: "deckHZ", name: "apex-deck", host: "hz", path: "/root/apex-deck" },
  { id: "api", name: "staging-api", host: "st", path: "/srv/staging-api" },
  { id: "none", name: "No project", host: "mac", path: "a scratch folder" },
];
type Thread = {
  id: string;
  project: string;
  title: string;
  text: string;
  files: string[];
  messages: string[];
  bots: string[];
  started: boolean;
  pinned?: boolean;
  archived?: boolean;
  hidden?: boolean;
  fork?: string;
  approval?: boolean;
  unread?: boolean;
  decision?: string;
  forkApprovalHost?: string;
  at?: number;
};
const makeThread = (
  id: string,
  project: string,
  title: string,
  messages: string[],
  bots: string[],
  pinned = false,
): Thread => ({
  id,
  project,
  title,
  messages,
  bots,
  pinned,
  text: "",
  files: [],
  started: true,
  approval: id === "t4",
  at: ({t1:5,t8:60,t2:180,t6:20,t3:2880,t4:0,t5:240} as Record<string,number>)[id],
});
const threads0 = [
  makeThread(
    "t1",
    "deck",
    "Signing check",
    [
      "You: Is the 0.5.1 dmg signed with Developer ID now?",
      "Jigga: Yes. codesign reports Developer ID Application, so Full Disk Access should survive the next update.",
    ],
    ["Jigga", "Codex"],
    true,
  ),
  makeThread(
    "t8",
    "deck",
    "PDF export polish",
    [
      "You: Make the PDF page dark all the way to the edges.",
      "Jigga: Done. The dark background now reaches the page edges.",
    ],
    ["Jigga"],
  ),
  makeThread(
    "t2",
    "ios",
    "Mockup review",
    [
      "You: How does pairing look on a small phone?",
      "Claude: The QR card fits; the device list needs a second line for long names.",
    ],
    ["Claude"],
  ),
  makeThread(
    "t6",
    "deckAT",
    "Daemon logs",
    [
      "You: Anything odd in the daemon log overnight?",
      "Grok: Two reconnects at 3:12 AM. Both recovered in under 5 seconds.",
    ],
    ["Grok"],
  ),
  makeThread(
    "t3",
    "smoke",
    "vps-smoke-claude",
    [
      "You: Is the daemon still on 0.5.0?",
      "Claude: Yes. apex-daemon --version prints 0.5.0, which works with app 0.5.1.",
    ],
    ["Claude"],
    true,
  ),
  makeThread(
    "t4",
    "deckHZ",
    "Load test the new PDF export",
    [
      "You: Run the load test on the Hetzner copy.",
      "Claude: Starting it in Hetzner-EU’s copy of apex-deck.",
    ],
    ["Claude"],
  ),
  makeThread(
    "t5",
    "api",
    "Migrations",
    [
      "You: Apply the pending migration.",
      "Grok: Applied 0042. Checking row counts next.",
    ],
    ["Grok"],
    true,
  ),
];
const folderTree: Record<string, Record<string, string[]>> = {
  mac: { "~/Downloads": ["apex-deck", "apex-deck-ios", "dmg-staging"], "~/Downloads/apex-deck": ["crates", "desktop", "docs", "src"], "~/Downloads/apex-deck-ios": ["App", "Docs"] },
  at: { "/home/l1quid8": ["apex-deck", "apex-smoke-test", "apex_terminal", "notes"], "/home/l1quid8/apex-deck": ["crates", "docs", "src"], "/home/l1quid8/apex_terminal": ["src"] },
  hz: { "/root": ["apex-deck", "backups", "bench"], "/root/apex-deck": ["crates", "docs", "src"] },
  lab: { "/home/pi": ["apex-deck", "code", "logs"], "/home/pi/apex-deck": ["crates", "docs", "src"], "/home/pi/code": ["apex-deck", "scratch"], "/home/pi/code/apex-deck": ["crates", "docs", "src"] },
  st: { "/srv": ["staging-api"] },
};
const botColors: Record<string, string> = {Jigga: "#71e6b5", Claude: "#a78bfa", Grok: "#f2c14e", Codex: "#60a5fa"};
const listed = (t: Thread) => !t.archived && !t.hidden && (t.started || !!t.text.trim() || !!t.files.length);
const titleOf = (text: string) => {
  const words = text.replace(/!\S+/g, " ").trim().split(/\s+/).slice(0,5).join(" ");
  return words ? words[0].toUpperCase() + words.slice(1) : "New thread";
};
const threadId = (thread: Thread) => {
  let hash = 2166136261;
  for (const char of thread.id + thread.title) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `thr_${(hash >>> 0).toString(36).slice(0,6)}`;
};
const files = [
  "image (22).png",
  "image (21).png",
  "Remote-IOS-Daemon-2026-10-06.pdf",
  "Reasoning-Slider-Mechanics-2026-10-06.pdf",
  "image (16).png",
  "daemon-ubuntu.md",
  "codesign-output.txt",
];
const toolIcons: Record<string,string> = {"google-drive": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\"  aria-hidden=\"true\"><path d=\"M8.5 3h7l7 12h-7Z\" fill=\"#fbbc04\"/><path d=\"M8.5 3 1.5 15l3.5 6 7-12Z\" fill=\"#34a853\"/><path d=\"M5 21h14l3.5-6h-14Z\" fill=\"#4285f4\"/></svg>", "vercel": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\"  aria-hidden=\"true\"><path d=\"M12 4 22 20H2Z\" fill=\"#e6edf3\"/></svg>", "robinhood": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#00c805\" stroke-width=\"2\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M4 20c3-9 8-14 16-16-1 8-6 13-14 14\"/><path d=\"M8 16l6-6\"/></svg>", "figma": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\"  aria-hidden=\"true\"><circle cx=\"9\" cy=\"5.5\" r=\"3.5\" fill=\"#f24e1e\"/><circle cx=\"15\" cy=\"5.5\" r=\"3.5\" fill=\"#ff7262\"/><circle cx=\"9\" cy=\"12\" r=\"3.5\" fill=\"#a259ff\"/><circle cx=\"15\" cy=\"12\" r=\"3.5\" fill=\"#1abcfe\"/><circle cx=\"9\" cy=\"18.5\" r=\"3.5\" fill=\"#0acf83\"/></svg>", "linear": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\"  aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"9.5\" fill=\"#5e6ad2\"/><path d=\"M5.5 13.5l5 5M5 10l9 9M7 6.5l10.5 10.5M10.5 4.5l9 9\" stroke=\"#fff\" stroke-width=\"1.3\"/></svg>", "hyper-mcp": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#97fce4\" stroke-width=\"2.2\" aria-hidden=\"true\"><path d=\"M3 12c0-3 2-5 4.5-5S11 9 12 12s2.5 5 4.5 5S21 15 21 12s-2-5-4.5-5S13 9 12 12s-2.5 5-4.5 5S3 15 3 12Z\"/></svg>", "computer-use": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\"  aria-hidden=\"true\"><path d=\"M5 3l14 8-6 2-3 6Z\" fill=\"#e6edf3\"/></svg>", "claude-docs": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#d97757\" stroke-width=\"1.8\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M14 3H6v18h12V7Z\"/><path d=\"M14 3v4h4M9 13h6M9 17h4\"/></svg>", "github": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\"  aria-hidden=\"true\"><path d=\"M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 2.9.8.1-.7.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7 3.6 3.6 0 0 1 .1-2.7s.8-.3 2.8 1a9.6 9.6 0 0 1 5 0c2-1.3 2.8-1 2.8-1 .4 1 .2 2 .1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.8V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z\" fill=\"#e6edf3\"/></svg>", "docker": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#2496ed\" stroke-width=\"1.6\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 12h16c1 0 2-1 2-2 0 6-5 10-11 10-4 0-7-3-7-8Z\"/><path d=\"M6 9h3v3H6zM9 9h3v3H9zM12 9h3v3h-3zM9 6h3v3H9z\"/></svg>", "sentry": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#a78bfa\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 4 3 20h4M12 4l9 16h-5M12 4 8.5 10.5A8 8 0 0 1 12 20\"/></svg>", "postgres": "<svg width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#7aa7d8\" stroke-width=\"1.7\" aria-hidden=\"true\"><ellipse cx=\"12\" cy=\"6\" rx=\"7\" ry=\"3\"/><path d=\"M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3\"/></svg>"};
const tools = [
  ["google-drive", "Google Drive", "Claude", "mac"],
  ["vercel", "Vercel", "Claude", "all"],
  ["robinhood", "Robinhood", "Claude", "mac"],
  ["github", "GitHub", "Claude", "server"],
  ["docker", "Docker", "Claude", "server"],
  ["sentry", "Sentry", "Claude", "server"],
  ["figma", "Figma · sign in needed", "Claude", "mac"],
  ["linear", "Linear · sign in needed", "Claude", "mac"],
  ["hyper-mcp", "Hyper MCP", "Codex", "mac"],
  ["computer-use", "Computer Use", "Codex", "mac"],
  ["claude-docs", "Claude Docs", "Jigga", "mac"],
  ["github", "GitHub", "Jigga", "mac"],
  ["postgres", "Postgres", "Grok", "server"],
];
export const stepCaptions = [
  "One Threads list across every machine. Pinned, Projects and Recents keep the server names and colored globes.",
  "Long-press a server project for its full path, thread count and helper version. Restart and update is available here.",
  "Project actions include Pin, Edit, Edit connection, Archive threads and Remove project.",
  "Edit connection checks machine identity before saving. Try l1quid8@203.0.113.24 for the same Apex-Terminal.",
  "New thread starts in the last project. Project, Files, Tools and Work in stay above the composer.",
  "Search projects, machines and full folder paths in the project sheet.",
  "Work in lists every machine, one row per folder. Staging is offline; Lab-Pi has no copy yet.",
  "Choose a folder on Lab-Pi. This is a separate copy; no project files are copied over.",
  "Change an unsent thread to Hetzner-EU. Its typed text stays, and the exact folder is visible.",
  "Files shows recent attachments and Photos / Files. Sending copies the attachments to the chosen machine.",
  "Tools belongs to the bots and machine in this thread. A selection inserts its !name into the draft.",
  "Send locks this thread to Hetzner-EU. The approval names the machine and folder where the command runs.",
  "Long-press a thread for its full title, project, machine, activity and participants.",
  "Thread actions and Copy use an in-memory pretend clipboard; your actual clipboard is untouched.",
  "Started threads stay on their machine. Choose New thread, Fork this thread or Cancel.",
  "Fork retains the whole conversation and its origin. Nothing runs before Send.",
  "Staging pauses only its own threads. Retry now is available; Send is off and nothing is queued.",
  "At large text, the folder path goes first and long project names shorten in the middle. The project and machine names always stay.",
  "iPhone only: MacBook asleep. Mac threads pause; the phone connects directly to Hetzner-EU and still sends.",
];
function preset(step: number) {
  const threads = structuredClone(threads0);
  threads.find(t => t.id === "t4")!.hidden = step < 12;
  let active = "t6",
    view = "list",
    sheet = "";
  if (step === 2) sheet = "project-card";
  if (step === 3) sheet = "project-menu";
  if (step === 4) {
    view = "connection";
  }
  if (step >= 5 && step <= 11) {
    const draft: Thread = {
      id: "draft",
      project: step >= 9 ? "deckHZ" : "deck",
      title: "New thread",
      text: step >= 9 ? "Run the load test on the Hetzner copy." : "",
      files: step === 11 ? [files[2]] : [],
      messages: [],
      bots: ["Claude"],
      started: false,
    };
    threads.push(draft);
    active = "draft";
    view = "chat";
    sheet =
      (
        {
          6: "project",
          7: "work",
          8: "folder",
          10: "files",
          11: "tools",
        } as Record<number, string>
      )[step] || "";
  }
  if (step >= 12 && step <= 16) {
    active = "t4";
    view = "chat";
    sheet =
      (
        { 13: "thread-card", 14: "copy", 15: "switch" } as Record<
          number,
          string
        >
      )[step] || "";
  }
  if (step === 13 || step === 14) view = "list";
  if (step === 16) {
    threads.push({
      ...structuredClone(threads.find((t) => t.id === "t4")!),
      id: "fork",
      approval: false,
      decision: undefined,
      forkApprovalHost: "Hetzner-EU",
      project: "deck",
      title: "Load test the new PDF export (fork)",
      started: false,
      fork: "Load test the new PDF export · Hetzner-EU",
    });
    active = "fork";
  }
  if (step === 17) {
    active = "t5";
    threads.find(t => t.id === "t5")!.text = "Check the migration row counts.";
    view = "chat";
    threads[0].text = "Is the 0.5.1 dmg notarized too?";
  }
  if (step === 18) {
    view = "chat";
    active = "t3";
  }
  if (step === 19) {
    view = "chat";
    active = "t1";
    threads[0].text = "Is the 0.5.1 dmg notarized too?";
  }
  return { threads, active, view, sheet };
}
type Connections = Record<string, { address: string; daemon: string }>;
const connections0: Connections = Object.fromEntries(
  machines.map((h) => [
    h.id,
    {
      address: h.address,
      daemon: h.id === "hz" ? "/root/.cargo/bin/apex-daemon" : "apex-daemon",
    },
  ]),
);
let saved:
  | (ReturnType<typeof preset> & {
      projects: Project[];
      scene: number;
      connections: Connections;
      unpaired: string[];
      updated: boolean;
      collapsed: string[];
    })
  | undefined;
export default function MachineFlow({
  step,
  onNavigate,
  onHost,
  initialView,
}: {
  step: number;
  onNavigate: (route: string) => void;
  onHost: (host: string, path: string, bots: string[], offline: boolean, asleep: boolean) => void;
  initialView?: string;
}) {
  const initial = step === 0 && saved ? saved : preset(step);
  const scene = step === 0 && saved ? saved.scene : step;
  const [connections, setConnections] = useState(
    step === 0 && saved ? saved.connections : connections0,
  );
  const [threads, setThreads] = useState(initial.threads),
    [active, setActive] = useState(initial.active),
    [view, setView] = useState(initialView || initial.view),
    [sheet, setSheet] = useState(initial.sheet);
  const [projects, setProjects] = useState(
      step === 0 && saved ? saved.projects : projects0,
    ),
    [query, setQuery] = useState(""),
    [selectedProject, setSelectedProject] = useState("deckAT"),
    [pending, setPending] = useState("deck");
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [address, setAddress] = useState(machines[1].address),
    [daemon, setDaemon] = useState("apex-daemon"),
    [editHost, setEditHost] = useState("at");
  const [folderHost, setFolderHost] = useState("lab"),
    [folderPath, setFolderPath] = useState("/home/pi"),
    [clipboard, setClipboard] = useState(""),
    [updated, setUpdated] = useState(step === 0 && saved ? saved.updated : false),
    [unpaired, setUnpaired] = useState<string[]>(
      step === 0 && saved ? saved.unpaired : [],
    );
  const content = useRef<HTMLElement>(null);
  const [rename, setRename] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>(step === 0 && saved ? saved.collapsed : []);
  const [folderProjectName, setFolderProjectName] = useState<string | undefined>(step === 8 ? "apex-deck" : undefined);
  const [folderServerChoice, setFolderServerChoice] = useState(false);
  const [connectionReturn, setConnectionReturn] = useState("list");
  const isOffline = (host: Machine) => !!host.offline || (scene === 19 && host.id === "mac") || unpaired.includes(host.id);
  const activity = (thread: Thread) => !thread.started ? "Unsent draft" : !thread.at ? "now" : (thread.at || 0) < 60 ? `${thread.at || 0}m ago` : (thread.at || 0) < 1440 ? `${Math.floor((thread.at || 0)/60)}h ago` : `${Math.floor((thread.at || 0)/1440)}d ago`;
  const dialog = useRef<HTMLDivElement>(null),
    hold = useRef<ReturnType<typeof setTimeout> | null>(null),
    held = useRef(false),
    swipe = useRef(0);
  useEffect(() => {
    saved = {
      threads,
      active,
      view: view === "chat" ? "chat" : "list",
      sheet: "",
      projects,
      scene,
      connections,
      unpaired,
      updated,
      collapsed,
    };
  }, [threads, active, view, projects, scene, connections, unpaired, updated, collapsed]);
  const t = threads.find((t) => t.id === active)!;
  const p = projects.find((p) => p.id === t.project)!;
  const h = machines.find((h) => h.id === p.host)!;
  const offline =
    !!h.offline || (scene === 19 && h.id === "mac") || unpaired.includes(h.id);
  useEffect(() => {
    onHost(h.name, p.path, t.bots, offline, scene === 19 && h.id === "mac");
  }, [h.name, p.path, t.bots, offline, scene]);
  useEffect(() => {
    if (!sheet) return;
    const previous = document.activeElement as HTMLElement;
    dialog.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheet("");
      if (e.key === "Tab") {
        const nodes = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input,textarea",
          ) || [],
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, [sheet]);
  useEffect(
    () => () => {
      if (hold.current) clearTimeout(hold.current);
    },
    [],
  );
  const patch = (changes: Partial<Thread>) =>
    setThreads((ts) =>
      ts.map((x) => (x.id === active ? { ...x, ...changes } : x)),
    );
  const openSheet = (s: string) => {
    setQuery("");
    setError("");
    setSheet(s);
  };
  const open = (id: string) => {
    setActive(id);
    setView("chat");
    setSheet("");
    setThreads(ts => ts.map(x => x.id === id ? {...x, unread: false} : x));
  };
  const newThread = (project = t.project, fork = false) => {
    const host = machines.find(h => h.id === projects.find(p => p.id === project)!.host)!;
    if (isOffline(host)) { setNotice(`${host.name} is ${scene === 19 && host.id === "mac" ? "asleep" : "offline"}. Choose an available machine.`); return; }
    const empty = !fork && threads.find(x => x.project === project && !x.started && !x.fork && !x.text.trim() && !x.files.length && !x.archived);
    if (empty) { open(empty.id); return; }
    const id = `draft-${Date.now()}`;
    const draft: Thread = {
      id,
      project,
      title: fork ? `${t.title} (fork)` : "New thread",
      text: "",
      files: [],
      messages: fork ? [...t.messages] : [],
      bots: fork ? [...t.bots] : ["Claude"],
      started: false,
      fork: fork ? `${t.title} · ${h.name}` : undefined,
      forkApprovalHost: fork && t.approval ? h.name : undefined,
    };
    setThreads((ts) => [...ts, draft]);
    setActive(id);
    setView("chat");
    setSheet("");

  };
  const choose = (id: string) => {
    const target = projects.find(p => p.id === id);
    if (!target) return;
    const targetHost = machines.find(h => h.id === target.host)!;
    if (isOffline(targetHost)) {
      setNotice(`${targetHost.name} is ${scene === 19 && targetHost.id === "mac" ? "asleep" : "offline"}. Choose an available machine.`);
      return;
    }
    if (id === t.project) {
      setSheet("");
      return;
    }
    if (t.started) {
      setPending(id);
      openSheet("switch");
    } else {
      patch({ project: id });
      setSheet("");
    }
  };
  const project = projects.find((x) => x.id === selectedProject)!;
  const projectMachine = machines.find((x) => x.id === project.host)!;
  const machineIcon = (host: Machine) =>
    host.id === "mac" ? (
      <Laptop size={17} />
    ) : (
      <Globe size={17} style={{ color: host.color }} />
    );
  const action = (label: string, fn: () => void, cls = "wide") => (
    <button className={cls} onClick={fn}>
      {label}
    </button>
  );
  const longPress = (fn: () => void) => ({
    onPointerDown: () => {
      held.current = false;
      hold.current = setTimeout(() => {
        held.current = true;
        fn();
      }, 500);
    },
    onPointerUp: () => {
      if (hold.current) clearTimeout(hold.current);
    },
    onPointerCancel: () => {
      if (hold.current) clearTimeout(hold.current);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      fn();
    },
  });
  const threadRow = (thread: Thread) => {
    const proj = projects.find((x) => x.id === thread.project)!,
      host = machines.find((x) => x.id === proj.host)!;
    return (
      <div
        className="mf-list-row"
        key={thread.id}
        onTouchStart={(e) => {
          swipe.current = e.touches[0].clientX;
        }}
        onTouchEnd={(e) => {
          const distance = e.changedTouches[0].clientX - swipe.current;
          if (Math.abs(distance) > 75) {
            held.current = true;
            setThreads((ts) =>
              ts.map((x) =>
                x.id === thread.id
                  ? {
                      ...x,
                      ...(distance > 0
                        ? { pinned: !x.pinned }
                        : { archived: true }),
                    }
                  : x,
              ),
            );
          }
        }}
      >
        <button
          className="mf-item"
          {...longPress(() => {
            setActive(thread.id);
            openSheet("thread-card");
          })}
          onClick={() => {
            if (!held.current) open(thread.id);
          }}
        >
          <strong>
            <i aria-hidden="true" title={isOffline(host) ? "Machine offline" : thread.approval && !thread.decision ? "Waiting for approval" : "Idle"} className={`mf-dot mf-thread-status ${isOffline(host) ? "mf-off" : thread.approval && !thread.decision ? "mf-waiting" : ""}`} />
            {!thread.started ? "Draft · " : ""}
            {thread.title}
          </strong>
          <small>
            {proj.name} · {host.name}
          </small>
          <span className="mf-meta">
            {isOffline(host) ? "Offline · " : thread.approval && !thread.decision ? "Waiting for approval · " : ""}{thread.unread ? "Unread · " : ""}{thread.bots.join(" · ")} · {activity(thread)}
          </span>
        </button>
        <button
          className="icon-button"
          aria-label={`Actions for ${thread.title}`}
          onClick={() => {
            setActive(thread.id);
            openSheet("thread-menu");
          }}
        >
          <MoreHorizontal size={18} />
        </button>
        {machineIcon(host)}
      </div>
    );
  };
  const browseFolder = (host: string, serverChoice = false, projectName?: string) => {
    const machine = machines.find(h => h.id === host)!;
    if (isOffline(machine)) { setNotice(`${machine.name} is ${scene === 19 && host === "mac" ? "asleep" : "offline"}. Choose an available machine.`); return; }
    setFolderProjectName(projectName);
    setFolderServerChoice(serverChoice);
    setFolderHost(host);
    setFolderPath(machines.find((x) => x.id === host)!.home);
    openSheet("folder");
  };
  const saveFolder = () => {
    if (isOffline(machines.find(h => h.id === folderHost)!)) return;
    const name = folderProjectName || folderPath.split("/").filter(Boolean).pop() || "apex-deck";
    const id = `folder-${Date.now()}`;
    const existing = projects.find(
      (x) => x.host === folderHost && x.path === folderPath && (!folderProjectName || x.name === folderProjectName),
    );
    if (existing) {
      choose(existing.id);
      return;
    }
    setProjects((ps) => [
      ...ps,
      { id, name, host: folderHost, path: folderPath },
    ]);
    if (t.started) {
      setPending(id);
      setSheet("switch");
    } else {
      patch({ project: id });
      setSheet("");
    }
  };
  const editConnection = (host: string) => {
    setConnectionReturn(view);
    setEditHost(host);
    setAddress(connections[host].address);
    setDaemon(connections[host].daemon);
    setError("");
    setSheet("");
    setView("connection");
  };
  const send = () => {
    if (offline || (!t.text.trim() && !t.files.length)) return;
    const canonical = !t.started && !t.fork && p.id === "deckHZ" && /load test/i.test(t.text) && threads.find(x => x.id === "t4" && x.hidden);
    const updatedThread: Thread = {
      ...t,
      id: canonical ? canonical.id : t.id,
      hidden: false,
      started: true,
      approval: !!t.approval || (h.id !== "mac" && /load test/i.test(t.text)),
      at: 0,
      title: canonical ? canonical.title : t.started || t.fork ? t.title : titleOf(t.text),
      messages: [
        ...t.messages,
        `You: ${t.text}${t.files.length ? ` [${t.files.join(", ")}]` : ""}`,
        `${t.bots[0]}: Working in ${h.name}’s copy of ${p.name}.`,
      ],
      text: "",
      files: [],
    };
    setThreads(ts => canonical ? ts.filter(x => x.id !== t.id).map(x => x.id === canonical.id ? updatedThread : x) : ts.map(x => x.id === t.id ? updatedThread : x));
    if (canonical) setActive(canonical.id);
    setNotice(`Message sent to ${h.name} · simulated`);
  };
  useEffect(() => {
    if (view === "chat") content.current?.scrollTo({top: content.current.scrollHeight});
  }, [active, view, t.messages.length, t.decision]);
  return (
    <>
      <header className="phone-header" inert={!!sheet}>
        {view === "list" ? (
          <span className="brand-mini">✳ apex deck</span>
        ) : (
          <button className="back" onClick={() => setView("list")}>
            <ArrowLeft size={20} />
            Threads
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Settings and Machines"
          onClick={() => setView("settings")}
        >
          <Settings size={20} />
        </button>
      </header>
      {view === "chat" && <div className="mf-chat-header" inert={!!sheet}>
            <div className="chat-context">
              <span className="mf-context-project" title={p.name}><span className="mf-name-full">{p.name}</span><span className="mf-name-short">{p.name.length > 14 ? `${p.name.slice(0,4)}…${p.name.slice(-4)}` : p.name}</span></span><span>{" · "}{h.name}</span>
            </div>
            <div className="chat-heading">
              <h2>{t.title}</h2>
              <button
                className="icon-button"
                aria-label="Thread actions"
                onClick={() => openSheet("thread-menu")}
              >
                <MoreHorizontal size={20} />
              </button>
            </div>
            <p className="mf-path mf-header-path">{p.path}</p>
      </div>}
      <main
        ref={content}
        className={`phone-content mf-content ${view === "chat" ? "chat-content" : ""}`}
        inert={!!sheet}
      >
        {view === "list" && (
          <>
            <div className="title-row">
              <h2>Threads</h2>
              <button
                className="icon-button"
                aria-label="New thread"
                onClick={() => newThread()}
              >
                <Plus size={22} />
              </button>
            </div>
            <p className="muted mf-intro">Across all your machines</p>
            <div className="section-label">PINNED</div>
            <div className="group">
              {threads.filter((t) => t.pinned && listed(t)).map(threadRow)}
            </div>
            <div className="section-label">PROJECTS</div>
            <div className="group">
              {projects
                .filter((p) => p.id !== "none" && !p.hidden)
                .sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned))
                .map((proj) => {
                  const host = machines.find((x) => x.id === proj.host)!;
                  return (
                    <div className="mf-project-group" key={proj.id}><div className="mf-list-row">
                      <button
                        className="mf-item"
                        aria-expanded={!collapsed.includes(proj.id)}
                        {...longPress(() => {
                          setSelectedProject(proj.id);
                          openSheet("project-card");
                        })}
                        onClick={() => {
                          if (held.current) return;
                          setCollapsed(ids => ids.includes(proj.id) ? ids.filter(id => id !== proj.id) : [...ids,proj.id]);
                        }}
                      >
                        <span className="mf-project-name">
                          <ChevronRight size={14} style={{transform: collapsed.includes(proj.id) ? undefined : "rotate(90deg)"}}/>
                          <Folder size={17} />
                          {proj.name}
                          {host.id !== "mac" && machineIcon(host)}
                        </span>
                        <small>
                          <i
                            className={`mf-dot ${isOffline(host) ? "mf-off" : ""}`}
                          />
                          {host.name}
                        </small>
                      </button>
                      <button className="icon-button" aria-label={`New thread in ${proj.name} on ${host.name}`} onClick={() => newThread(proj.id)}><Plus size={18}/></button>
                      <button
                        className="icon-button"
                        aria-label={`Project actions ${proj.name} ${host.name}`}
                        onClick={() => {
                          setSelectedProject(proj.id);
                          openSheet("project-menu");
                        }}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    </div>{!collapsed.includes(proj.id) && <div className="mf-nested">{threads.filter(t => t.project === proj.id && listed(t) && !t.pinned).length ? threads.filter(t => t.project === proj.id && listed(t) && !t.pinned).map(threadRow) : <p className="scope">No threads</p>}</div>}</div>
                  );
                })}
            </div>
            <div className="section-label">RECENTS</div>
            <div className="group">
              {threads.filter(listed).sort((a,b) => (a.at || 0)-(b.at || 0)).slice(0,4).map(threadRow)}
            </div>
            <p className="footnote">
              Long-press for details. Swipe right to pin; left to archive.
            </p>
          </>
        )}
        {view === "chat" && (
          <>
            <button
              className="participants"
              onClick={() => openSheet("participants")}
            >
              <span className={`avatar mf-bot-avatar mf-bot-${t.bots[0].toLowerCase()}`} style={{"--bot-color":botColors[t.bots[0]]} as React.CSSProperties}>{t.bots[0].slice(0,1)}</span>
              <span>
                {t.bots.join(" · ")}
                <small> · shared group thread</small>
                <br />
                <small>Everyone sees messages · reply when mentioned</small>
              </span>
              <ChevronRight size={16} />
            </button>
            {t.fork && (
              <p className="mf-banner">
                Forked from {t.fork}. History retained{t.started ? "." : "; nothing runs until you send."}
                {t.forkApprovalHost && ` The approval stays with the original thread on ${t.forkApprovalHost}.`}
              </p>
            )}
            {offline && (
              <div className="mf-banner" role="status">
                <strong>
                  {h.name}{" "}
                  {scene === 19 && h.id === "mac" ? "is asleep" : "is offline"}
                </strong>
                <p>{scene === 19 && h.id === "mac" ? "Paused until Tyler’s MacBook wakes" : `Paused while ${h.name} reconnects`}. Nothing is queued.</p>
                {action("Retry now", () =>
                  setNotice(
                    `${h.name} is still ${scene === 19 && h.id === "mac" ? "asleep" : "offline"} · simulated retry`,
                  ),
                )}
                {scene === 19 && h.id === "mac" &&
                  action("Open Hetzner-EU thread", () => open("t4"))}
              </div>
            )}
            {!t.messages.length && (
              <div className="mf-empty">
                <MessageSquare size={30} />
                <h3>What are we working on?</h3>
                <p>
                  {p.name} · {h.name}
                  <br />
                  {p.path}
                </p>
              </div>
            )}
            {t.messages.map((message, i) => (
              <section
                className={`message ${message.startsWith("You:") ? "human" : ""}`}
                key={i}
              >
                <div className="message-by">
                  {message.split(":")[0]}
                </div>
                <p>{message.slice(message.indexOf(":") + 1)}</p>
              </section>
            ))}
            {t.started && t.approval && t.decision && <p className="mf-approval-result" role="status">{t.decision === "Denied" ? `Denied. Nothing ran on ${h.name}.` : `${t.decision}. The load test finished on ${h.name}.`}</p>}
            {t.started && t.approval && !t.decision && (
              <section
                className="approval-card"
                aria-label="Load test approval"
              >
                <div className="eyebrow amber">APPROVAL REQUIRED</div>
                <h3>Run the load test</h3>
                <p>
                  Runs on {h.name}, in {p.path}{h.id !== "mac" ? " (server copy)" : ""}
                </p>
                <pre className="diff">npm run bench -- --pdf</pre>
                <p className="scope">
                  Claude · this thread · this exact command
                </p>
                {t.decision ? (
                  <p role="status">{t.decision === "Denied" ? `Denied. Nothing ran on ${h.name}.` : `${t.decision}. The load test finished on ${h.name}.`}</p>
                ) : (
                  <>
                    <div className="actions">
                      {action(
                        "Allow once",
                        () => patch({decision: "Allowed once"}),
                        "primary",
                      )}
                      {action("Deny", () => patch({decision: "Denied"}), "danger")}
                    </div>
                    {action(
                      "Always allow",
                      () => openSheet("always"),
                      "wide plain",
                    )}
                  </>
                )}
              </section>
            )}
          </>
        )}
        {view === "settings" && (
          <>
            <h2>Settings</h2>
            <div className="group">
              {action("Machines", () => setView("machines"))}
            </div>
            <p className="footnote">
              Tyler’s iPhone · direct connections to each machine
            </p>
          </>
        )}
        {view === "machines" && (
          <>
            <h2>Machines</h2>
            <p className="intro">
              Each machine connects directly to this phone. Servers stay
              reachable when your MacBook sleeps.
            </p>
            {machines
              .filter((h) => !unpaired.includes(h.id))
              .map((host) => (
                <div className="group padded" key={host.id}>
                  <h3>
                    {machineIcon(host)} {host.name}
                  </h3>
                  <p className="muted">
                    {host.offline
                      ? "Offline · last reached 7:02 AM"
                      : scene === 19 && host.id === "mac"
                        ? "Asleep"
                        : "Connected"}
                    <br />
                    Paired with this phone
                  </p>
                  <p className="mf-path">{connections[host.id].address}</p>
                  {host.id !== "mac" &&
                    action(`Edit connection ${host.name}`, () =>
                      editConnection(host.id),
                    )}
                  {action(
                    `Unpair ${host.name}`,
                    () => {
                      setEditHost(host.id);
                      openSheet("unpair");
                    },
                    "wide plain",
                  )}
                </div>
              ))}
            {action("Add a machine…", () => openSheet("add"), "primary wide")}
          </>
        )}
        {view === "connection" && (
          <>
            <h2>Edit connection</h2>
            <p className="intro">
              {machines.find((x) => x.id === editHost)!.name} stays the same
              machine. Save checks its identity before using a new address.
            </p>
            <div className="form">
              <label>
                SSH destination
                <input
                  aria-label="SSH destination"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </label>
              <label>
                Port
                <input
                  aria-label="SSH port"
                  defaultValue="22"
                  inputMode="numeric"
                />
              </label>
              <label>
                Daemon command
                <input
                  aria-label="Daemon command"
                  value={daemon}
                  onChange={(e) => setDaemon(e.target.value)}
                />
              </label>
            </div>
            <p className="scope">
              Saved identity: apex-{editHost}-host-id · simulated fingerprint
            </p>
            {error && (
              <p className="removed" role="alert">
                {error}
              </p>
            )}
            {action(
              "Save connection",
              () => {
                const map: Record<string, string> = {
                  "l1quid8@apex-terminal": "at",
                  "l1quid8@203.0.113.24": "at",
                  "root@hetzner-eu": "hz",
                  "pi@lab-pi.local": "lab",
                  "deploy@staging.internal": "st",
                };
                if (!daemon.trim()) {
                  setError("Enter the daemon command.");
                  return;
                }
                if (map[address.trim()] !== editHost) {
                  setError(
                    "This address reports a different machine or an unknown identity. Add it as a new machine; existing threads stay here.",
                  );
                  return;
                }
                setConnections((current) => ({
                  ...current,
                  [editHost]: {
                    address: address.trim(),
                    daemon: daemon.trim(),
                  },
                }));
                setNotice(
                  "Connection saved · same machine identity verified (simulated)",
                );
                setView(connectionReturn);
              },
              "primary wide",
            )}
            {action("Cancel", () => setView(connectionReturn), "plain wide")}
          </>
        )}
      </main>
      {view === "chat" && (
        <div className="composer mf-composer" inert={!!sheet}>
          <div className="mf-workbar">
            <button
              aria-label={`Project ${p.name}`}
              onClick={() => openSheet("project")}
            >
              <Folder size={16} />
              <span>{p.name}</span>
            </button>
            <button aria-label="Files" onClick={() => openSheet("files")}>
              <Files size={17} />
              <span>Files</span>
            </button>
            <button aria-label="Tools" onClick={() => openSheet("tools")}>
              <Plug size={17} />
              <span>Tools</span>
            </button>
            <button
              aria-label={`Work in ${h.name}`}
              onClick={() => openSheet("work")}
            >
              {t.started ? <Lock size={15} /> : machineIcon(h)}
              <span>{h.name}</span>
            </button>
          </div>
          <div className="mf-files">
            {t.files.map((file) => (
              <div className="attached-chip" key={file}>
                {file}
                <button
                  aria-label={`Remove ${file}`}
                  onClick={() =>
                    patch({ files: t.files.filter((x) => x !== file) })
                  }
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
          <div className="compose-input">
            <textarea
              aria-label="Message this thread"
              rows={2}
              value={t.text}
              onChange={(e) => patch({ text: e.target.value })}
              placeholder="Message the group…"
            />
            <button
              className="send"
              aria-label="Send to machine"
              disabled={offline || (!t.text.trim() && !t.files.length)}
              onClick={send}
            >
              <ArrowUp size={21} />
            </button>
          </div>
          <p className="mf-send-caption">
            {offline
              ? scene === 19 && h.id === "mac" ? "Paused until Tyler’s MacBook wakes" : `Paused while ${h.name} reconnects`
              : `${h.name} · ${p.path}`}
          </p>
        </div>
      )}
      <nav
        className="bottom-tabs"
        aria-label="Workspace sections"
        inert={!!sheet}
      >
        {[
          [Command, "Agents", "agents"],
          [Terminal, "Code", "code"],
          [MessageSquare, "Threads", "threads"],
          [Folder, "Library", "library"],
        ].map(([Icon, label, route]) => {
          const I = Icon as typeof Folder;
          return (
            <button
              key={route as string}
              className={route === "threads" ? "active" : ""}
              onClick={() =>
                route === "threads"
                  ? setView("list")
                  : onNavigate(route as string)
              }
            >
              <I size={21} />
              {label as string}
            </button>
          );
        })}
      </nav>
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {sheet && (
        <div className="sheet-overlay" onClick={() => setSheet("")}>
          <div
            className="sheet mf-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mf-sheet-title"
            ref={dialog}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="title-row">
              <h3 id="mf-sheet-title">
                {
                  (
                    {
                      project: "Project",
                      work: "Work in",
                      folder: "Choose a folder",
                      files: "Files",
                      tools: "Tools",
                      "project-card": projectMachine.name,
                      "project-menu": `Project actions · ${project.name}`,
                      "thread-card": "Thread details",
                      "thread-menu": "Thread actions",
                      copy: `Copy · ${t.title}`,
                      "rename-thread": `Rename · ${t.title}`,
                      "connect-tools": `Connect tools · ${h.name}`,
                      "copy-folder": "Copy a folder in…",
                      switch: "Work on another machine?",
                      always: "Always allow this command?",
                      participants: "Shared group",
                      add: "Add a machine",
                      unpair: "Unpair this machine?",
                      "edit-project": "Edit project",
                      "remove-project": "Remove project?",
                      archive: "Archive these threads?",
                      delete: "Delete this thread?",
                      browse: "Browse all",
                      pair: "Confirm machine identity",
                    } as Record<string, string>
                  )[sheet]
                }
              </h3>
              <button
                className="icon-button"
                aria-label="Close sheet"
                onClick={() => setSheet("")}
              >
                <X size={20} />
              </button>
            </div>
            {["project", "files", "tools"].includes(sheet) && (
              <input
                aria-label={`Search ${sheet}`}
                placeholder={`Search ${sheet === "project" ? "projects" : sheet}…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            {sheet === "project" && (
              <>
                {projects
                  .filter((proj) => proj.id !== "none" && !proj.hidden)
                  .filter((proj) =>
                    `${proj.name} ${proj.path} ${machines.find((h) => h.id === proj.host)!.name}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((proj) => {
                    const host = machines.find((h) => h.id === proj.host)!;
                    return (
                      <button
                        className="row"
                        key={proj.id}
                        disabled={isOffline(host)}
                        onClick={() => choose(proj.id)}
                      >
                        {machineIcon(host)}
                        <span className="row-copy">
                          <strong>{proj.name}</strong>
                          <small>
                            {host.name}{isOffline(host) ? " · Offline" : ""}
                            <br />
                            {proj.path}
                          </small>
                        </span>
                        {proj.id === p.id && <Check size={17} />}
                      </button>
                    );
                  })}
                {action("New server project", () => browseFolder(machines.find(host => host.id !== "mac" && !isOffline(host))?.id || "at", true))}
                {action("New project", () => browseFolder("mac"))}
                {action("Don’t work in a project", () => choose("none"))}
              </>
            )}
            {sheet === "work" && (
              <>
                {t.started && <p className="scope">This thread stays on {h.name}. Another machine starts a new thread or a fork there.</p>}
                {machines.map((host) => {
                  const copies = projects.filter(
                    (proj) => proj.host === host.id && proj.name === p.name,
                  );
                  return (
                    <React.Fragment key={host.id}>
                      {(copies.length ? copies : [null]).map((proj, i) => (
                        <button
                          className="row"
                          key={proj?.id || i}
                          disabled={
                            host.offline ||
                            unpaired.includes(host.id) ||
                            (scene === 19 && host.id === "mac")
                          }
                          onClick={() =>
                            proj ? choose(proj.id) : browseFolder(host.id, false, p.name)
                          }
                        >
                          {machineIcon(host)}
                          <span className="row-copy">
                            <strong><i className={`mf-dot ${isOffline(host) ? "mf-off" : ""}`} />{host.name}</strong>
                            <small>
                              {host.offline
                                ? "Offline · last reached 7:02 AM"
                                : scene === 19 && host.id === "mac"
                                  ? "Asleep"
                                  : proj?.path ||
                                    "No copy yet · choose a folder"}
                            </small>
                          </span>
                          {proj?.id === p.id && <Check size={17} />}
                        </button>
                      ))}
                    </React.Fragment>
                  );
                })}
                <p className="scope">Each machine keeps its own copy of {p.name}. Edits stay on that machine until you push or pull them.</p>
                {action(
                  "Add a machine…",
                  () => openSheet("add"),
                  "primary wide",
                )}
              </>
            )}
            {sheet === "folder" && (
              <>
                <p>
                  Choose a folder on{" "}
                  {machines.find((h) => h.id === folderHost)!.name}.
                </p>
                {folderProjectName && <p>For {folderProjectName}.</p>}
                {folderServerChoice && <label className="mf-label">Server<select aria-label="Server" value={folderHost} onChange={e => {setFolderHost(e.target.value); setFolderPath(machines.find(h => h.id === e.target.value)!.home);}}>{machines.filter(h => h.id !== "mac").map(host => <option key={host.id} value={host.id} disabled={isOffline(host)}>{host.name}{isOffline(host) ? " · Offline" : ""}</option>)}</select></label>}
                {folderHost !== "mac" && <p className="scope">
                  This is {machines.find(h => h.id === folderHost)!.name}’s own copy{folderProjectName && projects.some(p => p.host === "mac" && p.name === folderProjectName) ? ", separate from your MacBook’s" : ""}. No project files are copied over.
                </p>}
                <label className="mf-label">
                  Folder path
                  <input
                    aria-label="Folder path"
                    value={folderPath}
                    onChange={(e) => setFolderPath(e.target.value)}
                  />
                </label>
                {action("Parent folder", () =>
                  setFolderPath(
                    folderPath.slice(0, folderPath.lastIndexOf("/")) || "/",
                  ),
                )}
                {(folderTree[folderHost][folderPath] || []).map((name) =>
                  action(`Open folder ${name}`, () =>
                    setFolderPath(`${folderPath}/${name}`),
                  ),
                )}
                {action("Use this folder", saveFolder, "primary wide")}
              </>
            )}
            {sheet === "files" && (
              <>
                <p className="scope">
                  Files attached from this phone are copied to {h.name} with
                  your message.
                </p>
                {files
                  .filter((f) => f.toLowerCase().includes(query.toLowerCase()))
                  .map((file) => <button key={file} className="row" onClick={() => patch({files: t.files.includes(file) ? t.files.filter(f => f !== file) : [...t.files,file]})}>
                    {file.endsWith(".png") ? <Image size={18}/> : <FileText size={18}/>}<span className="row-copy">{file}</span>{t.files.includes(file) && <Check size={18}/>}</button>)}
                {action("Copy a folder in…", () => openSheet("copy-folder"))}
                {action(
                  "Browse all",
                  () => openSheet("browse"),
                  "primary wide",
                )}
              </>
            )}
            {sheet === "browse" && (
              <>
                <p>Choose from your phone · simulated file picker.</p>
                {action("Photos", () => {
                  patch({ files: [...t.files, "iPhone-photo.jpg"] });
                  setSheet("");
                })}
                {action("Files", () => {
                  patch({ files: [...t.files, "iPhone-document.pdf"] });
                  setSheet("");
                })}
              </>
            )}
            {sheet === "tools" && (
              <>
                <p className="scope">
                  Available to {t.bots.join(", ")} on {h.name}
                </p>
                {tools
                  .filter(
                    ([, name, bot, on]) =>
                      t.bots.includes(bot) &&
                      (on === "all" ||
                        on === (h.id === "mac" ? "mac" : "server")) &&
                      name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map(([token, name, bot]) => <button key={`${bot}-${token}`} className="row" aria-label={`${name} · ${bot}`} disabled={name.includes("sign in")} onClick={() => { patch({text: `${t.text}${t.text && !t.text.endsWith(" ") ? " " : ""}!${token} `}); setSheet(""); }}>
                    <span className="mf-tool-icon" dangerouslySetInnerHTML={{__html:toolIcons[token]}}/><span className="row-copy"><strong>{name}</strong><small>!{token} · {bot}</small></span></button>)}
                {action("Connect tools", () => openSheet("connect-tools"))}
              </>
            )}
            {sheet === "connect-tools" && <><p>Tool settings for {t.bots.join(", ")} on {h.name}.</p>{action("Sign in to Figma", () => setNotice("Figma sign-in preview · simulated"))}{action("Sign in to Linear", () => setNotice("Linear sign-in preview · simulated"))}</>}
            {sheet === "copy-folder" && <><p>Choose a folder from this phone. It will be copied to {h.name} with your message.</p>{action("Choose folder · sample-assets", () => {patch({files: [...t.files,"sample-assets/"]}); setSheet("");})}</>}
            {sheet === "project-card" && (
              <>
                <h3>{project.name}</h3>
                <p className="mf-path">{project.path}</p>
                <p>
                  {threads.filter((t) => t.project === project.id && t.started && !t.archived && !t.hidden).length}{" "}
                  {threads.filter(t => t.project === project.id && t.started && !t.archived && !t.hidden).length === 1 ? "thread" : "threads"} ·{" "}
                  {isOffline(projectMachine)
                    ? scene === 19 && projectMachine.id === "mac" ? "Asleep · paused until Tyler’s MacBook wakes" : "Offline · last reached 7:02 AM"
                    : "Connected"}
                </p>
                <p>
                  Helper{" "}
                  {updated
                    ? "0.5.1"
                    : projectMachine.id === "at"
                      ? "0.5.0 · update available"
                      : "0.5.1"}
                </p>
              </>
            )}
            {["project-card", "project-menu"].includes(sheet) && (
              <>
                <p className="scope">{project.name} · {projectMachine.name}</p>
                {action(project.pinned ? "Unpin project" : "Pin project", () => {
                  setNotice(`${project.name} ${project.pinned ? "unpinned" : "pinned"}`);
                  setProjects(ps => ps.map(p => p.id === project.id ? {...p, pinned: !p.pinned} : p));
                  setSheet("");
                })}
                {action("Edit project", () => {
                  setRename(project.name);
                  openSheet("edit-project");
                })}
                {project.host !== "mac" &&
                  action("Edit connection…", () =>
                    editConnection(project.host),
                  )}
                {project.host === "at" && !updated && !isOffline(projectMachine) &&
                  action("Restart and update", () => {
                    setUpdated(true);
                    setNotice(
                      "Helper restarted and updated to 0.5.1 · simulated",
                    );
                    setSheet("");
                  })}
                {action("Archive threads", () => openSheet("archive"))}
                {action(
                  "Remove project…",
                  () => openSheet("remove-project"),
                  "danger wide",
                )}
              </>
            )}
            {sheet === "edit-project" && <><label className="mf-label">Project name<input aria-label="Project name" value={rename} onChange={e => setRename(e.target.value)}/></label>{action("Save project name", () => {if (!rename.trim()) return; setProjects(ps => ps.map(p => p.id === project.id ? {...p,name:rename.trim()} : p)); setSheet("");})}</>}
            {sheet === "archive" && (
              <>
                <p>
                  Archive all threads in {project.name} on {projectMachine.name}
                  ?
                </p>
                {action("Archive threads", () => {
                  setThreads((ts) =>
                    ts.map((t) =>
                      t.project === project.id ? { ...t, archived: true } : t,
                    ),
                  );
                  setSheet("");
                  setNotice("Threads archived");
                })}
              </>
            )}
            {sheet === "remove-project" && (
              <>
                <p>
                  Remove this project from the list? Its threads and files stay
                  on {projectMachine.name}.
                </p>
                {action(
                  "Remove from list",
                  () => {
                    setProjects((ps) =>
                      ps.map((x) =>
                        x.id === project.id ? { ...x, hidden: true } : x,
                      ),
                    );
                    setNotice(
                      "Project hidden from the list · threads retained",
                    );
                    setSheet("");
                  },
                  "danger wide",
                )}
              </>
            )}
            {["thread-card", "thread-menu"].includes(sheet) && (
              <>
                <h3>{t.title}</h3>
                <p>
                  {machineIcon(h)} {p.name} · {h.name}
                </p>
                <p className="mf-path">{p.path}</p>
                <p>{activity(t)} · {t.bots.join(" · ")}</p>
              </>
            )}
            {["thread-card", "thread-menu"].includes(sheet) && (<>{action("Rename", () => {setRename(t.title); openSheet("rename-thread");})}{action("Mark as unread", () => {patch({unread:true}); setSheet("");})}{action("Copy ›", () => openSheet("copy"))}
                {action(t.pinned ? "Unpin thread" : "Pin thread", () => {
                  patch({ pinned: !t.pinned });
                  setSheet("");
                })}
                {action("Project ›", () => openSheet("project"))}
                {action("Fork", () => newThread(t.project, true))}
                {action("Share as PDF", () => {
                  setNotice("PDF share preview · simulated");
                  setSheet("");
                })}
                {action("Export", () => {
                  setClipboard(t.messages.join("\n\n"));
                  setNotice("Export preview saved in memory");
                  setSheet("");
                })}
                {action("Archive", () => {
                  patch({ archived: true });
                  setView("list");
                  setSheet("");
                })}
                {action("Delete…", () => openSheet("delete"), "danger wide")}
              </>
            )}
            {sheet === "copy" && <>                {[
                  "Thread Markdown",
                  "Last reply",
                  "Folder path",
                  "Thread ID",
                ].map((label, i) =>
                  <button key={label} disabled={i === 1 && !t.messages.some(message => !message.startsWith("You:"))} className="wide" aria-label={i === 0 ? "Copy as Markdown" : i === 3 ? "Copy thread ID" : `Copy ${label.toLowerCase()}`} onClick={() => {
                    const value = [
                      `# ${t.title}\n\n${p.name} · ${h.name} · ${p.path}\n\n${t.messages.map(message => {const colon = message.indexOf(":"); return `**${message.slice(0,colon)}** · 7:11 AM\n\n${message.slice(colon+1).trim()}`;}).join("\n\n")}${t.approval ? `\n\n> Run the load test: \`npm run bench -- --pdf\` on ${h.name}` : ""}`,
                      t.messages.filter(message => !message.startsWith("You:")).at(-1)?.replace(/^[^:]+:\s*/, "") || "",
                      h.id === "mac" ? p.path : `${connections[h.id].address}:${p.path}`,
                      threadId(t),
                    ][i];
                    setClipboard(value);
                    setNotice(`Pretend clipboard: ${value}`);
                    setSheet("");
                  }}>{i === 0 ? "Copy as Markdown" : i === 3 ? "Copy thread ID" : `Copy ${label.toLowerCase()}`}{i >= 2 && <small className="mf-copy-preview">{i === 2 ? h.id === "mac" ? p.path : `${connections[h.id].address}:${p.path}` : threadId(t)}</small>}</button>,
                )}
</>}
            {sheet === "rename-thread" && <><label className="mf-label">Thread title<input aria-label="Thread title" value={rename} onChange={e => setRename(e.target.value)}/></label>{action("Save thread title", () => {if (!rename.trim()) return; patch({title:rename.trim()}); setSheet("");})}</>}
            {sheet === "delete" && (
              <>
                <p>Delete {t.title}? This removes the simulated thread.</p>
                {action(
                  "Delete thread",
                  () => {
                    const remaining = threads.filter((x) => x.id !== active);
                    if (remaining.length) {
                      setThreads(remaining);
                      setActive(remaining[0].id);
                    } else {
                      const blank = {
                        ...t,
                        id: "empty-draft",
                        title: "New thread",
                        messages: [],
                        text: "",
                        files: [],
                        started: false,
                        approval: false,
                      };
                      setThreads([blank]);
                      setActive(blank.id);
                    }
                    setView("list");
                    setSheet("");
                  },
                  "danger wide",
                )}
              </>
            )}
            {sheet === "switch" && (
              <>
                <p>
                  This thread stays on {h.name}. Work in{" "}
                  {projects.find((x) => x.id === pending)?.name} on{" "}
                  {
                    machines.find(
                      (h) =>
                        h.id === projects.find((p) => p.id === pending)?.host,
                    )?.name
                  }{" "}
                  in a new thread or a fork.
                </p>
                <p className="scope">
                  The original conversation keeps running on {h.name}.
                </p>
                {action("New thread", () => newThread(pending), "primary wide")}
                {action("Fork this thread", () => newThread(pending, true))}
                {action("Cancel", () => setSheet(""), "plain wide")}
              </>
            )}
            {sheet === "always" && (
              <>
                <p>
                  Always allow Claude to run <code>npm run bench -- --pdf</code>{" "}
                  in this thread on {h.name}, in {p.path}.
                </p>
                <p className="scope">
                  Other commands, threads and machines still require approval.
                </p>
                {action(
                  "Confirm always allow",
                  () => {
                    patch({decision: "Always allowed for this command"});
                    setSheet("");
                  },
                  "primary wide",
                )}
              </>
            )}
            {sheet === "participants" && (
              <>
                <p>
                  Everyone sees the same conversation. Reply when mentioned.
                </p>
                {t.bots.map((bot) =>
                  action(`Mention ${bot}`, () => {
                    patch({ text: `${t.text}@${bot.toLowerCase()} ` });
                    setSheet("");
                  }),
                )}
              </>
            )}
            {sheet === "add" && (
              <>
                <p>{unpaired.some(id => id !== "mac") ? "Pair each server with this phone. Your MacBook shared these saved addresses." : unpaired.includes("mac") ? "Pair your MacBook again using QR or Nearby." : "All saved machines are already paired with this phone. Add another machine using QR, SSH or Nearby."} Already paired machines appear in Settings → Machines.</p>
                {machines
                  .filter((h) => h.id !== "mac" && unpaired.includes(h.id))
                  .map((host) =>
                    action(
                      `${host.name} · ${connections[host.id].address}`,
                      () => {
                        setEditHost(host.id);
                        setAddress(connections[host.id].address);
                        openSheet("pair");
                      },
                    ),
                  )}
                {action("Scan QR", () => onNavigate("qr"))}
                {action("Connect with SSH", () => onNavigate("ssh"))}
                {action("Nearby machines", () => onNavigate("nearby"))}
              </>
            )}
            {sheet === "pair" && (
              <>
                <p>{machines.find((h) => h.id === editHost)!.name}</p>
                <label className="mf-label">
                  SSH destination
                  <input
                    aria-label="Pair SSH destination"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </label>
                <p className="fingerprint">SHA256:demo-{editHost}-iPhone-key</p>
                <p className="scope">
                  Compare this simulated fingerprint with the machine before
                  pairing.
                </p>
                {action(
                  "Fingerprints match · pair phone",
                  () => {
                    setUnpaired((ids) => ids.filter((id) => id !== editHost));
                    setNotice(
                      `${machines.find((h) => h.id === editHost)!.name} paired with this phone · simulated`,
                    );
                    setSheet("");
                    setView("machines");
                  },
                  "primary wide",
                )}
              </>
            )}
            {sheet === "unpair" && (
              <>
                <p>
                  Remove this phone’s access to{" "}
                  {machines.find((h) => h.id === editHost)!.name}? Work stays on
                  the machine.
                </p>
                {action(
                  "Unpair this phone",
                  () => {
                    setUnpaired((ids) => [...ids, editHost]);
                    setSheet("");
                    setNotice("This phone unpaired · simulated");
                  },
                  "danger wide",
                )}
              </>
            )}
          </div>
        </div>
      )}
      <span hidden data-pretend-clipboard={clipboard} />
    </>
  );
}
