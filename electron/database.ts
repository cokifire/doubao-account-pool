import path from "node:path";
import Database from "better-sqlite3";
import { app } from "electron";
import type {
  Account,
  AccountCreateInput,
  AccountRuntimeStatus,
  AccountUpdateInput,
  ApiRequest,
  ApiRequestCreateInput,
  ApiRequestStatus,
  ApiRequestUpdateInput,
  AppSettings,
  AppSettingsUpdateInput,
  DoubaoModel,
  OperationLog,
  OperationLogCreateInput
} from "./types.js";
import { generateFingerprint } from "./fingerprint.js";

const now = () => new Date().toISOString();

/** 本地日期 YYYY-MM-DD（按运行时时区，而非 UTC）。 */
function todayLocalDate(): string {
  return toLocalDateStr(new Date());
}

/** 将 Date 转为本地日期 YYYY-MM-DD。 */
function toLocalDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 解析 dailyResetTime（如 "00:00"、"08:30"）为小时数，非法值回退到 0。 */
function parseResetHour(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.split(":");
  const hour = Number(parts[0]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return 0;
  return Math.floor(hour);
}
const OPERATION_LOG_RETENTION_DAYS = 3;

const DEFAULT_SETTINGS: AppSettings = {
  apiServiceEnabled: true,
  apiPort: 17888,
  apiKey: "local-doubao-key",
  executorEnabled: true,
  showExecutorWindow: false,
  autoCloseExecutorWindow: true,
  doubaoChatUrl: "https://www.doubao.com/chat",
  defaultModel: "seedance_2_0_mini",
  dailyQuotaLimit: 10,
  miniCost: 2,
  fastCost: 3,
  dailyResetTime: "00:00",
  generationTimeoutSeconds: 900,
  maxConcurrentAccounts: 4,
  retryCount: 1,
  autoRemoveWatermark: true,
  watermarkApiUrl: "https://nologo.code24.top/api/water-mask/parse",
  watermarkApiToken: "",
  outputDir: ""
};

export class AppDatabase {
  private readonly db: Database.Database;

  constructor() {
    const dbPath = path.join(app.getPath("userData"), "doubao-manager.sqlite3");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        partition TEXT NOT NULL UNIQUE,
        remark TEXT NOT NULL DEFAULT '',
        login_status TEXT NOT NULL DEFAULT 'unknown',
        current_status TEXT NOT NULL DEFAULT 'idle',
        daily_quota_limit INTEGER NOT NULL DEFAULT 10,
        quota_remaining INTEGER NOT NULL DEFAULT 10,
        quota_used_today INTEGER NOT NULL DEFAULT 0,
        last_quota_reset_date TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL DEFAULT 'local',
        model TEXT NOT NULL,
        account_id INTEGER,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        reference_image_path TEXT,
        reference_image_paths TEXT,
        remove_watermark INTEGER NOT NULL DEFAULT 1,
        callback_url TEXT,
        doubao_thread_url TEXT,
        raw_video_url TEXT,
        clean_video_url TEXT,
        output_video_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        account_id INTEGER,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL DEFAULT '',
        target_url TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_operation_logs_request_id ON operation_logs(request_id);
    `);

    this.ensureAccountColumns();
    this.ensureApiRequestColumns();
    this.pruneOperationLogs();
    this.cleanInvalidSuccessfulResults();
    this.ensureDefaultSettings();
    this.migrateExecutorConcurrency();
  }

  listAccounts(): Account[] {
    return this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        last_quota_reset_date AS lastQuotaResetDate,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        updated_at AS updatedAt,
        user_agent AS userAgent,
        hardware_concurrency AS hardwareConcurrency,
        device_memory AS deviceMemory,
        platform AS platform
      FROM accounts
      ORDER BY id ASC
    `).all() as Account[];
  }

  getAccount(id: number): Account | undefined {
    const account = this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        last_quota_reset_date AS lastQuotaResetDate,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        updated_at AS updatedAt,
        user_agent AS userAgent,
        hardware_concurrency AS hardwareConcurrency,
        device_memory AS deviceMemory,
        platform AS platform
      FROM accounts
      WHERE id = ?
    `).get(id) as Account | undefined;
    if (!account) return undefined;
    // 设备指纹在 migrate() 的 backfillFingerprints() 中已无条件补齐，
    // 这里仅做兜底，避免极旧数据触发 NOT NULL 约束。
    const needsFp = !account.userAgent || account.userAgent === "" || !account.platform || account.platform === "";
    if (needsFp) {
      const fp = generateFingerprint(account.id);
      this.db.prepare(`
        UPDATE accounts
        SET user_agent = ?, hardware_concurrency = ?, device_memory = ?, platform = ?
        WHERE id = ? AND (user_agent = '' OR user_agent IS NULL OR platform = '' OR platform IS NULL)
      `).run(
        fp.userAgent || "",
        fp.hardwareConcurrency ?? 8,
        fp.deviceMemory ?? 8,
        fp.platform || "Win32",
        account.id
      );
      return { ...account, ...fp };
    }
    return account;
  }

  createAccount(input: AccountCreateInput = {}): Account {
    const timestamp = now();
    const settings = this.getSettings();
    const nextNumber = this.nextAccountNumber();
    const name = `账号 ${String(nextNumber).padStart(3, "0")}`;
    const partition = `persist:doubao_account_${String(nextNumber).padStart(3, "0")}`;

    const result = this.db.prepare(`
      INSERT INTO accounts (
        name,
        partition,
        remark,
        login_status,
        current_status,
        daily_quota_limit,
        quota_remaining,
        quota_used_today,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, 'unknown', 'login_required', ?, ?, 0, ?, ?)
    `).run(
      name,
      partition,
      input.remark?.trim() || "",
      settings.dailyQuotaLimit,
      settings.dailyQuotaLimit,
      timestamp,
      timestamp
    );

    const id = Number(result.lastInsertRowid);
    // 为每个账号生成固定设备指纹（长期不变，更像同一台固定设备）。
    const fp = generateFingerprint(id);
    this.db.prepare(`
      UPDATE accounts
      SET user_agent = ?, hardware_concurrency = ?, device_memory = ?, platform = ?
      WHERE id = ?
    `).run(fp.userAgent, fp.hardwareConcurrency, fp.deviceMemory, fp.platform, id);

    return this.getAccount(id)!;
  }

  updateAccount(input: AccountUpdateInput): Account {
    const existing = this.getAccount(input.id);
    if (!existing) throw new Error("Account not found");

    const updated = {
      remark: input.remark ?? existing.remark,
      loginStatus: input.loginStatus ?? existing.loginStatus,
      currentStatus: input.currentStatus ?? existing.currentStatus,
      dailyQuotaLimit: input.dailyQuotaLimit ?? existing.dailyQuotaLimit,
      quotaRemaining: input.quotaRemaining ?? existing.quotaRemaining,
      quotaUsedToday: input.quotaUsedToday ?? existing.quotaUsedToday,
      updatedAt: now()
    };

    this.db.prepare(`
      UPDATE accounts
      SET
        remark = ?,
        login_status = ?,
        current_status = ?,
        daily_quota_limit = ?,
        quota_remaining = ?,
        quota_used_today = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      updated.remark.trim(),
      updated.loginStatus,
      updated.currentStatus,
      clampInt(updated.dailyQuotaLimit),
      clampInt(updated.quotaRemaining),
      clampInt(updated.quotaUsedToday),
      updated.updatedAt,
      input.id
    );

    return this.getAccount(input.id)!;
  }

  deleteAccount(id: number) {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }

  resetAccountQuota(id: number): Account {
    const today = todayLocalDate();
    this.db.prepare(`
      UPDATE accounts
      SET
        mini_remaining = mini_daily_limit,
        mini_used_today = 0,
        fast_remaining = fast_daily_limit,
        fast_used_today = 0,
        quota_remaining = daily_quota_limit,
        quota_used_today = 0,
        last_quota_reset_date = ?,
        updated_at = ?
      WHERE id = ?
    `).run(today, now(), id);
    return this.getAccount(id)!;
  }

  resetAllQuotas(): Account[] {
    const today = todayLocalDate();
    this.db.prepare(`
      UPDATE accounts
      SET
        mini_remaining = mini_daily_limit,
        mini_used_today = 0,
        fast_remaining = fast_daily_limit,
        fast_used_today = 0,
        quota_remaining = daily_quota_limit,
        quota_used_today = 0,
        last_quota_reset_date = ?,
        updated_at = ?
    `).run(today, now());
    return this.listAccounts();
  }

  /**
   * 自动重置跨过每日重置时间点、但当天额度尚未刷新的账号。
   * 判定规则：以 dailyResetTime 为界，若当前时间尚未到达今日重置时刻，
   * 则视为仍处于"昨日"的重置周期内（用昨天的日期作比较基准）。
   * 返回被重置的账号数量。
   */
  resetExpiredQuotas(settings: AppSettings): number {
    const now = new Date();
    const resetHour = parseResetHour(settings.dailyResetTime);
    const resetDay = new Date(now);
    if (now.getHours() < resetHour) {
      resetDay.setDate(resetDay.getDate() - 1);
    }
    const resetDayStr = toLocalDateStr(resetDay);
    const result = this.db
      .prepare(
        `UPDATE accounts
         SET
           mini_remaining = mini_daily_limit,
           mini_used_today = 0,
           fast_remaining = fast_daily_limit,
           fast_used_today = 0,
           quota_remaining = daily_quota_limit,
           quota_used_today = 0,
           last_quota_reset_date = ?,
           updated_at = ?
         WHERE last_quota_reset_date IS NULL
            OR last_quota_reset_date < ?`
      )
      .run(resetDayStr, now.toISOString(), resetDayStr);
    return result.changes;
  }

  findAvailableAccount(model: DoubaoModel): Account | undefined {
    const settings = this.getSettings();
    const requiredQuota = model === "seedance_2_0_mini" ? settings.miniCost : settings.fastCost;
    return this.db.prepare(`
      SELECT
        id,
        name,
        partition,
        remark,
        login_status AS loginStatus,
        current_status AS currentStatus,
        daily_quota_limit AS dailyQuotaLimit,
        quota_remaining AS quotaRemaining,
        quota_used_today AS quotaUsedToday,
        last_quota_reset_date AS lastQuotaResetDate,
        last_used_at AS lastUsedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM accounts
      WHERE login_status = 'logged_in'
        AND current_status IN ('idle', 'error')
        AND quota_remaining >= ?
      ORDER BY
        CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END ASC,
        last_used_at ASC,
        id ASC
      LIMIT 1
    `).get(requiredQuota) as Account | undefined;
  }

  reserveAvailableAccount(model: DoubaoModel): Account | undefined {
    return this.db.transaction(() => {
      const account = this.findAvailableAccount(model);
      if (!account) return undefined;
      this.markAccountAllocated(account.id, "busy");
      return this.getAccount(account.id);
    })();
  }

  deductQuota(accountId: number, model: DoubaoModel): Account {
    const settings = this.getSettings();
    const cost = model === "seedance_2_0_mini" ? settings.miniCost : settings.fastCost;
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET quota_remaining = MAX(0, quota_remaining - ?),
          quota_used_today = quota_used_today + ?,
          last_used_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(cost, cost, timestamp, timestamp, accountId);
    return this.getAccount(accountId)!;
  }

  refundQuota(accountId: number, model: DoubaoModel): Account {
    const settings = this.getSettings();
    const cost = model === "seedance_2_0_mini" ? settings.miniCost : settings.fastCost;
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET quota_remaining = MIN(daily_quota_limit, quota_remaining + ?),
          quota_used_today = MAX(0, quota_used_today - ?),
          updated_at = ?
      WHERE id = ?
    `).run(cost, cost, timestamp, accountId);
    return this.getAccount(accountId)!;
  }

  markAccountAllocated(id: number, status: AccountRuntimeStatus = "idle") {
    const timestamp = now();
    this.db.prepare(`
      UPDATE accounts
      SET current_status = ?,
          last_used_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(status, timestamp, timestamp, id);
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const data = { ...DEFAULT_SETTINGS } as Record<keyof AppSettings, unknown>;
    for (const row of rows) {
      if (isSettingsKey(row.key)) {
        data[row.key] = parseSettingValue(row.key, row.value);
      }
    }
    return data as AppSettings;
  }

  updateSettings(input: AppSettingsUpdateInput): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = {
      ...current,
      ...input,
      apiPort: clampPort(input.apiPort ?? current.apiPort),
      executorEnabled: Boolean(input.executorEnabled ?? current.executorEnabled),
      showExecutorWindow: Boolean(input.showExecutorWindow ?? current.showExecutorWindow),
      autoCloseExecutorWindow: Boolean(input.autoCloseExecutorWindow ?? current.autoCloseExecutorWindow),
      doubaoChatUrl: String(input.doubaoChatUrl || current.doubaoChatUrl || DEFAULT_SETTINGS.doubaoChatUrl),
      dailyQuotaLimit: clampInt(input.dailyQuotaLimit ?? current.dailyQuotaLimit),
      miniCost: Math.max(1, clampInt(input.miniCost ?? current.miniCost)),
      fastCost: Math.max(1, clampInt(input.fastCost ?? current.fastCost)),
      generationTimeoutSeconds: clampInt(input.generationTimeoutSeconds ?? current.generationTimeoutSeconds),
      maxConcurrentAccounts: Math.max(1, clampInt(input.maxConcurrentAccounts ?? current.maxConcurrentAccounts)),
      retryCount: clampInt(input.retryCount ?? current.retryCount)
    };

    const timestamp = now();
    const statement = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
      const value = next[key];
      statement.run(key, stringifySettingValue(value), timestamp);
    }

    return this.getSettings();
  }

  listApiRequests(limit = 100): ApiRequest[] {
    return this.db.prepare(`
      SELECT
        api_requests.id,
        api_requests.request_id AS requestId,
        api_requests.source,
        api_requests.model,
        api_requests.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        api_requests.status,
        api_requests.message,
        api_requests.prompt,
        api_requests.reference_image_path AS referenceImagePath,
        api_requests.reference_image_paths AS referenceImagePaths,
        api_requests.remove_watermark AS removeWatermark,
        api_requests.callback_url AS callbackUrl,
        api_requests.doubao_thread_url AS doubaoThreadUrl,
        api_requests.raw_video_url AS rawVideoUrl,
        api_requests.clean_video_url AS cleanVideoUrl,
        api_requests.output_video_path AS outputVideoPath,
        api_requests.created_at AS createdAt,
        api_requests.updated_at AS updatedAt,
        api_requests.finished_at AS finishedAt
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      ORDER BY api_requests.id DESC
      LIMIT ?
    `).all(limit).map(normalizeApiRequest);
  }

  getApiRequest(requestId: string): ApiRequest | undefined {
    const row = this.db.prepare(`
      SELECT
        api_requests.id,
        api_requests.request_id AS requestId,
        api_requests.source,
        api_requests.model,
        api_requests.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        api_requests.status,
        api_requests.message,
        api_requests.prompt,
        api_requests.reference_image_path AS referenceImagePath,
        api_requests.reference_image_paths AS referenceImagePaths,
        api_requests.remove_watermark AS removeWatermark,
        api_requests.callback_url AS callbackUrl,
        api_requests.doubao_thread_url AS doubaoThreadUrl,
        api_requests.raw_video_url AS rawVideoUrl,
        api_requests.clean_video_url AS cleanVideoUrl,
        api_requests.output_video_path AS outputVideoPath,
        api_requests.created_at AS createdAt,
        api_requests.updated_at AS updatedAt,
        api_requests.finished_at AS finishedAt
      FROM api_requests
      LEFT JOIN accounts ON accounts.id = api_requests.account_id
      WHERE api_requests.request_id = ?
    `).get(requestId);
    return row ? normalizeApiRequest(row) : undefined;
  }

  createApiRequest(input: ApiRequestCreateInput): ApiRequest {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO api_requests (
        request_id,
        source,
        model,
        account_id,
        status,
        message,
        prompt,
        reference_image_path,
        reference_image_paths,
        remove_watermark,
        callback_url,
        created_at,
        updated_at,
        finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId,
      input.source || "local-api",
      input.model,
      input.accountId ?? null,
      input.status,
      input.message || "",
      input.prompt,
      input.referenceImagePath || null,
      input.referenceImagePaths && input.referenceImagePaths.length ? JSON.stringify(input.referenceImagePaths) : null,
      input.removeWatermark === false ? 0 : 1,
      input.callbackUrl || null,
      timestamp,
      timestamp,
      input.status === "failed" || input.status === "success" || input.status === "stopped" ? timestamp : null
    );
    return this.getApiRequest(input.requestId)!;
  }

  updateApiRequestStatus(requestId: string, status: ApiRequestStatus, message: string) {
    const finishedAt = status === "success" || status === "failed" || status === "stopped" ? now() : null;
    this.db.prepare(`
      UPDATE api_requests
      SET status = ?, message = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
      WHERE request_id = ?
    `).run(status, message, now(), finishedAt, requestId);
    return this.getApiRequest(requestId)!;
  }

  updateApiRequest(input: ApiRequestUpdateInput) {
    const existing = this.getApiRequest(input.requestId);
    if (!existing) throw new Error("Request not found");

    const status = input.status ?? existing.status;
    const finishedAt = status === "success" || status === "failed" || status === "stopped" ? now() : null;
    this.db.prepare(`
      UPDATE api_requests
      SET
        status = ?,
        message = ?,
        doubao_thread_url = ?,
        raw_video_url = ?,
        clean_video_url = ?,
        output_video_path = ?,
        updated_at = ?,
        finished_at = COALESCE(?, finished_at)
      WHERE request_id = ?
    `).run(
      status,
      input.message ?? existing.message,
      input.doubaoThreadUrl ?? existing.doubaoThreadUrl,
      input.rawVideoUrl ?? existing.rawVideoUrl,
      input.cleanVideoUrl ?? existing.cleanVideoUrl,
      input.outputVideoPath ?? existing.outputVideoPath,
      now(),
      finishedAt,
      input.requestId
    );
    return this.getApiRequest(input.requestId)!;
  }

  clearApiRequests() {
    this.db.prepare("DELETE FROM api_requests").run();
  }

  appendOperationLog(input: OperationLogCreateInput): OperationLog {
    this.pruneOperationLogs();
    const timestamp = now();
    const result = this.db.prepare(`
      INSERT INTO operation_logs (
        request_id,
        account_id,
        action,
        status,
        message,
        target_url,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId || null,
      input.accountId ?? null,
      input.action,
      input.status || "info",
      input.message,
      input.targetUrl || null,
      timestamp
    );
    return this.getOperationLog(Number(result.lastInsertRowid))!;
  }

  listOperationLogs(limit = 500): OperationLog[] {
    this.pruneOperationLogs();
    return this.db.prepare(`
      SELECT
        operation_logs.id,
        operation_logs.request_id AS requestId,
        operation_logs.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        operation_logs.action,
        operation_logs.status,
        operation_logs.message,
        operation_logs.target_url AS targetUrl,
        operation_logs.created_at AS createdAt
      FROM operation_logs
      LEFT JOIN accounts ON accounts.id = operation_logs.account_id
      ORDER BY operation_logs.id DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(2000, limit))).map(normalizeOperationLog);
  }

  getOperationLog(id: number): OperationLog | undefined {
    const row = this.db.prepare(`
      SELECT
        operation_logs.id,
        operation_logs.request_id AS requestId,
        operation_logs.account_id AS accountId,
        accounts.name AS accountName,
        accounts.partition AS accountPartition,
        operation_logs.action,
        operation_logs.status,
        operation_logs.message,
        operation_logs.target_url AS targetUrl,
        operation_logs.created_at AS createdAt
      FROM operation_logs
      LEFT JOIN accounts ON accounts.id = operation_logs.account_id
      WHERE operation_logs.id = ?
    `).get(id);
    return row ? normalizeOperationLog(row) : undefined;
  }

  clearOperationLogs() {
    this.db.prepare("DELETE FROM operation_logs").run();
  }

  private pruneOperationLogs() {
    const cutoff = new Date(Date.now() - OPERATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM operation_logs WHERE created_at < ?").run(cutoff);
  }

  private ensureDefaultSettings() {
    const existingCount = this.db.prepare("SELECT COUNT(*) AS count FROM settings").get() as { count: number };
    if (existingCount.count === 0) {
      this.updateSettings(DEFAULT_SETTINGS);
    }
  }

  private migrateExecutorConcurrency() {
    const migrationKey = "executorConcurrencyV1";
    const migrated = this.db.prepare("SELECT 1 FROM settings WHERE key = ?").get(migrationKey);
    if (migrated) return;

    const timestamp = now();
    this.db.prepare(`
      UPDATE settings
      SET value = '4', updated_at = ?
      WHERE key = 'maxConcurrentAccounts' AND CAST(value AS INTEGER) = 1
    `).run(timestamp);
    this.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, 'true', ?)")
      .run(migrationKey, timestamp);
  }

  private ensureAccountColumns() {
    this.addColumnIfMissing("accounts", "name", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "remark", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "current_status", "TEXT NOT NULL DEFAULT 'idle'");
    this.addColumnIfMissing("accounts", "daily_quota_limit", "INTEGER NOT NULL DEFAULT 10");
    this.addColumnIfMissing("accounts", "quota_remaining", "INTEGER NOT NULL DEFAULT 10");
    this.addColumnIfMissing("accounts", "quota_used_today", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "mini_daily_limit", "INTEGER NOT NULL DEFAULT 5");
    this.addColumnIfMissing("accounts", "mini_remaining", "INTEGER NOT NULL DEFAULT 5");
    this.addColumnIfMissing("accounts", "mini_used_today", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "fast_daily_limit", "INTEGER NOT NULL DEFAULT 3");
    this.addColumnIfMissing("accounts", "fast_remaining", "INTEGER NOT NULL DEFAULT 3");
    this.addColumnIfMissing("accounts", "fast_used_today", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("accounts", "user_agent", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("accounts", "hardware_concurrency", "INTEGER NOT NULL DEFAULT 8");
    this.addColumnIfMissing("accounts", "device_memory", "INTEGER NOT NULL DEFAULT 8");
    this.addColumnIfMissing("accounts", "platform", "TEXT NOT NULL DEFAULT 'Win32'");
    this.addColumnIfMissing("accounts", "last_quota_reset_date", "TEXT");

    this.db.prepare(`
      UPDATE accounts
      SET
        name = CASE WHEN name = '' THEN '账号 ' || printf('%03d', id) ELSE name END,
        remark = CASE WHEN remark = '' AND name NOT LIKE '账号 %' THEN name ELSE remark END,
        daily_quota_limit = CASE WHEN daily_quota_limit = 10 AND (mini_daily_limit + fast_daily_limit) != 8 THEN mini_daily_limit + fast_daily_limit ELSE daily_quota_limit END,
        quota_remaining = CASE WHEN quota_remaining = 10 AND (mini_remaining + fast_remaining) != 8 THEN mini_remaining + fast_remaining ELSE quota_remaining END,
        quota_used_today = CASE WHEN quota_used_today = 0 AND (mini_used_today + fast_used_today) > 0 THEN mini_used_today + fast_used_today ELSE quota_used_today END
    `).run();

    // 回填空设备指纹列（旧库中可能存在 NULL 或空值，触发 NOT NULL 约束）。
    this.backfillFingerprints();
  }

  // 为每个账号补齐固定的设备指纹，保证 user_agent / platform 非空且
  // hardware_concurrency / device_memory 不为 NULL（避免 NOT NULL 约束失败）。
  private backfillFingerprints() {
    const rows = this.db.prepare(
      "SELECT id, user_agent, hardware_concurrency, device_memory, platform FROM accounts"
    ).all() as Array<{
      id: number;
      user_agent: string | null;
      hardware_concurrency: number | null;
      device_memory: number | null;
      platform: string | null;
    }>;
    const update = this.db.prepare(`
      UPDATE accounts
      SET user_agent = ?, hardware_concurrency = ?, device_memory = ?, platform = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      const missingText =
        !row.user_agent || row.user_agent === "" || !row.platform || row.platform === "";
      const missingNumber =
        row.hardware_concurrency === null || row.hardware_concurrency === undefined ||
        row.device_memory === null || row.device_memory === undefined;
      if (!missingText && !missingNumber) continue;
      const fp = generateFingerprint(row.id);
      // 兜底：即便指纹生成异常，也绝不允许写入 NULL（否则会触发 NOT NULL 约束）。
      update.run(
        fp.userAgent || "",
        row.hardware_concurrency ?? fp.hardwareConcurrency ?? 8,
        row.device_memory ?? fp.deviceMemory ?? 8,
        fp.platform || "Win32",
        row.id
      );
    }
  }

  private ensureApiRequestColumns() {
    this.addColumnIfMissing("api_requests", "source", "TEXT NOT NULL DEFAULT 'local'");
    this.addColumnIfMissing("api_requests", "reference_image_path", "TEXT");
    this.addColumnIfMissing("api_requests", "reference_image_paths", "TEXT");
    this.addColumnIfMissing("api_requests", "remove_watermark", "INTEGER NOT NULL DEFAULT 1");
    this.addColumnIfMissing("api_requests", "callback_url", "TEXT");
    this.addColumnIfMissing("api_requests", "doubao_thread_url", "TEXT");
    this.addColumnIfMissing("api_requests", "raw_video_url", "TEXT");
    this.addColumnIfMissing("api_requests", "clean_video_url", "TEXT");
    this.addColumnIfMissing("api_requests", "output_video_path", "TEXT");
    this.addColumnIfMissing("api_requests", "finished_at", "TEXT");
  }

  private cleanInvalidSuccessfulResults() {
    this.db.prepare(`
      UPDATE api_requests
      SET
        status = 'failed',
        message = '历史结果不包含有效的去水印 MP4',
        raw_video_url = NULL,
        clean_video_url = NULL,
        output_video_path = NULL,
        updated_at = ?,
        finished_at = COALESCE(finished_at, ?)
      WHERE status = 'success'
        AND NOT (
          LOWER(COALESCE(clean_video_url, '')) LIKE '%.mp4%'
          OR LOWER(COALESCE(clean_video_url, '')) LIKE '%video_mp4%'
          OR LOWER(COALESCE(output_video_path, '')) LIKE '%.mp4'
        )
    `).run(now(), now());
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
  }

  private nextAccountNumber(): number {
    const rows = this.db.prepare("SELECT partition FROM accounts").all() as Array<{ partition: string }>;
    const used = rows
      .map((row) => row.partition.match(/^persist:doubao_account_(\d+)$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number(value));

    let current = 1;
    while (used.includes(current)) current += 1;
    return current;
  }
}

function clampInt(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clampPort(value: number) {
  const port = clampInt(value);
  if (port < 1 || port > 65535) return DEFAULT_SETTINGS.apiPort;
  return port;
}

function stringifySettingValue(value: unknown) {
  return JSON.stringify(value);
}

function parseSettingValue(key: keyof AppSettings, value: string) {
  try {
    return JSON.parse(value) as AppSettings[typeof key];
  } catch {
    return value;
  }
}

function isSettingsKey(key: string): key is keyof AppSettings {
  return key in DEFAULT_SETTINGS;
}

function normalizeApiRequest(row: unknown): ApiRequest {
  const request = row as ApiRequest & { removeWatermark: number | boolean };
  const rawPaths = (row as Record<string, unknown>).referenceImagePaths;
  let referenceImagePaths: string[] = [];
  if (typeof rawPaths === "string" && rawPaths.trim()) {
    try {
      const parsed = JSON.parse(rawPaths);
      if (Array.isArray(parsed)) referenceImagePaths = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      referenceImagePaths = [];
    }
  } else if (Array.isArray(rawPaths)) {
    referenceImagePaths = rawPaths.filter((p): p is string => typeof p === "string");
  }
  return {
    ...request,
    referenceImagePaths,
    removeWatermark: Boolean(request.removeWatermark)
  };
}

function normalizeOperationLog(row: unknown): OperationLog {
  const log = row as OperationLog & { accountId: number | null };
  return {
    ...log,
    requestId: log.requestId || null,
    accountId: log.accountId === null || log.accountId === undefined ? null : Number(log.accountId),
    accountName: log.accountName || null,
    accountPartition: log.accountPartition || null,
    status: log.status === "success" || log.status === "failed" ? log.status : "info",
    targetUrl: log.targetUrl || null
  };
}
