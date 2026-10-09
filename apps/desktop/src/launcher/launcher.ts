// Home window page (sandboxed renderer). Talks to the main process only through window.glimpse (preload.ts).
// Looks and words follow the editor's Home and AI settings (packages/editor/src/Home.tsx, AiSettings.tsx).
import type { AiEngine, AiInfo, AiKeyProvider, AiProvider, BuildTarget, LauncherApi, RecentEntry } from "../api.js";

declare global {
  interface Window {
    glimpse: LauncherApi;
  }
}

const api = window.glimpse;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Icons (the editor's stroke set, 24×24, currentColor) ────────────────────

const PATHS = {
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M6.5 6h.01M9 6h.01"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
} as const;

function icon(name: keyof typeof PATHS, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = PATHS[name];
  return svg;
}

const TARGETS: { id: BuildTarget; label: string; icon: keyof typeof PATHS }[] = [
  { id: "html", label: "Website", icon: "layout" },
  { id: "react", label: "React app", icon: "code" },
  { id: "tui", label: "Terminal app", icon: "terminal" },
  { id: "native", label: "Desktop app", icon: "window" },
];

const IDEAS: { label: string; icon: keyof typeof PATHS; target: BuildTarget; text: string }[] = [
  { label: "Landing page", icon: "layout", target: "html", text: "A landing page for a coffee brand: hero with headline and call-to-action, three feature cards, testimonials and a footer." },
  { label: "Dashboard", icon: "chart", target: "html", text: "An analytics dashboard with a sidebar, four KPI tiles, a line chart and a table of recent orders." },
  { label: "Login form", icon: "lock", target: "html", text: "A clean sign-in page with email and password fields, a 'remember me' checkbox, a primary button and a link to sign up." },
  { label: "Terminal app", icon: "terminal", target: "tui", text: "A terminal todo app with a list on the left, details on the right and a status bar with keyboard shortcuts." },
];

function greeting(hour = new Date().getHours()): string {
  const part = hour < 5 ? "Up late" : hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  return `${part}, what are we building?`;
}

// ── Recent projects ─────────────────────────────────────────────────────────

const list = $<HTMLUListElement>("recent-list");
const empty = $<HTMLParagraphElement>("recent-empty");

/** Calls that open dialogs or windows: ignore repeated clicks while one is running. */
let busy = false;
async function run(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    await task();
  } catch (err) {
    console.error(err); // the main process already showed a dialog for anything the user should know about
  } finally {
    setBusy(false);
  }
  await renderRecent();
}

function setBusy(on: boolean): void {
  busy = on;
  document.body.style.cursor = on ? "progress" : "";
  updateSend();
}

async function renderRecent(): Promise<void> {
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
  path.textContent = `‎${p.path}‎`;
  open.append(name, badge, path);
  // A missing folder: the main process offers to locate it or remove it from the list.
  open.addEventListener("click", () => void run(() => api.openRecent(p.path)));

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

// ── Composer ────────────────────────────────────────────────────────────────

const prompt = $<HTMLTextAreaElement>("prompt");
const sendBtn = $<HTMLButtonElement>("send");
const notice = $<HTMLParagraphElement>("notice");
const targetBtn = $<HTMLButtonElement>("target-btn");
const targetMenu = $<HTMLDivElement>("target-menu");
let target: BuildTarget = "html";

function updateSend(): void {
  sendBtn.disabled = busy || !prompt.value.trim();
}

function say(text: string, kind: "error" | "info" = "error"): void {
  notice.textContent = text;
  notice.hidden = !text;
  notice.classList.toggle("info", kind === "info");
}

function renderTarget(): void {
  const t = TARGETS.find((x) => x.id === target)!;
  targetBtn.replaceChildren(icon(t.icon), document.createTextNode(` ${t.label} `), icon("chevron", 14));
  targetBtn.setAttribute("aria-label", `What to build: ${t.label}`);
  targetMenu.replaceChildren(
    ...TARGETS.map((x) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(x.id === target));
      b.dataset.target = x.id;
      if (x.id === target) b.className = "active";
      b.append(icon(x.icon), document.createTextNode(` ${x.label}`));
      b.addEventListener("click", () => {
        target = x.id;
        renderTarget();
        setMenu(false);
        prompt.focus();
      });
      return b;
    }),
  );
}

function setMenu(open: boolean): void {
  targetMenu.hidden = !open;
  targetBtn.setAttribute("aria-expanded", String(open));
  if (open) targetMenu.querySelector<HTMLElement>(".active")?.focus();
}

async function renderFolder(): Promise<void> {
  const f = await api.folder();
  $("folder-name").textContent = f ? f.name : "No folder";
  $("folder-path").textContent = f ? f.path : "";
  $("folder-chip").title = f ? `Builds in ${f.path}. Click to choose another folder` : "Choose the folder to build in (optional)";
  $("folder-clear").hidden = !f;
}

async function send(): Promise<void> {
  const text = prompt.value.trim();
  if (!text || busy) return;
  // Busy before anything is awaited (the AI info can take seconds while the shell environment loads): a second
  // Enter or click meanwhile must not send the request twice.
  setBusy(true);
  say("");
  const info = await api.aiInfo().catch(() => null);
  renderAi(info);
  // Nothing can run it yet: set the AI up first, and the request goes out once that's saved.
  if (info && info.engine === "none") {
    setBusy(false);
    openAiPanel(() => void send());
    return;
  }
  try {
    const res = await api.send({ text, target });
    if (res.status === "sent") {
      prompt.value = "";
      say("");
    } else if (res.status === "failed") {
      say(res.message);
    } else {
      say("");
    }
  } catch (err) {
    say(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
  } finally {
    setBusy(false);
    await renderFolder();
    await renderRecent();
  }
}

// ── AI settings ─────────────────────────────────────────────────────────────

let ai: AiInfo | null = null;
let choice: AiEngine = "auto";
/** The Direct API provider picked in the panel, and the model typed per provider ("" = its default). */
let provider: AiProvider = "anthropic";
let models: Partial<Record<AiProvider, string>> = {};
const KEY_HINTS: Record<AiKeyProvider, string> = { anthropic: "sk-ant-…", openai: "sk-…", gemini: "AIza…", openrouter: "sk-or-…" };
/** Runs after a successful Save (a request that was waiting for the AI to be set up). */
let afterSave: (() => void) | null = null;

function renderAi(info: AiInfo | null): void {
  if (info) ai = info;
  const chip = $("ai-chip");
  if (!ai) return;
  $("ai-label").textContent = ai.label;
  chip.classList.toggle("on", ai.engine !== "none");
  chip.title =
    ai.engine === "none" ? "Choose what builds your UI: Claude Code, Codex, or a model's API. AI settings…"
    : ai.engine === "external" ? "Requests wait until your agent picks them up. AI settings…"
    : `${ai.label} builds your request on this machine. AI settings…`;
}

const OPTIONS: { id: AiEngine; title: string; sub: string }[] = [
  { id: "auto", title: "Auto", sub: "Uses Claude Code, then Codex, then the Direct API" },
  { id: "claude", title: "Claude Code", sub: "Runs the claude command line, with your Claude subscription or account" },
  { id: "codex", title: "Codex", sub: "Runs the codex command line, with your ChatGPT or OpenAI account" },
  { id: "api", title: "Direct API", sub: "No agent: Glimpse calls the model itself (Claude, GPT, Gemini, OpenRouter, Ollama)" },
];

function renderAiPanel(): void {
  const options = [...OPTIONS];
  if (ai?.preferred === "external" || choice === "external")
    options.push({ id: "external", title: "External agent", sub: "Glimpse doesn't run the AI; requests wait for your agent (Help › Use with an External Agent…)" });
  $("ai-options").replaceChildren(
    ...options.map((o) => {
      const wrap = document.createElement("div");
      wrap.className = `ai-option${o.id === choice ? " on" : ""}`;
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(o.id === choice));
      b.dataset.engine = o.id;
      const radio = document.createElement("span");
      radio.className = "ai-radio";
      const textWrap = document.createElement("span");
      textWrap.className = "ai-text";
      const title = document.createElement("span");
      title.className = "ai-title";
      title.textContent = o.title;
      const sub = document.createElement("span");
      sub.className = "ai-sub";
      sub.textContent = o.id === "auto" && ai && ai.preferred === "auto" && ai.engine !== "none" ? `${o.sub} · Now: ${ai.label}` : o.sub;
      textWrap.append(title, sub);
      b.append(radio, textWrap);
      b.addEventListener("click", () => {
        choice = o.id;
        renderAiPanel();
      });
      wrap.append(b);
      const found = foundBadge(o.id);
      if (found) wrap.append(found);
      return wrap;
    }),
  );
  renderApiFields();
}

function providerInfo(p: AiProvider = provider) {
  return ai?.providers?.find((x) => x.id === p);
}

/** The Direct API part of the panel: provider, model, and the provider's key (or Ollama's state). */
function renderApiFields(): void {
  const select = $<HTMLSelectElement>("ai-provider");
  const providers = ai?.providers ?? [];
  $("ai-api").hidden = providers.length === 0 || (choice !== "api" && choice !== "auto");
  if (select.options.length !== providers.length)
    select.replaceChildren(
      ...providers.map((p) => {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name;
        return o;
      }),
    );
  for (const o of select.options) {
    const p = providerInfo(o.value as AiProvider);
    o.textContent = p ? `${p.name}${p.ready ? " ✓" : ""}` : o.value;
  }
  select.value = provider;
  const info = providerInfo();
  const model = $<HTMLInputElement>("ai-model");
  model.value = models[provider] ?? "";
  model.placeholder = info ? `Default: ${info.defaultModel}` : "";
  $("ai-models").replaceChildren(
    ...(info?.models ?? []).map((m) => {
      const o = document.createElement("option");
      o.value = m;
      return o;
    }),
  );
  const ollama = provider === "ollama";
  const saved = !ollama && !!info?.keySaved;
  const status = $("ai-key-saved");
  status.hidden = !saved && !ollama;
  status.textContent =
    ollama ?
      info?.ready ? `Ollama is running · ${info.models.length} model${info.models.length === 1 ? "" : "s"} installed`
      : "Ollama isn't running on this machine. Get it at ollama.com and start it."
    : "The key is stored on this machine and never shown again.";
  const key = $<HTMLInputElement>("ai-key");
  key.hidden = saved || ollama;
  key.placeholder = !ollama && info?.envKey ? "Using the key from the environment · paste one to save it" : KEY_HINTS[provider as AiKeyProvider] ?? "";
  key.setAttribute("aria-label", `${info?.name ?? "Provider"} API key`);
  $("ai-key-btn").hidden = ollama;
  $("ai-key-btn").textContent = saved ? "Remove key" : "Save key";
  updateKeyBtn();
}

function foundBadge(id: AiEngine): HTMLElement | null {
  if (!ai || id === "auto" || id === "external") return null;
  const span = document.createElement("span");
  const ok = id === "api" ? ai.available.api : ai.available[id];
  span.className = `ai-found${ok ? " ok" : ""}`;
  const p = providerInfo(ai.provider);
  span.textContent =
    id === "api" ?
      p ? `${p.name}${ok ? " ready" : " not set up"}`
      : ai.keySaved ? "Key saved"
      : ai.available.api ? "Key from the environment"
      : "No key"
    : ok ? "Installed"
    : "Not found";
  return span;
}

function updateKeyBtn(): void {
  const btn = $<HTMLButtonElement>("ai-key-btn");
  btn.disabled = aiBusy || (!providerInfo()?.keySaved && !$<HTMLInputElement>("ai-key").value.trim());
}

function aiError(text: string): void {
  const el = $("ai-error");
  el.textContent = text;
  el.hidden = !text;
}

let aiBusy = false;
function setAiBusy(on: boolean): void {
  aiBusy = on;
  for (const id of ["ai-save", "ai-cancel"]) $<HTMLButtonElement>(id).disabled = on;
  $("ai-save").textContent = on ? "Saving…" : "Save";
  updateKeyBtn();
}

function openAiPanel(then?: () => void): void {
  afterSave = then ?? null;
  choice = ai?.preferred ?? "auto";
  provider = ai?.provider ?? "anthropic";
  models = { [provider]: ai?.chosenModel ?? "" };
  aiError("");
  $<HTMLInputElement>("ai-key").value = "";
  renderAiPanel();
  $("ai-panel").hidden = false;
  $("ai-panel").querySelector<HTMLElement>(".ai-option.on button, .ai-option button")?.focus();
  void api.aiInfo().then((fresh) => {
    renderAi(fresh);
    if ($("ai-panel").hidden) return;
    renderAiPanel();
  });
}

function closeAiPanel(): void {
  if (aiBusy) return;
  $("ai-panel").hidden = true;
  afterSave = null;
  prompt.focus();
}

async function saveKey(): Promise<void> {
  const input = $<HTMLInputElement>("ai-key");
  const key = input.value.trim();
  setAiBusy(true);
  aiError("");
  try {
    if (provider === "ollama") return;
    const p = provider as AiKeyProvider;
    const next = await api.saveAi({ apiKey: { provider: p, key: providerInfo()?.keySaved ? null : key } });
    input.value = "";
    renderAi(next);
    renderAiPanel();
  } catch (err) {
    aiError(cleanError(err));
  } finally {
    setAiBusy(false);
  }
}

async function saveAi(): Promise<void> {
  const typed = provider === "ollama" ? "" : $<HTMLInputElement>("ai-key").value.trim();
  const model = $<HTMLInputElement>("ai-model").value.trim();
  setAiBusy(true);
  aiError("");
  try {
    const next = await api.saveAi({
      engine: choice,
      ...(ai?.providers && { provider, model: model || null }),
      ...(typed && { apiKey: { provider: provider as AiKeyProvider, key: typed } }),
    });
    $<HTMLInputElement>("ai-key").value = "";
    renderAi(next);
    renderAiPanel();
    if (next.engine === "none") {
      aiError(
        choice === "auto" ?
          "Nothing that can run the AI was found on this machine. Install Claude Code or Codex, or set up a provider for the Direct API."
        : `${OPTIONS.find((o) => o.id === choice)?.title ?? choice} isn't available on this machine yet. Install it, or pick another option.`,
      );
      return;
    }
    const then = afterSave;
    setAiBusy(false);
    closeAiPanel();
    then?.();
  } catch (err) {
    aiError(cleanError(err));
  } finally {
    setAiBusy(false);
  }
}

function cleanError(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
}

// ── Start ───────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  $("greeting").textContent = greeting();
  const info = await api.info();
  const mac = info.platform === "darwin";
  for (const kbd of document.querySelectorAll<HTMLElement>("kbd[data-shortcut]")) {
    kbd.textContent = mac ? `⌘${kbd.dataset.shortcut!.replace("Shift+", "⇧")}` : `Ctrl+${kbd.dataset.shortcut}`;
  }
  $("version").textContent = `Glimpse ${info.version}`;
  document.documentElement.dataset.platform = info.platform;

  $("open-folder").addEventListener("click", () => void run(() => api.openFolder()));
  $("folder-chip").addEventListener("click", () =>
    void run(async () => {
      await api.pickFolder();
      await renderFolder();
      prompt.focus();
    }),
  );
  $("folder-clear").addEventListener("click", () =>
    void (async () => {
      await api.clearFolder();
      await renderFolder();
      prompt.focus();
    })(),
  );

  prompt.addEventListener("input", () => {
    updateSend();
    if (!notice.classList.contains("info")) say("");
  });
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  sendBtn.addEventListener("click", () => void send());

  renderTarget();
  targetBtn.addEventListener("click", () => setMenu(targetMenu.hidden));
  targetBtn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && targetMenu.hidden) {
      e.preventDefault();
      setMenu(true);
    }
  });
  $("target-wrap").addEventListener("keydown", (e) => {
    if (targetMenu.hidden) return;
    const items = [...targetMenu.querySelectorAll<HTMLElement>("button")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      setMenu(false);
      targetBtn.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
  window.addEventListener("mousedown", (e) => {
    if (!targetMenu.hidden && !$("target-wrap").contains(e.target as Node)) setMenu(false);
  });

  $("ideas").replaceChildren(
    ...IDEAS.map((idea) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "idea";
      b.append(icon(idea.icon), document.createTextNode(` ${idea.label}`));
      b.addEventListener("click", () => {
        prompt.value = idea.text;
        target = idea.target;
        renderTarget();
        updateSend();
        prompt.focus();
      });
      return b;
    }),
  );

  $("ai-chip").addEventListener("click", () => openAiPanel());
  $("ai-cancel").addEventListener("click", () => closeAiPanel());
  $("ai-save").addEventListener("click", () => void saveAi());
  $("ai-key-btn").addEventListener("click", () => void saveKey());
  $("ai-key").addEventListener("input", () => updateKeyBtn());
  $("ai-provider").addEventListener("change", () => {
    models[provider] = $<HTMLInputElement>("ai-model").value;
    provider = $<HTMLSelectElement>("ai-provider").value as AiProvider;
    $<HTMLInputElement>("ai-key").value = "";
    aiError("");
    renderApiFields();
  });
  $("ai-model").addEventListener("input", () => {
    models[provider] = $<HTMLInputElement>("ai-model").value;
  });
  $("ai-key").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && $<HTMLInputElement>("ai-key").value.trim()) {
      e.preventDefault();
      void saveKey();
    }
  });
  $("ai-panel").addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) closeAiPanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("ai-panel").hidden) closeAiPanel();
  });

  api.onRecentChanged(() => void renderRecent());
  prompt.focus();
  await Promise.all([renderRecent(), renderFolder(), api.aiInfo().then(renderAi, () => undefined)]);
  // The recent list slides in on opening only, not each time it is redrawn (launcher.css).
  setTimeout(() => document.documentElement.classList.add("settled"), 600);
}

void init();
