// Nexus Chat — renderer
type ServerData = { id: string; name: string; code: string; ownerId: string };
type ChannelData = { id: string; serverId: string; name: string; type: "text" | "voice" };
type MessageData = { id: string; channelId: string; serverId: string; authorId: string; username: string; content: string; createdAt: number };
type ClientInfo = { id: string; username: string; avatarColor: string; voiceChannelId: string | null; muted: boolean; deafened: boolean; screenSharing: boolean };

const qs = (s: string) => document.querySelector(s) as HTMLElement;
const qsa = (s: string) => [...document.querySelectorAll(s)] as HTMLElement[];

let ws: WebSocket | null = null;
let selfId: string | null = null;
let selfUsername = "";
let selfColor = "#5865F2";
let servers: ServerData[] = [];
let channels: ChannelData[] = [];
let messages: MessageData[] = [];
let clients: ClientInfo[] = [];
let activeServerId: string | null = null;
let activeChannelId: string | null = null;
let connected = false;

// voice
let localAudio: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let voiceChannelId: string | null = null;
let micEnabled = true;
let deafened = false;
let shareType: "screen" | "window" = "screen";
let selectedQuality = "720p30";
let selectedFps = "30";
let pickerChoice: string | null = null;

const peers = new Map<string, RTCPeerConnection>();
const remoteAudios = new Map<string, HTMLAudioElement>();
const remoteVideos = new Map<string, HTMLVideoElement>();

const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

function toast(msg: string) {
  const c = qs("#toast");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function uid() { return Math.random().toString(36).slice(2,9); }

// ---------- UI refs ----------
const loginOverlay = qs("#login-overlay");
const appEl = qs("#app");
const inputUsername = qs("#input-username") as HTMLInputElement;
const inputHost = qs("#input-host") as HTMLInputElement;
const inputPort = qs("#input-port") as HTMLInputElement;
const hostStatusLine = qs("#host-status-line");
const hostIpsEl = qs("#host-ips");
const btnStartHost = qs("#btn-start-host");
const btnStopHost = qs("#btn-stop-host");
const btnConnect = qs("#btn-connect");
const loginError = qs("#login-error");

// ---------- Host controls (Electron) ----------
async function refreshHostStatus() {
  const api: any = (window as any).electronAPI;
  if (!api) { hostStatusLine.textContent = "Modo navegador — inicie um servidor externo se quiser hospedar"; hostStatusLine.style.color = "#949ba4"; return; }
  try {
    const st = await api.getHostStatus();
    const ips = await api.getIPs();
    if (st.running) {
      hostStatusLine.textContent = `Rodando em ws://${ips[0]}:${st.port} ✓`;
      hostStatusLine.style.color = "#23a559";
      btnStartHost.style.display = "none"; btnStopHost.style.display = "";
      hostIpsEl.textContent = `Convide amigos com: ws://${ips[0]}:${st.port}  •  IPs: ${ips.join(", ")}`;
      // auto fill host input if localhost
      if (inputHost.value.includes("localhost")) inputHost.value = `ws://${ips[0]}:${st.port}`;
    } else {
      hostStatusLine.textContent = "Parado";
      hostStatusLine.style.color = "#f23f43";
      btnStartHost.style.display = ""; btnStopHost.style.display = "none";
      hostIpsEl.textContent = ips.length ? `Seu IP local: ${ips.join(", ")}` : "";
    }
  } catch {}
}
btnStartHost?.addEventListener("click", async () => {
  const api: any = (window as any).electronAPI;
  if (!api) return toast("Hospedagem só no app desktop (.exe)");
  const port = parseInt((inputPort as HTMLInputElement).value) || 8765;
  await api.startHost(port);
  await refreshHostStatus();
  toast(`Servidor iniciado na porta ${port}`);
});
btnStopHost?.addEventListener("click", async () => {
  const api: any = (window as any).electronAPI;
  await api.stopHost();
  await refreshHostStatus();
  toast("Servidor parado");
});
qs("#btn-host-config")?.addEventListener("click", () => {
  loginOverlay.classList.remove("hidden");
  // scroll to host box? just ensure visible
});
qs("#btn-invite")?.addEventListener("click", async () => {
  const ips = (window as any).electronAPI ? await (window as any).electronAPI.getIPs() : [];
  const st = (window as any).electronAPI ? await (window as any).electronAPI.getHostStatus() : null;
  let invite = inputHost.value.trim();
  if (st?.running && ips[0]) invite = `ws://${ips[0]}:${st.port}`;
  if (navigator.clipboard) await navigator.clipboard.writeText(invite).catch(()=>{});
  toast(`Convite copiado: ${invite}`);
});
qs("#btn-test-host")?.addEventListener("click", async () => {
  const url = inputHost.value.trim().replace(/^ws:\/\//, "http://").replace(/\/$/, "") + "/health";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) } as any);
    const j = await r.json();
    toast(j.ok ? `Host online — ${j.clients} conectados` : "Host respondeu mas com erro");
  } catch { toast("Não consegui alcançar o host. Verifique IP/porta e firewall."); }
});

// init host status poll
refreshHostStatus(); setInterval(refreshHostStatus, 3000);

// ---------- Connect ----------
btnConnect.addEventListener("click", connect);
inputUsername.addEventListener("keydown", e => { if (e.key === "Enter") connect(); });
inputHost.addEventListener("keydown", e => { if (e.key === "Enter") connect(); });

async function connect() {
  const username = (inputUsername as HTMLInputElement).value.trim().slice(0,20);
  if (!username) { (qs("#login-error") as HTMLElement).textContent = "Escolha um nome"; return; }
  let host = (inputHost as HTMLInputElement).value.trim();
  if (!host) host = "ws://localhost:8765";
  if (!host.startsWith("ws://") && !host.startsWith("wss://")) host = "ws://" + host;
  selfUsername = username;
  localStorage.setItem("nexus_username", username);
  localStorage.setItem("nexus_host", host);
  (qs("#login-error") as HTMLElement).textContent = "";
  btnConnect.textContent = "Conectando…";
  (btnConnect as HTMLButtonElement).disabled = true;
  try {
    await connectWS(host, username);
  } catch (e: any) {
    (qs("#login-error") as HTMLElement).textContent = e.message || "Falha ao conectar";
    btnConnect.textContent = "Entrar no Nexus →";
    (btnConnect as HTMLButtonElement).disabled = false;
  }
}

function connectWS(url: string, username: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws) try { ws.close(); } catch {}
    ws = new WebSocket(url);
    let opened = false;
    const timeout = setTimeout(() => { if (!opened) { try{ ws?.close(); }catch{} reject(new Error("Tempo esgotado. Verifique se o host iniciou o servidor e liberou o firewall.")); } }, 6000);
    ws.onopen = () => {
      opened = true; clearTimeout(timeout);
      ws!.send(JSON.stringify({ op: "hello", username }));
    };
    ws.onmessage = (ev) => handleWSMessage(ev.data, resolve, reject);
    ws.onerror = () => { if (!opened) { clearTimeout(timeout); reject(new Error("Não consegui conectar ao host")); } };
    ws.onclose = () => {
      if (connected) {
        connected = false;
        setConn(false);
        toast("Desconectado do servidor");
        // show login again
        loginOverlay.classList.remove("hidden");
        appEl.classList.add("hidden");
        btnConnect.textContent = "Entrar no Nexus →";
        (btnConnect as HTMLButtonElement).disabled = false;
      } else if (!opened) {
        clearTimeout(timeout); reject(new Error("Conexão fechada"));
      }
    };
  });
}

function handleWSMessage(raw: string, resolve?: (v:any)=>void, reject?: (e:any)=>void) {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.op) {
    case "hello_ok":
      selfId = msg.clientId; selfColor = msg.avatarColor || selfColor;
      connected = true; setConn(true);
      loginOverlay.classList.add("hidden"); appEl.classList.remove("hidden");
      qs("#user-name").textContent = selfUsername;
      (qs("#user-avatar") as HTMLElement).textContent = selfUsername.slice(0,1).toUpperCase();
      (qs("#user-avatar") as HTMLElement).style.background = selfColor;
      btnConnect.textContent = "Entrar no Nexus →"; (btnConnect as HTMLButtonElement).disabled = false;
      qs("#titlebar-status").textContent = `— ${selfUsername} @ ${inputHost.value}`;
      if (resolve) resolve(undefined);
      // request full state
      ws?.send(JSON.stringify({ op: "get_state" }));
      break;
    case "state":
      servers = msg.servers || []; channels = msg.channels || []; messages = msg.messages || []; clients = msg.clients || [];
      if (msg.selfId) selfId = msg.selfId;
      if (!activeServerId && servers.length) activeServerId = servers[0].id;
      if (activeServerId && !channels.find(c=> c.serverId===activeServerId)) {
        // keep server but reset channel
      }
      if (!activeChannelId) {
        const tc = channels.find(c=> c.serverId===activeServerId && c.type==="text");
        if (tc) activeChannelId = tc.id;
      }
      renderAll();
      break;
    case "message_new":
      messages.push(msg.message);
      if (msg.message.channelId === activeChannelId) renderChat();
      // flash if not active?
      break;
    case "voice_update":
    case "presence":
      clients = msg.clients || clients;
      renderMembers(); renderVoiceChannels(); renderVoicePanel(); updateVoiceGrid();
      break;
    case "webrtc_signal":
      handleSignal(msg.fromId, msg.data);
      break;
    case "typing": {
      const ind = qs("#typing-indicator");
      ind.textContent = `${msg.username} está digitando…`;
      clearTimeout((ind as any)._t);
      (ind as any)._t = setTimeout(()=> ind.textContent="", 2200);
      break;
    }
    case "joined_server":
      activeServerId = msg.serverId;
      {
        const tc = channels.find(c=> c.serverId===activeServerId && c.type==="text");
        activeChannelId = tc ? tc.id : null;
      }
      renderAll();
      break;
    case "error":
      toast(msg.message || "Erro");
      if (reject) { reject(new Error(msg.message)); }
      break;
  }
  if (msg.op==="state" && resolve) {
    // already resolved on hello_ok; but if state came first keep
  }
}

function setConn(on: boolean) {
  const dot = qs("#connection-dot") as HTMLElement;
  dot.style.background = on ? "#23a559" : "#80848e";
  dot.style.boxShadow = on ? "0 0 8px #23a559" : "none";
}

// ---------- Rendering ----------
function renderAll() {
  renderServers(); renderChannels(); renderChat(); renderMembers(); renderVoiceChannels(); renderVoicePanel(); updateVoiceGrid();
}

function renderServers() {
  const rail = qs("#rail-servers"); rail.innerHTML = "";
  for (const s of servers) {
    const el = document.createElement("div");
    el.className = "rail-server" + (s.id===activeServerId ? " active" : "");
    el.textContent = s.name.slice(0,2).toUpperCase();
    el.title = `${s.name}\nCódigo: ${s.code}`;
    el.addEventListener("click", () => {
      activeServerId = s.id;
      const tc = channels.find(c=> c.serverId===s.id && c.type==="text");
      activeChannelId = tc ? tc.id : channels.find(c=> c.serverId===s.id)?.id || null;
      renderAll();
    });
    // right click to copy code?
    el.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      if (navigator.clipboard) await navigator.clipboard.writeText(s.code);
      toast(`Código ${s.code} copiado`);
    });
    rail.appendChild(el);
  }
  qs("#server-name").textContent = servers.find(s=> s.id===activeServerId)?.name || "—";
}

function renderChannels() {
  const tc = qs("#text-channels"); const vc = qs("#voice-channels");
  tc.innerHTML = ""; vc.innerHTML = "";
  const chans = channels.filter(c=> c.serverId===activeServerId);
  for (const ch of chans.filter(c=> c.type==="text")) {
    const el = document.createElement("div");
    el.className = "chan" + (ch.id===activeChannelId ? " active" : "");
    el.innerHTML = `<span class="hash">#</span><span class="name">${ch.name}</span>`;
    el.addEventListener("click", () => {
      activeChannelId = ch.id; qs("#chat-view").classList.remove("hidden"); qs("#voice-view").classList.add("hidden");
      renderChannels(); renderChat();
      qs("#main-hash").textContent = "#"; qs("#main-title").textContent = ch.name;
      (qs("#input-message") as HTMLInputElement).placeholder = `Enviar mensagem em #${ch.name}`;
    });
    // delete on right click
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (confirm(`Apagar #${ch.name}?`)) {
        ws?.send(JSON.stringify({ op: "delete_channel", channelId: ch.id }));
      }
    });
    tc.appendChild(el);
  }
  for (const ch of chans.filter(c=> c.type==="voice")) {
    const el = document.createElement("div");
    const participants = clients.filter(c=> c.voiceChannelId===ch.id);
    const isActive = voiceChannelId===ch.id;
    el.className = "chan voice" + (isActive ? " active" : "");
    el.innerHTML = `<span class="icon">🔊</span><span class="name">${ch.name}</span>${participants.length? `<span class="count">${participants.length}</span>`:""}`;
    el.addEventListener("click", () => {
      // preview voice channel? show voice view
      qs("#main-hash").textContent = "🔊"; qs("#main-title").textContent = ch.name;
      qs("#chat-view").classList.add("hidden"); qs("#voice-view").classList.remove("hidden");
      // list participants below? handled by voice grid
      if (!voiceChannelId) {
        // not auto join, just show. Join via double click or button
      }
      renderChannels();
    });
    el.addEventListener("dblclick", () => joinVoice(ch.id));
    // small avatars inside?
    if (participants.length) {
      const sub = document.createElement("div");
      sub.style.paddingLeft = "28px"; sub.style.display = "flex"; sub.style.flexDirection="column"; sub.style.gap="4px"; sub.style.marginBottom="4px";
      for (const p of participants) {
        const row = document.createElement("div");
        row.style.display="flex"; row.style.alignItems="center"; row.style.gap="6px"; row.style.fontSize="12px"; row.style.color="#949ba4";
        row.innerHTML = `<span class="avatar" style="width:20px;height:20px;background:${p.avatarColor};border-radius:50%;display:grid;place-items:center;font-size:10px;color:white;">${p.username.slice(0,1).toUpperCase()}</span>${p.username}${p.screenSharing?' 🖥️':''}${p.muted?' 🔇':''}`;
        sub.appendChild(row);
      }
      const wrap = document.createElement("div");
      wrap.appendChild(el); wrap.appendChild(sub);
      vc.appendChild(wrap);
      // add join button if not in voice
      if (!voiceChannelId) {
        const btn = document.createElement("button");
        btn.textContent = "Entrar"; btn.className="btn tiny primary"; btn.style.margin="4px 0 8px 28px";
        btn.addEventListener("click", ()=> joinVoice(ch.id));
        wrap.appendChild(btn);
      }
      continue;
    }
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (confirm(`Apagar 🔊 ${ch.name}?`)) ws?.send(JSON.stringify({ op: "delete_channel", channelId: ch.id }));
    });
    vc.appendChild(el);
  }
}

function renderChat() {
  const list = qs("#chat-list"); list.innerHTML = "";
  if (!activeChannelId) { list.innerHTML = `<div class="hint" style="padding:40px;text-align:center">Selecione um canal de texto</div>`; return; }
  const msgs = messages.filter(m=> m.channelId===activeChannelId).slice(-300);
  if (msgs.length===0) {
    list.innerHTML = `<div style="padding:40px 0; text-align:center; color:#949ba4">
      <div style="width:64px;height:64px;border-radius:50%;background:#2b2d31;display:grid;place-items:center;margin:0 auto 12px;font-size:28px">#</div>
      <div style="font-weight:700;color:#f2f3f5">Bem-vindo ao #${channels.find(c=> c.id===activeChannelId)?.name}!</div>
      <div>Este é o começo do histórico.</div>
    </div>`;
    return;
  }
  for (const m of msgs) {
    const el = document.createElement("div"); el.className = "msg";
    const isSystem = m.authorId==="system";
    const color = clients.find(c=> c.id===m.authorId)?.avatarColor || (isSystem? "#00a8fc" : "#5865f2");
    const initial = m.username.slice(0,1).toUpperCase();
    const time = new Date(m.createdAt).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" });
    el.innerHTML = `<div class="msg-avatar" style="background:${color}">${initial}</div>
      <div class="msg-body"><div class="msg-head"><span class="msg-author" style="color:${isSystem? '#00a8fc': '#f2f3f5'}">${m.username}</span><span class="msg-time">${time}</span></div>
      <div class="msg-text">${escapeHtml(m.content)}</div></div>`;
    list.appendChild(el);
  }
  const scroll = qs("#chat-scroll"); scroll.scrollTop = scroll.scrollHeight;
}

function escapeHtml(s: string) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function renderMembers() {
  const list = qs("#members-list"); list.innerHTML = "";
  const groups: Record<string, ClientInfo[]> = { "Online": [], "No canal de voz": [], "Offline": [] } as any;
  // simple: all clients online
  const online = clients;
  const voice = clients.filter(c=> c.voiceChannelId);
  // header counts
  const addGroup = (title: string, members: ClientInfo[]) => {
    if (!members.length) return;
    const g = document.createElement("div"); g.className="members-group";
    g.innerHTML = `<h4>${title} — ${members.length}</h4>`;
    for (const m of members) {
      const row = document.createElement("div");
      row.className = "member " + (m.voiceChannelId? "voice":"online");
      row.innerHTML = `<span class="avatar" style="background:${m.avatarColor}">${m.username.slice(0,1).toUpperCase()}</span><span class="name">${m.username}${m.id===selfId?' (você)':''}</span><span class="status-dot"></span>`;
      if (m.voiceChannelId) {
        const ch = channels.find(c=> c.id===m.voiceChannelId);
        row.title = `Em voz: ${ch?.name || m.voiceChannelId} ${m.muted?'(mutado)':''} ${m.screenSharing?'(compartilhando)':''}`;
      }
      g.appendChild(row);
    }
    list.appendChild(g);
  };
  addGroup("Online", online);
  if (voice.length) addGroup("Em voz", voice);
}

function renderVoiceChannels() {
  // already inside renderChannels, but update alone
}
function renderVoicePanel() {
  const panel = qs("#voice-panel");
  if (voiceChannelId) {
    panel.classList.remove("hidden");
    const ch = channels.find(c=> c.id===voiceChannelId);
    qs("#vp-text").textContent = `Conectado em ${ch?.name || "voz"} • ${clients.filter(c=> c.voiceChannelId===voiceChannelId).length} pessoas`;
    (qs("#btn-mic") as HTMLElement).classList.toggle("active", micEnabled);
    (qs("#btn-mic") as HTMLElement).textContent = micEnabled ? "🎙️" : "🔇";
    (qs("#btn-deaf") as HTMLElement).classList.toggle("active", deafened);
    (qs("#btn-screen") as HTMLElement).classList.toggle("active", !!screenStream);
  } else {
    panel.classList.add("hidden");
  }
}

// ---------- Channel creation ----------
let pendingChanType: "text"|"voice" = "text";
qsa("[data-create]").forEach(b => b.addEventListener("click", () => {
  pendingChanType = (b.getAttribute("data-create") as any) || "text";
  qsa("#modal-create-channel [data-ctype]").forEach(x=> x.classList.toggle("active", x.getAttribute("data-ctype")===pendingChanType));
  (qs("#modal-create-channel") as HTMLDialogElement).showModal();
}));
qsa("#modal-create-channel [data-ctype]").forEach(b => b.addEventListener("click", () => {
  pendingChanType = b.getAttribute("data-ctype") as any;
  qsa("#modal-create-channel [data-ctype]").forEach(x=> x.classList.toggle("active", x.getAttribute("data-ctype")===pendingChanType));
}));
(qs("#modal-create-channel") as HTMLDialogElement).addEventListener("close", () => {
  if ((qs("#modal-create-channel") as HTMLDialogElement).returnValue !== "confirm") return;
  const name = (qs("#input-new-channel") as HTMLInputElement).value.trim();
  if (!name) return;
  if (!activeServerId) return toast("Selecione um servidor");
  ws?.send(JSON.stringify({ op: "create_channel", serverId: activeServerId, name, type: pendingChanType }));
  (qs("#input-new-channel") as HTMLInputElement).value = "";
});

qs("#btn-add-server")?.addEventListener("click", () => (qs("#modal-create-server") as HTMLDialogElement).showModal());
(qs("#modal-create-server") as HTMLDialogElement).addEventListener("close", () => {
  if ((qs("#modal-create-server") as HTMLDialogElement).returnValue !== "confirm") return;
  const name = (qs("#input-new-server") as HTMLInputElement).value.trim();
  if (!name) return;
  ws?.send(JSON.stringify({ op: "create_server", name }));
  (qs("#input-new-server") as HTMLInputElement).value = "";
});
qs("#btn-join-server")?.addEventListener("click", () => (qs("#modal-join-server") as HTMLDialogElement).showModal());
(qs("#modal-join-server") as HTMLDialogElement).addEventListener("close", () => {
  if ((qs("#modal-join-server") as HTMLDialogElement).returnValue !== "confirm") return;
  const code = (qs("#input-join-code") as HTMLInputElement).value.trim();
  if (!code) return;
  ws?.send(JSON.stringify({ op: "join_server", code }));
  (qs("#input-join-code") as HTMLInputElement).value = "";
});

// ---------- Composer ----------
const inputMessage = qs("#input-message") as HTMLInputElement;
inputMessage.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const content = inputMessage.value.trim();
    if (!content || !activeChannelId) return;
    ws?.send(JSON.stringify({ op: "send_message", channelId: activeChannelId, content }));
    inputMessage.value = "";
  } else {
    if (activeChannelId) ws?.send(JSON.stringify({ op: "typing", channelId: activeChannelId }));
  }
});

// ---------- Voice logic ----------
async function joinVoice(channelId: string) {
  if (voiceChannelId === channelId) return;
  if (voiceChannelId) await leaveVoice(false);
  voiceChannelId = channelId;
  // get mic
  try {
    localAudio = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    micEnabled = true;
    // apply mute state
    localAudio.getAudioTracks().forEach(t => t.enabled = !deafened && micEnabled);
  } catch (e: any) {
    toast("Permita o microfone para entrar na call");
    voiceChannelId = null;
    return;
  }
  ws?.send(JSON.stringify({ op: "join_voice", channelId }));
  ws?.send(JSON.stringify({ op: "voice_state", muted: !micEnabled, deafened, screenSharing: !!screenStream }));
  // show voice view
  qs("#voice-view").classList.remove("hidden"); qs("#chat-view").classList.add("hidden");
  qs("#main-hash").textContent = "🔊"; qs("#main-title").textContent = channels.find(c=> c.id===channelId)?.name || "voz";
  renderVoicePanel(); renderChannels();
  // create peer connections for existing participants
  const others = clients.filter(c=> c.voiceChannelId===channelId && c.id!==selfId);
  for (const o of others) await ensurePeer(o.id, true);
  updateVoiceGrid();
  // speaking detection for local
  setupSpeakingDetection();
}

async function leaveVoice(notify = true) {
  if (!voiceChannelId) return;
  if (notify) ws?.send(JSON.stringify({ op: "leave_voice" }));
  // close peers
  for (const [id, pc] of peers) { try{ pc.close(); }catch{}; remoteAudios.get(id)?.remove(); remoteVideos.get(id)?.remove(); }
  peers.clear(); remoteAudios.clear(); remoteVideos.clear();
  if (localAudio) { localAudio.getTracks().forEach(t=> t.stop()); localAudio=null; }
  if (screenStream) { screenStream.getTracks().forEach(t=> t.stop()); screenStream=null; }
  voiceChannelId = null;
  if (notify) {
    qs("#voice-view").classList.add("hidden"); qs("#chat-view").classList.remove("hidden");
    const ch = channels.find(c=> c.id===activeChannelId);
    if (ch) { qs("#main-hash").textContent = "#"; qs("#main-title").textContent = ch.name; }
  }
  renderVoicePanel(); renderChannels(); updateVoiceGrid();
  // remove stage
  qs("#screen-stage").classList.add("hidden"); qs("#stage-wrap").innerHTML="";
}

qs("#btn-leave")?.addEventListener("click", () => leaveVoice(true));
qs("#btn-mic")?.addEventListener("click", () => {
  micEnabled = !micEnabled;
  if (localAudio) localAudio.getAudioTracks().forEach(t=> t.enabled = micEnabled && !deafened);
  ws?.send(JSON.stringify({ op: "voice_state", muted: !micEnabled, deafened, screenSharing: !!screenStream }));
  renderVoicePanel(); updateVoiceGrid();
  // show speaking? toast
  toast(micEnabled ? "Microfone ativado" : "Microfone mutado");
});
qs("#btn-deaf")?.addEventListener("click", () => {
  deafened = !deafened;
  if (localAudio) localAudio.getAudioTracks().forEach(t=> t.enabled = micEnabled && !deafened);
  // mute remote audios
  remoteAudios.forEach(a=> a.muted = deafened);
  ws?.send(JSON.stringify({ op: "voice_state", muted: !micEnabled, deafened, screenSharing: !!screenStream }));
  renderVoicePanel();
  toast(deafened ? "Fone silenciado" : "Fone ativado");
});

// speaking detection (simple volume)
let audioCtx: AudioContext | null = null;
function setupSpeakingDetection() {
  if (!localAudio) return;
  try {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(localAudio);
    const analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;
    setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a,b)=> a+b,0)/data.length;
      const nowSpeaking = avg>18 && micEnabled && !deafened;
      if (nowSpeaking!==speaking) {
        speaking = nowSpeaking;
        // visual update via css? just update grid tile
        const selfTile = document.querySelector(`[data-tile="${selfId}"]`);
        if (selfTile) selfTile.classList.toggle("speaking-ring", speaking);
      }
    }, 120);
  } catch {}
}

// WebRTC mesh
async function ensurePeer(targetId: string, isOfferer: boolean) {
  if (peers.has(targetId)) return peers.get(targetId)!;
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(targetId, pc);

  // add local tracks
  if (localAudio) localAudio.getAudioTracks().forEach(t => pc.addTrack(t, localAudio!));
  if (screenStream) screenStream.getVideoTracks().forEach(t => pc.addTrack(t, screenStream!));

  // remote handling
  pc.ontrack = (ev) => {
    const stream = ev.streams[0];
    const track = ev.track;
    if (track.kind === "audio") {
      let audio = remoteAudios.get(targetId);
      if (!audio) {
        audio = document.createElement("audio"); audio.autoplay = true; (audio as any).playsInline = true;
        audio.muted = deafened;
        remoteAudios.set(targetId, audio);
        document.body.appendChild(audio); // hidden but playing
      }
      audio.srcObject = stream;
      audio.play().catch(()=>{});
    } else if (track.kind === "video") {
      let video = remoteVideos.get(targetId);
      if (!video) {
        video = document.createElement("video"); video.autoplay = true; (video as any).playsInline = true; video.muted = true;
        remoteVideos.set(targetId, video);
      }
      video.srcObject = stream;
      updateVoiceGrid();
      // also stage if screen
      maybeShowStage(targetId, stream);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) ws?.send(JSON.stringify({ op: "webrtc_signal", targetId, data: { type: "ice", candidate: e.candidate } }));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      peers.delete(targetId);
      updateVoiceGrid();
    }
  };

  if (isOfferer) {
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    ws?.send(JSON.stringify({ op: "webrtc_signal", targetId, data: { type: "offer", sdp: offer } }));
  }
  return pc;
}

async function handleSignal(fromId: string, data: any) {
  // if not in voice, ignore
  if (!voiceChannelId) return;
  // we are in same voice? check peer's voice channel includes us (clients list maybe stale) — allow anyway if we are in voice
  let pc = peers.get(fromId);
  if (data.type === "offer") {
    if (!pc) pc = await ensurePeer(fromId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws?.send(JSON.stringify({ op: "webrtc_signal", targetId: fromId, data: { type: "answer", sdp: answer } }));
  } else if (data.type === "answer") {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === "ice") {
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  }
}

// need to react to new participants joining after us: when voice_update arrives, ensure peers for new ones where we are offerer if our id < their id (deterministic)
let lastVoiceClients: string[] = [];
function handleVoiceUpdateForMesh() {
  if (!voiceChannelId || !selfId) return;
  const inChannel = clients.filter(c=> c.voiceChannelId===voiceChannelId).map(c=> c.id);
  const newOnes = inChannel.filter(id=> id!==selfId && !peers.has(id));
  for (const id of newOnes) {
    // deterministic offerer: lower id offers
    const shouldOffer = selfId! < id;
    if (shouldOffer) ensurePeer(id, true);
  }
  const left = [...peers.keys()].filter(id=> !inChannel.includes(id));
  for (const id of left) {
    try{ peers.get(id)?.close(); }catch{};
    peers.delete(id);
    remoteAudios.get(id)?.remove(); remoteAudios.delete(id);
    remoteVideos.get(id)?.remove(); remoteVideos.delete(id);
  }
  lastVoiceClients = inChannel;
}

// patch: call mesh handler whenever clients update
const origRenderVoicePanel2 = renderVoicePanel;
let _origClients: ClientInfo[] = [];
setInterval(() => {
  if (JSON.stringify(clients.map(c=>c.id+c.voiceChannelId).sort()) !== JSON.stringify(_origClients.map(c=>c.id+c.voiceChannelId).sort())) {
    _origClients = [...clients];
    handleVoiceUpdateForMesh();
  }
}, 700);

// ---------- Quality handling ----------
function parseQuality(q: string) {
  // returns { w,h, bitrateKbps }
  switch(q) {
    case "480p30": return { w: 854, h: 480, bitrate: 800 };
    case "720p30": return { w: 1280, h: 720, bitrate: 1500 };
    case "1080p30": return { w: 1920, h: 1080, bitrate: 2500 };
    case "1080p60": return { w: 1920, h: 1080, bitrate: 3500 };
    case "source": return { w: undefined, h: undefined, bitrate: 4000 };
    default: return { w: 1280, h: 720, bitrate: 1500 };
  }
}
async function applyQualityToSenders() {
  const q = parseQuality(selectedQuality);
  for (const pc of peers.values()) {
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.kind === "video") {
        try {
          const params: any = sender.getParameters();
          if (!params.encodings) params.encodings = [{}];
          if (q.bitrate) params.encodings[0].maxBitrate = q.bitrate * 1000;
          if (q.w && q.h) {
            params.encodings[0].scaleResolutionDownBy = 1; // rely on capture constraints
            params.encodings[0].maxFramerate = parseInt(selectedFps) || 30;
          }
          await sender.setParameters(params);
        } catch {}
      }
    }
  }
}
qs("#select-quality")?.addEventListener("change", (e) => {
  selectedQuality = (e.target as HTMLSelectElement).value;
  applyQualityToSenders();
  if (screenStream) restartScreenWithQuality();
});
qs("#select-fps")?.addEventListener("change", (e) => {
  selectedFps = (e.target as HTMLSelectElement).value;
  applyQualityToSenders();
});

qsa("[data-share]").forEach(b => b.addEventListener("click", () => {
  qsa("[data-share]").forEach(x=> x.classList.remove("active"));
  b.classList.add("active");
  shareType = b.getAttribute("data-share") as any;
}));

// ---------- Screen share ----------
qs("#btn-screen")?.addEventListener("click", async () => {
  if (screenStream) {
    stopScreenShare();
    return;
  }
  openScreenPicker();
});

function openScreenPicker() {
  const dlg = qs("#modal-screen-picker") as HTMLDialogElement;
  const grid = qs("#screen-thumb-grid"); grid.innerHTML = "<div class='hint'>Carregando prévia…</div>";
  dlg.showModal();
  loadThumbnails(shareType);
}

qsa("[data-spick]").forEach(b => b.addEventListener("click", () => {
  qsa("[data-spick]").forEach(x=> x.classList.remove("active"));
  b.classList.add("active");
  const t = b.getAttribute("data-spick") as any;
  shareType = t;
  // sync with voice panel
  qsa("[data-share]").forEach(x=> x.classList.toggle("active", x.getAttribute("data-share")===t));
  loadThumbnails(t);
}));

async function loadThumbnails(type: "screen"|"window") {
  const grid = qs("#screen-thumb-grid"); grid.innerHTML = "";
  const api: any = (window as any).electronAPI;
  if (api?.getDesktopSources) {
    try {
      const sources = await api.getDesktopSources(type==="screen" ? ["screen"] : ["window","screen"]);
      if (!sources.length) { grid.innerHTML = `<div class="hint">Nenhuma fonte encontrada. Tente o outro modo.</div>`; return; }
      for (const s of sources) {
        const thumb = document.createElement("div"); thumb.className="thumb"; thumb.dataset.id = s.id;
        thumb.innerHTML = `<img src="${s.thumbnail}" alt=""><div class="label">${s.name}</div>`;
        thumb.addEventListener("click", () => {
          qsa(".thumb").forEach(x=> x.classList.remove("active"));
          thumb.classList.add("active");
          pickerChoice = s.id;
        });
        grid.appendChild(thumb);
      }
      // auto select first
      if (sources[0]) { (grid.firstChild as HTMLElement)?.classList.add("active"); pickerChoice = sources[0].id; }
      return;
    } catch {}
  }
  // fallback: show generic options for browser getDisplayMedia
  const thumb = document.createElement("div"); thumb.className="thumb active"; thumb.dataset.id="browser";
  thumb.innerHTML = `<div style="aspect-ratio:16/9;background:#111;display:grid;place-items:center;color:#949ba4">Usar seletor do navegador</div><div class="label">${type==="screen"? "Tela do PC (navegador)":"Janela / Aba"}</div>`;
  thumb.addEventListener("click", () => { qsa(".thumb").forEach(x=> x.classList.remove("active")); thumb.classList.add("active"); pickerChoice="browser"; });
  grid.appendChild(thumb); pickerChoice="browser";
}

qs("#btn-picker-cancel")?.addEventListener("click", () => (qs("#modal-screen-picker") as HTMLDialogElement).close());
qs("#btn-picker-share")?.addEventListener("click", async () => {
  (qs("#modal-screen-picker") as HTMLDialogElement).close();
  const quality = (qs("#pick-quality") as HTMLSelectElement).value;
  selectedQuality = quality;
  (qs("#select-quality") as HTMLSelectElement).value = quality;
  const fpsSel = shareType==="screen" ? "30" : "30";
  // start share
  await startScreenShare(pickerChoice, quality, (qs("#pick-audio") as HTMLInputElement).checked);
});

async function startScreenShare(sourceId: string | null, quality: string, withAudio: boolean) {
  const q = parseQuality(quality);
  let constraints: any = {
    video: {
      frameRate: { ideal: parseInt(selectedFps)||30, max: 60 },
    },
    audio: withAudio ? { echoCancellation: false, noiseSuppression: false } : false,
  };
  if (q.w && q.h) { constraints.video.width = { ideal: q.w }; constraints.video.height = { ideal: q.h }; }

  // Electron desktopCapturer path: use chromeMediaSource
  const api: any = (window as any).electronAPI;
  let stream: MediaStream | null = null;
  if (api && sourceId && sourceId!=="browser" && sourceId.startsWith("screen:") || sourceId?.startsWith("window:")) {
    try {
      // Electron requires mandatory chromeMediaSource
      const videoConstraints: any = {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          minWidth: q.w || 1280,
          maxWidth: q.w || 1920,
          minHeight: q.h || 720,
          maxHeight: q.h || 1080,
          minFrameRate: parseInt(selectedFps)||30,
          maxFrameRate: 60,
        }
      };
      stream = await (navigator.mediaDevices as any).getUserMedia({ video: videoConstraints, audio: withAudio ? { mandatory: { chromeMediaSource: "desktop" } } : false });
    } catch (e) {
      console.error(e);
      // fallback to getDisplayMedia
      stream = null;
    }
  }
  if (!stream) {
    try {
      // try to hint displaySurface
      if (shareType==="window") (constraints.video as any).displaySurface = "window";
      else (constraints.video as any).displaySurface = "monitor";
      stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (e: any) {
      toast("Compartilhamento cancelado ou não permitido");
      return;
    }
  }
  screenStream = stream;
  // handle ended
  screenStream.getVideoTracks()[0]?.addEventListener("ended", () => stopScreenShare());

  // add to peers
  for (const [id, pc] of peers) {
    for (const t of screenStream!.getVideoTracks()) pc.addTrack(t, screenStream!);
    if (withAudio) for (const t of screenStream!.getAudioTracks()) pc.addTrack(t, screenStream!);
    // renegotiate
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws?.send(JSON.stringify({ op: "webrtc_signal", targetId: id, data: { type: "offer", sdp: offer } }));
  }
  ws?.send(JSON.stringify({ op: "voice_state", muted: !micEnabled, deafened, screenSharing: true }));
  renderVoicePanel(); updateVoiceGrid();
  toast(`Compartilhando ${shareType==="screen"?"tela do PC":"janela"} em ${quality}`);
  // show local preview in stage?
  maybeShowStage(selfId!, screenStream);
}

function stopScreenShare() {
  if (!screenStream) return;
  // remove senders
  for (const pc of peers.values()) {
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.kind==="video" && screenStream?.getVideoTracks().includes(sender.track as MediaStreamTrack)) {
        try { pc.removeTrack(sender); } catch {}
      }
    }
  }
  screenStream.getTracks().forEach(t=> t.stop());
  screenStream = null;
  ws?.send(JSON.stringify({ op: "voice_state", muted: !micEnabled, deafened, screenSharing: false }));
  // renegotiate without video
  for (const [id, pc] of peers) {
    pc.createOffer().then(o=> pc.setLocalDescription(o).then(()=> ws?.send(JSON.stringify({ op:"webrtc_signal", targetId:id, data:{type:"offer", sdp:o}}))));
  }
  renderVoicePanel(); updateVoiceGrid();
  qs("#screen-stage").classList.add("hidden");
  toast("Compartilhamento encerrado");
}

async function restartScreenWithQuality() {
  if (!screenStream) return;
  // not easy to change capture resolution without re-capture. Re-capture if user changed quality via panel
  // keep simple: just update bitrate via sender params (already done)
}

function maybeShowStage(peerId: string, stream: MediaStream) {
  const wrap = qs("#stage-wrap");
  const stage = qs("#screen-stage");
  // if stream has video, show stage with that stream (prefer screen streams)
  const hasVideo = stream.getVideoTracks().length > 0;
  if (!hasVideo) return;
  stage.classList.remove("hidden");
  wrap.innerHTML = "";
  const video = document.createElement("video");
  video.autoplay = true; (video as any).playsInline = true; video.controls = false; video.muted = peerId===selfId;
  video.srcObject = stream;
  wrap.appendChild(video);
  video.play().catch(()=>{});
  const peerName = clients.find(c=> c.id===peerId)?.username || (peerId===selfId? selfUsername : peerId.slice(0,4));
  qs("#stage-title").textContent = `Tela de ${peerName} • ${selectedQuality}`;
  // scroll into view
  stage.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
qs("#btn-stage-close")?.addEventListener("click", () => {
  qs("#screen-stage").classList.add("hidden"); qs("#stage-wrap").innerHTML="";
});

function updateVoiceGrid() {
  const grid = qs("#voice-grid");
  grid.innerHTML = "";
  if (!voiceChannelId) {
    grid.innerHTML = `<div style="grid-column:1/-1; padding:32px; text-align:center; color:#949ba4">
      <div style="font-size:28px; margin-bottom:8px">🔊</div>
      <div style="font-weight:700; color:#f2f3f5">Ninguém na call ainda</div>
      <div>Entre em um canal de voz para conversar e compartilhar tela.</div>
    </div>`;
    return;
  }
  const inChannel = clients.filter(c=> c.voiceChannelId===voiceChannelId);
  // include self if not in clients yet? self should be in list after server update, but ensure tile
  const allIds = new Set(inChannel.map(c=> c.id));
  if (selfId && voiceChannelId && !allIds.has(selfId)) {
    inChannel.push({ id:selfId, username:selfUsername, avatarColor:selfColor, voiceChannelId, muted:!micEnabled, deafened, screenSharing: !!screenStream });
  }
  for (const p of inChannel) {
    const tile = document.createElement("div"); tile.className="voice-tile"; tile.dataset.tile = p.id;
    const isSelf = p.id===selfId;
    const video = !isSelf ? remoteVideos.get(p.id) : (screenStream && screenStream.getVideoTracks().length? (()=>{ const v=document.createElement("video"); v.srcObject=screenStream!; v.autoplay=true; (v as any).playsInline=true; v.muted=true; return v;})() : null);
    const hasVideo = !!video;
    tile.innerHTML = `<div class="tile-head">
      <span class="tile-avatar" style="background:${p.avatarColor}">${p.username.slice(0,1).toUpperCase()}</span>
      <span class="tile-name">${p.username}${isSelf?' (você)':''}</span>
      <span class="tile-badge ${p.muted?'muted':''} ${!p.muted && !p.deafened ? 'speaking' : ''}">${p.muted?'🔇 mutado': p.screenSharing?'🖥️ compartilhando':'● ao vivo'}</span>
    </div>
    <div class="tile-video">${hasVideo? "":"<span class='no-cam'>Sem vídeo</span>"}</div>`;
    if (hasVideo && video) {
      const box = tile.querySelector(".tile-video") as HTMLElement;
      box.innerHTML = "";
      video.style.width="100%"; video.style.height="100%"; video.style.objectFit="contain";
      box.appendChild(video);
      video.play?.().catch(()=>{});
      // click to stage
      box.style.cursor="pointer";
      box.addEventListener("click", () => {
        const stream = (video as HTMLVideoElement).srcObject as MediaStream;
        if (stream) maybeShowStage(p.id, stream);
      });
    } else if (isSelf && localAudio) {
      // show speaking ring placeholder
    }
    // mute indicator overlay?
    grid.appendChild(tile);
  }
  // if someone is screen sharing, auto stage the first sharer (prioritize remote)
  const sharer = inChannel.find(c=> c.screenSharing && remoteVideos.has(c.id));
  if (sharer) {
    const v = remoteVideos.get(sharer.id);
    if (v && v.srcObject) maybeShowStage(sharer.id, v.srcObject as MediaStream);
  } else if (screenStream) {
    maybeShowStage(selfId!, screenStream);
  }
}

// ---------- persist username/host ----------
(function restore() {
  const u = localStorage.getItem("nexus_username");
  const h = localStorage.getItem("nexus_host");
  if (u) (inputUsername as HTMLInputElement).value = u;
  if (h) (inputHost as HTMLInputElement).value = h;
})();

// keyboard: M to mute, D to deafen
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase()==="m" && voiceChannelId && !(e.target instanceof HTMLInputElement)) {
    qs("#btn-mic")?.click();
  }
  if ((e.target as HTMLElement)?.id==="input-message" && e.key==="Escape") {
    (e.target as HTMLInputElement).blur();
  }
});

// members toggle
qs("#btn-toggle-members")?.addEventListener("click", () => {
  const m = qs("#members");
  m.style.display = m.style.display==="none" ? "" : "none";
});

// tiny quality btn in stage
qs("#btn-stage-quality")?.addEventListener("click", () => {
  const s = prompt("Qualidade (720p30, 1080p30, 1080p60, 480p30, source):", selectedQuality);
  if (s) { selectedQuality = s; (qs("#select-quality") as HTMLSelectElement).value = s; applyQualityToSenders(); toast(`Qualidade: ${s}`); }
});

// ---------- Cleanup ao fechar (corrige travamento) ----------
function cleanupBeforeClose() {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
  try { localAudio?.getTracks().forEach(t => t.stop()); } catch {}
  try { screenStream?.getTracks().forEach(t => t.stop()); } catch {}
  try { audioCtx?.close(); } catch {}
  for (const pc of peers.values()) try { pc.close(); } catch {}
  peers.clear();
  // remove audios do DOM
  for (const a of remoteAudios.values()) try { a.pause(); a.srcObject = null; a.remove(); } catch {}
  remoteAudios.clear();
}
// electron fecha a janela mas o renderer pode ficar preso com ws/peers abertos
window.addEventListener("beforeunload", cleanupBeforeClose);
window.addEventListener("pagehide", cleanupBeforeClose);
// também se o main pedir para fechar, garante
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && (ws?.readyState === WebSocket.CLOSING || ws?.readyState === WebSocket.CLOSED)) {
    cleanupBeforeClose();
  }
});

// ---------- Updater (GitHub Releases + git pull) ----------
const btnUpdate = qs("#btn-update") as HTMLButtonElement;
const modalUpdate = qs("#modal-update") as HTMLDialogElement;
const updateInfoEl = qs("#update-info") as HTMLElement;
const updateProgressEl = qs("#update-progress") as HTMLElement;
const updateBar = qs("#update-bar") as HTMLElement;
const updatePercent = qs("#update-percent") as HTMLElement;
const btnUpdateClose = qs("#btn-update-close") as HTMLButtonElement;
const btnUpdateAction = qs("#btn-update-action") as HTMLButtonElement;
const btnUpdateInstall = qs("#btn-update-install") as HTMLButtonElement;
const btnGitPull = qs("#btn-git-pull") as HTMLButtonElement;

async function openUpdater() {
  modalUpdate.showModal();
  updateInfoEl.textContent = "Verificando atualização…";
  updateProgressEl.style.display = "none";
  btnUpdateAction.style.display = "none";
  btnUpdateInstall.style.display = "none";
  btnGitPull.style.display = "none";
  const api: any = (window as any).electronAPI;
  if (!api?.checkUpdate) {
    updateInfoEl.innerHTML = `Modo navegador — sem auto-update.<br>Atualize com:<br><code>git pull origin main</code> na pasta do projeto.`;
    btnGitPull.style.display = "";
    return;
  }
  try {
    const ver = await api.getAppVersion().catch(()=>"?");
    updateInfoEl.textContent = `Versão atual: ${ver} — consultando GitHub…`;
    const res = await api.checkUpdate();
    if (res?.github?.hasUpdate) {
      updateInfoEl.innerHTML = `Nova versão <b>${res.github.latest}</b> disponível! (atual: ${res.github.current})<br><a href="${res.github.url}" target="_blank" style="color:#00a8fc">Ver no GitHub</a>`;
      btnUpdateAction.style.display = "";
      btnUpdateAction.textContent = "Baixar atualização";
    } else if (res?.updateInfo) {
      updateInfoEl.textContent = `Nova versão ${res.updateInfo.version} disponível!`;
      btnUpdateAction.style.display = "";
    } else if (res?.git?.output) {
      updateInfoEl.innerHTML = `<pre style="white-space:pre-wrap;background:#2b2d31;padding:8px;border-radius:6px;max-height:120px;overflow:auto">${res.git.output}</pre>`;
      if (res.git.hasUpdate) btnGitPull.style.display = "";
    } else if (res?.ok) {
      updateInfoEl.textContent = "Você já está na última versão ✓";
    } else {
      updateInfoEl.textContent = res?.error || "Sem atualização disponível ✓";
    }
    // mostra git pull em dev
    if (!res?.isPackaged) btnGitPull.style.display = "";
  } catch (e: any) {
    updateInfoEl.textContent = "Erro ao verificar: " + (e?.message || e);
  }
}
btnUpdate?.addEventListener("click", openUpdater);
btnUpdateClose?.addEventListener("click", () => modalUpdate.close());
btnUpdateAction?.addEventListener("click", async () => {
  const api: any = (window as any).electronAPI;
  updateProgressEl.style.display = "";
  updateInfoEl.textContent = "Baixando atualização…";
  btnUpdateAction.disabled = true;
  try { await api.downloadUpdate(); } catch (e: any) { updateInfoEl.textContent = "Erro no download: " + (e?.message || e); btnUpdateAction.disabled = false; }
});
btnUpdateInstall?.addEventListener("click", async () => {
  const api: any = (window as any).electronAPI;
  await api.installUpdate();
});
btnGitPull?.addEventListener("click", async () => {
  const api: any = (window as any).electronAPI;
  updateInfoEl.textContent = "Executando git pull…";
  btnGitPull.disabled = true;
  try {
    const r = await api.gitPull();
    updateInfoEl.innerHTML = `<pre style="white-space:pre-wrap;background:#2b2d31;padding:8px;border-radius:6px;max-height:160px;overflow:auto">${r.output}</pre>`;
    if (r.ok) toast("Repositório atualizado — reinicie o app para aplicar");
    else toast("Falha no git pull");
  } catch (e: any) { updateInfoEl.textContent = String(e); }
  btnGitPull.disabled = false;
});
// eventos do main
try {
  const api: any = (window as any).electronAPI;
  api?.onUpdaterStatus?.((data: any) => {
    if (data.type === "checking") updateInfoEl.textContent = "Verificando…";
    if (data.type === "available") { updateInfoEl.textContent = `Versão ${data.version} disponível!`; btnUpdateAction.style.display = ""; }
    if (data.type === "not-available") updateInfoEl.textContent = "Você já está na última versão ✓";
    if (data.type === "downloaded") { updateInfoEl.textContent = `Versão ${data.version} pronta!`; btnUpdateAction.style.display = "none"; btnUpdateInstall.style.display = ""; updateProgressEl.style.display = "none"; toast(`Atualização ${data.version} pronta — reinicie para instalar`); if (!modalUpdate.open) modalUpdate.showModal(); }
    if (data.type === "error") updateInfoEl.textContent = "Erro: " + data.message;
  });
  api?.onUpdaterProgress?.((p: any) => {
    updateProgressEl.style.display = "";
    const pct = Math.round(p.percent || 0);
    updateBar.style.width = pct + "%";
    updatePercent.textContent = `${pct}% — ${(p.bytesPerSecond/1024/1024).toFixed(1)} MB/s`;
  });
} catch {}

// expose for debug
(window as any)._leave = leaveVoice;
(window as any)._cleanup = cleanupBeforeClose;
(window as any)._openUpdater = openUpdater;
