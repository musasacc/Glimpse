import type { ReactNode, SVGProps } from "react";

/** Small stroke icon set (24×24, currentColor), so the editor needs no icon dependency. */
function Icon({ children, size = 16, ...rest }: { children: ReactNode; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const PlusCircle = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </Icon>
);
export const Search = (p: P) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);
export const Eye = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 12C5 7.5 19 7.5 21.5 12 19 16.5 5 16.5 2.5 12Z" />
    <circle cx="13" cy="11.5" r="2.5" />
  </Icon>
);
export const History = (p: P) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </Icon>
);
export const Folder = (p: P) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </Icon>
);
export const ArrowUp = (p: P) => (
  <Icon {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
);
export const Sidebar = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Icon>
);
export const PanelRight = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Icon>
);
export const Undo = (p: P) => (
  <Icon {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </Icon>
);
export const Redo = (p: P) => (
  <Icon {...p}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0 0 12h3" />
  </Icon>
);
export const Monitor = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </Icon>
);
export const Tablet = (p: P) => (
  <Icon {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M11 18h2" />
  </Icon>
);
export const Phone = (p: P) => (
  <Icon {...p}>
    <rect x="7" y="3" width="10" height="18" rx="2" />
    <path d="M11 18h2" />
  </Icon>
);
export const Terminal = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </Icon>
);
export const Layout = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M9 9v11" />
  </Icon>
);
export const Chart = (p: P) => (
  <Icon {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Icon>
);
export const Lock = (p: P) => (
  <Icon {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);
export const AppWindow = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 8h18M6.5 6h.01M9 6h.01" />
  </Icon>
);
export const Pointer = (p: P) => (
  <Icon {...p}>
    <path d="m4 4 7 17 2.5-7.5L21 11Z" />
  </Icon>
);
export const Hand = (p: P) => (
  <Icon {...p}>
    <path d="M7 11V6a2 2 0 0 1 4 0v5M11 10V4a2 2 0 0 1 4 0v6M15 10V6a2 2 0 0 1 4 0v8a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.5L3 14a2 2 0 0 1 3.5-2L7 13" />
  </Icon>
);
/* Multi-select editing: align, distribute, group, box prompt, discard. */
export const AlignLeft = (p: P) => (
  <Icon {...p}>
    <path d="M4 3v18" />
    <rect x="8" y="6" width="12" height="4" rx="1" />
    <rect x="8" y="14" width="7" height="4" rx="1" />
  </Icon>
);
export const AlignCenter = (p: P) => (
  <Icon {...p}>
    <path d="M12 3v3M12 10v4M12 18v3" />
    <rect x="5" y="6" width="14" height="4" rx="1" />
    <rect x="8" y="14" width="8" height="4" rx="1" />
  </Icon>
);
export const AlignRight = (p: P) => (
  <Icon {...p}>
    <path d="M20 3v18" />
    <rect x="4" y="6" width="12" height="4" rx="1" />
    <rect x="9" y="14" width="7" height="4" rx="1" />
  </Icon>
);
export const AlignTop = (p: P) => (
  <Icon {...p}>
    <path d="M3 4h18" />
    <rect x="6" y="8" width="4" height="12" rx="1" />
    <rect x="14" y="8" width="4" height="7" rx="1" />
  </Icon>
);
export const AlignMiddle = (p: P) => (
  <Icon {...p}>
    <path d="M3 12h3M10 12h4M18 12h3" />
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="8" width="4" height="8" rx="1" />
  </Icon>
);
export const AlignBottom = (p: P) => (
  <Icon {...p}>
    <path d="M3 20h18" />
    <rect x="6" y="4" width="4" height="12" rx="1" />
    <rect x="14" y="9" width="4" height="7" rx="1" />
  </Icon>
);
export const DistributeH = (p: P) => (
  <Icon {...p}>
    <path d="M4 3v18M20 3v18" />
    <rect x="9" y="7" width="6" height="10" rx="1" />
  </Icon>
);
export const DistributeV = (p: P) => (
  <Icon {...p}>
    <path d="M3 4h18M3 20h18" />
    <rect x="7" y="9" width="10" height="6" rx="1" />
  </Icon>
);
export const Group = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
    <rect x="7" y="7" width="5" height="5" rx="1" />
    <rect x="12" y="12" width="5" height="5" rx="1" />
  </Icon>
);
export const Ungroup = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </Icon>
);
export const BoxPrompt = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" strokeDasharray="3 2.5" />
    <path d="M8 12h8M12 9v6" />
  </Icon>
);
export const Trash = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="m6 7 1 13h10l1-13M9 7V4h6v3" />
  </Icon>
);
export const Code = (p: P) => (
  <Icon {...p}>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
  </Icon>
);
export const Send = (p: P) => (
  <Icon {...p}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" />
  </Icon>
);
export const Type = (p: P) => (
  <Icon {...p}>
    <path d="M4 7V5h16v2M9 19h6M12 5v14" />
  </Icon>
);
export const Heading = (p: P) => (
  <Icon {...p}>
    <path d="M6 4v16M18 4v16M6 12h12" />
  </Icon>
);
export const Link = (p: P) => (
  <Icon {...p}>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
  </Icon>
);
export const Input = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="7" width="18" height="10" rx="2" />
    <path d="M7 10v4" />
  </Icon>
);
export const Image = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="2" />
    <path d="m21 16-5-5-9 9" />
  </Icon>
);
export const ButtonIcon = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="8" width="18" height="8" rx="4" />
  </Icon>
);
export const Card = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 10h6M7 14h10" />
  </Icon>
);
export const Help = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5M12 17h.01" />
  </Icon>
);
export const Chevron = (p: P) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
