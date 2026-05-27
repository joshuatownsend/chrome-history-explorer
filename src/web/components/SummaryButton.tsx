import { useState } from "react";
import { api } from "../api.ts";

/**
 * On-demand AI summary for one URL. Fetches the page server-side, summarizes via
 * the configured provider, and shows the result inline. Disabled for private URLs.
 */
export function SummaryButton({ urlId, isPrivate, enabled }: { urlId: number; isPrivate: boolean; enabled: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [text, setText] = useState("");

  if (isPrivate || !enabled) return null;

  const run = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === "loading") return;
    setState("loading");
    const res = await api.summarize(urlId);
    if (res.summary) {
      setText(res.summary);
      setState("done");
    } else {
      setText(res.error ?? "failed");
      setState("error");
    }
  };

  if (state === "done" || state === "error") {
    return (
      <div className={`mt-1 text-xs ${state === "error" ? "text-orange-400" : "text-neutral-400"}`}>
        {state === "done" ? "✨ " : "⚠ "}
        {text}
      </div>
    );
  }

  return (
    <button
      onClick={run}
      className="text-xs text-neutral-600 hover:text-blue-400"
      title="Summarize this page with AI"
    >
      {state === "loading" ? "summarizing…" : "✨ summarize"}
    </button>
  );
}
