import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
 * With `onPin`, the text goes there instead (the box prompt reuses this popover).
 */
export function TalkPopover({
  node,
  anchor,
  onClose,
  onPin,
  placeholder = "Tell the AI what to do with this… e.g. make this bounce",
}: {
  node?: string;
  anchor: { left: number; top: number; height: number };
  onClose: () => void;
  onPin?: (text: string) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const Speech = speechRecognition();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.top + anchor.height + 8 });

  useEffect(() => {
    input.current?.focus();
    return () => rec.current?.stop();
  }, []);

  // Stay inside the preview: open above the element when there is no room below.
  useLayoutEffect(() => {
    const el = box.current;
    const area = el?.offsetParent as HTMLElement | null;
    const below = anchor.top + anchor.height + 8;
    if (!el || !area) return;
    const above = anchor.top - 8 - el.offsetHeight;
    const top = below + el.offsetHeight <= area.clientHeight || above < 0 ? below : above;
    setPos({
      left: Math.max(8, Math.min(anchor.left, area.clientWidth - el.offsetWidth - 8)),
      top: Math.max(8, Math.min(top, area.clientHeight - el.offsetHeight - 8)),
    });
  }, [anchor.left, anchor.top, anchor.height]);

  const pin = () => {
    const t = text.trim();
    if (t && onPin) onPin(t);
    else if (t && node) store.edit({ op: "comment", node, id: `c${Date.now().toString(36)}`, text: t });
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
    <div ref={box} className="talk" style={pos} onMouseDown={(e) => e.stopPropagation()}>
      <textarea
        ref={input}
        className="input"
        rows={2}
        placeholder={placeholder}
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
