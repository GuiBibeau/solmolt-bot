import { WebSocketServer } from 'ws';
import type { SolmoltConfig } from '../config/config.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/registry.js';
import { SessionJournal, TradeJournal } from '../journal/index.js';
import { randomId } from '../util/id.js';
import { info, warn, error } from '../util/logger.js';

export type GatewayState = {
  autopilotEnabled: boolean;
  autopilotIntervalMs: number;
  sdkMode: string;
};

type ConnectionContext = {
  sessionId: string;
  role: 'operator';
  journal: SessionJournal;
};

type JsonObject = Record<string, unknown>;

type GatewayMessage = {
  id?: string;
  method: string;
  params?: JsonObject;
};

export class GatewayServer {
  private wss?: WebSocketServer;
  private autopilotTimer?: NodeJS.Timeout;
  private state: GatewayState;

  constructor(
    private readonly config: SolmoltConfig,
    private readonly registry: ToolRegistry,
    private readonly ctx: ToolContext
  ) {
    this.state = {
      autopilotEnabled: config.autopilot.enabled,
      autopilotIntervalMs: config.autopilot.intervalMs,
      sdkMode: config.solana.sdkMode,
    };
  }

  start(): void {
    const { bind, port } = this.config.gateway;
    this.wss = new WebSocketServer({ host: bind, port });
    info('gateway listening', { bind, port });

    this.wss.on('connection', (socket) => {
      let connected = false;
      let connCtx: ConnectionContext | null = null;

      socket.on('message', async (raw) => {
        let msg: GatewayMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch (err) {
          warn('invalid message', { err: String(err) });
          socket.send(JSON.stringify({ error: 'invalid_json' }));
          return;
        }

        if (!connected) {
          if (msg.method !== 'connect') {
            socket.send(JSON.stringify({ error: 'expected_connect' }));
            socket.close();
            return;
          }
          const token = String(msg.params?.token ?? '');
          const role = String(msg.params?.role ?? '');
          if (token !== this.config.gateway.authToken) {
            socket.send(JSON.stringify({ id: msg.id, error: 'unauthorized' }));
            socket.close();
            return;
          }
          if (role !== 'operator') {
            socket.send(JSON.stringify({ id: msg.id, error: 'invalid_role' }));
            socket.close();
            return;
          }
          connected = true;
          const sessionId = randomId('session');
          connCtx = {
            sessionId,
            role: 'operator',
            journal: new SessionJournal(sessionId),
          };
          socket.send(JSON.stringify({ id: msg.id, result: { ok: true, role } }));
          return;
        }

        if (!connCtx) return;
        await this.handleMessage(socket, connCtx, msg);
      });
    });

    if (this.state.autopilotEnabled) {
      this.startAutopilot();
    }
  }

  stop(): void {
    if (this.autopilotTimer) {
      clearInterval(this.autopilotTimer);
    }
    this.wss?.close();
  }

  private async handleMessage(socket: WebSocket, connCtx: ConnectionContext, msg: GatewayMessage): Promise<void> {
    let response: unknown;
    let errorCode: string | undefined;
    try {
      switch (msg.method) {
        case 'status': {
          response = {
            ...this.state,
            publicKey: this.ctx.solana.getPublicKey(),
          };
          break;
        }
        case 'autopilot.start': {
          this.state.autopilotEnabled = true;
          this.startAutopilot();
          response = { ok: true };
          break;
        }
        case 'autopilot.stop': {
          this.state.autopilotEnabled = false;
          this.stopAutopilot();
          response = { ok: true };
          break;
        }
        case 'tool.invoke': {
          const name = String(msg.params?.name ?? '');
          const input = (msg.params?.input ?? {}) as Record<string, unknown>;
          const toolCtx = { ...this.ctx, sessionJournal: connCtx.journal };
          response = await this.registry.invoke(name, toolCtx, input);
          break;
        }
        default:
          errorCode = 'unknown_method';
      }
    } catch (err) {
      error('gateway error', { err: String(err) });
      errorCode = 'server_error';
    }

    if (errorCode) {
      socket.send(JSON.stringify({ id: msg.id, error: errorCode }));
    } else {
      socket.send(JSON.stringify({ id: msg.id, result: response }));
    }

    await connCtx.journal.append({
      type: 'gateway',
      method: msg.method,
      ts: new Date().toISOString(),
    });
  }

  private startAutopilot(): void {
    if (this.autopilotTimer) return;
    this.autopilotTimer = setInterval(() => {
      this.registry
        .invoke('system.autopilot_tick', this.ctx, { reason: 'timer' })
        .catch((err) => warn('autopilot tick failed', { err: String(err) }));
    }, this.state.autopilotIntervalMs);
  }

  private stopAutopilot(): void {
    if (!this.autopilotTimer) return;
    clearInterval(this.autopilotTimer);
    this.autopilotTimer = undefined;
  }
}

// ws types don't export in ESM for type-only
type WebSocket = import('ws').WebSocket;
