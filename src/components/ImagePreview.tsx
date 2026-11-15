import { ReactNode, useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { formatBytes, imageType } from "../image";
import { PaneTitle } from "./DiffView";

/** One version of an image file: `path` as of revision `rev`. */
export interface ImageVersion {
  rev: string;
  path: string;
}

interface ImagePreviewProps {
  repo: string;
  /** The image before the change; null when the file was added. */
  before: ImageVersion | null;
  /** The image after the change; null when the file was deleted. */
  after: ImageVersion | null;
  title?: string;
  actions?: ReactNode;
}

/** Shows an image file before and after a change, side by side. */
export function ImagePreview({ repo, before, after, title, actions }: ImagePreviewProps) {
  const label = (side: "before" | "after") =>
    before && after ? (side === "before" ? "Before" : "After") : side === "before" ? "Deleted" : "Added";

  return (
    <div className="diff-view">
      <PaneTitle title={title} actions={actions} />
      <div className="diff-scroll image-compare">
        {before && <ImagePane repo={repo} version={before} label={label("before")} />}
        {after && <ImagePane repo={repo} version={after} label={label("after")} />}
      </div>
    </div>
  );
}

type Loaded = { url: string; bytes: number } | { error: string } | null;

function ImagePane({ repo, version, label }: { repo: string; version: ImageVersion; label: string }) {
  const { rev, path } = version;
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    setLoaded(null);
    setSize(null);
    let cancelled = false;
    let url: string | null = null;
    api
      .fileAtRevision(repo, rev, path)
      .then((data) => {
        if (cancelled) return;
        // SVG only renders from a blob with the right type; <img> never runs scripts inside it.
        url = URL.createObjectURL(new Blob([data], { type: imageType(path) ?? "" }));
        setLoaded({ url, bytes: data.byteLength });
      })
      .catch((e) => !cancelled && setLoaded({ error: errorMessage(e) }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [repo, rev, path]);

  const meta = [size && `${size.width} × ${size.height}`, loaded && "bytes" in loaded && formatBytes(loaded.bytes)]
    .filter(Boolean)
    .join(" · ");

  return (
    <figure className="image-pane">
      <figcaption>
        <span className="image-label">{label}</span>
        {meta && <span className="image-meta">{meta}</span>}
      </figcaption>
      <div className="image-frame">
        {!loaded ? (
          <div className="empty">Loading…</div>
        ) : "error" in loaded ? (
          <div className="empty error-text">{loaded.error}</div>
        ) : (
          <img
            src={loaded.url}
            alt={`${label}: ${path}`}
            onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            onError={() => setLoaded({ error: "This image could not be displayed" })}
          />
        )}
      </div>
    </figure>
  );
}
