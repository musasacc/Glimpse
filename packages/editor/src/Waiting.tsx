import type { ReactNode } from "react";
import { engineLabel } from "./agent";
import { Mark } from "./Logo";
import { currentEngine, useStore } from "./store";

/**
 * The canvas before there's anything to show: the mark, pulsing, and what happens next (the AI is building, an
 * external agent is listening, or a request from the Home screen starts it). `children`: where the result appears.
 */
export function WaitingForAi({ children }: { children: ReactNode }) {
  const state = useStore();
  const title =
    state.agentRun ? `${engineLabel(state.agentRun.engine, state.agentInfo)} is building…`
    : currentEngine(state) === "external" && state.agentWaiting ? "Your agent is listening"
    : "Describe what you want on the Home screen";
  return (
    <div className="waiting">
      <div className="waiting-eye">
        <Mark weight={3} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
