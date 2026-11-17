import { Operation } from "../api";
import { operationName, operationTitle } from "../remote";

interface OperationBannerProps {
  operation: Operation;
  /** Files that still have conflicts. */
  conflicts: number;
  busy: boolean;
  onAbort: () => void;
  onContinue: () => void;
  onSkip: () => void;
}

/**
 * Shown while a merge, rebase, cherry-pick or revert waits for the user, typically after a
 * pull stopped on conflicts: explains what to do and offers to continue, skip or abort.
 */
export function OperationBanner({ operation, conflicts, busy, onAbort, onContinue, onSkip }: OperationBannerProps) {
  const name = operationName(operation);
  const merge = operation.kind === "merge";
  const todo =
    conflicts > 0
      ? `Resolve the conflicts in ${conflicts} file${conflicts === 1 ? "" : "s"} and mark them resolved, then ${
          merge ? "commit to finish the merge" : "continue"
        }.`
      : merge
        ? "All conflicts are resolved. Commit to finish the merge, here or with your own message in Local changes."
        : "All conflicts are resolved. Continue to go on.";

  return (
    <div className="operation-banner" role="status">
      <div className="operation-text">
        <strong>{operationTitle(operation)}</strong>
        <span>{todo}</span>
      </div>
      <button
        className="small primary"
        disabled={busy || conflicts > 0}
        title={conflicts > 0 ? "Resolve all conflicts first" : merge ? "Commit with the prepared merge message" : `Continue the ${name}`}
        onClick={onContinue}
      >
        {merge ? "Commit merge" : "Continue"}
      </button>
      {!merge && (
        <button className="small" disabled={busy} title="Leave out the commit that stopped" onClick={onSkip}>
          Skip commit
        </button>
      )}
      <button className="small danger" disabled={busy} title={`Undo the ${name} and go back to where you were`} onClick={onAbort}>
        Abort {name}
      </button>
    </div>
  );
}
