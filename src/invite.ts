// Invite helpers — PeerJS internet fallback (opcional, se peerjs disponível)
let peer: any = null;
let peerId: string | null = null;

export async function getPeerId(): Promise<string | null> {
  if (peerId) return peerId;
  try {
    const { Peer } = await import("peerjs");
    return await new Promise<string>((resolve, reject) => {
      const p = new (Peer as any)(undefined, { debug: 0 });
      const t = setTimeout(() => { try{ p.destroy(); }catch{}; reject(new Error("timeout peer")); }, 8000);
      p.on("open", (id: string) => { clearTimeout(t); peer = p; peerId = id; resolve(id); });
      p.on("error", (e: any) => { clearTimeout(t); reject(e); });
    });
  } catch { return null; }
}

export function getPeer() { return peer; }
