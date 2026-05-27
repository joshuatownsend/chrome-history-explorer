import { useState } from "react";
import type { TreeNode } from "../api.ts";
import { fmtNum } from "../lib/format.ts";
import { LivenessBadge } from "./LivenessBadge.tsx";

interface Props {
  node: TreeNode;
  depth: number;
}

export function TreeNodeView({ node, depth }: Props) {
  const [open, setOpen] = useState(false);
  const hasChildren = node.children.length > 0;
  const label = node.isPage ? node.title || node.label : node.label;

  return (
    <div>
      <div
        className="flex items-center gap-2 border-b border-neutral-900/60 py-1 pr-4 hover:bg-neutral-900/50"
        style={{ paddingLeft: 40 + depth * 18 }}
      >
        {hasChildren ? (
          <button onClick={() => setOpen((o) => !o)} className="w-4 shrink-0 text-neutral-500 hover:text-neutral-300">
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {node.isPage && node.url ? (
          <a
            href={node.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate text-sm text-neutral-200 hover:text-blue-400"
            title={node.url}
          >
            <span className="mr-1 text-neutral-600">●</span>
            {label}
          </a>
        ) : (
          <button
            onClick={() => hasChildren && setOpen((o) => !o)}
            className="min-w-0 flex-1 truncate text-left text-sm font-medium text-neutral-300"
            title={node.label}
          >
            {node.isPrivate ? "🔒 " : ""}
            {label}
          </button>
        )}

        {node.isPage && <LivenessBadge status={node.liveness ?? null} resultJson={node.livenessJson ?? null} />}

        {hasChildren && (
          <span className="shrink-0 text-[10px] text-neutral-600" title={`${node.pageCount} pages`}>
            {fmtNum(node.pageCount)}p
          </span>
        )}
        <span className="w-20 shrink-0 text-right text-sm tabular-nums text-neutral-400" title="total visits in this branch">
          {fmtNum(node.visits)}
        </span>
      </div>

      {open &&
        node.children.map((child, i) => (
          <TreeNodeView key={child.label + i} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}
