/** What the home window may ask the main process for (exposed by preload.ts as `window.glimpse`). */
export interface LauncherApi {
  info(): Promise<AppInfo>;
  recent(): Promise<RecentEntry[]>;
  /** Pick an existing folder and open it. */
  openFolder(): Promise<void>;
  /** Open a folder from the recent list. */
  openRecent(path: string): Promise<void>;
  removeRecent(path: string): Promise<void>;
  /** Called whenever the recent list changes; returns an unsubscribe function. */
  onRecentChanged(listener: () => void): () => void;

  /** The folder the next request is built in (the composer's folder chip), or null: then sending asks where to save. */
  folder(): Promise<FolderChoice | null>;
  /** Pick the folder for the next request (null when the dialog was cancelled; the previous choice stays). */
  pickFolder(): Promise<FolderChoice | null>;
  /** Forget the chosen folder ("No folder"). */
  clearFolder(): Promise<void>;
  /**
   * Build something: in the chosen folder, or (none chosen) in a new folder the user names in a save dialog. Opens
   * the project's window and hands the request to its Glimpse server.
   */
  send(request: HomeRequest): Promise<SendResult>;

  /** Which AI builds requests. Never includes the API key. */
  aiInfo(): Promise<AiInfo>;
  /** Change the AI settings (glimpse-ui's saveAgentSettings); returns the new info. */
  saveAi(patch: SaveAiPatch): Promise<AiInfo>;
}

export interface AppInfo {
  version: string;
  glimpseVersion: string;
  platform: NodeJS.Platform;
}

export interface RecentEntry {
  path: string;
  name: string;
  /** ISO timestamp of the last time it was opened. */
  openedAt: string;
  /** False when the folder was moved or deleted. */
  exists: boolean;
  /** True while a window for it is open. */
  open: boolean;
}

export interface FolderChoice {
  path: string;
  name: string;
}

/** What the home screen's target selector offers (the editor's targets). */
export type BuildTarget = "html" | "react" | "tui" | "native";

export interface HomeRequest {
  text: string;
  target: BuildTarget;
}

/** "sent": the project window is open and has the request. "canceled": the user closed the save dialog. "failed": a dialog said why. */
export type SendResult = { status: "sent"; folder: string } | { status: "canceled" } | { status: "failed"; message: string };

/** The preference in Glimpse's settings (glimpse-ui's AgentEngine). */
export type AiEngine = "auto" | "claude" | "codex" | "api" | "external";
/** Who would actually build a request; "none" when nothing can. */
export type ResolvedAiEngine = "claude" | "codex" | "api" | "external" | "none";

/** The Direct API's providers (glimpse-ui's ApiProvider). */
export type AiProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "ollama";
export type AiKeyProvider = Exclude<AiProvider, "ollama">;

export interface AiProviderInfo {
  id: AiProvider;
  name: string;
  defaultModel: string;
  /** Suggestions for the model field (Ollama: its installed models). */
  models: string[];
  /** A key is saved in Glimpse's settings (never the key itself). Always false for Ollama. */
  keySaved: boolean;
  /** A key is set in the environment (OPENAI_API_KEY…). */
  envKey: boolean;
  /** It could run now: a key (saved or in the environment), or Ollama answering. */
  ready: boolean;
}

export interface AiInfo {
  preferred: AiEngine;
  engine: ResolvedAiEngine;
  /** "Claude Code", "Codex", "Claude · opus-5-5", "GPT · OpenAI", "Gemini", "Ollama · llama3", "Your agent" or "Set up AI". */
  label: string;
  /** What is installed or configured on this machine (`api`: the chosen provider has a key, or Ollama answers). */
  available: { claude: boolean; codex: boolean; api: boolean };
  /** The chosen provider's key is saved in Glimpse's settings (the key itself never reaches the page). */
  keySaved: boolean;
  /** The Direct API's provider, the model it uses, and the model chosen in the settings ("" = the default). */
  provider: AiProvider;
  model: string;
  chosenModel: string;
  providers: AiProviderInfo[];
}

/**
 * `anthropicApiKey: null` removes the saved Anthropic key (older pages). `apiKey` saves (string) or removes (null) a
 * provider's key; `model: null` goes back to the provider's default.
 */
export interface SaveAiPatch {
  engine?: AiEngine;
  anthropicApiKey?: string | null;
  provider?: AiProvider;
  model?: string | null;
  apiKey?: { provider: AiKeyProvider; key: string | null };
}

/** IPC channel names (ipcMain.handle / ipcRenderer.invoke). */
export const IPC = {
  info: "glimpse:info",
  recent: "glimpse:recent",
  openFolder: "glimpse:open-folder",
  openRecent: "glimpse:open-recent",
  removeRecent: "glimpse:remove-recent",
  recentChanged: "glimpse:recent-changed",
  folder: "glimpse:folder",
  pickFolder: "glimpse:pick-folder",
  clearFolder: "glimpse:clear-folder",
  send: "glimpse:send",
  aiInfo: "glimpse:ai-info",
  saveAi: "glimpse:save-ai",
} as const;
