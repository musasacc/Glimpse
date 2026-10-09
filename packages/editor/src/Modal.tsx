import { useEffect, useId, useRef } from "react";
import { animateOut } from "./motion";

/** How many modal dialogs are on screen: editor shortcuts stay off while any is (they'd act on the page behind it). */
let open = 0;
export function modalOpen(): boolean {
  return open > 0;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog over the editor: a scrim, `role="dialog"` with `aria-modal`, its first `h2` as the label, focus moved
 * in (to an `autoFocus` control, or the dialog) and kept in with Tab, and back where it was on close. Escape and a click
 * on the scrim close it, except while `busy` (a request is in flight and its outcome must stay on screen).
 */
export function Modal({
  onClose,
  busy = false,
  className = "",
  role = "dialog",
  children,
}: {
  onClose: () => void;
  busy?: boolean;
  className?: string;
  role?: "dialog" | "alertdialog";
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const titleId = useId();
  // Escape and the scrim close it with a short fade (the dialog's own buttons close it at once, as they act).
  const closeIfIdle = () => {
    if (busy || leaving.current) return;
    leaving.current = true;
    animateOut(scrim.current, "leaving", 140, onClose);
  };

  useEffect(() => {
    open++;
    const before = document.activeElement as HTMLElement | null;
    const el = dialog.current;
    // autoFocus already ran in the children's commit; otherwise focus the dialog so keys land here.
    if (el && !el.contains(document.activeElement)) el.focus();
    el?.querySelector("h2")?.setAttribute("id", titleId);
    return () => {
      open--;
      if (before?.isConnected && before !== document.body) before.focus({ preventScroll: true });
    };
  }, [titleId]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keep editor shortcuts (Delete, arrows, undo…) away from the page behind the dialog.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      closeIfIdle();
    } else if (e.key === "Tab" && dialog.current) {
      const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (items.length === 0) return e.preventDefault();
      const first = items[0]!;
      const last = items.at(-1)!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === dialog.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div ref={scrim} className="scrim" onMouseDown={closeIfIdle} onKeyDown={onKeyDown}>
      <div
        ref={dialog}
        className={`dialog ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
