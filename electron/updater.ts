import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { exec } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// Auto-updater via GitHub Releases + fallback git pull
export function setupUpdater(getWin: () => BrowserWindow | null) {
  // só ativa em produção empacotada
  const isPackaged = app.isPackaged;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  // --- helpers ---
  function send(channel: string, data: any) {
    try { getWin()?.webContents.send(channel, data); } catch {}
  }

  autoUpdater.on("checking-for-update", () => send("updater:status", { type: "checking" }));
  autoUpdater.on("update-available", (info) => {
    send("updater:status", { type: "available", version: info.version, info });
    // pergunta ao usuário
    dialog.showMessageBox(getWin()!, {
      type: "info",
      title: "Atualização disponível",
      message: `Nova versão ${info.version} disponível! Deseja baixar agora?`,
      buttons: ["Baixar agora", "Depois"],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate();
    });
  });
  autoUpdater.on("update-not-available", (info) => send("updater:status", { type: "not-available", version: info.version }));
  autoUpdater.on("download-progress", (p) => send("updater:progress", { percent: p.percent, bytesPerSecond: p.bytesPerSecond, transferred: p.transferred, total: p.total }));
  autoUpdater.on("update-downloaded", (info) => {
    send("updater:status", { type: "downloaded", version: info.version });
    dialog.showMessageBox(getWin()!, {
      type: "info",
      title: "Pronto para atualizar",
      message: `Versão ${info.version} baixada. Reiniciar agora para instalar?`,
      buttons: ["Reiniciar agora", "Depois"],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        setTimeout(() => autoUpdater.quitAndInstall(false, true), 500);
      }
    });
  });
  autoUpdater.on("error", (err) => {
    send("updater:status", { type: "error", message: err?.message || String(err) });
  });

  // IPC
  ipcMain.handle("updater:check", async () => {
    if (!isPackaged) {
      // modo dev: tenta git pull como fallback
      return await checkGitUpdate();
    }
    try {
      const res = await autoUpdater.checkForUpdates();
      return { ok: true, updateInfo: res?.updateInfo ?? null, isPackaged };
    } catch (e: any) {
      // fallback: tenta GitHub API direta
      const git = await checkGitHubAPI();
      if (git.hasUpdate) return { ok: true, fallback: git, error: e?.message };
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle("updater:download", async () => {
    if (!isPackaged) return { ok: false, error: "Só disponível no app instalado (.exe)" };
    try { await autoUpdater.downloadUpdate(); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message }; }
  });

  ipcMain.handle("updater:install", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle("updater:gitPull", async () => {
    return await doGitPull();
  });

  ipcMain.handle("updater:getVersion", () => app.getVersion());

  // auto check 5s após iniciar (só se empacotado)
  if (isPackaged) {
    setTimeout(() => { autoUpdater.checkForUpdates().catch(()=>{}); }, 5000);
    // check periódico a cada 1h
    setInterval(() => { autoUpdater.checkForUpdates().catch(()=>{}); }, 60 * 60 * 1000);
  } else {
    // em dev, só loga
    console.log("[Updater] modo desenvolvimento — auto-update desabilitado, use 'git pull'");
  }
}

// Fallback: consulta GitHub Releases API pública + raw + git (funciona mesmo com repo privado)
async function checkGitHubAPI(): Promise<{ hasUpdate: boolean; latest?: string; current: string; url?: string; isPrivate?: boolean; note?: string }> {
  const current = app.getVersion();
  try {
    // 1) tenta releases/latest (público)
    const res = await fetch("https://api.github.com/repos/gabrielrambo-dev-code/nexus-chat/releases/latest", {
      headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "nexus-chat" } as any,
    } as any);
    if (res.ok) {
      const j: any = await res.json();
      const latest = (j.tag_name || j.name || "").replace(/^v/, "");
      const hasUpdate = latest && latest !== current;
      return { hasUpdate, latest, current, url: j.html_url };
    }
    // 2) se 404, pode ser repo privado — tenta raw package.json via git ls-remote fallback
    if (res.status === 404) {
      // tenta buscar versão remota via git (funciona mesmo privado se já tem credencial)
      const remoteVer = await getRemoteVersionViaGit().catch(() => null);
      if (remoteVer) {
        const hasUpdate = remoteVer !== current;
        return { hasUpdate, latest: remoteVer, current, isPrivate: true, note: "Repo privado — atualização via git. Torne o repo público para Releases automáticas." };
      }
      // tenta raw public (se tornar público, vai funcionar)
      try {
        const raw = await fetch("https://raw.githubusercontent.com/gabrielrambo-dev-code/nexus-chat/main/package.json", { headers: { "User-Agent": "nexus-chat" } as any } as any);
        if (raw.ok) {
          const pj: any = await raw.json();
          const latest = (pj.version || "").replace(/^v/, "");
          return { hasUpdate: latest && latest !== current, latest, current, isPrivate: true };
        }
      } catch {}
      return { hasUpdate: false, current, isPrivate: true, note: "Repo privado ou sem releases — use git pull ou publique uma Release no GitHub" };
    }
  } catch {}
  return { hasUpdate: false, current };
}

async function getRemoteVersionViaGit(): Promise<string | null> {
  return new Promise((resolve) => {
    exec("git ls-remote https://github.com/gabrielrambo-dev-code/nexus-chat.git HEAD", { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // Não dá para pegar version só com ls-remote; tenta fetch + show
      exec("git show origin/main:package.json 2>nul | findstr version", { timeout: 8000 }, (_e2, out2) => {
        if (out2) {
          const m = out2.match(/\"version\"\s*:\s*\"([^\"]+)\"/);
          if (m) return resolve(m[1]);
        }
        resolve(null);
      });
    });
  });
}

async function checkGitUpdate(): Promise<any> {
  const gitPull = await doGitPull(true); // dry-run check
  const gh = await checkGitHubAPI();
  return { ok: true, git: gitPull, github: gh, isDev: true };
}

function doGitPull(dryRun = false): Promise<{ ok: boolean; output: string; hasUpdate?: boolean }> {
  return new Promise((resolve) => {
    // tenta achar .git na pasta do app (dev) ou ao lado do exe (se clonado)
    const possibleRoots = [
      path.join(process.resourcesPath, ".."),
      path.join(app.getAppPath(), ".."),
      path.join(app.getAppPath()),
      process.cwd(),
    ];
    let gitRoot: string | null = null;
    for (const p of possibleRoots) {
      if (fs.existsSync(path.join(p, ".git"))) { gitRoot = p; break; }
      // sobe 2 níveis
      const up = path.join(p, "..", ".git");
      if (fs.existsSync(up)) { gitRoot = path.join(p, ".."); break; }
    }
    // tenta também local padrão do clone
    if (!gitRoot && fs.existsSync(path.join(process.cwd(), ".git"))) gitRoot = process.cwd();

    if (!gitRoot) {
      resolve({ ok: false, output: "Repositório git não encontrado. Atualização via GitHub Releases apenas no app instalado." });
      return;
    }

    const cmd = dryRun ? "git fetch --dry-run" : "git pull --ff-only";
    exec(cmd, { cwd: gitRoot, timeout: 15000 }, (err, stdout, stderr) => {
      const out = (stdout + "\n" + stderr).trim();
      if (err && !dryRun) resolve({ ok: false, output: out || err.message });
      else resolve({ ok: true, output: out || "Já atualizado", hasUpdate: !out.includes("Already up to date") && !out.includes("Já atualizado") });
    });
  });
}
