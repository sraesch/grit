/** The `mergeTool` setting that runs the user's own command. */
export const CUSTOM_MERGE_TOOL = "custom";

/** git's built-in merge tools that open a window of their own, by the name git knows them by. */
export const MERGE_TOOLS: { name: string; label: string }[] = [
  { name: "araxis", label: "Araxis Merge" },
  { name: "bc", label: "Beyond Compare" },
  { name: "codecompare", label: "Code Compare" },
  { name: "deltawalker", label: "DeltaWalker" },
  { name: "diffmerge", label: "DiffMerge" },
  { name: "diffuse", label: "Diffuse" },
  { name: "ecmerge", label: "ECMerge" },
  { name: "examdiff", label: "ExamDiff Pro" },
  { name: "opendiff", label: "FileMerge (opendiff)" },
  { name: "guiffy", label: "Guiffy" },
  { name: "gvimdiff", label: "gVim" },
  { name: "kdiff3", label: "KDiff3" },
  { name: "meld", label: "Meld" },
  { name: "p4merge", label: "P4Merge" },
  { name: "smerge", label: "Sublime Merge" },
  { name: "tkdiff", label: "TkDiff" },
  { name: "tortoisemerge", label: "TortoiseMerge" },
  { name: "vscode", label: "Visual Studio Code" },
  { name: "winmerge", label: "WinMerge" },
  { name: "xxdiff", label: "xxdiff" },
];

/** The choices for the merge tool setting; a stored name that isn't one of git's known tools is kept. */
export function mergeToolChoices(current: string): { value: string; label: string }[] {
  const tools = MERGE_TOOLS.map((t) => ({ value: t.name, label: t.label }));
  if (current && current !== CUSTOM_MERGE_TOOL && !MERGE_TOOLS.some((t) => t.name === current)) {
    tools.push({ value: current, label: current });
  }
  return [
    { value: "", label: "As configured in git" },
    ...tools,
    { value: CUSTOM_MERGE_TOOL, label: "Custom command" },
  ];
}

/** Whether a message from saving the settings is about the merge tool, so it is shown there. */
export function isMergeToolError(message: string): boolean {
  return /merge tool/i.test(message);
}
