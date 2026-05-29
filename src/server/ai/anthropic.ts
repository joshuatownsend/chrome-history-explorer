import {
  buildSummaryPrompt,
  SUMMARY_SYSTEM,
  UnsupportedError,
  type AIProvider,
} from "./provider.ts";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

/** Claude provider: summarization via the Messages API. (No native embeddings.) */
export class AnthropicProvider implements AIProvider {
  name = "Claude (Anthropic)";
  canSummarize = true;
  canEmbed = false;

  constructor(private apiKey: string) {}

  summarize(title: string, text: string): Promise<string> {
    return this.complete(SUMMARY_SYSTEM, buildSummaryPrompt(title, text));
  }

  async complete(system: string, user: string, maxTokens = 200): Promise<string> {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { content?: { text?: string }[] };
    return data.content?.[0]?.text?.trim() ?? "";
  }

  async embed(): Promise<number[][]> {
    throw new UnsupportedError("Anthropic has no native embeddings — use OpenAI for semantic search.");
  }
}
