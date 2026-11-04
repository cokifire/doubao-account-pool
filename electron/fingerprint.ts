// 每个账号固定设备指纹生成与应用。
// 基础指纹：给每个账号一个长期固定、互不相同的 UA 与基础硬件参数
// （hardwareConcurrency / deviceMemory / platform），让同一 Chromium 实例下的
// 多个账号在外层风控看来像不同的固定设备。
// 激进指纹（aggressive，可选开关）：补全 navigator.webdriver、plugins/mimeTypes、
// window.chrome、WebGL 渲染器、canvas/audio 微噪声、语言与时区一致性，
// 抹掉 Electron 内嵌环境最明显的残留信号。全部按账号种子确定性生成。

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

const HARDWARE_CONCURRENCY_POOL = [4, 8, 8, 12, 16, 6, 10] as const;
const DEVICE_MEMORY_POOL = [4, 8, 8, 16] as const;

// UA 与 platform 必须成对出现，否则会出现「UA 声称 Macintosh、navigator.platform 却是 Win32」
// 这类自相矛盾的信号，被风控（如 Google 登录）直接判定为伪造浏览器。
// 因此这里把两者绑定成同一条 profile，一次取值保证永远一致。
interface DeviceProfile {
  system: string;
  platform: string;
}
const DEVICE_PROFILES: ReadonlyArray<DeviceProfile> = [
  { system: "Windows NT 10.0; Win64; x64", platform: "Win32" },
  { system: "Windows NT 10.0; WOW64", platform: "Win32" },
  { system: "Macintosh; Intel Mac OS X 10_15_7", platform: "MacIntel" },
  { system: "X11; Linux x86_64", platform: "Linux x86_64" },
  { system: "Windows NT 11.0; Win64; x64", platform: "Win32" }
];

// UA 模板使用 {chromeVersion} 占位，由运行时真实 Chromium 版本填充。
const USER_AGENT_TEMPLATE =
  "Mozilla/5.0 ({system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chromeVersion}.0.0.0 Safari/537.36";

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
  // 一次选出 profile，UA 与 platform 来自同一条记录，天然一致。
  const profile = pick(DEVICE_PROFILES, seed);
  return {
    userAgent: buildUserAgent(profile.system, chromeMajor),
    hardwareConcurrency: pick(HARDWARE_CONCURRENCY_POOL, seed >> 3),
    deviceMemory: pick(DEVICE_MEMORY_POOL, seed >> 5),
    platform: profile.platform
  };
}

function buildUserAgent(system: string, chromeMajor: string): string {
  return USER_AGENT_TEMPLATE
    .replace("{system}", system)
    .replace("{chromeVersion}", chromeMajor);
}

// 从一段既有 UA 反推应匹配的 navigator.platform。
// 用于修复历史账号中 UA 与 platform 不一致的数据（保持 UA 不变，只纠正 platform，
// 以免改变已登录账号的会话特征）。
export function platformForUserAgent(userAgent: string): string {
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "MacIntel";
  if (/Linux/i.test(userAgent)) return "Linux x86_64";
  return "Win32";
}

// —— 激进指纹 ——
//
// 语言/时区统一成中文用户画像：本项目面向豆包（国内版），中文用户无论用
// Windows / Mac / Linux 都属正常组合，比“随机出 en-US 却挂在 Mac 上”更一致。
// 因此 language 固定 zh-CN、时区固定 Asia/Shanghai，不随 platform 变化。
export interface AggressiveFingerprint {
  language: string;
  languages: string[];
  timezone: string;
  webglVendor: string;
  webglRenderer: string;
  canvasNoiseSeed: number;
  audioNoiseSeed: number;
}

const DEFAULT_LANGUAGE = "zh-CN";
const DEFAULT_LANGUAGES = ["zh-CN", "zh"];
const DEFAULT_TIMEZONE = "Asia/Shanghai";

interface WebglProfile {
  vendor: string;
  renderer: string;
}

// WebGL 渲染器必须与 platform 匹配，禁止出现「Win32 + Apple GPU」这类矛盾组合。
const WEBGL_PROFILES: Record<string, ReadonlyArray<WebglProfile>> = {
  Win32: [
    { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" }
  ],
  MacIntel: [
    { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M1, OpenGL 4.1)" },
    { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M2, OpenGL 4.1)" }
  ],
  "Linux x86_64": [
    { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)" }
  ]
};

export function generateAggressiveFingerprint(accountId: number, platform: string): AggressiveFingerprint {
  const seed = accountId * 2654435761;
  const webglPool = WEBGL_PROFILES[platform] || WEBGL_PROFILES.Win32;
  const webgl = pick(webglPool, seed >> 6);
  return {
    language: DEFAULT_LANGUAGE,
    languages: [...DEFAULT_LANGUAGES],
    timezone: DEFAULT_TIMEZONE,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    canvasNoiseSeed: (seed ^ 0x9e3779b9) >>> 0,
    audioNoiseSeed: (seed ^ 0x85ebca6b) >>> 0
  };
}

/** 构建 preload 脚本所需的输入：基础指纹字段 + 账号 id（激进指纹的稳定种子）。 */
export interface FingerprintPreloadInput extends AccountFingerprint {
  id: number;
}

export interface FingerprintPreloadOptions {
  /** 是否启用激进指纹补全。默认 false，保持既有行为。 */
  aggressive?: boolean;
}

// 在渲染进程里覆盖 navigator 的基础硬件参数（UA 由 session.setUserAgent 处理，
// 不需要在这里改，避免 UA 与 navigator.userAgent 不一致）。
// aggressive 开启时额外注入 webdriver / plugins / chrome / WebGL / canvas / audio / 语言时区。
export function buildFingerprintPreloadScript(
  input: FingerprintPreloadInput,
  options: FingerprintPreloadOptions = {}
): string {
  const { hardwareConcurrency, deviceMemory, platform } = input;
  const chromeMajor = chromeMajorVersion();
  const base = `
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

  if (!options.aggressive) return base;
  return base + buildAggressivePreloadScript(generateAggressiveFingerprint(input.id, platform));
}

// 生成激进指纹注入脚本。所有注入值都来自外部（确定性），脚本内不含任何账户相关原文。
function buildAggressivePreloadScript(fp: AggressiveFingerprint): string {
  return `
(function () {
  var LANG = ${JSON.stringify(fp.language)};
  var LANGS = ${JSON.stringify(fp.languages)};
  var TZ = ${JSON.stringify(fp.timezone)};
  var WEBGL_VENDOR = ${JSON.stringify(fp.webglVendor)};
  var WEBGL_RENDERER = ${JSON.stringify(fp.webglRenderer)};
  var CANVAS_SEED = ${fp.canvasNoiseSeed};
  var AUDIO_SEED = ${fp.audioNoiseSeed};

  // 1. 显式抹掉自动化标记（Electron 内嵌/自动化场景常见残留）。
  try {
    Object.defineProperty(navigator, 'webdriver', { get: function () { return false; } });
  } catch (e) {}

  // 2. 语言 / 时区一致性：中文用户画像，与豆包（国内版）语境一致。
  try {
    Object.defineProperty(navigator, 'language', { get: function () { return LANG; } });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'languages', { get: function () { return LANGS; } });
  } catch (e) {}
  try {
    var origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      var opts = origResolved.call(this);
      try { Object.defineProperty(opts, 'timeZone', { value: TZ, configurable: true }); } catch (e) {}
      return opts;
    };
  } catch (e) {}
  try {
    Date.prototype.getTimezoneOffset = function () { return -480; };
  } catch (e) {}

  // 3. 伪造 Chrome 风格的 plugins / mimeTypes（Electron 里常为空或形状不同）。
  try {
    var _mimes = [];
    var _plugins = [];
    function makeMime(type, desc, suffixes) {
      var m = { type: type, description: desc, suffixes: suffixes, enabledPlugin: null };
      _mimes.push(m);
      return m;
    }
    function makePlugin(name, filename, desc, types) {
      var p = { name: name, filename: filename, description: desc, length: types.length };
      for (var i = 0; i < types.length; i++) {
        p[i] = types[i];
        types[i].enabledPlugin = p;
      }
      p.item = function (i) { return types[i] || null; };
      p.namedItem = function (n) {
        for (var j = 0; j < types.length; j++) { if (types[j].type === n) return types[j]; }
        return null;
      };
      _plugins.push(p);
      return p;
    }
    makePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format',
      [makeMime('application/x-google-chrome-pdf', 'Portable Document Format', 'pdf')]);
    makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'Portable Document Format',
      [makeMime('application/pdf', 'Portable Document Format', 'pdf')]);
    makePlugin('Native Client', 'internal-nacl-plugin', 'Native Client Executable',
      [makeMime('application/x-nacl', 'Native Client Executable', ''), makeMime('application/x-pnacl', 'Portable Native Client Executable', '')]);

    function makeArrayLike(items) {
      var out = { length: items.length };
      for (var i = 0; i < items.length; i++) out[i] = items[i];
      out.item = function (i) { return items[i] || null; };
      out.namedItem = function (n) {
        for (var j = 0; j < items.length; j++) { if (items[j].name === n) return items[j]; }
        return null;
      };
      out.refresh = function () {};
      return out;
    }
    var fakePlugins = makeArrayLike(_plugins);
    var fakeMimes = makeArrayLike(_mimes);
    Object.defineProperty(navigator, 'plugins', { get: function () { return fakePlugins; } });
    Object.defineProperty(navigator, 'mimeTypes', { get: function () { return fakeMimes; } });
  } catch (e) {}

  // 4. 保证 window.chrome.runtime 存在（真实 Chrome 的常见特征）。
  try {
    var _chrome = window.chrome;
    if (_chrome && !_chrome.runtime) {
      Object.defineProperty(_chrome, 'runtime', { value: {}, configurable: true });
    }
  } catch (e) {}

  // 5. WebGL 渲染器 / 厂商（抹掉 Electron 的 ANGLE/Metal 等真实渲染器残留）。
  try {
    var _targets = [];
    if (typeof WebGLRenderingContext !== 'undefined') _targets.push(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') _targets.push(WebGL2RenderingContext.prototype);
    _targets.forEach(function (proto) {
      var orig = proto.getParameter;
      if (!orig) return;
      proto.getParameter = function (param) {
        if (param === 0x9245) return WEBGL_VENDOR;    // UNMASKED_VENDOR_WEBGL
        if (param === 0x9246) return WEBGL_RENDERER;  // UNMASKED_RENDERER_WEBGL
        return orig.apply(this, arguments);
      };
    });
  } catch (e) {}

  // 6. canvas 微噪声：在 getImageData 读回时对前若干像素做确定性 ±1 扰动。
  try {
    var _canvasOrig = CanvasRenderingContext2D.prototype.getImageData;
    if (_canvasOrig) {
      var _canvasState = CANVAS_SEED;
      var _canvasNoise = function () {
        _canvasState = (_canvasState * 1664525 + 1013904223) >>> 0;
        return _canvasState / 4294967296;
      };
      CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
        var data = _canvasOrig.apply(this, arguments);
        try {
          var d = data.data;
          var n = Math.min(d.length, 64);
          for (var i = 0; i < n; i += 4) {
            var delta = Math.floor(_canvasNoise() * 3) - 1;
            d[i] = Math.min(255, Math.max(0, d[i] + delta));
            d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + delta));
            d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + delta));
          }
        } catch (e) {}
        return data;
      };
    }
  } catch (e) {}

  // 7. audio 微噪声：在 getChannelData 读回时对前若干采样做不可闻扰动。
  try {
    if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
      var _audioOrig = AudioBuffer.prototype.getChannelData;
      var _audioState = AUDIO_SEED;
      var _audioNoise = function () {
        _audioState = (_audioState * 1664525 + 1013904223) >>> 0;
        return _audioState / 4294967296;
      };
      AudioBuffer.prototype.getChannelData = function (channel) {
        var data = _audioOrig.apply(this, arguments);
        try {
          var n = Math.min(data.length, 16);
          for (var i = 0; i < n; i++) {
            data[i] += (_audioNoise() - 0.5) * 1e-4;
          }
        } catch (e) {}
        return data;
      };
    }
  } catch (e) {}
})();
`;
}
