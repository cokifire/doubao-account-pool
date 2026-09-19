import type {
  Account,
  AccountCreateInput,
  AccountUpdateInput,
  ApiRequest,
  ApiServerStatus,
  AppSettings,
  AppSettingsUpdateInput,
  CookieImportResult,
  OperationLog
} from "../electron/types";

declare global {
  interface Window {
    doubaoManager: {
      accounts: {
        list: () => Promise<Account[]>;
        create: (input?: AccountCreateInput) => Promise<Account>;
        update: (input: AccountUpdateInput) => Promise<Account>;
        setEnabled: (id: number, enabled: boolean) => Promise<Account>;
        delete: (id: number) => Promise<boolean>;
        open: (id: number) => Promise<void>;
        relogin: (id: number) => Promise<boolean>;
        openExternalLogin: (id: number) => Promise<string>;
        importCookies: (id: number, raw: string) => Promise<CookieImportResult>;
        detectLogin: (id: number) => Promise<Account>;
        detectAll: () => Promise<Account[]>;
        resetQuota: (id: number) => Promise<Account>;
        resetAllQuotas: () => Promise<Account[]>;
      };
      settings: {
        get: () => Promise<AppSettings>;
        update: (input: AppSettingsUpdateInput) => Promise<AppSettings>;
      };
      apiServer: {
        status: () => Promise<ApiServerStatus>;
        restart: () => Promise<ApiServerStatus>;
      };
      apiRequests: {
        list: (limit?: number) => Promise<ApiRequest[]>;
        clear: () => Promise<boolean>;
      };
      operationLogs: {
        list: (limit?: number) => Promise<OperationLog[]>;
        clear: () => Promise<boolean>;
      };
      events: {
        onDataChanged: (callback: () => void) => () => void;
      };
    };
  }
}

export {};
