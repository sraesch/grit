import { ReactNode } from "react";

interface ToolbarButtonProps {
  icon: ReactNode;
  label: string;
  /** A count shown on the icon, e.g. commits to pull or push; hidden when 0. */
  badge?: number;
  /** A warning mark on the icon, described by `warning` for screen readers. */
  warning?: string | null;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}

/** A main toolbar button: an icon with its label underneath, as in Fork. */
export function ToolbarButton({ icon, label, badge, warning, title, disabled, onClick }: ToolbarButtonProps) {
  return (
    <button className="toolbar-button" title={title} disabled={disabled} onClick={onClick}>
      <span className="toolbar-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="toolbar-label">{label}</span>
      {/* After the label, so it reads as "Pull 2"; CSS places it on the icon. */}
      {!!badge && <span className="toolbar-badge">{badge}</span>}
      {warning && (
        <span className="toolbar-badge warning" aria-label={warning}>
          !
        </span>
      )}
    </button>
  );
}

/** A thin vertical line between groups of toolbar buttons. */
export function ToolbarDivider() {
  return <span className="toolbar-divider" aria-hidden="true" />;
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

/** Fetch: a light curved arrow down; it only updates the remote branches. */
export function FetchIcon() {
  return (
    <Icon>
      <path d="M19.5 3.5C13 3.5 9.5 7.5 9.5 14v4.5" strokeWidth={1.8} />
      <path d="M4.5 13.5l5 5 5-5" strokeWidth={1.8} />
    </Icon>
  );
}

/** Pull: a bold curved arrow down into the branch. */
export function PullIcon() {
  return (
    <Icon>
      <path d="M19.5 4C13.5 4 9.5 7.5 9.5 13" strokeWidth={4.2} />
      <path d="M3.5 12.5h12L9.5 20.5z" fill="currentColor" strokeWidth={1.5} />
    </Icon>
  );
}

/** Push: a bold curved arrow up from the branch. */
export function PushIcon() {
  return (
    <Icon>
      <path d="M4.5 20c6 0 10-3.5 10-9" strokeWidth={4.2} />
      <path d="M8.5 11.5h12L14.5 3.5z" fill="currentColor" strokeWidth={1.5} />
    </Icon>
  );
}

export function SettingsIcon() {
  return (
    <Icon>
      <g strokeWidth={1.8}>
        <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
        <circle cx="15" cy="7" r="2" />
        <circle cx="9" cy="17" r="2" />
      </g>
    </Icon>
  );
}

export function AboutIcon() {
  return (
    <Icon>
      <g strokeWidth={1.8}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5.5" />
      </g>
      <circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
    </Icon>
  );
}
