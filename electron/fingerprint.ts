// 每个账号固定设备指纹生成与应用。
// 设计目标：在不触碰 timezone / locale / language 的前提下，给每个账号一个
// 长期固定、互不相同的 UA 与基础硬件参数（hardwareConcurrency / deviceMemory / platform），
// 让同一 Chromium 实例下的多个账号在外层风控看来像不同的固定设备。

// 关键约束：指纹里的 Chrome 版本号必须与打包的 Chromium 核心严格一致。
// 因此这里不硬编码，而是运行时从 process.versions.chrome 读取（Electron 主进程
// 里该字段即实际打包的 Chromium 版本），Electron/Chromium 升级后自动跟随，不会冲突。
function getChromiumMajorVersion(): string {
  const chrome = (process.versions as Record<string, string | undefined>).chrome;
  if (chrome) {
    const major = chrome.split(".")[0];
    if (/^\d+$/.test(major)) return major;
  }
  // 非 Electron 环境（如单元测试）时的兜底默认值。
  return "136";
}

const WINDOWS_PLATFORMS = ["Win32", "Win32", "Win32", "Linux x86_64", "MacIntel"] as const;
const HARDWARE_CONCURRENCY_POOL = [4, 8, 8, 12, 16, 6, 10] as const;
const DEVICE_MEMORY_POOL = [4, 8, 8, 16] as const;

// UA 模板使用 {chromeVersion} 占位，由运行时真实 Chromium 版本填充。
const USER_AGENT_TEMPLATES = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion}.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion}.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion}.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion}.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion}.0.0.0 Safari/537.36"
] as const;

// 惰性计算一次实际 Chromium 主版本号，供 UA 与 userAgentData brands 共用。
let cachedChromeMajor: string | null = null;
function chromeMajorVersion(): string {
  if (cachedChromeMajor === null) {
    cachedChromeMajor = getChromiumMajorVersion();
  }
  return cachedChromeMajor;
}

function pick<T>(pool: ReadonlyArray<T>, seed: number): T {
  const len = pool.length;
  // 取正模，避免 seed 为负数（如 seed >> 7 溢出为 32 位有符号整数）时
  // pool[负索引] 返回 undefined，进而被绑定成 NULL 触发 NOT NULL 约束。
  const index = ((Math.trunc(seed) % len) + len) % len;
  return pool[index];
}

// 用账号 id 作为稳定种子，保证同一账号每次生成都一致（固定指纹）。
export interface AccountFingerprint {
  userAgent: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  platform: string;
}

export function generateFingerprint(accountId: number): AccountFingerprint {
  const seed = accountId * 2654435761;
  const chromeMajor = chromeMajorVersion();
  return {
    userAgent: pick(USER_AGENT_TEMPLATES, seed).replace("{chromeVersion}", chromeMajor),
    hardwareConcurrency: pick(HARDWARE_CONCURRENCY_POOL, seed >> 3),
    deviceMemory: pick(DEVICE_MEMORY_POOL, seed >> 5),
    platform: pick(WINDOWS_PLATFORMS, seed >> 7)
  };
}

// 在渲染进程里覆盖 navigator 的基础硬件参数（UA 由 session.setUserAgent 处理，
// 不需要在这里改，避免 UA 与 navigator.userAgent 不一致）。
// timezone / language / locale 保持 Chromium 默认，不在此处改动。
export function buildFingerprintPreloadScript(fingerprint: AccountFingerprint): string {
  const { hardwareConcurrency, deviceMemory, platform } = fingerprint;
  const chromeMajor = chromeMajorVersion();
  return `
(function () {
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: function () { return ${hardwareConcurrency}; }
    });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function () { return ${deviceMemory}; }
    });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'platform', {
      get: function () { return ${JSON.stringify(platform)}; }
    });
  } catch (e) {}
  try {
    if (navigator.userAgentData) {
      Object.defineProperty(navigator, 'userAgentData', {
        get: function () {
          return {
            mobile: false,
            platform: ${JSON.stringify(platform)},
            brands: [
              { brand: 'Chromium', version: '${chromeMajor}' },
              { brand: 'Google Chrome', version: '${chromeMajor}' },
              { brand: 'Not)A;Brand', version: '24' }
            ],
            getHighEntropyValues: function () {
              return Promise.resolve({ brands: [], mobile: false, platform: ${JSON.stringify(platform)}, architecture: 'x86', bitness: '64', model: '', platformVersion: '', wow64: false });
            }
          };
        }
      });
    }
  } catch (e) {}
})();
`;
}
