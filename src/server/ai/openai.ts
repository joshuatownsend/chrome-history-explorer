import { buildSummaryPrompt, SUMMARY_SYSTEM, type AIProvider } from "./provider.ts";

const CHAT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";

/** OpenAI provider: summarization + embeddings (semantic search). */
export class OpenAIProvider implements AIProvider {
  name = "OpenAI";
  canSummarize = true;
  canEmbed = true;

  constructor(private apiKey: string) {}

  private headers() {
    return { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
  }

  async summarize(title: string, text: string): Promise<string> {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 200,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM },
          { role: "user", content: buildSummaryPrompt(title, text) },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }

  async complete(system: string, user: string, maxTokens = 200): Promise<string> {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }

  async embed(texts: string[]): Promise<number[][]> {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    });
    if (!r.ok) throw new Error(`OpenAI embed ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { data?: { embedding: number[] }[] };
    return (data.data ?? []).map((d) => d.embedding);
  }
}
