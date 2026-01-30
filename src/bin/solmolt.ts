#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from '../config/index.js';
import { createSolanaAdapter } from '../solana/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerDefaultTools } from '../tools/tools.js';
import { JupiterClient } from '../jupiter/client.js';
import { SessionJournal, TradeJournal } from '../journal/index.js';
import { GatewayServer } from '../gateway/server.js';
import { runCliCommand } from '../cli/client.js';

const program = new Command();

program
  .name('solmolt')
  .description('SolMolt Core gateway + CLI')
  .option('-c, --config <path>', 'Path to config file');

program
  .command('gateway')
  .description('Start the SolMolt gateway daemon')
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const solana = createSolanaAdapter(config);
    const registry = new ToolRegistry();
    const jupiter = new JupiterClient(config.jupiter.baseUrl, config.jupiter.apiKey);
    registerDefaultTools(registry, jupiter);

    const ctx = {
      config,
      solana,
      sessionJournal: new SessionJournal('gateway'),
      tradeJournal: new TradeJournal(),
    };

    const gateway = new GatewayServer(config, registry, ctx);
    gateway.start();
  });

program
  .command('status')
  .description('Fetch gateway status')
  .action(async () => {
    const config = loadConfig(program.opts().config);
    await runCliCommand(config, { method: 'status' });
  });

program
  .command('autopilot <action>')
  .description('Start or stop autopilot')
  .action(async (action: string) => {
    const config = loadConfig(program.opts().config);
    if (action === 'start') {
      await runCliCommand(config, { method: 'autopilot.start' });
      return;
    }
    if (action === 'stop') {
      await runCliCommand(config, { method: 'autopilot.stop' });
      return;
    }
    throw new Error('action must be start|stop');
  });

program
  .command('tool <name>')
  .description('Invoke a tool by name')
  .option('-i, --input <json>', 'JSON input payload', '{}')
  .action(async (name: string, options: { input: string }) => {
    const config = loadConfig(program.opts().config);
    const input = JSON.parse(options.input || '{}') as Record<string, unknown>;
    await runCliCommand(config, {
      method: 'tool.invoke',
      params: { name, input },
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
