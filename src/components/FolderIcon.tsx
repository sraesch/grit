/** A folder outline for the folder rows of a tree; drawn open while the folder is expanded. */
export function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="folder-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
      data-open={open}
    >
      {open ? (
        <path d="M1.5 12.5V3.5a1 1 0 0 1 1-1h3.6l1.5 1.8h5.4a1 1 0 0 1 1 1v1.8M1.5 12.5l2-5.2h11.2l-2 5.2z" />
      ) : (
        <path d="M1.5 3.5a1 1 0 0 1 1-1h3.6l1.5 1.8h5.9a1 1 0 0 1 1 1v6.7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
      )}
    </svg>
  );
}
