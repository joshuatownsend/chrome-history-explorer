import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { fmtNum } from "../lib/format.ts";

const linesToArr = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export function SettingsView() {
  const [privateText, setPrivateText] = useState("");
  const [hiddenText, setHiddenText] = useState("");
  const [counts, setCounts] = useState<{ private: number; hidden: number; total: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getPrivacyRules().then((r) => {
      setPrivateText(r.privatePatterns.join("\n"));
      setHiddenText(r.hiddenPatterns.join("\n"));
      setCounts(r.counts);
    });
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await api.savePrivacyRules({
        privatePatterns: linesToArr(privateText),
        hiddenPatterns: linesToArr(hiddenText),
      });
      setCounts(res.counts);
      setStatus(
        `Saved. ${fmtNum(res.counts.private)} private, ${fmtNum(res.counts.hidden)} hidden ` +
          `(${fmtNum(res.changed)} reclassified). Reload other views to see changes.`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 overflow-auto p-6">
      <div>
        <h2 className="text-base font-semibold text-neutral-100">Privacy &amp; ignore rules</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Built-in rules always treat <code>localhost</code>, LAN IPs (<code>192.168.*</code>,{" "}
          <code>10.*</code>, …), and <code>*.local</code> as private. Add your own hosts below.
          One pattern per line — a bare domain like <code>example.com</code> also matches its
          subdomains; use <code>*</code> as a wildcard (e.g. <code>*.corp.net</code>).
        </p>
      </div>

      <section>
        <label className="text-sm font-medium text-neutral-200">Treat as private</label>
        <p className="mb-1 text-xs text-neutral-500">
          Still visible in the app, but never sent to liveness checks or AI providers, and shown
          with a 🔒.
        </p>
        <textarea
          value={privateText}
          onChange={(e) => setPrivateText(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={"intranet.example.com\n*.myhomelab.net\n100.64.*"}
          className="w-full rounded bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-200 ring-1 ring-neutral-700 focus:ring-blue-600"
        />
      </section>

      <section>
        <label className="text-sm font-medium text-neutral-200">Hide entirely</label>
        <p className="mb-1 text-xs text-neutral-500">
          Excluded from all browsing views, search, the domain tree, and dashboard lists.
        </p>
        <textarea
          value={hiddenText}
          onChange={(e) => setHiddenText(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={"webmail.example.com\n*.bank.com"}
          className="w-full rounded bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-200 ring-1 ring-neutral-700 focus:ring-blue-600"
        />
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-blue-700 px-4 py-1.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
        >
          {saving ? "Applying…" : "Save & apply"}
        </button>
        {counts && (
          <span className="text-xs text-neutral-500">
            {fmtNum(counts.private)} private · {fmtNum(counts.hidden)} hidden · {fmtNum(counts.total)} total URLs
          </span>
        )}
      </div>
      {status && <p className="text-sm text-green-400">{status}</p>}
    </div>
  );
}
