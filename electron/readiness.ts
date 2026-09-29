/**
 * 页面控件就绪门禁：有界等待 + 连续稳定采样。
 *
 * 纯逻辑模块，时间源与等待都可注入，便于单测。
 *
 * 豆包是 SPA，控件在页面打开或模式切换后往往晚于脚本才挂载。单次 DOM 查询会把
 * 「还没渲染出来」误判成「页面没有这个控件」，固定 sleep 则在慢机器上不够、在快
 * 机器上白白浪费。这里统一走有界轮询，并要求连续 N 次采样都成立才算就绪，
 * 避免抓到动画/重排过程中的瞬时状态。
 */

export interface ReadinessOptions {
  /** 阶段名，同时用于错误码（`<stage>_not_ready`）。 */
  stage: string;
  /** 就绪探针：返回 true 表示本次采样通过。 */
  probe: () => boolean | Promise<boolean>;
  /** 有界等待上限，默认 15s。 */
  timeoutMs?: number;
  /** 需要的连续稳定采样次数，默认 3。 */
  stableSamples?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export interface ReadinessDiagnostics {
  ready: boolean;
  stage: string;
  attempts: number;
  elapsedMs: number;
  stableSamples: number;
}

export class ReadinessError extends Error {
  readonly code: string;
  readonly diagnostic: ReadinessDiagnostics;

  constructor(stage: string, diagnostic: ReadinessDiagnostics) {
    super(`${stage}_not_ready: ${stage} 未在有界等待内就绪（${diagnostic.elapsedMs}ms/${diagnostic.attempts} 次）`);
    this.name = "ReadinessError";
    this.code = `${stage}_not_ready`;
    this.diagnostic = diagnostic;
  }
}

export async function waitForReadiness(options: ReadinessOptions): Promise<ReadinessDiagnostics> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const requiredStableSamples = Math.max(1, options.stableSamples ?? 3);
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let attempts = 0;
  let stable = 0;

  for (;;) {
    attempts += 1;
    const sampled = Boolean(await options.probe());
    stable = sampled ? stable + 1 : 0;

    if (stable >= requiredStableSamples) {
      return {
        ready: true,
        stage: options.stage,
        attempts,
        elapsedMs: Math.max(0, now() - startedAt),
        stableSamples: stable
      };
    }

    const remaining = timeoutMs - Math.max(0, now() - startedAt);
    if (remaining <= 0) break;
    // 有界指数退避，最多 2s 一次。
    await wait(Math.min(2_000, 250 * 2 ** Math.min(attempts - 1, 3), remaining));
  }

  const diagnostic: ReadinessDiagnostics = {
    ready: false,
    stage: options.stage,
    attempts,
    elapsedMs: Math.max(0, now() - startedAt),
    stableSamples: stable
  };
  throw new ReadinessError(options.stage, diagnostic);
}
