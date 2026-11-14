/**
 * The grit logo (direction C, "Fork r"): a lowercase r drawn as a branch forking
 * from a commit. Paths are in the design's 360×360 tile coordinates.
 *
 * Colors come from CSS variables so the mark adapts to the theme: the dark tile
 * on light backgrounds and the light tile on dark backgrounds (see App.css).
 */

const STEM = "M138 93 L138 248";
const BRANCH = "M138 176 A70 70 0 0 1 208 106 L222 106";

interface MarkProps {
  size: number;
  /** Accessible name; omit for decorative use next to a visible "grit" label. */
  label?: string;
}

/** The app icon: the mark on its rounded tile. */
export function LogoTile({ size, label }: MarkProps) {
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <svg className="logo-tile" viewBox="0 0 360 360" width={size} height={size} {...a11y}>
      <rect width="360" height="360" rx="80" className="logo-bg" />
      <path d={STEM} className="logo-line" strokeWidth={34} strokeLinecap="round" fill="none" />
      <path d={BRANCH} className="logo-line" strokeWidth={34} fill="none" />
      <circle cx="138" cy="254" r="30" className="logo-commit" />
      {/* r=24 plus a 12px stroke covers r=30: a solid dot when fill and stroke match, a ringed dot otherwise. */}
      <circle cx="222" cy="106" r="24" className="logo-head" strokeWidth={12} />
    </svg>
  );
}

/** Horizontal lockup: tile plus the "grit" wordmark. */
export function LogoLockup({ size, as: Tag = "span" }: { size: number; as?: "span" | "h1" }) {
  return (
    <Tag className="logo-lockup" style={{ fontSize: size, gap: size * 0.3 }}>
      <LogoTile size={size} />
      <span className="logo-wordmark">grit</span>
    </Tag>
  );
}
