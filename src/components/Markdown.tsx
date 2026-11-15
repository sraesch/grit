import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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

/**
 * Renders GitHub-flavored markdown (autolinks, lists, tables, task lists, strikethrough).
 * Raw HTML is dropped, so text from commits can't inject markup into the app.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Splits a commit message into its summary (first line) and the trimmed body. */
export function splitCommitMessage(message: string): { summary: string; body: string } {
  const [summary, ...bodyLines] = message.trim().split("\n");
  return { summary: summary ?? "", body: bodyLines.join("\n").trim() };
}

interface CommitMessageProps {
  message: string;
  /** Render the body as markdown; otherwise it is shown verbatim. */
  markdown?: boolean;
}

/**
 * A commit message as git hosts show it: the summary line stays plain text and the body is
 * rendered as markdown.
 */
export function CommitMessage({ message, markdown = true }: CommitMessageProps) {
  const { summary, body } = splitCommitMessage(message);
  return (
    <>
      <div className="commit-summary">{summary}</div>
      {body &&
        (markdown ? (
          <Markdown className="commit-body-markdown">{body}</Markdown>
        ) : (
          <pre className="commit-body">{body}</pre>
        ))}
    </>
  );
}
