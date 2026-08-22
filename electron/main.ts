import { app, BrowserWindow, ipcMain, desktopCapturer, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { HostServer } from "./server";
import { setupUpdater } from "./updater";
import { startTunnel, stopTunnel, getTunnelStatus, ensureFirewallRule } from "./tunnel";

let win: BrowserWindow | null = null;
let hostServer: HostServer | null = null;
let isQuitting = false;

// single instance — evita 2 processos travados
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function getRendererPath() {
  const devPath = path.join(__dirname, "../src/index.html");
  if (fs.existsSync(devPath)) return devPath;
  return path.join(__dirname, "../dist/index.html");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#313338",
    title: "Nexus Chat",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#1e1f22", symbolColor: "#f2f3f5", height: 32 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    autoHideMenuBar: true,
  });

  const renderer = getRendererPath();
  const isDev = process.env.NODE_ENV === "development" && fs.existsSync(path.join(__dirname, "../src/index.html"));

  if (!isDev && renderer.endsWith("dist/index.html") && fs.existsSync(renderer)) {
    win.loadFile(renderer);
  } else if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const fallback = path.join(__dirname, "../dist/index.html");
    if (fs.existsSync(fallback)) win.loadFile(fallback);
    else win.loadURL(`file://${renderer}`);
  }

  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", (e) => {
    if (!isQuitting && hostServer?.isRunning()) {
      e.preventDefault();
      isQuitting = true;
      Promise.all([hostServer.stop().catch(() => {}), stopTunnel().catch(() => {})]).finally(() => {
        hostServer = null;
        setTimeout(() => app.exit(0), 400);
        app.quit();
      });
      setTimeout(() => { if (!app.isReady() || win) try { app.exit(0); } catch {} }, 2000);
    } else {
      stopTunnel().catch(() => {});
    }
  });

  win.on("closed", () => { win = null; });
}

function getLocalIPs(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  if (ips.length === 0) ips.push("127.0.0.1");
  return ips;
}

app.whenReady().then(() => {
  createWindow();
  setupUpdater(() => win);

  ipcMain.handle("app:getVersion", () => app.getVersion());
  ipcMain.handle("app:getIPs", () => getLocalIPs());
  ipcMain.handle("app:getHostStatus", () => ({ ...(hostServer?.getStatus() ?? { running: false, port: 0, ips: [] }), tunnel: getTunnelStatus() }));

  ipcMain.handle("host:start", async (_e: any, port: number) => {
    if (hostServer?.isRunning()) return { ...hostServer.getStatus(), tunnel: getTunnelStatus() };
    hostServer = new HostServer(port, app.getPath("userData"));
    await hostServer.start();
    hostServer.onBroadcast((data: any) => {
      try { win?.webContents.send("host:broadcast", data); } catch {}
    });
    return { ...hostServer.getStatus(), tunnel: getTunnelStatus() };
  });

  ipcMain.handle("host:stop", async () => {
    await hostServer?.stop().catch(()=>{});
    await stopTunnel().catch(()=>{});
    hostServer = null;
    return { running: false, tunnel: getTunnelStatus() };
  });

  ipcMain.handle("tunnel:start", async (_e: any, port: number) => {
    if (!hostServer?.isRunning()) throw new Error("Inicie o servidor local primeiro");
    const res = await startTunnel(port);
    return { ...res, status: getTunnelStatus() };
  });
  ipcMain.handle("tunnel:stop", async () => {
    await stopTunnel();
    return getTunnelStatus();
  });
  ipcMain.handle("tunnel:status", () => getTunnelStatus());

  ipcMain.handle("firewall:allow", async (_e: any, port: number) => {
    return await ensureFirewallRule(port);
  });
  ipcMain.handle("firewall:check", async (_e: any, port: number) => {
    const { checkFirewallRule } = await import("./tunnel");
    return await checkFirewallRule(port);
  });

  ipcMain.handle("desktop:getSources", async (_e: any, opts: { types: ("screen" | "window")[] }) => {
    const sources = await desktopCapturer.getSources({
      types: opts.types as any,
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((s: any) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      displayId: (s as any).display_id || "",
    }));
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (!isQuitting) app.quit();
  }
});

app.on("before-quit", (e) => {
  if (!hostServer?.isRunning() || isQuitting) {
    stopTunnel().catch(()=>{});
    return;
  }
  e.preventDefault();
  isQuitting = true;
  Promise.all([hostServer.stop().catch(()=>{}), stopTunnel().catch(()=>{})]).finally(() => {
    hostServer = null;
    app.quit();
  });
  setTimeout(() => { try { app.exit(0); } catch {} }, 1500);
});

app.on("will-quit", () => {
  try { win?.removeAllListeners(); } catch {}
});
