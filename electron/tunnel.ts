import { exec } from "node:child_process";

let tunnel: any = null;
let tunnelUrl: string | null = null;
let tunnelPort: number | null = null;

export async function startTunnel(port: number): Promise<{ url: string; wsUrl: string }> {
  if (tunnelUrl && tunnelPort === port) return { url: tunnelUrl, wsUrl: toWsUrl(tunnelUrl) };
  await stopTunnel().catch(() => {});
  // usa localtunnel via require dinâmico para não travar se não houver rede
  // @ts-ignore
  const lt = await import("localtunnel").then((m: any) => m.default || m).catch(() => null);
  if (!lt) throw new Error("localtunnel não disponível");
  tunnel = await (lt as any)({ port, allow_invalid_cert: true });
  tunnelPort = port;
  tunnelUrl = tunnel.url;
  if (!tunnelUrl) throw new Error("Falha ao criar túnel");
  tunnel.on?.("close", () => { tunnelUrl = null; tunnelPort = null; tunnel = null; });
  tunnel.on?.("error", () => {});
  return { url: tunnelUrl, wsUrl: toWsUrl(tunnelUrl) };
}

export async function stopTunnel(): Promise<void> {
  if (!tunnel) return;
  try { await (tunnel as any).close?.(); } catch {}
  try { (tunnel as any).close?.(); } catch {}
  tunnel = null; tunnelUrl = null; tunnelPort = null;
}

export function getTunnelStatus() {
  return { running: !!tunnelUrl, url: tunnelUrl, wsUrl: tunnelUrl ? toWsUrl(tunnelUrl) : null, port: tunnelPort };
}

function toWsUrl(httpUrl: string): string {
  // https://xxx.loca.lt -> wss://xxx.loca.lt
  // http://xxx.loca.lt  -> ws://xxx.loca.lt
  if (httpUrl.startsWith("https://")) return "wss://" + httpUrl.slice(8);
  if (httpUrl.startsWith("http://")) return "ws://" + httpUrl.slice(7);
  return httpUrl;
}

export async function ensureFirewallRule(port: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const ruleName = "Nexus Chat";
    // tenta criar regra TCP inbound (precisa admin — se falhar, orienta usuário)
    const cmd = `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port} profile=private,public enable=yes`;
    exec(cmd, { timeout: 8000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).trim();
      if (err) resolve({ ok: false, output: out || err.message + " — execute o app como Administrador para liberar automaticamente" });
      else resolve({ ok: true, output: out || "Regra criada" });
    });
  });
}

export async function checkFirewallRule(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`netsh advfirewall firewall show rule name="Nexus Chat" verbose`, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.includes(`${port}`) || stdout.includes("Nexus Chat"));
    });
  });
}
