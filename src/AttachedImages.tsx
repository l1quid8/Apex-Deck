import { useEffect, useState } from "react";
import { videoType } from "./attachments";

interface Props {
  paths: string[];
  read: (path: string) => Promise<ArrayBuffer>;
  /** Show the file in its folder. */
  onOpen: (path: string) => void;
}

/** The pictures a message attached, read from the app's attachments folder. */
export function AttachedImages({ paths, read, onOpen }: Props) {
  if (!paths.length) return null;
  return <div className="attached-images">{paths.map((path) => <Picture key={path} path={path} read={read} onOpen={onOpen} />)}</div>;
}

function Picture({ path, read, onOpen }: { path: string } & Omit<Props, "paths">) {
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
  const name = path.split("/").pop() ?? path;
  return <button type="button" className="attached-image" title={path} onClick={() => onOpen(path)}><img src={url} alt={name} /></button>;
}

/** The videos a message attached, read the same way and shown with a player. */
export function AttachedVideos({ paths, read, onOpen }: Props) {
  if (!paths.length) return null;
  return <div className="attached-images">{paths.map((path) => <Video key={path} path={path} read={read} onOpen={onOpen} />)}</div>;
}

function Video({ path, read, onOpen }: { path: string } & Omit<Props, "paths">) {
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
    <video src={url} controls preload="metadata" playsInline aria-label={path.split("/").pop() ?? path} />
    <button type="button" className="attached-video-open" title={path} onClick={() => onOpen(path)}>Show in folder</button>
  </div>;
}
