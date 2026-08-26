export type LoginStatus = "unknown" | "logged_in" | "logged_out";
export type AccountRuntimeStatus = "idle" | "busy" | "error" | "login_required";
export type DoubaoModel = "seedance_2_0_mini" | "seedance_2_0_fast";
export type ApiRequestStatus = "accepted" | "running" | "success" | "failed" | "stopped";
export type OperationLogStatus = "info" | "success" | "failed";

export interface Account {
  id: number;
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
