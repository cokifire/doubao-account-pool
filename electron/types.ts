export type LoginStatus = "unknown" | "logged_in" | "logged_out";
export type AccountRuntimeStatus = "idle" | "busy" | "error" | "login_required";
/** 账号所属站点：豆包（国内版）或 Dola（海外版）。 */
export type AccountAppType = "doubao" | "dola";
export type DoubaoModel = "seedance_2_0_mini" | "seedance_2_0_fast";
export type ApiRequestStatus = "accepted" | "running" | "success" | "failed" | "stopped";
export type OperationLogStatus = "info" | "success" | "failed";

export interface Account {
  id: number;
  appType: AccountAppType;
  name: string;
  partition: string;
  remark: string;
  enabled: boolean;
  loginStatus: LoginStatus;
  currentStatus: AccountRuntimeStatus;
  dailyQuotaLimit: number;
  quotaRemaining: number;
  quotaUsedToday: number;
  lastQuotaResetDate: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  userAgent: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  platform: string;
}

export interface AccountCreateInput {
  remark?: string;
  appType?: AccountAppType;
}

/** 从系统浏览器导入 Cookie 的结果（用于「系统浏览器登录 + Cookie 回灌」）。 */
export interface CookieImportResult {
  /** 成功写入隔离分区的条数。 */
  imported: number;
  /** 解析或写入失败的条数。 */
  failed: number;
  /** 写入的 cookie 涉及的域名（去重）。 */
  domains: string[];
  /** 回灌后重新检测出的登录状态。 */
  loginStatus: LoginStatus;
}

export interface AccountUpdateInput {
  id: number;
  enabled?: boolean;
  remark?: string;
  loginStatus?: LoginStatus;
  currentStatus?: AccountRuntimeStatus;
  dailyQuotaLimit?: number;
  quotaRemaining?: number;
  quotaUsedToday?: number;
}

export interface AppSettings {
  apiServiceEnabled: boolean;
  apiPort: number;
  apiKey: string;
  executorEnabled: boolean;
  showExecutorWindow: boolean;
  autoCloseExecutorWindow: boolean;
  doubaoChatUrl: string;
  dolaChatUrl: string;
  defaultModel: DoubaoModel;
  dailyQuotaLimit: number;
  miniCost: number;
  fastCost: number;
  dailyResetTime: string;
  generationTimeoutSeconds: number;
  maxConcurrentAccounts: number;
  retryCount: number;
  autoRemoveWatermark: boolean;
  watermarkApiUrl: string;
  watermarkApiToken: string;
  outputDir: string;
}

export type AppSettingsUpdateInput = Partial<AppSettings>;

export interface ApiRequest {
  id: number;
  requestId: string;
  source: string;
  model: DoubaoModel;
  accountId: number | null;
  accountName: string | null;
  accountPartition: string | null;
  status: ApiRequestStatus;
  message: string;
  prompt: string;
  referenceImagePath: string | null;
  referenceImagePaths: string[];
  removeWatermark: boolean;
  callbackUrl: string | null;
  doubaoThreadUrl: string | null;
  rawVideoUrl: string | null;
  cleanVideoUrl: string | null;
  outputVideoPath: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface ApiRequestCreateInput {
  requestId: string;
  source?: string;
  model: DoubaoModel;
  accountId?: number | null;
  status: ApiRequestStatus;
  message?: string;
  prompt: string;
  referenceImagePath?: string | null;
  referenceImagePaths?: string[];
  removeWatermark?: boolean;
  callbackUrl?: string | null;
}

export interface ApiRequestUpdateInput {
  requestId: string;
  status?: ApiRequestStatus;
  message?: string;
  doubaoThreadUrl?: string | null;
  rawVideoUrl?: string | null;
  cleanVideoUrl?: string | null;
  outputVideoPath?: string | null;
}

export interface OperationLog {
  id: number;
  requestId: string | null;
  accountId: number | null;
  accountName: string | null;
  accountPartition: string | null;
  action: string;
  status: OperationLogStatus;
  message: string;
  targetUrl: string | null;
  createdAt: string;
}

export interface OperationLogCreateInput {
  requestId?: string | null;
  accountId?: number | null;
  action: string;
  status?: OperationLogStatus;
  message: string;
  targetUrl?: string | null;
}

export interface ApiServerStatus {
  version: string;
  enabled: boolean;
  running: boolean;
  port: number;
  url: string | null;
  message: string;
}

export interface GenerateRequestBody {
  model?: DoubaoModel;
  prompt: string;
  referenceImagePath?: string | null;
  referenceImagePaths?: string[];
  referenceImageUrl?: string | null;
  removeWatermark?: boolean;
  callbackUrl?: string | null;
  source?: string;
}
