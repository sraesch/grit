import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef } from "react";
import Markdown, { Components } from "react-markdown";
import appChangelog from "../../CHANGELOG.app.md?raw";
import { LogoLockup } from "./Logo";

interface Props {
  onClose: () => void;
  /** Defaults to the app version from package.json. */
  version?: string;
  /** Markdown; defaults to CHANGELOG.app.md. */
  changelog?: string;
}

// Links open in the system browser; following them inside the webview would replace the app.
const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
};

/** Modal with the logo, the app version and the user-facing changelog. */
export function AboutDialog({ onClose, version = __APP_VERSION__, changelog = appChangelog }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const hasReleases = /^## /m.test(changelog);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal about" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <header className="about-header">
          <LogoLockup size={44} />
          <h2 id="about-title" className="visually-hidden">
            About grit
          </h2>
          <div className="about-version selectable">Version {version}</div>
        </header>
        <div className="about-changelog selectable">
          {/* skipHtml drops raw HTML, including the maintainer comment at the top of the file. */}
          <Markdown components={components} skipHtml>{changelog}</Markdown>
          {!hasReleases && <p className="empty small">No released versions yet.</p>}
        </div>
        <footer className="modal-footer">
          <button ref={closeRef} className="primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
