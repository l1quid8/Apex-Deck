import { useEffect, useState } from "react";
import { videoType } from "./attachments";
import { pathBase } from "./paths";

interface Props {
  paths: string[];
  read: (path: string) => Promise<ArrayBuffer>;
  /** Show the file in its folder. */
  onOpen: (path: string) => void;
  /** Settle the transcript after asynchronous media loading changes its height. */
  onLoad?: () => void;
}

/** The pictures a message attached, read from the app's attachments folder. */
export function AttachedImages({ paths, read, onOpen, onLoad }: Props) {
  if (!paths.length) return null;
  return <div className="attached-images">{paths.map((path) => <Picture key={path} path={path} read={read} onOpen={onOpen} onLoad={onLoad} />)}</div>;
}

function Picture({ path, read, onOpen, onLoad }: { path: string } & Omit<Props, "paths">) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let live = true;
    read(path).then((bytes) => {
      if (!live) return;
      made = URL.createObjectURL(new Blob([bytes]));
      setUrl(made);
    }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path, read]);
  if (!url) return null;
  const name = pathBase(path);
  return <button type="button" className="attached-image" title={path} onClick={() => onOpen(path)}><img src={url} alt={name} onLoad={onLoad} /></button>;
}

/** The videos a message attached, read the same way and shown with a player. */
export function AttachedVideos({ paths, read, onOpen, onLoad }: Props) {
  if (!paths.length) return null;
  return <div className="attached-images">{paths.map((path) => <Video key={path} path={path} read={read} onOpen={onOpen} onLoad={onLoad} />)}</div>;
}

function Video({ path, read, onOpen, onLoad }: { path: string } & Omit<Props, "paths">) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let live = true;
    read(path).then((bytes) => {
      if (!live) return;
      made = URL.createObjectURL(new Blob([bytes], { type: videoType(path) }));
      setUrl(made);
    }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path, read]);
  if (!url) return null;
  return <div className="attached-video">
    <video src={url} controls preload="metadata" playsInline onLoadedMetadata={onLoad} aria-label={pathBase(path)} />
    <button type="button" className="attached-video-open" title={path} onClick={() => onOpen(path)}>Show in folder</button>
  </div>;
}
