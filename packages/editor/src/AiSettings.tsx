import { useEffect, useState, type ReactNode } from "react";
import * as I from "./icons";
import * as L from "./loop-icons";
import { engineName, getAgentInfo, saveAgentSettings, type AgentInfo, type Preferred } from "./agent";
import { Modal } from "./Modal";
import { store } from "./store";

const MCP_COMMAND = "claude mcp add glimpse -- npx -y glimpse-ui mcp";
const CLAUDE_CODE_URL = "https://docs.anthropic.com/en/docs/claude-code";
const CODEX_URL = "https://github.com/openai/codex";

/**
 * AI settings: what builds the UI. Glimpse runs Claude Code or Codex when installed, or the Claude API with the
 * user's key; "Auto" takes the first of those it finds. An external agent (connected over MCP) is the advanced
 * option. Saving with a request waiting (Home's "Set up AI") sends it right after (see store.closeAiSettings).
 */
export function AiSettings() {
  const [info, setInfo] = useState<AgentInfo | null>(store.state.agentInfo);
  /** GET /api/agent answered: null info then means a server that can't run the AI itself. */
  const [loaded, setLoaded] = useState(false);
  const [choice, setChoice] = useState<Preferred>(store.state.agentInfo?.preferred ?? "auto");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "key" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    void getAgentInfo().then((fresh) => {
      if (!live) return;
      if (fresh) {
        setInfo(fresh);
        setChoice(fresh.preferred);
        store.setAgentInfo(fresh);
      }
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const oldServer = loaded && !info;
  const available = info?.available;
  const close = () => store.closeAiSettings();

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const saveKey = async (anthropicApiKey: string | null) => {
    setBusy("key");
    setError(null);
    try {
      const next = await saveAgentSettings({ anthropicApiKey, ...(anthropicApiKey && choice === "api" && { engine: "api" as const }) });
      setInfo(next);
      store.setAgentInfo(next);
      setKey("");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const typed = key.trim();
      const next = await saveAgentSettings({ engine: choice, ...(typed && { anthropicApiKey: typed }) });
      setInfo(next);
      setKey("");
      if (next.engine === "none") {
        store.setAgentInfo(next);
        setError(
          choice === "auto" ?
            "Nothing that can run the AI was found on this machine. Install Claude Code or Codex, or add an Anthropic API key."
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

  const resolves = info && info.preferred === "auto" && info.engine !== "none" ? `Now: ${engineName(info.engine)}` : null;

  return (
    <Modal onClose={close} busy={busy !== null} className="ai-settings">
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
          <div className="ai-options" role="radiogroup" aria-label="What builds your UI">
            <Option id="auto" choice={choice} onChoose={setChoice} title="Auto" badge={<span className="ai-tag">Recommended</span>}>
              Uses Claude Code, then Codex, then your API key{resolves ? ` · ${resolves}` : ""}
            </Option>
            <Option id="claude" choice={choice} onChoose={setChoice} title="Claude Code" badge={<Found found={available?.claude} url={CLAUDE_CODE_URL} name="Claude Code" />}>
              Runs the <code>claude</code> command line, with your Claude subscription or account
            </Option>
            <Option id="codex" choice={choice} onChoose={setChoice} title="Codex" badge={<Found found={available?.codex} url={CODEX_URL} name="Codex" />}>
              Runs the <code>codex</code> command line, with your ChatGPT or OpenAI account
            </Option>
            <Option
              id="api"
              choice={choice}
              onChoose={setChoice}
              title="Claude API key"
              badge={available?.api ? <span className="ai-found ok">Key saved</span> : <span className="ai-found">No key</span>}
            >
              Glimpse calls the Claude API itself with your Anthropic key
            </Option>
            <div className="ai-key">
              {available?.api ? (
                <>
                  <span className="hint">The key is stored on this machine and never shown again.</span>
                  <button className="btn" disabled={busy !== null} onClick={() => void saveKey(null)}>
                    {busy === "key" ? "Removing…" : "Remove key"}
                  </button>
                </>
              ) : (
                <>
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Anthropic API key"
                    placeholder="sk-ant-…"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && key.trim()) {
                        e.preventDefault();
                        void saveKey(key.trim());
                      }
                    }}
                  />
                  <button className="btn" disabled={!key.trim() || busy !== null} onClick={() => void saveKey(key.trim())}>
                    {busy === "key" ? "Saving…" : "Save key"}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <details className="ai-external" open={oldServer || choice === "external" || undefined}>
          <summary>
            <I.Chevron size={14} /> External agent <span className="ai-tag">Advanced</span>
          </summary>
          <p className="hint">
            Prefer to drive Glimpse from an agent you already run? Add Glimpse as an MCP server, then ask the agent to build in Glimpse. Your requests
            wait until it picks them up.
          </p>
          <div className="ai-command">
            <code>{MCP_COMMAND}</code>
            <button className="btn" onClick={() => void copy()} title="Copy the command">
              <L.Copy size={13} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {!oldServer && (
            <div className="ai-options" role="radiogroup" aria-label="External agent">
              <Option id="external" choice={choice} onChoose={setChoice} title="Use an external agent" badge={null}>
                Glimpse doesn't run the AI; it waits for your agent
              </Option>
            </div>
          )}
        </details>

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
