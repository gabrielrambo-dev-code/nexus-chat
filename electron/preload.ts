import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getIPs: (): Promise<string[]> => ipcRenderer.invoke("app:getIPs"),
  getHostStatus: () => ipcRenderer.invoke("app:getHostStatus"),
  startHost: (port: number) => ipcRenderer.invoke("host:start", port),
  stopHost: () => ipcRenderer.invoke("host:stop"),
  startTunnel: (port: number) => ipcRenderer.invoke("tunnel:start", port),
  stopTunnel: () => ipcRenderer.invoke("tunnel:stop"),
  getTunnelStatus: () => ipcRenderer.invoke("tunnel:status"),
  allowFirewall: (port: number) => ipcRenderer.invoke("firewall:allow", port),
  getDesktopSources: (types: ("screen" | "window")[]) => ipcRenderer.invoke("desktop:getSources", { types }),
  onHostBroadcast: (cb: (data: any) => void) => {
    const handler = (_e: any, data: any) => cb(data);
    ipcRenderer.on("host:broadcast", handler);
    return () => ipcRenderer.removeListener("host:broadcast", handler);
  },
  // updater
  checkUpdate: () => ipcRenderer.invoke("updater:check"),
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  gitPull: () => ipcRenderer.invoke("updater:gitPull"),
  getAppVersion: () => ipcRenderer.invoke("updater:getVersion"),
  onUpdaterStatus: (cb: (data: any) => void) => {
    const h = (_e: any, d: any) => cb(d);
    ipcRenderer.on("updater:status", h);
    return () => ipcRenderer.removeListener("updater:status", h);
  },
  onUpdaterProgress: (cb: (data: any) => void) => {
    const h = (_e: any, d: any) => cb(d);
    ipcRenderer.on("updater:progress", h);
    return () => ipcRenderer.removeListener("updater:progress", h);
  },
});

declare global {
  interface Window {
    electronAPI?: {
      getVersion: () => Promise<string>;
      getIPs: () => Promise<string[]>;
      getHostStatus: () => Promise<any>;
      startHost: (port: number) => Promise<any>;
      stopHost: () => Promise<any>;
      startTunnel: (port: number) => Promise<any>;
      stopTunnel: () => Promise<any>;
      getTunnelStatus: () => Promise<any>;
      allowFirewall: (port: number) => Promise<any>;
      getDesktopSources: (types: ("screen" | "window")[]) => Promise<{ id: string; name: string; thumbnail: string; displayId: string }[]>;
      onHostBroadcast: (cb: (data: any) => void) => () => void;
      checkUpdate: () => Promise<any>;
      downloadUpdate: () => Promise<any>;
      installUpdate: () => Promise<any>;
      gitPull: () => Promise<any>;
      getAppVersion: () => Promise<string>;
      onUpdaterStatus: (cb: (data: any) => void) => () => void;
      onUpdaterProgress: (cb: (data: any) => void) => () => void;
    };
  }
}
