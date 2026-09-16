// 站点（App）常量表：豆包（国内版 doubao.com）与 Dola（海外版 dola.com）。
//
// 两个站点共用同一套前端（tiptap 编辑器、/chat/ 会话、/thread/ 分享），差异
// 只在域名与入口地址，因此所有"按站点分支"的判断都从这里取值，不要在业务
// 代码里散落 if (host === 'doubao.com')。
//
// 注意：executor.ts 会把一部分判定函数用 toString() 注入到页面渲染进程执行，
// 注入后的上下文里没有任何模块级变量。本文件导出的东西只允许在 Node 侧使用，
// 绝不能被注入函数引用（需要站点信息时，把结果当参数/字面量传进脚本）。
import type { AccountAppType, AppSettings } from "./types.js";

export interface AppSiteConfig {
  appType: AccountAppType;
  /** 界面展示名。 */
  label: string;
  /** 该站点可能出现的域名（含 www 变体，均小写）。 */
  hostnames: readonly string[];
  /** 读取站点级登录 cookie 时使用的域名。 */
  authHost: string;
  /** 隔离分区前缀，分区格式 `persist:<前缀>_<三位序号>`。 */
  partitionPrefix: string;
  /** 该站点入口地址对应的 AppSettings 字段。 */
  settingsKey: keyof AppSettings;
  /** 入口地址默认值。 */
  defaultChatUrl: string;
}

export const DEFAULT_APP_TYPE: AccountAppType = "doubao";

export const APP_SITES: Record<AccountAppType, AppSiteConfig> = {
  doubao: {
    appType: "doubao",
    label: "豆包",
    hostnames: ["doubao.com", "www.doubao.com"],
    authHost: "https://www.doubao.com",
    partitionPrefix: "doubao_account",
    settingsKey: "doubaoChatUrl",
    defaultChatUrl: "https://www.doubao.com/chat"
  },
  dola: {
    appType: "dola",
    label: "Dola",
    hostnames: ["dola.com", "www.dola.com"],
    authHost: "https://www.dola.com",
    partitionPrefix: "dola_account",
    settingsKey: "dolaChatUrl",
    defaultChatUrl: "https://dola.com/chat"
  }
};

export const APP_TYPE_LIST = Object.keys(APP_SITES) as AccountAppType[];

const BARE_HOSTNAMES = APP_TYPE_LIST.map((appType) => APP_SITES[appType].hostnames[0]);
const ALL_HOSTNAMES = APP_TYPE_LIST.flatMap((appType) => APP_SITES[appType].hostnames);

export function normalizeAppType(value: unknown): AccountAppType {
  return value === "dola" ? "dola" : DEFAULT_APP_TYPE;
}

export function getAppSite(appType?: AccountAppType | null): AppSiteConfig {
  return APP_SITES[normalizeAppType(appType)];
}

export function appTypeLabel(appType?: AccountAppType | null): string {
  return getAppSite(appType).label;
}

/** 站点序号 → 隔离分区，如 `persist:dola_account_003`。 */
export function buildAccountPartition(appType: AccountAppType, serial: number): string {
  const site = getAppSite(appType);
  return `persist:${site.partitionPrefix}_${String(serial).padStart(3, "0")}`;
}

/** 从隔离分区反解站点；无法识别时回退到默认站点。 */
export function appTypeFromPartition(partition: string | null | undefined): AccountAppType {
  if (!partition) return DEFAULT_APP_TYPE;
  const matched = APP_TYPE_LIST.find((appType) =>
    partition.includes(`${APP_SITES[appType].partitionPrefix}_`)
  );
  return matched ?? DEFAULT_APP_TYPE;
}

/** 从任意 URL 判定站点；非已知站点返回 null。 */
export function appTypeFromUrl(url: string | null | undefined): AccountAppType | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return APP_TYPE_LIST.find((appType) => APP_SITES[appType].hostnames.includes(hostname))
      ?? null;
  } catch {
    return null;
  }
}

export function isAppSiteHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  return ALL_HOSTNAMES.includes(hostname.toLowerCase());
}

/**
 * 站点域名的正则片段（用于拼 URL 正则），如 `(?:www\.)?(?:doubao|dola)\.com`。
 * 返回的是 RegExp source 片段，可直接放进 new RegExp 的字符串里。
 */
export function appSiteHostRegExpSource(): string {
  const domains = BARE_HOSTNAMES.map((hostname) => hostname.replace(/\./g, "\\."));
  return `(?:www\\.)?(?:${domains.join("|")})`;
}

/** 登录后才会写入的会话 cookie；两个站点共用字节跳动的 passport 体系。 */
export const LOGIN_SESSION_COOKIE_RE = /^(sessionid|sessionid_ss|sid_tt|sid_guard|uid_tt|uid_tt_ss)$/i;

/** cookie 读取源地址（决定按哪个域名匹配 cookie）。 */
export function authUrlForAppType(appType?: AccountAppType | null): string {
  return getAppSite(appType).authHost;
}

/** 该账号站点当前配置的入口地址；未配置时回退到站点默认值。 */
export function chatUrlForAppType(settings: AppSettings | undefined, appType?: AccountAppType | null): string {
  const site = getAppSite(appType);
  const configured = settings?.[site.settingsKey];
  const trimmed = typeof configured === "string" ? configured.trim() : "";
  return trimmed || site.defaultChatUrl;
}
