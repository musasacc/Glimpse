import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import * as I from "./icons";
import { TUI_FONT, TUI_FONT_SIZE, type SceneTarget } from "./scene-geometry";
import { sceneMode, useSceneMode } from "./scene-mode";
import { store, useStore } from "./store";
import { ANSI, SCREEN_BG, SCREEN_FG } from "./tui-colors";

/**
 * The real app next to its mock. A terminal UI runs in a real terminal
 * (xterm.js, fed by the server's pty over the websocket), by default at the
 * mock's size so the two compare cell for cell. A native GUI opens its own
 * window; its output shows here as a read-only log. The command always comes
 * from the server (--run, the MCP, or meta.command when the human presses Run).
 */
export function TerminalPane({ target }: { target: SceneTarget }) {
  useStore();
  const sm = useSceneMode();
  const t = sm.terminal;
  const readOnly = target === "native";
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const sent = useRef({ cols: 0, rows: 0 });
  const [fitMode, setFitMode] = useState<"mock" | "fit">(readOnly ? "fit" : "mock");
  const root = store.scene?.nodes[store.scene.rootId]?.layout;
  const mockCols = root?.w ?? 80;
  const mockRows = root?.h ?? 24;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const xterm = new Terminal({
      fontFamily: TUI_FONT,
      fontSize: TUI_FONT_SIZE,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: SCREEN_BG,
        foreground: SCREEN_FG,
        cursor: SCREEN_FG,
        selectionBackground: "#264f78",
        black: ANSI.black,
        red: ANSI.red,
        green: ANSI.green,
        yellow: ANSI.yellow,
        blue: ANSI.blue,
        magenta: ANSI.magenta,
        cyan: ANSI.cyan,
        white: ANSI.white,
        brightBlack: ANSI["bright-black"],
        brightRed: ANSI["bright-red"],
        brightGreen: ANSI["bright-green"],
        brightYellow: ANSI["bright-yellow"],
        brightBlue: ANSI["bright-blue"],
        brightMagenta: ANSI["bright-magenta"],
        brightCyan: ANSI["bright-cyan"],
        brightWhite: ANSI["bright-white"],
      },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(el);
    term.current = { term: xterm, fit };
    if (sceneMode.termBuffer) xterm.write(sceneMode.termBuffer);
    const off = sceneMode.onTerm((data) => (data === null ? xterm.reset() : xterm.write(data)));
    const input = xterm.onData((data) => {
      if (readOnly) return;
      sceneMode.input(data);
      // Without a TTY the app doesn't echo what is typed: show it here.
      const ts = sceneMode.state.terminal;
      if (ts.mode === "pipe" && ts.running) xterm.write(echo(data));
    });
    return () => {
      off();
      input.dispose();
      xterm.dispose();
      term.current = null;
    };
  }, [readOnly]);

  // Size the terminal: the mock's size (font scaled to fit the pane), or as many cells as fit.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const layout = () => {
      const x = term.current;
      if (!x || !el.clientWidth || !el.clientHeight) return;
      let cols: number;
      let rows: number;
      if (fitMode === "mock") {
        cols = mockCols;
        rows = mockRows;
        // The largest font (up to the mock's) at which cols×rows still fit.
        for (let size = TUI_FONT_SIZE; size >= 6; size -= 0.5) {
          if (x.term.options.fontSize !== size) x.term.options.fontSize = size;
          const fits = x.fit.proposeDimensions();
          if (!fits || (fits.cols >= cols && fits.rows >= rows)) break;
        }
        if (x.term.cols !== cols || x.term.rows !== rows) x.term.resize(cols, rows);
      } else {
        if (x.term.options.fontSize !== TUI_FONT_SIZE) x.term.options.fontSize = TUI_FONT_SIZE;
        x.fit.fit();
        cols = x.term.cols;
        rows = x.term.rows;
      }
      if (cols !== sent.current.cols || rows !== sent.current.rows) {
        sent.current = { cols, rows };
        sceneMode.resize(cols, rows);
      }
    };
    layout();
    const ro = new ResizeObserver(() => layout());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitMode, mockCols, mockRows, readOnly, sm.dock.side]);

  // A reconnect means a new websocket: tell the server our size again.
  useEffect(() => {
    if (store.state.connected && sent.current.cols) sceneMode.resize(sent.current.cols, sent.current.rows);
  }, [store.state.connected]);

  const command = t.command ?? (typeof sm.extras.meta?.command === "string" ? sm.extras.meta.command : null);
  const exited = !t.running && t.exit;
  const status = t.running ? "running" : exited ? `exited${exited.code !== null ? ` (${exited.code})` : exited.signal ? ` (${exited.signal})` : ""}` : t.command ? "stopped" : "not started";
  const dock = sm.dock;

  return (
    <section className={`term-pane${readOnly ? " is-log" : ""}`} style={dockStyle(dock)} aria-label={readOnly ? "App log" : "Terminal"}>
      <Splitter side={dock.side} />
      <header className="term-head">
        <span className={`term-dot${t.running ? " on" : ""}`} title={status} />
        <span className="term-name">{readOnly ? "App log" : "Terminal"}</span>
        {command ? (
          <code className="term-cmd ellipsis" title={command}>
            {command}
          </code>
        ) : (
          <span className="term-cmd hint">no command</span>
        )}
        <span className="term-status">{status}</span>
        {t.command && <span className="term-mode" title={t.mode === "pty" ? "A real terminal (pty)" : (t.fallbackReason ?? "No terminal: plain pipes")}>{t.mode}</span>}
        <span className="grow" />
        {t.running ? (
          <>
            <button className="btn" title="Stop the app, then start it again" onClick={() => sceneMode.run()}>
              <Restart /> Restart
            </button>
            <button className="btn" title="Stop the app" onClick={() => sceneMode.stop()}>
              <StopIcon /> Stop
            </button>
          </>
        ) : (
          <button className="btn primary" title={command ? `Run ${command}` : "Set meta.command in the scene file first"} onClick={() => sceneMode.run()}>
            <Play /> Run
          </button>
        )}
        {!readOnly && (
          <label className="term-check" title="Restart the app when its code is saved">
            <input type="checkbox" checked={t.autoRestart} onChange={(e) => sceneMode.setAutoRestart(e.target.checked)} />
            Restart on save
          </label>
        )}
        {!readOnly && (
          <button
            className="btn term-size"
            title={fitMode === "mock" ? "The terminal has the mock's size. Click to fill the pane instead." : "The terminal fills the pane. Click to match the mock's size."}
            onClick={() => setFitMode(fitMode === "mock" ? "fit" : "mock")}
          >
            {fitMode === "mock" ? `${mockCols}×${mockRows}` : "Fit"}
          </button>
        )}
        <button
          className="icon-btn"
          title={dock.side === "bottom" ? "Dock on the right" : "Dock at the bottom"}
          onClick={() => sceneMode.setDock({ side: dock.side === "bottom" ? "right" : "bottom" })}
        >
          <I.PanelRight />
        </button>
        <button className="icon-btn" title="Hide" onClick={() => sceneMode.setDock({ open: false })}>
          <Close />
        </button>
      </header>
      {(t.error || (t.command && t.mode === "pipe") || !command) && (
        <div className={`term-note${t.error ? " error" : ""}`}>
          {t.error ??
            (!command
              ? 'Nothing to run yet: set meta.command in the scene file (e.g. "python app.py"), or start Glimpse with --run "<command>".'
              : `No TTY: limited input, keys reach the app line by line.${t.fallbackReason ? ` ${t.fallbackReason}` : ""}`)}
        </div>
      )}
      <div className="term-host" ref={host} onPointerDown={(e) => e.stopPropagation()} />
    </section>
  );
}

/** The pane's width (docked right) or height (at the bottom). */
export function dockStyle(dock: { side: "right" | "bottom"; size?: number }): React.CSSProperties {
  const size = dock.size ?? "45%";
  return dock.side === "right" ? { width: size } : { height: size };
}

/** Drag the pane's edge to make it bigger or smaller. */
function Splitter({ side }: { side: "right" | "bottom" }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const pane = el.parentElement!;
    const start = side === "right" ? e.clientX : e.clientY;
    const from = side === "right" ? pane.offsetWidth : pane.offsetHeight;
    const max = (side === "right" ? pane.parentElement!.clientWidth : pane.parentElement!.clientHeight) - 160;
    const move = (ev: PointerEvent) => {
      const d = start - (side === "right" ? ev.clientX : ev.clientY);
      sceneMode.setDock({ size: Math.max(140, Math.min(max, from + d)) });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return <div className={`term-splitter ${side}`} onPointerDown={onPointerDown} role="separator" aria-orientation={side === "right" ? "vertical" : "horizontal"} />;
}

/** What a terminal would echo for typed input (pipe mode has no echo of its own). */
function echo(data: string): string {
  if (data === "\r") return "\r\n";
  if (data === "\x7f" || data === "\b") return "\b \b";
  // Arrow keys and other escape sequences don't print.
  return data.startsWith("\x1b") ? "" : data.replace(/\r/g, "\r\n");
}

const Play = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 2l7 4-7 4z" fill="currentColor" />
  </svg>
);

const StopIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="currentColor" />
  </svg>
);

const Restart = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

const Close = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
