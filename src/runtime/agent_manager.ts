import { SessionJournal } from "../journal/index.js";
import { createLlmClient } from "../llm/index.js";
import type {
  LlmClient,
  LlmMessage,
  LlmToolCall,
  ToolSchema,
} from "../llm/types.js";
import type { ToolContext, ToolRegistry } from "../tools/registry.js";
import { randomId } from "../util/id.js";
import { warn } from "../util/logger.js";
import { isRecord } from "../util/types.js";
import { LaneQueue } from "./queue.js";
import { RunStore } from "./run_store.js";
import { SessionStore } from "./session_store.js";
import { isToolAllowed, mergeToolPolicies } from "./tool_policy.js";
import type {
  AgentDefinition,
  AgentMeta,
  AgentRunRequest,
  AgentRuntime,
  RunAccepted,
  RunRecord,
  ToolPolicy,
} from "./types.js";
import { buildAutonomousPrompt } from "../agent/prompt.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type RunResult = {
  actionsTaken: string[];
  outputText?: string | null;
};

export class AgentManager implements AgentRuntime {
  private readonly sessionStore: SessionStore;
  private readonly runStore: RunStore;
  private readonly queue: LaneQueue;
  private readonly defaultAgentId: string;
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly llmCache = new Map<string, LlmClient>();
  private readonly runPromises = new Map<string, Deferred<RunRecord>>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly baseCtx: Omit<ToolContext, "sessionJournal">,
  ) {
    const runtimeCfg = baseCtx.config.runtime;
    this.sessionStore = new SessionStore(runtimeCfg.sessionsDir);
    this.runStore = new RunStore(runtimeCfg.runsDir);
    this.queue = new LaneQueue(runtimeCfg.lanes);
    this.defaultAgentId = baseCtx.config.agents.defaultAgentId;
    this.loadAgents(baseCtx.config.agents.agents);
  }

  getDefaultAgentId(): string {
    return this.defaultAgentId;
  }

  submitRun(request: AgentRunRequest): RunAccepted {
    const runId = randomId("run");
    const acceptedAt = new Date().toISOString();
    const agentId = request.agentId || this.defaultAgentId;
    const agent = this.getAgent(agentId);
    const lane = request.lane ?? agent.lane ?? "main";
    const record: RunRecord = {
      runId,
      agentId,
      sessionKey: request.sessionKey,
      status: "accepted",
      acceptedAt,
      lane,
      parentRunId: request.parentRunId,
      metadata: request.metadata,
    };

    void this.runStore.write(record).catch((err) => {
      warn("run.store.write.failed", { err: String(err) });
    });

    const deferred = this.createDeferred<RunRecord>();
    this.runPromises.set(runId, deferred);

    this.queue.enqueue({
      id: randomId("task"),
      runId,
      sessionKey: request.sessionKey,
      lane,
      execute: async () => {
        await this.executeRun(request, runId, acceptedAt, agent, lane);
      },
    });

    return { runId, acceptedAt };
  }

  async submitMessage(input: {
    sessionKey: string;
    content: string;
    agentId?: string;
    triggerRun?: boolean;
  }): Promise<{ ok: true } | RunAccepted> {
    if (!input.triggerRun) {
      const message: LlmMessage = { role: "user", content: input.content };
      await this.appendMessage(input.sessionKey, message);
      return { ok: true };
    }
    const agentId = input.agentId ?? this.defaultAgentId;
    return this.submitRun({
      agentId,
      sessionKey: input.sessionKey,
      input: input.content,
      reason: "operator",
    });
  }

  submitAutopilotTick(reason: "timer" | "operator" | "recovery"): RunAccepted {
    const agentId = this.defaultAgentId;
    const sessionKey = `autopilot:${agentId}`;
    const input = `Tick reason: ${reason}. Decide whether to take action. Use tools when needed.`;
    return this.submitRun({
      agentId,
      sessionKey,
      input,
      reason,
      lane: "autopilot",
    });
  }

  spawnSubagent(input: {
    task: string;
    agentId?: string;
    label?: string;
    parentRunId?: string;
    parentSessionKey?: string;
  }): RunAccepted & { childSessionKey: string } {
    const agentId = input.agentId ?? this.defaultAgentId;
    const childSessionKey = `agent:${agentId}:subagent:${randomId("sub")}`;
    const accepted = this.submitRun({
      agentId,
      sessionKey: childSessionKey,
      input: input.task,
      lane: "subagent",
      parentRunId: input.parentRunId,
      parentSessionKey: input.parentSessionKey,
      metadata: input.label ? { label: input.label } : undefined,
      toolPolicy: {
        deny: [
          "sessions.*",
          "runs.*",
          "agent.message",
          "system.autopilot_tick",
        ],
      },
    });
    return { ...accepted, childSessionKey };
  }

  async wait(runId: string, timeoutMs?: number): Promise<RunRecord | null> {
    const pending = this.runPromises.get(runId);
    if (!pending) {
      return this.getRun(runId);
    }
    if (!timeoutMs || timeoutMs <= 0) {
      return pending.promise;
    }
    return await Promise.race([
      pending.promise,
      new Promise<RunRecord | null>((resolve) => {
        setTimeout(() => {
          void this.getRun(runId)
            .then(resolve)
            .catch(() => resolve(null));
        }, timeoutMs);
      }),
    ]);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runStore.get(runId);
  }

  async listSessions() {
    return this.sessionStore.list();
  }

  async getSessionHistory(sessionKey: string, limit?: number) {
    return this.sessionStore.read(sessionKey, limit);
  }

  async getSessionMessages(sessionKey: string) {
    return this.sessionStore.getMessages(sessionKey);
  }

  private createDeferred<T>(): Deferred<T> {
    let resolveFn: (value: T) => void = () => {};
    const promise = new Promise<T>((res) => {
      resolveFn = res;
    });
    return { promise, resolve: resolveFn };
  }

  private loadAgents(defs: Record<string, Omit<AgentDefinition, "id">>): void {
    for (const [id, def] of Object.entries(defs)) {
      this.agents.set(id, {
        id,
        canSpawnSubagents: def.canSpawnSubagents ?? true,
        instructions: def.instructions,
        model: def.model,
        toolPolicy: def.toolPolicy,
        lane: def.lane,
      });
    }
  }

  private getAgent(id: string): AgentDefinition {
    return (
      this.agents.get(id) ?? {
        id,
        canSpawnSubagents: true,
      }
    );
  }

  private async executeRun(
    request: AgentRunRequest,
    runId: string,
    acceptedAt: string,
    agent: AgentDefinition,
    lane: string,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    await this.runStore.update(runId, {
      status: "running",
      startedAt,
      acceptedAt,
      agentId: agent.id,
      sessionKey: request.sessionKey,
      lane,
      parentRunId: request.parentRunId,
      metadata: request.metadata,
    });

    let result: RunResult | undefined;
    let error: string | undefined;
    try {
      result = await this.runAgent(request, runId, agent);
    } catch (err) {
      error = String(err);
      warn("agent.run.failed", { err: error, runId });
    }

    const completedAt = new Date().toISOString();
    const record = await this.runStore.update(runId, {
      status: error ? "failed" : "completed",
      completedAt,
      error,
      output: result
        ? { text: result.outputText, actionsTaken: result.actionsTaken }
        : undefined,
    });

    await this.maybeAnnounceSubagent(request, record);

    const deferred = this.runPromises.get(runId);
    if (deferred) {
      deferred.resolve(record);
      this.runPromises.delete(runId);
    }
  }

  private async runAgent(
    request: AgentRunRequest,
    runId: string,
    agent: AgentDefinition,
  ): Promise<RunResult> {
    const llm = this.getLlm(agent.model);
    const messages = await this.sessionStore.getMessages(request.sessionKey);

    const toolPolicy = this.resolveToolPolicy(agent, request);
    const tools = this.filterTools(toolPolicy);
    await this.ensureSystemPrompt(messages, agent, request.sessionKey, tools);

    const userMessage: LlmMessage = {
      role: "user",
      content: request.input,
    };
    messages.push(userMessage);
    await this.appendMessage(request.sessionKey, userMessage);

    const ctx = this.buildToolContext(request, runId, agent, toolPolicy);

    const actions: string[] = [];
    const maxSteps = 6;
    let lastAssistantText: string | null | undefined;

    for (let step = 0; step < maxSteps; step += 1) {
      const response = await llm.generate(messages, tools);
      messages.push(response.message);
      lastAssistantText = response.text ?? response.message.content ?? null;
      await this.appendMessage(request.sessionKey, response.message);
      await ctx.sessionJournal.append({
        type: "llm",
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls?.map((call) => ({
          id: call.id,
          name: call.name,
        })),
        ts: new Date().toISOString(),
      });

      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      const toolResults = await this.executeToolCalls(
        response.toolCalls,
        actions,
        ctx,
        toolPolicy,
        request.sessionKey,
      );
      messages.push(...toolResults);
    }

    return { actionsTaken: actions, outputText: lastAssistantText };
  }

  private buildToolContext(
    request: AgentRunRequest,
    runId: string,
    agent: AgentDefinition,
    toolPolicy: ToolPolicy | undefined,
  ): ToolContext {
    const canSpawnSubagents =
      request.parentRunId != null ? false : (agent.canSpawnSubagents ?? true);
    const meta: AgentMeta = {
      agentId: agent.id,
      sessionKey: request.sessionKey,
      runId,
      parentRunId: request.parentRunId,
      canSpawnSubagents,
    };
    return {
      ...this.baseCtx,
      sessionJournal: new SessionJournal(
        request.sessionKey,
        this.sessionStore.getBaseDir(),
      ),
      runtime: this,
      agentMeta: meta,
      toolPolicy,
    };
  }

  private getLlm(modelOverride?: string): LlmClient {
    const model = modelOverride ?? this.baseCtx.config.llm.model;
    const key = `${this.baseCtx.config.llm.provider}:${model}`;
    const cached = this.llmCache.get(key);
    if (cached) return cached;
    const client = createLlmClient({
      ...this.baseCtx.config.llm,
      model,
    });
    this.llmCache.set(key, client);
    return client;
  }

  private buildSystemPrompt(
    agent: AgentDefinition,
    tools: ToolSchema[],
  ): string {
    const policy = this.baseCtx.config.policy;
    const plan = this.baseCtx.config.autopilot.plan;
    const instruction =
      agent.instructions ??
      "You are Serious Trader Ralph, an autonomous Solana trading agent.";
    return buildAutonomousPrompt({
      instruction,
      policy,
      plan,
      tools,
    });
  }

  private async ensureSystemPrompt(
    messages: LlmMessage[],
    agent: AgentDefinition,
    sessionKey: string,
    tools: ToolSchema[],
  ): Promise<void> {
    if (messages.some((msg) => msg.role === "system")) return;
    const systemMessage: LlmMessage = {
      role: "system",
      content: this.buildSystemPrompt(agent, tools),
    };
    messages.unshift(systemMessage);
    await this.appendMessage(sessionKey, systemMessage);
  }

  private async appendMessage(
    sessionKey: string,
    message: LlmMessage,
  ): Promise<void> {
    await this.sessionStore.append(sessionKey, {
      type: "message",
      message,
      ts: new Date().toISOString(),
    });
  }

  private resolveToolPolicy(
    agent: AgentDefinition,
    request: AgentRunRequest,
  ): ToolPolicy | undefined {
    let merged = mergeToolPolicies(agent.toolPolicy, request.toolPolicy);
    if (request.parentRunId) {
      merged = mergeToolPolicies(merged, {
        deny: [
          "sessions.*",
          "runs.*",
          "agent.message",
          "system.autopilot_tick",
        ],
      });
    }
    if (agent.canSpawnSubagents === false) {
      merged = mergeToolPolicies(merged, { deny: ["sessions.spawn"] });
    }
    return merged;
  }

  private filterTools(policy: ToolPolicy | undefined): ToolSchema[] {
    const tools = this.registry.listSchemas(this.baseCtx.config);
    if (!policy) return tools;
    return tools.filter((schema) => isToolAllowed(policy, schema.name));
  }

  private async executeToolCalls(
    toolCalls: LlmToolCall[],
    actions: string[],
    ctx: ToolContext,
    policy: ToolPolicy | undefined,
    sessionKey: string,
  ): Promise<LlmMessage[]> {
    const toolResults: LlmMessage[] = [];
    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments || "{}");
        if (isRecord(parsed)) {
          args = parsed;
        }
      } catch (_err) {
        await ctx.sessionJournal.append({
          type: "tool_call",
          tool: call.name,
          args: {},
          ts: new Date().toISOString(),
          error: "invalid-arguments",
        });
      }

      if (!isToolAllowed(policy, call.name)) {
        const denied = { error: "tool-not-allowed", tool: call.name };
        const deniedMessage: LlmMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(denied),
        };
        toolResults.push(deniedMessage);
        await this.appendMessage(sessionKey, deniedMessage);
        continue;
      }

      await ctx.sessionJournal.append({
        type: "tool_call",
        tool: call.name,
        args,
        ts: new Date().toISOString(),
      });

      try {
        const result = await this.registry.invoke(call.name, ctx, args);
        actions.push(call.name);
        const content = JSON.stringify(result);
        const toolMessage: LlmMessage = {
          role: "tool",
          tool_call_id: call.id,
          content,
        };
        toolResults.push(toolMessage);
        await this.appendMessage(sessionKey, toolMessage);
      } catch (err) {
        const errorPayload = { error: String(err) };
        const toolMessage: LlmMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(errorPayload),
        };
        toolResults.push(toolMessage);
        await this.appendMessage(sessionKey, toolMessage);
      }
    }
    return toolResults;
  }

  private async maybeAnnounceSubagent(
    request: AgentRunRequest,
    record: RunRecord,
  ): Promise<void> {
    if (!request.parentSessionKey) return;
    const entry = {
      type: "subagent_announce",
      ts: new Date().toISOString(),
      runId: record.runId,
      agentId: record.agentId,
      sessionKey: record.sessionKey,
      status: record.status,
      output: record.output,
      error: record.error,
    };
    await this.sessionStore.append(request.parentSessionKey, entry);
  }
}
