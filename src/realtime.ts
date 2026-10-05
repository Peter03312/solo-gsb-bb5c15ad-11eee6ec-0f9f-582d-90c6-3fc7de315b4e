import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { getDb } from './db.js';
import { buildShowState } from './state.js';

interface Client {
  ws: WebSocket;
  role: 'director' | 'station';
  showId: number;
  positionName?: string;
  isAlive: boolean;
}

let wss: WebSocketServer;
const clients = new Set<Client>();

export function initRealtime(server: http.Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => authenticate(ws, req.url ?? ''));

  // 心跳：探测断线，断线后客户端重连即收到服务端权威状态
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.isAlive) {
        c.ws.terminate();
        clients.delete(c);
        continue;
      }
      c.isAlive = false;
      c.ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));
}

function authenticate(ws: WebSocket, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://localhost');
  } catch {
    ws.close(4001, 'bad request');
    return;
  }
  const token = parsed.searchParams.get('token') ?? '';
  const session = getDb().prepare(`SELECT role, position_id, show_id FROM sessions WHERE token = ?`).get(token) as
    | { role: string; position_id: number | null; show_id: number | null }
    | undefined;

  if (!session || !session.show_id) {
    ws.close(4401, '未授权：口令无效或缺少场次');
    return;
  }

  let positionName: string | undefined;
  if (session.role === 'station') {
    const pos = getDb().prepare(`SELECT name FROM positions WHERE id = ?`).get(session.position_id) as
      | { name: string }
      | undefined;
    if (!pos) {
      ws.close(4401, '岗位不存在');
      return;
    }
    positionName = pos.name;
  }

  const client: Client = {
    ws,
    role: session.role as 'director' | 'station',
    showId: session.show_id,
    positionName,
    isAlive: true,
  };
  clients.add(client);

  ws.on('pong', () => {
    client.isAlive = true;
  });
  ws.on('close', () => clients.delete(client));
  ws.on('error', () => clients.delete(client));

  // 连接/重连后立刻下发服务端权威状态
  sendState(client);

  ws.on('message', (raw) => {
    let msg: { type?: string };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // 客户端可主动请求重新同步
    if (msg.type === 'sync') sendState(client);
  });
}

function sendState(client: Client): void {
  const state = buildShowState(client.showId, client.positionName);
  if (!state) {
    client.ws.send(JSON.stringify({ type: 'error', code: 'SHOW_NOT_FOUND', message: '场次不存在' }));
    return;
  }
  client.ws.send(JSON.stringify({ type: 'state', state }));
}

/** 状态变更后向该场次所有连接（岗位端 + 导演监视端）广播最新状态 */
export function broadcastShow(showId: number, event?: { kind: string; message?: string }): void {
  const openStates = new Map<Client, ReturnType<typeof buildShowState>>();
  for (const c of clients) {
    if (c.showId !== showId || c.ws.readyState !== WebSocket.OPEN) continue;
    const state = buildShowState(c.showId, c.positionName);
    if (state) openStates.set(c, state);
  }
  for (const [c, state] of openStates) {
    c.ws.send(JSON.stringify({ type: 'state', state }));
    if (event) c.ws.send(JSON.stringify({ type: 'event', kind: event.kind, message: event.message }));
  }
}
