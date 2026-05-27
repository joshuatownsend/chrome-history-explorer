import { useCallback, useEffect, useState } from "react";
import { api, type DomainRow, type Filters, type TreeNode, type UrlRow } from "../api.ts";
import { fmtNum, fmtRelative } from "../lib/format.ts";
import { TreeNodeView } from "./TreeNodeView.tsx";

type SortKey = "visits" | "urls" | "last_visited" | "domain";

type Expansion =
  | "loading"
  | { kind: "flat"; rows: UrlRow[] }
  | { kind: "tree"; nodes: TreeNode[] };

interface Props {
  filters: Filters;
  onPickDomain: (domain: string) => void;
}

const TREE_PREF_KEY = "che.domainTreeView";

export function DomainView({ filters, onPickDomain }: Props) {
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<SortKey>("visits");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [treeMode, setTreeMode] = useState(() => localStorage.getItem(TREE_PREF_KEY) === "1");
  const [expanded, setExpanded] = useState<Record<string, Expansion>>({});

  const load = useCallback(async () => {
    const page = await api.domains(filters, sort, dir, 500, 0);
    setTotal(page.total);
    setRows(page.rows);
    setExpanded({});
  }, [filters, sort, dir]);

  useEffect(() => {
    void load();
  }, [load]);

  // Switching modes collapses everything (mixed flat/tree expansions would be confusing).
  useEffect(() => {
    localStorage.setItem(TREE_PREF_KEY, treeMode ? "1" : "0");
    setExpanded({});
  }, [treeMode]);

  const toggle = async (domain: string | null) => {
    if (!domain) return;
    if (expanded[domain]) {
      setExpanded((e) => {
        const next = { ...e };
        delete next[domain];
        return next;
      });
      return;
    }
    setExpanded((e) => ({ ...e, [domain]: "loading" }));
    if (treeMode) {
      const t = await api.tree(domain);
      setExpanded((e) => ({ ...e, [domain]: { kind: "tree", nodes: t.children } }));
    } else {
      const page = await api.urls({ ...filters, domain }, "visit_count", "desc", 100, 0);
      setExpanded((e) => ({ ...e, [domain]: { kind: "flat", rows: page.rows } }));
    }
  };

  const header = (key: SortKey, label: string, cls: string) => (
    <button
      onClick={() => {
        if (key === sort) setDir((d) => (d === "desc" ? "asc" : "desc"));
        else {
          setSort(key);
          setDir(key === "domain" ? "asc" : "desc");
        }
      }}
      className={`${cls} text-left hover:text-neutral-100`}
    >
      {label}
      {sort === key && <span className="ml-1">{dir === "desc" ? "↓" : "↑"}</span>}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center px-4 py-1.5 text-xs text-neutral-500">
        <span>{fmtNum(total)} domains</span>
        <label className="ml-auto flex items-center gap-1.5 text-neutral-400">
          <input type="checkbox" checked={treeMode} onChange={(e) => setTreeMode(e.target.checked)} />
          Tree view (group pages by path)
        </label>
      </div>
      <div className="flex gap-3 border-b border-neutral-800 px-4 py-2 text-xs font-medium text-neutral-400">
        {header("domain", "Domain", "flex-1")}
        {header("urls", "URLs", "w-20 shrink-0 text-right")}
        {header("visits", "Visits", "w-24 shrink-0 text-right")}
        {header("last_visited", "Last visit", "w-28 shrink-0 text-right")}
      </div>

      <div className="flex-1 overflow-auto">
        {rows.map((d) => {
          const key = d.domain ?? "(none)";
          const exp = expanded[key];
          return (
            <div key={key} className="border-b border-neutral-900">
              <div
                className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-neutral-900/70"
                onClick={() => toggle(d.domain)}
              >
                <div className="flex flex-1 items-center gap-2 truncate">
                  <span className="text-neutral-500">{exp ? "▾" : "▸"}</span>
                  <span className="truncate font-medium text-neutral-100">
                    {d.is_private ? "🔒 " : ""}
                    {d.domain}
                  </span>
                </div>
                <div className="w-20 shrink-0 text-right text-sm tabular-nums text-neutral-400">
                  {fmtNum(d.url_count)}
                </div>
                <div className="w-24 shrink-0 text-right text-sm tabular-nums">{fmtNum(d.visits)}</div>
                <div className="w-28 shrink-0 text-right text-xs text-neutral-400">
                  {fmtRelative(d.last_visited)}
                </div>
              </div>

              {exp === "loading" && <div className="px-10 py-2 text-xs text-neutral-500">loading…</div>}

              {typeof exp === "object" && exp.kind === "tree" && (
                <div className="bg-neutral-950/60 py-1">
                  {exp.nodes.length === 0 && (
                    <div className="px-10 py-2 text-xs text-neutral-600">no pages</div>
                  )}
                  {exp.nodes.map((n, i) => (
                    <TreeNodeView key={n.label + i} node={n} depth={0} />
                  ))}
                </div>
              )}

              {typeof exp === "object" && exp.kind === "flat" && (
                <div className="bg-neutral-950/60">
                  <div className="flex items-center justify-between px-10 py-1 text-xs text-neutral-600">
                    <span>top {exp.rows.length} URLs by visits</span>
                    <button className="text-blue-400 hover:text-blue-300" onClick={() => onPickDomain(key)}>
                      view all in list →
                    </button>
                  </div>
                  {exp.rows.map((u) => (
                    <a
                      key={u.id}
                      href={u.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-3 px-10 py-1 hover:bg-neutral-900"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-neutral-300" title={u.url}>
                        {u.title || u.url}
                      </span>
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-neutral-500">
                        {fmtNum(u.visit_count)}
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
