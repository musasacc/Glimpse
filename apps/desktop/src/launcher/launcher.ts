// Launcher page (sandboxed renderer). Talks to the main process only through window.glimpse (preload.ts).
import type { LauncherApi, RecentEntry } from "../api.js";

declare global {
  interface Window {
    glimpse: LauncherApi;
  }
}

const api = window.glimpse;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>("recent-list");
const empty = $<HTMLParagraphElement>("recent-empty");

/** Calls that open dialogs or windows: ignore repeated clicks while one is running. */
let busy = false;
async function run(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  document.body.style.cursor = "progress";
  try {
    await task();
  } catch (err) {
    console.error(err); // the main process already showed a dialog for anything the user should know about
  } finally {
    busy = false;
    document.body.style.cursor = "";
  }
  await render();
}

async function render(): Promise<void> {
  const items = await api.recent();
  list.replaceChildren(...items.map(row));
  empty.hidden = items.length > 0;
}

function row(p: RecentEntry): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `recent-row${p.exists ? "" : " missing"}`;

  const open = document.createElement("button");
  open.type = "button";
  open.className = "recent-item";
  open.title = p.exists ? `Open ${p.path}` : `${p.path} was moved or deleted. Click to locate it or remove it from the list`;
  const name = document.createElement("span");
  name.className = "recent-name";
  name.textContent = p.name;
  const badge = document.createElement("span");
  if (!p.exists) {
    badge.className = "badge missing";
    badge.textContent = "Missing";
  } else if (p.open) {
    badge.className = "badge open";
    badge.textContent = "Open";
  }
  const path = document.createElement("span");
  path.className = "recent-path";
  // rtl keeps the end of long paths visible; the LRM marks stop punctuation from jumping to the other side.
  path.textContent = `\u200e${p.path}\u200e`;
  open.append(name, badge, path);
  open.addEventListener("click", () => {
    // A missing folder: the main process offers to locate it or remove it from the list.
    void run(() => api.openRecent(p.path));
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.title = "Remove from recent projects";
  remove.setAttribute("aria-label", `Remove ${p.name} from recent projects`);
  remove.textContent = "×";
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    void run(() => api.removeRecent(p.path));
  });

  li.append(open, remove);
  return li;
}

async function init(): Promise<void> {
  const info = await api.info();
  const mod = info.platform === "darwin" ? "⌘" : "Ctrl+";
  for (const kbd of document.querySelectorAll<HTMLElement>("kbd[data-shortcut]")) {
    kbd.textContent = `${mod}${info.platform === "darwin" ? kbd.dataset.shortcut!.replace("Shift+", "⇧") : kbd.dataset.shortcut}`;
  }
  $("version").textContent = `Glimpse ${info.version}`;
  document.documentElement.dataset.platform = info.platform;
  $("open-folder").addEventListener("click", () => void run(() => api.openFolder()));
  $("new-project").addEventListener("click", () => void run(() => api.newProject()));
  api.onRecentChanged(() => void render());
  await render();
}

void init();
