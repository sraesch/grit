import { FileChange } from "../api";
import { Dialog } from "./RemoteDialogs";

/** How many paths the dialog names before summing up the rest. */
const MAX_LISTED = 10;

interface DiscardDialogProps {
  files: FileChange[];
  onDiscard: (files: FileChange[]) => void;
  onClose: () => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Confirms discarding unstaged changes and deleting untracked files, which can't be undone. */
export function DiscardDialog({ files, onDiscard, onClose }: DiscardDialogProps) {
  const untracked = files.filter((f) => f.status === "?").length;
  const tracked = files.length - untracked;
  const onlyUntracked = tracked === 0;

  let question: string;
  if (files.length === 1) {
    question = onlyUntracked ? "Delete this untracked file?" : "Discard the unstaged changes to this file?";
  } else if (onlyUntracked) {
    question = `Delete ${plural(untracked, "untracked file")}?`;
  } else if (untracked === 0) {
    question = `Discard the unstaged changes to ${plural(tracked, "file")}?`;
  } else {
    const changes = plural(tracked, "file");
    question = `Discard the unstaged changes to ${changes} and delete ${plural(untracked, "untracked file")}?`;
  }

  const listed = files.slice(0, MAX_LISTED);
  return (
    <Dialog
      id="discard"
      title={onlyUntracked ? (files.length === 1 ? "Delete File" : "Delete Files") : "Discard Changes"}
      submitLabel={onlyUntracked ? "Delete" : "Discard"}
      danger
      canSubmit={files.length > 0}
      onSubmit={() => onDiscard(files)}
      onClose={onClose}
    >
      <p className="settings-hint">{question}</p>
      <ul className="discard-list">
        {listed.map((f) => (
          <li key={f.path}>{f.path}</li>
        ))}
        {files.length > listed.length && <li className="more">and {files.length - listed.length} more</li>}
      </ul>
      <p className="settings-hint warning-text" role="note">
        This can't be undone.{tracked > 0 && " Staged changes are kept."}
      </p>
    </Dialog>
  );
}
