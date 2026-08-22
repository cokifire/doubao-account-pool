// 每个账号固定设备指纹生成与应用。
// 设计目标：在不触碰 timezone / locale / language 的前提下，给每个账号一个
// 长期固定、互不相同的 UA 与基础硬件参数（hardwareConcurrency / deviceMemory / platform），
// 让同一 Chromium 实例下的多个账号在外层风控看来像不同的固定设备。

const WINDOWS_PLATFORMS = ["Win32", "Win32", "Win32", "Linux x86_64", "MacIntel"] as const;
const HARDWARE_CONCURRENCY_POOL = [4, 8, 8, 12, 16, 6, 10] as const;
const DEVICE_MEMORY_POOL = [4, 8, 8, 16] as const;

// Electron 36 内置 Chromium 136，匹配一组常见桌面 UA。
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
] as const;

function pick<T>(pool: ReadonlyArray<T>, seed: number): T {
  return pool[seed % pool.length];
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
  return {
    userAgent: pick(USER_AGENTS, seed),
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
              { brand: 'Chromium', version: '136' },
              { brand: 'Google Chrome', version: '136' },
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
