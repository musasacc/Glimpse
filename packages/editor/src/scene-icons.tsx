import type { ReactNode } from "react";
import type { NodeType } from "@glimpse/core";
import * as I from "./icons";

/** Icons for the widgets of terminal UIs and native GUIs (24×24 strokes, like icons.tsx). */
function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const ICONS: Partial<Record<NodeType, () => ReactNode>> = {
  button: () => <I.ButtonIcon />,
  label: () => <I.Type />,
  text: () => (
    <Icon>
      <path d="M4 6h16M4 10h16M4 14h12M4 18h8" />
    </Icon>
  ),
  input: () => <I.Input />,
  checkbox: () => (
    <Icon>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="m8 12 3 3 5-6" />
    </Icon>
  ),
  radio: () => (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </Icon>
  ),
  switch: () => (
    <Icon>
      <rect x="2" y="7" width="20" height="10" rx="5" />
      <circle cx="17" cy="12" r="3" fill="currentColor" />
    </Icon>
  ),
  select: () => (
    <Icon>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="m14 11 2 2 2-2" />
    </Icon>
  ),
  list: () => (
    <Icon>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="5" cy="6" r="1" fill="currentColor" />
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="5" cy="18" r="1" fill="currentColor" />
    </Icon>
  ),
  table: () => (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 14.5h18M10 4v16" />
    </Icon>
  ),
  tree: () => (
    <Icon>
      <path d="M6 3v14a2 2 0 0 0 2 2h4M6 9h6" />
      <rect x="13" y="6" width="7" height="6" rx="1" />
      <rect x="13" y="16" width="7" height="6" rx="1" />
    </Icon>
  ),
  tabs: () => (
    <Icon>
      <path d="M3 20V7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v10z" />
      <path d="M11 8h10" />
    </Icon>
  ),
  progress: () => (
    <Icon>
      <rect x="2" y="9" width="20" height="6" rx="3" />
      <path d="M5 12h8" strokeWidth={3} />
    </Icon>
  ),
  slider: () => (
    <Icon>
      <path d="M3 12h18" />
      <circle cx="10" cy="12" r="3" fill="currentColor" />
    </Icon>
  ),
  panel: () => (
    <Icon>
      <rect x="3" y="5" width="18" height="15" rx="2" />
      <path d="M6 5V4M6 5h6" strokeWidth={3} />
    </Icon>
  ),
  box: () => (
    <Icon>
      <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" />
    </Icon>
  ),
  divider: () => (
    <Icon>
      <path d="M3 12h18" />
      <path d="M7 6h10M7 18h10" opacity={0.4} />
    </Icon>
  ),
  menu: () => (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M6 6.5h3M11 6.5h3" />
    </Icon>
  ),
  statusbar: () => (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 15h18M6 17.5h3M11 17.5h5" />
    </Icon>
  ),
  image: () => <I.Image />,
};

export function WidgetIcon({ type }: { type: NodeType }) {
  return <>{(ICONS[type] ?? ICONS.box!)()}</>;
}
