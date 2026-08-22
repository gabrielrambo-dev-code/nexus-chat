import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";

// ---------- types ----------
type ChannelType = "text" | "voice";
interface ServerData {
  id: string;
  name: string;
  code: string;
  ownerId: string;
  createdAt: number;
}
interface ChannelData {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  createdAt: number;
}
interface MessageData {
  id: string;
  channelId: string;
  serverId: string;
  authorId: string;
  username: string;
  content: string;
  createdAt: number;
  attachments?: string[];
}
interface ClientInfo {
  id: string;
  ws: WebSocket;
  username: string;
  avatarColor: string;
  voiceChannelId: string | null;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  screenSharing: boolean;
}

function uid(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
const AVATAR_COLORS = ["#5865F2", "#ED4245", "#57F287", "#FEE75C", "#EB459E", "#00A8FC", "#23A559", "#F23F43"];

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const k of Object.keys(nets)) for (const n of nets[k] || []) if (n.family === "IPv4" && !n.internal) ips.push(n.address);
  if (!ips.length) ips.push("127.0.0.1");
  return ips;
}

export class HostServer {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private port: number;
  private dataDir: string;
  private filePath: string;
  private clients = new Map<string, ClientInfo>();
  private servers: ServerData[] = [];
  private channels: ChannelData[] = [];
  private messages: MessageData[] = [];
  private broadcastFn: ((data: any) => void) | null = null;
  private running = false;

  constructor(port: number, userDataPath: string) {
    this.port = port;
    this.dataDir = path.join(userDataPath, "nexus");
    this.filePath = path.join(this.dataDir, "data.json");
  }

  onBroadcast(fn: (data: any) => void) {
    this.broadcastFn = fn;
  }

  isRunning() {
    return this.running;
  }
  getStatus() {
    return { running: this.running, port: this.port, ips: getLocalIPs(), invite: `ws://${getLocalIPs()[0]}:${this.port}` };
  }

  async start() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.load();
    if (this.servers.length === 0) this.seed();

    this.httpServer = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, servers: this.servers.length, clients: this.clients.size }));
        return;
      }
      if (req.url === "/invite") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ invite: `ws://${getLocalIPs()[0]}:${this.port}`, ips: getLocalIPs(), port: this.port }));
        return;
      }
      res.writeHead(404); res.end("not found");
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, () => resolve());
      this.httpServer!.on("error", reject);
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.running = true;
    console.log(`[HostServer] running ws://${getLocalIPs()[0]}:${this.port}`);
  }

  async stop() {
    if (!this.running) {
      this.wss = null; this.httpServer = null;
      return;
    }
    this.running = false;
    // termina todas as conexões — terminate força fechamento imediato (corrige travamento ao fechar)
    for (const c of this.clients.values()) {
      try { (c.ws as any).terminate?.(); } catch {}
      try { c.ws.close(); } catch {}
    }
    this.clients.clear();
    // fecha WSS com timeout (wss.close pode travar se houver sockets presos)
    await Promise.race([
      new Promise<void>((r) => {
        if (!this.wss) return r();
        try { this.wss.close(() => r()); } catch { r(); }
      }),
      new Promise<void>((r) => setTimeout(r, 1200)),
    ]);
    // força fechamento de sockets do http server
    if (this.httpServer) {
      try {
        // destrói sockets pendentes
        (this.httpServer as any)._connections = 0;
      } catch {}
      await Promise.race([
        new Promise<void>((r) => {
          try { this.httpServer!.close(() => r()); } catch { r(); }
        }),
        new Promise<void>((r) => setTimeout(r, 1200)),
      ]);
      // força destroy em todos os sockets se ainda houver
      try { (this.httpServer as any).closeAllConnections?.(); } catch {}
    }
    this.wss = null; this.httpServer = null;
    console.log("[HostServer] stopped");
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const j = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
        this.servers = j.servers || [];
        this.channels = j.channels || [];
        this.messages = j.messages || [];
      }
    } catch {}
  }
  private save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({ servers: this.servers, channels: this.channels, messages: this.messages.slice(-2000) }, null, 2));
    } catch {}
  }
  private seed() {
    const sid = uid("srv_");
    this.servers.push({ id: sid, name: "Nexus Central", code: genCode(), ownerId: "system", createdAt: Date.now() });
    this.channels.push({ id: uid("ch_"), serverId: sid, name: "geral", type: "text", createdAt: Date.now() });
    this.channels.push({ id: uid("ch_"), serverId: sid, name: "memes", type: "text", createdAt: Date.now() });
    this.channels.push({ id: uid("ch_"), serverId: sid, name: "Bate-papo", type: "voice", createdAt: Date.now() });
    this.channels.push({ id: uid("ch_"), serverId: sid, name: "Jogando", type: "voice", createdAt: Date.now() });
    this.messages.push({ id: uid("msg_"), channelId: this.channels[0]!.id, serverId: sid, authorId: "system", username: "Nexus", content: "Bem-vindo ao Nexus Chat! 🎉 Crie servidores, converse por texto, entre em call de voz e compartilhe sua tela. O servidor roda no PC de quem abrir a call.", createdAt: Date.now() });
    this.save();
  }

  private handleConnection(ws: WebSocket) {
    const clientId = uid("cli_");
    let info: ClientInfo | null = null;

    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // hello must be first
      if (msg.op === "hello") {
        const username = String(msg.username || "Anônimo").slice(0, 24) || "Anônimo";
        info = {
          id: clientId,
          ws,
          username,
          avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
          voiceChannelId: null,
          muted: false,
          deafened: false,
          speaking: false,
          screenSharing: false,
        };
        this.clients.set(clientId, info);
        this.send(ws, { op: "hello_ok", clientId, username, avatarColor: info.avatarColor });
        this.sendState(ws);
        this.broadcast({ op: "presence", clients: this.presenceList() });
        return;
      }
      if (!info) { this.send(ws, { op: "error", message: "envie hello primeiro" }); return; }

      switch (msg.op) {
        case "get_state": this.sendState(ws); break;
        case "create_server": {
          const name = String(msg.name || "").trim().slice(0, 32) || "Novo Servidor";
          const srv: ServerData = { id: uid("srv_"), name, code: genCode(), ownerId: clientId!, createdAt: Date.now() };
          this.servers.push(srv);
          // default channels
          this.channels.push({ id: uid("ch_"), serverId: srv.id, name: "geral", type: "text", createdAt: Date.now() });
          this.channels.push({ id: uid("ch_"), serverId: srv.id, name: "Bate-papo", type: "voice", createdAt: Date.now() });
          this.save();
          this.broadcastState();
          break;
        }
        case "join_server": {
          const code = String(msg.code || "").toUpperCase().trim();
          const srv = this.servers.find(s => s.code === code);
          if (!srv) { this.send(ws, { op: "error", message: "Código de convite inválido" }); break; }
          this.send(ws, { op: "joined_server", serverId: srv.id });
          this.sendState(ws);
          break;
        }
        case "create_channel": {
          const serverId = String(msg.serverId);
          const name = String(msg.name || "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 24) || "novo-canal";
          const type = msg.type === "voice" ? "voice" : "text";
          if (!this.servers.find(s => s.id === serverId)) { this.send(ws, { op: "error", message: "Servidor não encontrado" }); break; }
          this.channels.push({ id: uid("ch_"), serverId, name, type, createdAt: Date.now() });
          this.save(); this.broadcastState(); break;
        }
        case "delete_channel": {
          const id = String(msg.channelId);
          this.channels = this.channels.filter(c => c.id !== id);
          this.messages = this.messages.filter(m => m.channelId !== id);
          this.save(); this.broadcastState(); break;
        }
        case "send_message": {
          const channelId = String(msg.channelId);
          const content = String(msg.content || "").trim().slice(0, 2000);
          if (!content) break;
          const ch = this.channels.find(c => c.id === channelId);
          if (!ch) break;
          const m: MessageData = { id: uid("msg_"), channelId, serverId: ch.serverId, authorId: clientId, username: info.username, content, createdAt: Date.now() };
          this.messages.push(m);
          if (this.messages.length > 3000) this.messages = this.messages.slice(-3000);
          this.save();
          this.broadcast({ op: "message_new", message: m });
          break;
        }
        case "join_voice": {
          const channelId = String(msg.channelId);
          const ch = this.channels.find(c => c.id === channelId && c.type === "voice");
          if (!ch) { this.send(ws, { op: "error", message: "Canal de voz não encontrado" }); break; }
          info.voiceChannelId = channelId;
          this.broadcastVoice();
          break;
        }
        case "leave_voice": {
          info.voiceChannelId = null;
          info.screenSharing = false;
          this.broadcastVoice();
          break;
        }
        case "voice_state": {
          info.muted = !!msg.muted;
          info.deafened = !!msg.deafened;
          info.screenSharing = !!msg.screenSharing;
          this.broadcastVoice();
          break;
        }
        case "webrtc_signal": {
          const targetId = String(msg.targetId);
          const target = this.clients.get(targetId);
          if (target && target.ws.readyState === WebSocket.OPEN) {
            this.send(target.ws, { op: "webrtc_signal", fromId: clientId, fromUsername: info.username, data: msg.data });
          }
          break;
        }
        case "typing": {
          const channelId = String(msg.channelId);
          this.broadcast({ op: "typing", channelId, username: info.username, clientId }, clientId);
          break;
        }
        default: break;
      }
    });

    ws.on("close", () => {
      if (info) {
        this.clients.delete(clientId);
        this.broadcastVoice();
        this.broadcast({ op: "presence", clients: this.presenceList() });
      }
    });
    ws.on("error", () => {});
  }

  private presenceList() {
    return [...this.clients.values()].map(c => ({ id: c.id, username: c.username, avatarColor: c.avatarColor, voiceChannelId: c.voiceChannelId, muted: c.muted, deafened: c.deafened, screenSharing: c.screenSharing }));
  }

  private send(ws: WebSocket, data: any) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }
  private broadcast(data: any, excludeId?: string) {
    const raw = JSON.stringify(data);
    for (const [id, c] of this.clients) if (id !== excludeId && c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
    this.broadcastFn?.(data);
  }
  private sendState(ws: WebSocket) {
    this.send(ws, {
      op: "state",
      servers: this.servers,
      channels: this.channels,
      messages: this.messages.slice(-2000),
      clients: this.presenceList(),
      selfId: [...this.clients.values()].find(c => c.ws === ws)?.id,
    });
  }
  private broadcastState() {
    this.broadcast({ op: "state", servers: this.servers, channels: this.channels, messages: this.messages.slice(-2000), clients: this.presenceList() });
  }
  private broadcastVoice() {
    this.broadcast({ op: "voice_update", clients: this.presenceList() });
    this.broadcast({ op: "presence", clients: this.presenceList() });
  }
}
