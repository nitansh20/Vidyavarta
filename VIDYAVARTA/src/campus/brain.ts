/**
 * The local AI brain: Ollama running on the same laptop.
 * Nothing is uploaded anywhere. The brain only PREPARES drafts -
 * every send still passes the existing human approval gates.
 */
export interface BrainStatus { configured: boolean; model: string; host: string; available: boolean; checkedAt: string | null; error: string | null }

export class Brain {
  private cache: BrainStatus;
  private probeFlight: Promise<BrainStatus> | null = null;
  private probedAt = 0;
  constructor(readonly env: NodeJS.ProcessEnv = process.env) {
    this.cache = { configured: this.configured, model: this.model, host: this.host, available: false, checkedAt: null, error: 'Not checked yet.' };
  }
  get model(): string { return (this.env.OLLAMA_MODEL || 'llama3.2:3b').trim(); }
  get host(): string { return (this.env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim().replace(/\/+$/, ''); }
  get configured(): boolean { return Boolean(this.env.OLLAMA_HOST || this.env.OLLAMA_MODEL); }
  /** Last known status. Synchronous, never blocks a request. */
  status(): BrainStatus { return { ...this.cache }; }
  /** Ping Ollama (1.5 s timeout, single-flight, 30 s cache). */
  async probe(force = false): Promise<BrainStatus> {
    if (!force && this.cache.available && Date.now() - this.probedAt < 30_000) return this.status();
    if (this.probeFlight) return this.probeFlight;
    this.probeFlight = (async () => {
      try {
        const res = await fetch(this.host + '/api/tags', { signal: AbortSignal.timeout(1500) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const tags = await res.json() as { models?: { name?: string }[] };
        const names = (tags.models ?? []).map(m => String(m.name ?? '')).filter(Boolean);
        const family = this.model.split(':')[0];
        const hasModel = names.length === 0 || names.some(n => n === this.model || n.split(':')[0] === family);
        this.cache = { configured: this.configured, model: this.model, host: this.host, available: hasModel, checkedAt: new Date().toISOString(), error: hasModel ? null : `Ollama is running, but the model '${this.model}' is missing. Run:  ollama pull ${this.model}` };
      } catch {
        this.cache = { configured: this.configured, model: this.model, host: this.host, available: false, checkedAt: new Date().toISOString(), error: 'Ollama is not reachable on ' + this.host + '. Is Ollama running? (OLLAMA-SETUP.txt has the steps.)' };
      }
      this.probedAt = Date.now();
      return this.status();
    })().finally(() => { this.probeFlight = null; });
    return this.probeFlight;
  }
  /** One JSON answer from the model. Throws on transport or empty answers. */
  async chat(prompt: string, timeoutMs = 45_000): Promise<string> {
    const res = await fetch(this.host + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }], stream: false, format: 'json', options: { temperature: 0.2 } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error('Ollama answered HTTP ' + res.status);
    const data = await res.json() as { message?: { content?: string } };
    const text = String(data.message?.content ?? '');
    if (!text.trim()) throw new Error('Ollama returned an empty answer.');
    return text;
  }
}

/** Best-effort JSON extraction from a model answer (tolerates code fences). */
export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
