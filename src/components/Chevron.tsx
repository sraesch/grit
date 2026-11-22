/** The toggle arrow of a collapsible row: points right when closed, down when open. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`chevron${open ? " open" : ""}`}
      viewBox="0 0 10 10"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 1.5 7 5 3.5 8.5" />
    </svg>
  );
}
