/**
 * The providers the "Direct API" engine can call, without any SDK: their names, default models, endpoints and the
 * environment variables that hold their keys. Anthropic goes through the official Anthropic SDK; the others speak
 * the OpenAI Chat Completions protocol (OpenAI itself, OpenRouter, Ollama, and Gemini's OpenAI-compatible endpoint).
 */

export type ApiProvider = "anthropic" | "openai" | "gemini" | "openrouter" | "ollama";
export const API_PROVIDERS: readonly ApiProvider[] = ["anthropic", "openai", "gemini", "openrouter", "ollama"];
/** The providers that need an API key (Ollama runs locally without one). */
export type KeyProvider = Exclude<ApiProvider, "ollama">;
export const KEY_PROVIDERS: readonly KeyProvider[] = ["anthropic", "openai", "gemini", "openrouter"];

/** How hard the model thinks: maps to Anthropic's effort and OpenAI-style reasoning effort where supported. */
export type Quality = "fast" | "balanced" | "best";
export const QUALITIES: readonly Quality[] = ["fast", "balanced", "best"];

export const OLLAMA_DEFAULT_URL = "http://localhost:11434";
export const DEFAULT_MAX_STEPS = 40;
export const MAX_STEPS_LIMIT = 200;
export const MAX_INSTRUCTIONS = 4000;

export interface ProviderInfo {
  name: string;
  /** The model used when the settings name none (Ollama: the first installed model, else this). */
  defaultModel: string;
  /** Suggestions for the model picker; any other model id can be typed. */
  models: readonly string[];
  /** The OpenAI-compatible endpoint (undefined: the SDK's own default). */
  baseURL?: string;
  /** Environment variables that hold a key, in order of preference. */
  envKeys: readonly string[];
}

export const PROVIDERS: Record<ApiProvider, ProviderInfo> = {
  anthropic: {
    name: "Anthropic",
    defaultModel: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
    envKeys: ["ANTHROPIC_API_KEY"],
  },
  openai: {
    name: "OpenAI",
    defaultModel: "gpt-5",
    models: ["gpt-5", "gpt-5-mini"],
    envKeys: ["OPENAI_API_KEY"],
  },
  gemini: {
    name: "Gemini",
    defaultModel: "gemini-2.5-pro",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  openrouter: {
    name: "OpenRouter",
    defaultModel: "anthropic/claude-opus-5-5",
    models: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "openai/gpt-5", "google/gemini-2.5-pro"],
    baseURL: "https://openrouter.ai/api/v1",
    envKeys: ["OPENROUTER_API_KEY"],
  },
  ollama: {
    name: "Ollama",
    defaultModel: "llama3.2",
    models: [],
    envKeys: [],
  },
};

export const isApiProvider = (v: unknown): v is ApiProvider => typeof v === "string" && (API_PROVIDERS as readonly string[]).includes(v);
export const isKeyProvider = (v: unknown): v is KeyProvider => typeof v === "string" && (KEY_PROVIDERS as readonly string[]).includes(v);
export const isQuality = (v: unknown): v is Quality => typeof v === "string" && (QUALITIES as readonly string[]).includes(v);
