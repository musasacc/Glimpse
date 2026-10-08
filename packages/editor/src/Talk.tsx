import { useEffect, useRef, useState } from "react";
import { store } from "./store";

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function speechRecognition(): (new () => SpeechRecognitionLike) | undefined {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;
}

/**
 * Point & talk: type (or say) an instruction for the selected element.
 * It is pinned to that element and handed to the AI as a `comment` op.
 */
export function TalkPopover({ node, anchor, onClose }: { node: string; anchor: { left: number; top: number; height: number }; onClose: () => void }) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const Speech = speechRecognition();

  useEffect(() => {
    input.current?.focus();
    return () => rec.current?.stop();
  }, []);

  const pin = () => {
    const t = text.trim();
    if (t) store.edit({ op: "comment", node, id: `c${Date.now().toString(36)}`, text: t });
    onClose();
  };

  const toggleMic = () => {
    if (!Speech) return;
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r = new Speech();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    const before = text ? text + " " : "";
    r.onresult = (e) => {
      let said = "";
      for (let i = 0; i < e.results.length; i++) said += e.results[i]![0]!.transcript;
      setText(before + said);
    };
    r.onend = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  };

  return (
    <div className="talk" style={{ left: anchor.left, top: anchor.top + anchor.height + 8 }} onMouseDown={(e) => e.stopPropagation()}>
      <textarea
        ref={input}
        className="input"
        rows={2}
        placeholder="Tell the AI what to do with this… e.g. make this bounce"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            pin();
          } else if (e.key === "Escape") onClose();
        }}
      />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button className="btn" onClick={toggleMic} disabled={!Speech} title={Speech ? "Speak your instruction" : "Voice input isn't supported in this browser"}>
          {listening ? "■ Stop" : "🎤 Speak"}
        </button>
        <div className="row">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={pin} disabled={!text.trim()}>
            Pin
          </button>
        </div>
      </div>
    </div>
  );
}
