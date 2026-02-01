import { Command } from "commander";
import { sendAgentMessage } from "../cli/agent.js";
import { runCliCommand } from "../cli/client.js";
import { runDoctor } from "../cli/doctor.js";
import { installToolFromRegistry } from "../cli/tools.js";
import { runUpdate } from "../cli/update.js";
import { loadConfig } from "../config/index.js";
import { GatewayServer } from "../gateway/server.js";
import { SessionJournal, TradeJournal } from "../journal/index.js";
import { JupiterClient } from "../jupiter/client.js";
import { AgentManager } from "../runtime/agent_manager.js";
import { createSolanaAdapter } from "../solana/index.js";
import { loadSkillsFromDir } from "../tools/loader.js";
import { loadOpenClawPluginsFromDir } from "../tools/openclaw.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerDefaultTools } from "../tools/tools.js";
import { isRecord } from "../util/types.js";

const program = new Command();

program
  .name("ralph")
  .description("Serious Trader Ralph gateway + CLI")
  .option("-c, --config <path>", "Path to config file");

program
  .command("gateway [action]")
  .description("Gateway lifecycle (start|stop|restart)")
  .action(async (action?: string) => {
    if (!action || action === "start") {
      const config = loadConfig(program.opts().config);
      const solana = createSolanaAdapter(config);
      const registry = new ToolRegistry();
      const jupiter = new JupiterClient(
        config.jupiter.baseUrl,
        config.jupiter.apiKey,
      );
      registerDefaultTools(registry, jupiter);
      await loadSkillsFromDir(registry, config.tools.skillsDir);
      await loadOpenClawPluginsFromDir(registry, config.openclaw.pluginsDir);

      const ctx = {
        config,
        solana,
        sessionJournal: new SessionJournal("gateway"),
        tradeJournal: new TradeJournal(),
      };

      const runtime = new AgentManager(registry, ctx);
      const gatewayCtx = { ...ctx, runtime };

      const gateway = new GatewayServer(config, registry, gatewayCtx);
      gateway.start();
      return;
    }

    if (action === "stop") {
      const config = loadConfig(program.opts().config);
      await runCliCommand(config, { method: "gateway.shutdown" });
      return;
    }

    if (action === "restart") {
      const config = loadConfig(program.opts().config);
      await runCliCommand(config, { method: "gateway.restart" });
      return;
    }

    throw new Error("gateway action must be start|stop|restart");
  });

program
  .command("status")
  .description("Fetch gateway status")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    await runCliCommand(config, { method: "status" });
  });

program
  .command("autopilot <action>")
  .description("Start or stop autopilot")
  .action(async (action: string) => {
    const config = loadConfig(program.opts().config);
    if (action === "start") {
      await runCliCommand(config, { method: "autopilot.start" });
      return;
    }
    if (action === "stop") {
      await runCliCommand(config, { method: "autopilot.stop" });
      return;
    }
    throw new Error("action must be start|stop");
  });

program
  .command("tool <name>")
  .description("Invoke a tool by name")
  .option("-i, --input <json>", "JSON input payload", "{}")
  .action(async (name: string, options: { input: string }) => {
    const config = loadConfig(program.opts().config);
    const parsed = JSON.parse(options.input || "{}");
    const input = isRecord(parsed) ? parsed : {};
    await runCliCommand(config, {
      method: "tool.invoke",
      params: { name, input },
    });
  });

program
  .command("agent:message")
  .description("Send a message to the agent (optional trigger)")
  .requiredOption("-m, --message <text>", "Message content")
  .option("-t, --trigger", "Trigger a tick after sending")
  .action(async (options: { message: string; trigger?: boolean }) => {
    const config = loadConfig(program.opts().config);
    await sendAgentMessage(config, options.message, options.trigger);
  });

program
  .command("tools:install <name>")
  .description("Install a tool from the configured registry")
  .option("--registry <url>", "Registry URL override")
  .option(
    "--target <target>",
    "Install target (openclaw or skills)",
    "openclaw",
  )
  .option("-f, --force", "Overwrite if already installed")
  .action(
    async (
      name: string,
      options: { registry?: string; target?: string; force?: boolean },
    ) => {
      const config = loadConfig(program.opts().config);
      const target = options.target === "skills" ? "skills" : "openclaw";
      const dest = await installToolFromRegistry(config, name, {
        registryUrl: options.registry,
        target,
        force: options.force,
      });
      console.log(`Installed ${name} to ${dest}`);
      console.log("Restart the gateway to load the new tool.");
    },
  );

program
  .command("doctor")
  .description("Run health checks")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    await runDoctor(config);
  });

program
  .command("update")
  .description("Update code from git and reinstall deps")
  .action(async () => {
    runUpdate();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
