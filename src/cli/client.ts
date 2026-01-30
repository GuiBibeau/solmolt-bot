import WebSocket from "ws";
import type { RalphConfig } from "../config/config.js";
import { randomId } from "../util/id.js";

export type CliCommand =
  | { method: "status" }
  | { method: "autopilot.start" }
  | { method: "autopilot.stop" }
  | { method: "gateway.shutdown" }
  | { method: "gateway.restart" }
  | {
      method: "tool.invoke";
      params: { name: string; input: Record<string, unknown> };
    };

export async function runCliCommand(
  config: RalphConfig,
  command: CliCommand,
): Promise<void> {
  const url = `ws://${config.gateway.bind}:${config.gateway.port}`;
  const ws = new WebSocket(url);

  const send = (payload: unknown) => ws.send(JSON.stringify(payload));

  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const connectId = randomId("connect");
  send({
    id: connectId,
    method: "connect",
    params: { token: config.gateway.authToken, role: "operator" },
  });

  await waitForResponse(ws, connectId);

  const reqId = randomId("req");
  send({
    id: reqId,
    method: command.method,
    params: command.method === "tool.invoke" ? command.params : undefined,
  });

  const response = await waitForResponse(ws, reqId);
  console.log(JSON.stringify(response, null, 2));
  ws.close();
}

function waitForResponse(
  ws: WebSocket,
  id: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const handler = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.id === id) {
          ws.off("message", handler);
          if (msg.error) {
            reject(new Error(String(msg.error)));
          } else {
            resolve(msg);
          }
        }
      } catch (err) {
        ws.off("message", handler);
        reject(err);
      }
    };
    ws.on("message", handler);
  });
}
