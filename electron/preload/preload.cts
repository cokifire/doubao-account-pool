import { contextBridge, ipcRenderer } from "electron";
import type { AccountCreateInput, AccountUpdateInput, AppSettingsUpdateInput } from "../types.js";

const api = {
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list"),
    create: (input?: AccountCreateInput) => ipcRenderer.invoke("accounts:create", input),
    update: (input: AccountUpdateInput) => ipcRenderer.invoke("accounts:update", input),
    setEnabled: (id: number, enabled: boolean) => ipcRenderer.invoke("accounts:set-enabled", id, enabled),
    delete: (id: number) => ipcRenderer.invoke("accounts:delete", id),
    open: (id: number) => ipcRenderer.invoke("accounts:open", id),
    relogin: (id: number) => ipcRenderer.invoke("accounts:relogin", id),
    // 在系统默认浏览器打开登录页（绕开 Google 对嵌入浏览器的封堵），
    // 登录后把 Cookie 导回来写进该账号的隔离分区。
    openExternalLogin: (id: number) => ipcRenderer.invoke("accounts:open-external-login", id),
    importCookies: (id: number, raw: string) => ipcRenderer.invoke("accounts:import-cookies", id, raw),
    detectLogin: (id: number) => ipcRenderer.invoke("accounts:detect-login", id),
    detectAll: () => ipcRenderer.invoke("accounts:detect-all"),
    resetQuota: (id: number) => ipcRenderer.invoke("accounts:reset-quota", id),
    resetAllQuotas: () => ipcRenderer.invoke("accounts:reset-all-quotas")
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (input: AppSettingsUpdateInput) => ipcRenderer.invoke("settings:update", input)
  },
  apiServer: {
    status: () => ipcRenderer.invoke("api-server:status"),
    restart: () => ipcRenderer.invoke("api-server:restart")
  },
  apiRequests: {
    list: (limit?: number) => ipcRenderer.invoke("api-requests:list", limit),
    clear: () => ipcRenderer.invoke("api-requests:clear")
  },
  operationLogs: {
    list: (limit?: number) => ipcRenderer.invoke("operation-logs:list", limit),
    clear: () => ipcRenderer.invoke("operation-logs:clear")
  },
  events: {
    onDataChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("data:changed", listener);
      return () => ipcRenderer.removeListener("data:changed", listener);
    }
  }
};

contextBridge.exposeInMainWorld("doubaoManager", api);

export type DoubaoManagerApi = typeof api;
