import { useEffect, useMemo, useState, type ReactNode } from "react";

import { parseBlocks, parseInline, pathLike, type Block, type Inline } from "./markdownText";
import { RichText } from "./RichText";

interface Props {
  text: string;
  /** Open a file, folder or web address a link points at. */
  onOpen: (target: string, reveal?: boolean) => void;
  /** Extra controls for a code block's header, beside Copy. */
  codeAction?: (code: { language: string; text: string }) => ReactNode;
  /** Whether a path in a code span exists; those that do become links. */
  pathExists?: (path: string) => Promise<boolean>;
}

/**
 * A bot's reply, drawn from the markdown it was written in.
 *
 * Structure (headings, lists, code blocks, tables) comes from markdownText.ts.
 * Links are left to RichText, so they behave the same here as everywhere
 * else in the chat.
 */
export function Markdown({ text, onOpen, codeAction, pathExists }: Props) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const inline = (source: string) => <InlineText source={source} onOpen={onOpen} pathExists={pathExists} />;
  return (
    <div className="md">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} inline={inline} codeAction={codeAction} />
      ))}
    </div>
  );
}

function InlineText({ source, onOpen, pathExists }: { source: string; onOpen: Props["onOpen"]; pathExists?: Props["pathExists"] }) {
  const spans = useMemo(() => parseInline(source), [source]);
  const draw = (span: Inline, key: number): ReactNode => {
    switch (span.kind) {
      case "text":
        return <RichText key={key} text={span.text} onOpen={onOpen} />;
      case "code":
        return pathExists && pathLike(span.text) ? <PathCode key={key} path={span.text.trim()} onOpen={onOpen} pathExists={pathExists} /> : <code key={key}>{span.text}</code>;
      case "bold":
        return <strong key={key}>{span.children.map(draw)}</strong>;
      case "italic":
        return <em key={key}>{span.children.map(draw)}</em>;
      case "strike":
        return <s key={key}>{span.children.map(draw)}</s>;
    }
  };
  return <>{spans.map(draw)}</>;
}

/** A path in a code span: a link like any other once it's known to exist, plain code until then. */
function PathCode({ path, onOpen, pathExists }: { path: string; onOpen: Props["onOpen"]; pathExists: NonNullable<Props["pathExists"]> }) {
  const [real, setReal] = useState(false);
  useEffect(() => {
    let alive = true;
    pathExists(path).then((yes) => alive && setReal(yes), () => {});
    return () => { alive = false; };
  }, [path, pathExists]);
  return <code>{real ? <RichText text={`[${path}](${path})`} onOpen={onOpen} /> : path}</code>;
}

function BlockView({ block, inline, codeAction }: { block: Block; inline: (source: string) => ReactNode; codeAction?: Props["codeAction"] }) {
  switch (block.kind) {
    case "paragraph":
      return <p>{inline(block.text)}</p>;
    case "heading":
      return (
        <p className={`md-heading level-${Math.min(block.level, 4)}`} role="heading" aria-level={block.level}>
          {inline(block.text)}
        </p>
      );
    case "code":
      return <CodeBlock language={block.language} text={block.text} action={codeAction?.({ language: block.language, text: block.text })} />;
    case "quote":
      return <blockquote>{inline(block.text)}</blockquote>;
    case "rule":
      return <hr />;
    case "list": {
      // Numbered items keep the numbers they were written with, so a list
      // that starts at 3 or is split by a paragraph still reads correctly.
      return (
        <ul className={block.ordered ? "md-list numbered" : "md-list"}>
          {block.items.map((item, i) => (
            <li key={i} style={{ marginLeft: `${item.depth * 1.4}em` }}>
              <span className="md-marker" aria-hidden={item.number === undefined}>
                {item.number !== undefined ? `${item.number}.` : "•"}
              </span>
              <span className="md-item">{inline(item.text)}</span>
            </li>
          ))}
        </ul>
      );
    }
    case "table":
      return (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function CodeBlock({ language, text, action }: { language: string; text: string; action?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{language || "code"}</span>
        <span className="md-code-actions">
          {action}
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
