// Cloudflare Worker that runs the BuildrBank Docker image (Dockerfile) as a
// container and forwards every request to uvicorn on port 8000.
import { DurableObject } from "cloudflare:workers";

const PORT = 8000;                       // matches EXPOSE / CMD in Dockerfile
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // sleep after 10 min idle

// Secrets set in the Cloudflare dashboard (Worker -> Settings -> Variables and Secrets).
const PASS_THROUGH = [
  "OPENROUTER_API_KEY", "SUPABASE_URL", "SUPABASE_KEY",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST",
  "TAVILY_API_KEY", "ANSWER_MODEL", "ROUTER_MODEL", "JUDGE_MODEL", "EMBED_MODEL",
];

interface Env {
  APP: DurableObjectNamespace<BuildrBank>;
  [key: string]: unknown;
}

export class BuildrBank extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  async fetch(request: Request): Promise<Response> {
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    await this.starting;

    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container!.getTcpPort(PORT).fetch(forwarded);
  }

  private async start(): Promise<void> {
    const container = this.ctx.container!;
    if (!container.running) {
      const env: Record<string, string> = {};
      for (const k of PASS_THROUGH) {
        const v = this.env[k];
        if (typeof v === "string" && v) env[k] = v;
      }
      container.start({
        image: container.images.base,
        instance: "basic",
        enableInternet: true,   // the agent must reach OpenRouter, Supabase, Langfuse
        env,
      });
      this.ctx.waitUntil(container.monitor().catch((e) => console.error("Container failed:", e)));
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    // Wait until FastAPI answers /health (startup loads models config etc.).
    const port = container.getTcpPort(PORT);
    for (let i = 0; i < 300; i++) {
      try {
        const r = await port.fetch("http://container/health", { signal: AbortSignal.timeout(2000) });
        await r.body?.cancel();
        if (r.status < 500) return;
      } catch { /* not listening yet */ }
      await scheduler.wait(500);
    }
    throw new Error("BuildrBank container did not become ready on port 8000");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One shared instance, so chat memory (SQLite in /app/data) is shared too.
    return env.APP.getByName("main").fetch(request);
  },
};
