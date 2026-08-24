// 验证 fingerprint 在各 accountId 下都不会产生 undefined / null，
// 避免被绑定为 NULL 触发 SQLite NOT NULL 约束。
import { generateFingerprint } from "../electron/fingerprint.ts";

function pick(pool, seed) {
  const len = pool.length;
  const index = ((Math.trunc(seed) % len) + len) % len;
  return pool[index];
}

let bad = 0;
const WINDOWS_PLATFORMS = ["Win32", "Win32", "Win32", "Linux x86_64", "MacIntel"];
const HARDWARE_CONCURRENCY_POOL = [4, 8, 8, 12, 16, 6, 10];
const DEVICE_MEMORY_POOL = [4, 8, 8, 16];

// 覆盖 1..200000，包括会让 seed>>7 溢出为负的高 id。
for (let id = 1; id <= 200000; id++) {
  const seed = id * 2654435761;
  if (pick(WINDOWS_PLATFORMS, seed >> 7) === undefined) bad++;
  if (pick(HARDWARE_CONCURRENCY_POOL, seed >> 3) === undefined) bad++;
  if (pick(DEVICE_MEMORY_POOL, seed >> 5) === undefined) bad++;
  const fp = generateFingerprint(id);
  if (fp.userAgent == null || fp.hardwareConcurrency == null || fp.deviceMemory == null || fp.platform == null) bad++;
}

console.log(bad === 0 ? "PASS: 所有 id 的指纹均非 undefined/null" : `FAIL: 发现 ${bad} 处 undefined/null`);
process.exit(bad === 0 ? 0 : 1);
