import { useEffect, useId, useState, type ReactNode } from "react";
import * as L from "./loop-icons";
import {
  API_PROVIDERS,
  engineLabel,
  engineName,
  getAgentInfo,
  PROVIDER_META,
  saveAgentSettings,
  type AgentInfo,
  type ApiProvider,
  type KeyProvider,
  type Preferred,
  type Quality,
  type SettingsPatch,
} from "./agent";
import { Modal } from "./Modal";
import { store } from "./store";

const MCP_COMMAND = "claude mcp add glimpse -- npx -y glimpse-ui mcp";
const CLAUDE_CODE_URL = "https://docs.anthropic.com/en/docs/claude-code";
const CODEX_URL = "https://github.com/openai/codex";
const OLLAMA_URL = "https://ollama.com/download";
const MAX_INSTRUCTIONS = 4000;

const QUALITY: { id: Quality; title: string; sub: string }[] = [
  { id: "fast", title: "Fast", sub: "Quick edits, least thinking" },
  { id: "balanced", title: "Balanced", sub: "Good for most requests" },
  { id: "best", title: "Best", sub: "Thinks longest, slowest" },
];

const ENV_NAMES: Record<KeyProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const isKeyProvider = (p: ApiProvider): p is KeyProvider => p !== "ollama";

/**
 * AI settings: what builds the UI. Glimpse runs Claude Code or Codex when installed, or calls a model's API itself
 * (Anthropic, OpenAI, Gemini, OpenRouter or a local Ollama); "Auto" takes the first of those it finds. An external
 * agent (connected over MCP) is the advanced option. Behavior settings apply to every engine Glimpse runs. Saving
 * with a request waiting (Home's "Set up AI") sends it right after (see store.closeAiSettings).
 */
export function AiSettings() {
  const initial = store.state.agentInfo;
  const [info, setInfo] = useState<AgentInfo | null>(initial);
  /** GET /api/agent answered: null info then means a server that can't run the AI itself. */
  const [loaded, setLoaded] = useState(false);
  const [choice, setChoice] = useState<Preferred>(initial?.preferred ?? "auto");
  const [provider, setProvider] = useState<ApiProvider>(initial?.api?.provider ?? "anthropic");
  /** The model typed per provider ("" = its default). */
  const [models, setModels] = useState<Partial<Record<ApiProvider, string>>>(initial?.api ? { [initial.api.provider]: initial.api.chosenModel } : {});
  const [keys, setKeys] = useState<Partial<Record<KeyProvider, string>>>({});
  const [baseUrl, setBaseUrl] = useState(initial?.api?.ollama.baseUrl ?? "http://localhost:11434");
  const [quality, setQuality] = useState<Quality>(initial?.behavior?.quality ?? "balanced");
  const [maxSteps, setMaxSteps] = useState(String(initial?.behavior?.maxSteps ?? 40));
  const [allowCommands, setAllowCommands] = useState(initial?.behavior?.allowCommands ?? false);
  const [instructions, setInstructions] = useState(initial?.behavior?.customInstructions ?? "");
  const [busy, setBusy] = useState<"save" | "key" | "ollama" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ids = useId();

  /** Take the server's settings into the form (on open, after a key or Ollama change: not over the human's edits). */
  const adopt = (fresh: AgentInfo, all: boolean) => {
    setInfo(fresh);
    store.setAgentInfo(fresh);
    if (!all) return;
    setChoice(fresh.preferred);
    if (fresh.api) {
      setProvider(fresh.api.provider);
      setModels({ [fresh.api.provider]: fresh.api.chosenModel });
      setBaseUrl(fresh.api.ollama.baseUrl);
    }
    if (fresh.behavior) {
      setQuality(fresh.behavior.quality);
      setMaxSteps(String(fresh.behavior.maxSteps));
      setAllowCommands(fresh.behavior.allowCommands);
      setInstructions(fresh.behavior.customInstructions);
    }
  };

  useEffect(() => {
    let live = true;
    void getAgentInfo().then((fresh) => {
      if (!live) return;
      if (fresh) adopt(fresh, true);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const oldServer = loaded && !info;
  /** A server that runs the AI but only knows the Anthropic key (no providers, no behavior settings). */
  const legacy = !!info && !info.api;
  const api = info?.api ?? null;
  const available = info?.available;
  const close = () => store.closeAiSettings();
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const steps = Number(maxSteps);
  const stepsOk = Number.isInteger(steps) && steps >= 1 && steps <= 200;

  /** Save or remove one provider's key right away (it never comes back to the page). */
  const saveKey = async (p: KeyProvider, key: string | null) => {
    setBusy("key");
    setError(null);
    try {
      const patch: SettingsPatch = legacy ? { anthropicApiKey: key } : { api: { keys: { [p]: key } } };
      adopt(await saveAgentSettings(patch), false);
      setKeys((k) => ({ ...k, [p]: "" }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  /** Save Ollama's address and look for it (and its models) again. */
  const checkOllama = async () => {
    setBusy("ollama");
    setError(null);
    try {
      adopt(await saveAgentSettings({ api: { baseUrl: baseUrl.trim() || null } }), false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const patch = (): SettingsPatch => {
    const typedKeys = Object.fromEntries(Object.entries(keys).filter(([, v]) => v?.trim()).map(([p, v]) => [p, v!.trim()])) as Partial<Record<KeyProvider, string>>;
    if (legacy) return { engine: choice, ...(typedKeys.anthropic && { anthropicApiKey: typedKeys.anthropic }) };
    const model = models[provider]?.trim() ?? "";
    return {
      engine: choice,
      api: {
        provider,
        model: model || null,
        ...(provider === "ollama" && baseUrl.trim() !== api?.ollama.baseUrl && { baseUrl: baseUrl.trim() || null }),
        ...(Object.keys(typedKeys).length > 0 && { keys: typedKeys }),
      },
      quality,
      allowCommands,
      ...(stepsOk && { maxSteps: steps }),
      customInstructions: instructions.trim() || null,
    };
  };

  const save = async () => {
    if (!legacy && !stepsOk) {
      setError("Max steps must be a whole number from 1 to 200.");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const next = await saveAgentSettings(patch());
      setInfo(next);
      setKeys({});
      if (next.engine === "none") {
        store.setAgentInfo(next);
        setError(
          choice === "auto" ? "Nothing that can run the AI was found on this machine. Install Claude Code or Codex, or set up a provider under Direct API."
          : choice === "api" ?
            provider === "ollama" ?
              "Ollama isn't answering at that address. Start Ollama, or pick another provider."
            : `Add a ${PROVIDER_META[provider].name} API key first, or pick another provider.`
          : `${engineName(choice)} isn't available on this machine yet. Install it, or pick another option.`,
        );
        setBusy(null);
        return;
      }
      store.closeAiSettings(next);
    } catch (e) {
      fail(e);
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard access (an insecure origin): the command stays selectable.
    }
  };

  const resolves = info && info.preferred === "auto" && info.engine !== "none" ? `Now: ${engineLabel(info.engine, info)}` : null;
  const providerReady = (p: ApiProvider): boolean => (p === "ollama" ? !!api?.ollama.running : !!(api?.keysSaved[p] || api?.envKeys[p]));
  const apiBadge =
    legacy ?
      available?.api ? <span className="ai-found ok">Key saved</span>
      : <span className="ai-found">No key</span>
    : api ?
      providerReady(api.provider) ? <span className="ai-found ok">{api.providers[api.provider].name} ready</span>
      : <span className="ai-found">Not set up</span>
    : null;

  return (
    <Modal onClose={close} busy={busy !== null} className="ai-settings ai-settings-v2">
      <header>
        <h2>AI settings</h2>
        <p>{oldServer ? "Choose what builds your UI." : "Choose what builds your UI. Glimpse runs it on this machine and every file it saves shows up live."}</p>
      </header>
      <div className="body">
        {oldServer && (
          <p className="ai-notice" role="status">
            This version of the Glimpse server can't run the AI itself. Update Glimpse, or connect an external agent.
          </p>
        )}

        {!oldServer && (
          <Section title="Engine" hint="What runs your requests">
            <div className="ai-options" role="radiogroup" aria-label="What builds your UI">
              <Option id="auto" choice={choice} onChoose={setChoice} title="Auto" badge={<span className="ai-tag">Recommended</span>}>
                Claude Code, then Codex, then the Direct API{resolves ? ` · ${resolves}` : ""}
              </Option>
              <Option id="claude" choice={choice} onChoose={setChoice} title="Claude Code" badge={<Found found={available?.claude} url={CLAUDE_CODE_URL} name="Claude Code" />}>
                Runs the <code>claude</code> command line, with your Claude subscription or account
              </Option>
              <Option id="codex" choice={choice} onChoose={setChoice} title="Codex" badge={<Found found={available?.codex} url={CODEX_URL} name="Codex" />}>
                Runs the <code>codex</code> command line, with your ChatGPT or OpenAI account
              </Option>
              <Option id="api" choice={choice} onChoose={setChoice} title={legacy ? "Claude API key" : "Direct API"} badge={apiBadge}>
                {legacy ? "Glimpse calls the Claude API itself with your Anthropic key" : "No agent: Glimpse calls the model itself, with your key or a local Ollama"}
              </Option>
              <Option id="external" choice={choice} onChoose={setChoice} title="External agent" badge={<span className="ai-tag">Advanced</span>}>
                Glimpse doesn't run the AI; it waits for your agent (MCP)
              </Option>
            </div>
          </Section>
        )}

        {(oldServer || choice === "external") && (
          <div className="ai-mcp">
            <p className="hint">
              Prefer to drive Glimpse from an agent you already run? Add Glimpse as an MCP server, then ask the agent to build in Glimpse. Your requests wait
              until it picks them up.
            </p>
            <div className="ai-command">
              <code>{MCP_COMMAND}</code>
              <button className="btn" onClick={() => void copy()} title="Copy the command">
                <L.Copy size={13} /> {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {legacy && (
          <Section title="Claude API key" hint="For the Claude API key engine">
            <KeyRow
              label="Anthropic API key"
              placeholder="sk-ant-…"
              saved={!!available?.api}
              env={false}
              envName={ENV_NAMES.anthropic}
              value={keys.anthropic ?? ""}
              onChange={(v) => setKeys((k) => ({ ...k, anthropic: v }))}
              onSave={(v) => void saveKey("anthropic", v)}
              busy={busy}
              keyUrl={PROVIDER_META.anthropic.keyUrl}
            />
          </Section>
        )}

        {api && (
          <Section
            title="Direct API"
            hint={choice === "api" ? "The model Glimpse calls" : choice === "auto" ? "Used when no CLI is installed" : "Used when the engine is Direct API"}
            dim={choice !== "api" && choice !== "auto"}
          >
            <div className="ai-providers" role="tablist" aria-label="Provider">
              {API_PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  aria-selected={p === provider}
                  className={p === provider ? "on" : ""}
                  onClick={() => {
                    setProvider(p);
                    setError(null);
                  }}
                >
                  <span className={`ai-pdot${providerReady(p) ? " ok" : ""}`} aria-hidden />
                  {PROVIDER_META[p].short}
                </button>
              ))}
            </div>

            <div className="ai-provider" role="tabpanel" aria-label={PROVIDER_META[provider].name}>
              {isKeyProvider(provider) ? (
                <Field label="API key" htmlFor={`${ids}-key`}>
                  <KeyRow
                    id={`${ids}-key`}
                    label={`${PROVIDER_META[provider].name} API key`}
                    placeholder={PROVIDER_META[provider].keyHint ?? ""}
                    saved={api.keysSaved[provider]}
                    env={api.envKeys[provider]}
                    envName={ENV_NAMES[provider]}
                    value={keys[provider] ?? ""}
                    onChange={(v) => setKeys((k) => ({ ...k, [provider]: v }))}
                    onSave={(v) => void saveKey(provider, v)}
                    busy={busy}
                    keyUrl={PROVIDER_META[provider].keyUrl}
                  />
                </Field>
              ) : (
                <Field label="Address" htmlFor={`${ids}-ollama`}>
                  <div className="ai-row">
                    <input
                      id={`${ids}-ollama`}
                      className="input mono"
                      spellCheck={false}
                      value={baseUrl}
                      placeholder="http://localhost:11434"
                      onChange={(e) => setBaseUrl(e.target.value)}
                    />
                    <button className="btn" disabled={busy !== null} onClick={() => void checkOllama()}>
                      {busy === "ollama" ? "Checking…" : "Check"}
                    </button>
                  </div>
                  <p className="ai-status-line">
                    {api.ollama.running ?
                      <>
                        <span className="ai-found ok">Running</span> · {api.ollama.models.length === 0 ? "no models yet: run ollama pull llama3.2" : `${api.ollama.models.length} model${api.ollama.models.length === 1 ? "" : "s"} installed`}
                      </>
                    : <>
                        <span className="ai-found">Not running</span> ·{" "}
                        <a href={OLLAMA_URL} target="_blank" rel="noreferrer">
                          get Ollama
                        </a>
                        , then start it
                      </>
                    }
                  </p>
                </Field>
              )}

              <Field label="Model" htmlFor={`${ids}-model`}>
                <input
                  id={`${ids}-model`}
                  className="input mono"
                  list={`${ids}-models`}
                  spellCheck={false}
                  autoComplete="off"
                  value={models[provider] ?? ""}
                  placeholder={`Default: ${api.providers[provider].defaultModel}`}
                  onChange={(e) => setModels((m) => ({ ...m, [provider]: e.target.value }))}
                />
                <datalist id={`${ids}-models`}>
                  {api.providers[provider].models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                {api.providers[provider].models.length > 0 && (
                  <div className="ai-chips" aria-label="Suggested models">
                    {api.providers[provider].models.slice(0, 6).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`ai-chip${(models[provider] || api.providers[provider].defaultModel) === m ? " on" : ""}`}
                        onClick={() => setModels((x) => ({ ...x, [provider]: m === api.providers[provider].defaultModel ? "" : m }))}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            </div>
          </Section>
        )}

        {info?.behavior && (
          <Section title="Behavior" hint="For every engine Glimpse runs">
            <Field label="Quality">
              <div className="ai-seg" role="radiogroup" aria-label="Quality">
                {QUALITY.map((q) => (
                  <button key={q.id} type="button" role="radio" aria-checked={quality === q.id} className={quality === q.id ? "on" : ""} onClick={() => setQuality(q.id)}>
                    <span className="ai-title">{q.title}</span>
                    <span className="ai-sub">{q.sub}</span>
                  </button>
                ))}
              </div>
            </Field>
            <div className="ai-grid">
              <Field label="Max steps" htmlFor={`${ids}-steps`} note="Direct API: tool calls before it gives up">
                <input
                  id={`${ids}-steps`}
                  className={`input${stepsOk ? "" : " invalid"}`}
                  type="number"
                  min={1}
                  max={200}
                  value={maxSteps}
                  onChange={(e) => setMaxSteps(e.target.value)}
                />
              </Field>
              <Field label="Claude Code" note="Off: it only edits files">
                <label className="ai-toggle">
                  <input type="checkbox" checked={allowCommands} onChange={(e) => setAllowCommands(e.target.checked)} />
                  <span className="ai-switch" aria-hidden />
                  Allow shell commands
                </label>
              </Field>
            </div>
            <Field label="Custom instructions" htmlFor={`${ids}-instr`} note={`Added to every request · ${instructions.length}/${MAX_INSTRUCTIONS}`}>
              <textarea
                id={`${ids}-instr`}
                className="input"
                rows={3}
                maxLength={MAX_INSTRUCTIONS}
                placeholder="e.g. Use Tailwind. Keep everything in one index.html. Dark theme."
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </Field>
          </Section>
        )}

        {error && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button className="btn" onClick={close} disabled={busy !== null}>
          {oldServer ? "Close" : "Cancel"}
        </button>
        {!oldServer && (
          <button className="btn primary" onClick={() => void save()} disabled={busy !== null || !loaded}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        )}
      </footer>
    </Modal>
  );
}

function Section({ title, hint, dim, children }: { title: string; hint?: string; dim?: boolean; children: ReactNode }) {
  return (
    <section className={`ai-section${dim ? " dim" : ""}`} aria-label={title}>
      <div className="ai-section-head">
        <h3>{title}</h3>
        {hint && <span>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, htmlFor, note, children }: { label: string; htmlFor?: string; note?: string; children: ReactNode }) {
  return (
    <div className="ai-field">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="ai-label">{label}</span>}
      {children}
      {note && <span className="ai-note">{note}</span>}
    </div>
  );
}

/** A provider's key: saved (Remove), from the environment, or a field to save one. The key itself is never shown. */
function KeyRow({
  id,
  label,
  placeholder,
  saved,
  env,
  envName,
  value,
  onChange,
  onSave,
  busy,
  keyUrl,
}: {
  id?: string;
  label: string;
  placeholder: string;
  saved: boolean;
  env: boolean;
  envName: string;
  value: string;
  onChange: (v: string) => void;
  onSave: (key: string | null) => void;
  busy: string | null;
  keyUrl?: string;
}) {
  const link = keyUrl && (
    <a className="ai-getkey" href={keyUrl} target="_blank" rel="noreferrer">
      Get a key ↗
    </a>
  );
  if (saved)
    return (
      <div className="ai-row">
        <span className="ai-saved">
          <span className="ai-found ok">Key saved</span> on this machine, never shown again
        </span>
        <button className="btn" disabled={busy !== null} onClick={() => onSave(null)}>
          {busy === "key" ? "Removing…" : "Remove"}
        </button>
      </div>
    );
  return (
    <>
      <div className="ai-row">
        <input
          id={id}
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          placeholder={env ? `Using ${envName} · paste a key to save one` : placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              e.preventDefault();
              onSave(value.trim());
            }
          }}
        />
        <button className="btn" disabled={!value.trim() || busy !== null} onClick={() => onSave(value.trim())}>
          {busy === "key" ? "Saving…" : "Save"}
        </button>
      </div>
      <span className="ai-note">
        {env ? <>Found {envName} in the environment. </> : null}
        {link}
      </span>
    </>
  );
}

function Option({
  id,
  choice,
  onChoose,
  title,
  badge,
  children,
}: {
  id: Preferred;
  choice: Preferred;
  onChoose: (id: Preferred) => void;
  title: string;
  badge: ReactNode;
  children: ReactNode;
}) {
  const on = id === choice;
  // The badge sits beside the radio, not in it: it may hold a link.
  return (
    <div className={`ai-option${on ? " on" : ""}`}>
      <button type="button" role="radio" aria-checked={on} onClick={() => onChoose(id)}>
        <span className="ai-radio" />
        <span className="ai-text">
          <span className="ai-title">{title}</span>
          <span className="ai-sub">{children}</span>
        </span>
      </button>
      {badge}
    </div>
  );
}

/** "Installed", or "Not found" with where to get it (while the info is loading: nothing). */
function Found({ found, url, name }: { found: boolean | undefined; url: string; name: string }) {
  if (found === undefined) return null;
  if (found) return <span className="ai-found ok">Installed</span>;
  return (
    <span className="ai-found">
      Not found ·{" "}
      <a href={url} target="_blank" rel="noreferrer">
        install {name}
      </a>
    </span>
  );
}
