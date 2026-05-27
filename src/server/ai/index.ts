import { AnthropicProvider } from "./anthropic.ts";
import { OpenAIProvider } from "./openai.ts";
import type { AIProvider, ProviderInfo } from "./provider.ts";

function anthropicKey() {
  return process.env.ANTHROPIC_API_KEY?.trim() || "";
}
function openaiKey() {
  return process.env.OPENAI_API_KEY?.trim() || "";
}

/** What providers are available, for the /config endpoint + UI gating. */
export function providerInfo(): ProviderInfo[] {
  return [
    {
      id: "anthropic",
      name: "Claude (Anthropic)",
      configured: !!anthropicKey(),
      canSummarize: true,
      canEmbed: false,
    },
    {
      id: "openai",
      name: "OpenAI",
      configured: !!openaiKey(),
      canSummarize: true,
      canEmbed: true,
    },
  ];
}

/** Resolve a provider for a capability, honoring an optional preference. */
export function getProvider(opts: { need: "summarize" | "embed"; prefer?: string }): AIProvider | null {
  const ak = anthropicKey();
  const ok = openaiKey();
  const anthropic = ak ? new AnthropicProvider(ak) : null;
  const openai = ok ? new OpenAIProvider(ok) : null;

  if (opts.need === "embed") return openai; // only OpenAI embeds

  // summarize: honor preference, else first configured.
  if (opts.prefer === "anthropic" && anthropic) return anthropic;
  if (opts.prefer === "openai" && openai) return openai;
  return anthropic ?? openai;
}
