import { getLoopConfig, requireAdmin, updateLoopConfig } from "./config";
import { runAutopilotTick } from "./loop";
import { json, okCors, withCors } from "./response";
import { listTrades } from "./trade_index";
import type { Env } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (request.method === "OPTIONS") {
      return okCors(env);
    }

    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return withCors(json({ ok: true }), env);
      }

      if (request.method === "POST" && url.pathname === "/api/waitlist") {
        const payload = await readPayload(request);
        const email = String(payload.email ?? "")
          .trim()
          .toLowerCase();
        const source = String(payload.source ?? "portal").trim();

        if (!EMAIL_RE.test(email)) {
          return withCors(
            json({ ok: false, error: "invalid-email" }, { status: 400 }),
            env,
          );
        }

        await env.WAITLIST_DB.prepare(
          "INSERT INTO waitlist (email, source) VALUES (?1, ?2) ON CONFLICT(email) DO NOTHING",
        )
          .bind(email, source)
          .run();

        return withCors(json({ ok: true }), env);
      }

      if (request.method === "GET" && url.pathname === "/api/loop/status") {
        const config = await getLoopConfig(env);
        return withCors(json({ ok: true, config }), env);
      }

      if (request.method === "POST" && url.pathname === "/api/loop/start") {
        requireAdmin(request, env);
        const config = await updateLoopConfig(env, { enabled: true });
        return withCors(json({ ok: true, config }), env);
      }

      if (request.method === "POST" && url.pathname === "/api/loop/stop") {
        requireAdmin(request, env);
        const config = await updateLoopConfig(env, { enabled: false });
        return withCors(json({ ok: true, config }), env);
      }

      if (request.method === "POST" && url.pathname === "/api/config") {
        requireAdmin(request, env);
        const payload = await readPayload(request);
        const policy =
          payload.policy && typeof payload.policy === "object"
            ? payload.policy
            : undefined;
        const strategy =
          payload.strategy && typeof payload.strategy === "object"
            ? payload.strategy
            : undefined;
        const config = await updateLoopConfig(env, {
          policy: policy as unknown,
          strategy: strategy as unknown,
        });
        return withCors(json({ ok: true, config }), env);
      }

      if (request.method === "POST" && url.pathname === "/api/loop/tick") {
        requireAdmin(request, env);
        ctx.waitUntil(runAutopilotTick(env, ctx, "manual"));
        return withCors(json({ ok: true }), env);
      }

      if (request.method === "GET" && url.pathname === "/api/trades") {
        requireAdmin(request, env);
        const limitRaw = url.searchParams.get("limit") ?? "50";
        const limit = Number(limitRaw);
        const tenantId = env.TENANT_ID ?? "default";
        const trades = await listTrades(
          env,
          tenantId,
          Number.isFinite(limit) ? limit : 50,
        );
        return withCors(json({ ok: true, trades }), env);
      }

      return withCors(
        json({ ok: false, error: "not-found" }, { status: 404 }),
        env,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown-error";
      const status = message === "unauthorized" ? 401 : 500;
      return withCors(json({ ok: false, error: message }, { status }), env);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await runAutopilotTick(env, ctx);
  },
};

async function readPayload(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as Record<string, unknown>;
  }
  if (contentType.includes("form")) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  return {};
}
