/** Pluggable AI provider abstraction (Claude / OpenAI). */

export interface AIProvider {
  name: string;
  canSummarize: boolean;
  canEmbed: boolean;
  /** One-paragraph summary of page text. */
  summarize(title: string, text: string): Promise<string>;
  /** Generic single-turn completion with a caller-supplied system prompt. */
  complete(system: string, user: string, maxTokens?: number): Promise<string>;
  /** Embed texts into vectors for semantic search. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface ProviderInfo {
  id: string; // 'anthropic' | 'openai'
  name: string;
  configured: boolean;
  canSummarize: boolean;
  canEmbed: boolean;
}

export class UnsupportedError extends Error {}

/** Cosine similarity for semantic search ranking. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const SUMMARY_SYSTEM =
  "You summarize a web page for someone scanning their browsing history. " +
  "In 1-2 sentences, say what the page is and why someone might have visited it. " +
  "Be concrete and factual. No preamble.";

export function buildSummaryPrompt(title: string, text: string): string {
  const body = text.slice(0, 6000);
  return `Title: ${title}\n\nPage text:\n${body}`;
}

export { SUMMARY_SYSTEM };
