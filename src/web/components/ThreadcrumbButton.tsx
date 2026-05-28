import { useState } from "react";
import { api } from "../api.ts";

/**
 * Sends one history link to ThreadCrumb (server-side proxy). Hidden for private
 * URLs and when the integration isn't configured. `compact` renders an icon-only
 * button for dense rows (the virtualized table); otherwise a labeled button.
 */
export function ThreadcrumbButton({
  url,
  isPrivate,
  enabled,
  compact,
}: {
  url: string;
  isPrivate: boolean;
  enabled: boolean;
  compact?: boolean;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");

  if (isPrivate || !enabled) return null;

  const send = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (state === "sending" || state === "sent") return;
    setState("sending");
    const res = await api.sendToThreadcrumb(url);
    if (res.error) {
      setMsg(res.error);
      setState("error");
    } else {
      setState("sent");
    }
  };

  const label = compact
    ? { idle: "🧵", sending: "…", sent: "✓", error: "⚠" }[state]
    : { idle: "🧵 ThreadCrumb", sending: "sending…", sent: "✓ sent", error: `⚠ ${msg}` }[state];

  const tone =
    state === "error"
      ? "text-orange-400"
      : state === "sent"
        ? "text-green-400"
        : "text-neutral-600 hover:text-blue-400";

  const title =
    state === "error" ? msg : state === "sent" ? "Sent to ThreadCrumb" : "Send this link to ThreadCrumb";

  return (
    <button
      onClick={send}
      disabled={state === "sending" || state === "sent"}
      className={`text-xs disabled:cursor-default ${tone}`}
      title={title}
    >
      {label}
    </button>
  );
}
