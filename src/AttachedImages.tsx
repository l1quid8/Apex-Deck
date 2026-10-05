import { useEffect, useState } from "react";

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
