#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""豆包 /thread/ 分享视频「无水印 original 档位」下载器(对抗性审查整理版)。

本文件在原始片段基础上补全了依赖与公共函数, 并修复了审查中发现的若干问题。

⚠ 运行前必须核对一处「逆向」相关项是否与当前接口一致:
  1. extract_fallback_api —— 从分享页 HTML 提取 fallback_api 的匹配规则, 需匹配当前页面结构
qAAB 盐值(FPLAY_KDF_SALT)来自公开逆向实现(catscarlet 的 GreasyFork 脚本 555118 /
ITzhengjinhan/media-parser 文档), 两个来源一致; 接口变更即可能失效。
依赖: cryptography(``pip install cryptography``), 用于 AES-CBC 解密。
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
REFERER = "https://www.doubao.com/"
TIMEOUT = 30
MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024   # 下载上限 4GiB, 防异常/恶意流写爆磁盘
# host 白名单(为空 = 不限制 host, 但仍强制 http/https)。建议按需填入豆包 CDN 域名以收紧 SSRF 面。
ALLOWED_HOST_SUFFIXES = ()

# TODO(逆向): qAAB 令牌解密盐(FPLAY_KDF_SALT, base64 编码的 64 字节)。
# 来源: 公开逆向实现(catscarlet GreasyFork #555118 / ITzhengjinhan/media-parser), 两者一致。
QAAB_SALT = base64.b64decode(
    "TdTC5rgxYgkOUrPHpnM7pByyRiuCmrWKGWs521cXdST0m69/COjWjSanLjfBqVovHwWlGJKu8pSXMrYqOKrdWA==")

# qAAB 令牌二进制结构(逆向所得魔法值, 接口变更即失效):
QAAB_HEADER = b"\xa8\x00\x01\x00"
QAAB_HDR_LEN = 4
QAAB_IV_OFF = 20     # 数据段内用作 IV 的偏移
QAAB_IV_LEN = 16
QAAB_BODY_OFF = 36   # 密文主体起始偏移


# ---------------------------------------------------------------------------
# HTTP 与安全基座
# ---------------------------------------------------------------------------
def _validate_http_url(url: str) -> str:
    """强制 http/https; 可选 host 白名单。SSRF 最小防护。"""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise SystemExit(f"错误: 拒绝非 http/https 链接: {url!r}")
    if not parts.hostname:
        raise SystemExit(f"错误: 链接缺少 host: {url!r}")
    if ALLOWED_HOST_SUFFIXES and not parts.hostname.endswith(ALLOWED_HOST_SUFFIXES):
        raise SystemExit(f"错误: 链接 host 不在白名单: {parts.hostname!r}")
    return url


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    """跟随重定向, 但校验每个目标仍是 http/https 且命中白名单, 拒绝 file:// 等跳转。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            _validate_http_url(newurl)
        except SystemExit:
            return None  # 拒绝非法重定向目标
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_SafeRedirect())


def http_get(url: str) -> bytes:
    _validate_http_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER})
    with _OPENER.open(req, timeout=TIMEOUT) as resp:
        return resp.read()


def http_get_json(url: str) -> dict:
    return json.loads(http_get(url).decode("utf-8", "ignore"))


def aes_cbc_decrypt(payload: bytes, key: bytes, iv: bytes) -> bytes:
    """AES-CBC 解密(依赖 cryptography)。"""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    return decryptor.update(payload) + decryptor.finalize()


def extract_fallback_api(html: str) -> str:
    """从分享页 HTML 提取官方播放接口 fallback_api。

    TODO(逆向): 需按豆包当前页面结构核对。页面里 fallback_api 的值被多层转义:
    ``/`` 写作 ``\\/``、``&`` 写作 ``&amp;``, 提取后需反转义。
    2026-11 实测链接形如:
    ``https://vas-lf-x.snssdk.com/video/fplay/1/<id>/<vid>?aid=...&key_seed=...``
    """
    m = re.search(
        r"fallback_api[^h]*?(https:(?:[\w\-.~%:/?#\[\]@!$'()*+,;=\\]|&amp;)+)", html)
    if not m:
        raise SystemExit("错误: 未在分享页中找到 fallback_api, 页面结构可能已变更。")
    return (m.group(1).rstrip("\\")
            .replace("\\u002F", "/").replace("\\/", "/").replace("&amp;", "&"))


# ---------------------------------------------------------------------------
# 请求无水印(original)档位
# ---------------------------------------------------------------------------
def get_original_play_info(fallback_api: str) -> dict:
    """改参数后请求播放接口, 返回 video_info.data。"""
    parts = urllib.parse.urlsplit(fallback_api)
    q = dict(urllib.parse.parse_qsl(parts.query))
    q["codec_type"] = "8"              # 触发 original 原始质量档
    q["logo_type"] = "unwatermarked"   # 去水印标识
    q["channel"] = "no"
    url = urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(q), ""))
    resp = http_get_json(url)
    data = (resp.get("video_info") or {}).get("data") or {}
    if data.get("status") != 10:
        raise SystemExit(f"错误: 播放接口返回异常 status={data.get('status')} "
                         f"message={data.get('message')}")
    return data


# ---------------------------------------------------------------------------
# qAAB 解密
# ---------------------------------------------------------------------------
def _b64d(s: str) -> bytes:
    s = s.replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    return base64.b64decode(s)


def _strip_pkcs7(v: bytes) -> bytes:
    if not v:
        return b""
    p = v[-1]
    if 1 <= p <= 16 and p <= len(v) and v[-p:] == bytes([p]) * p:
        return v[:-p]
    return v


def _as_url(v: bytes) -> str:
    if not v:
        return ""
    # 明文应全部为可打印 ASCII(允许 tab/换行/回车)。含其它字节则视为「带 PKCS7 填充
    # 或解密错误」, 返回空串交由 _try_decrypt 走 strip_pkcs7 分支再试一次。
    if any(b not in (9, 10, 13) and not (32 <= b <= 126) for b in v):
        return ""
    try:
        s = v.decode("ascii").strip()
    except UnicodeDecodeError:
        return ""
    return s if s.startswith(("http://", "https://")) else ""


def _try_decrypt(payload: bytes, key: bytes, iv: bytes) -> str:
    if not payload or len(payload) % 16:
        return ""
    try:
        pt = aes_cbc_decrypt(payload, key, iv)
    except Exception:
        return ""
    return _as_url(pt) or _as_url(_strip_pkcs7(pt))


def decode_qaab(token: str, key_seed: str) -> str:
    """解密 qAAB 令牌, 返回真实 CDN 直链; 失败返回空串。"""
    try:
        data = _b64d(token.strip())
        seed = _b64d(urllib.parse.unquote(key_seed).strip())
    except Exception:
        return ""
    first = hashlib.sha512(seed[:32]).digest()
    material = hashlib.sha512(first + QAAB_SALT).digest()
    key, iv = material[:16], material[16:32]

    attempts = []
    if data[:QAAB_HDR_LEN] == QAAB_HEADER:
        attempts.append((data[QAAB_HDR_LEN:], key, iv))
        attempts.append((data[QAAB_HDR_LEN:], iv, key))
        if len(data) > QAAB_BODY_OFF:
            attempts.append((
                data[QAAB_BODY_OFF:], key,
                data[QAAB_IV_OFF:QAAB_IV_OFF + QAAB_IV_LEN]))
            attempts.append((data[QAAB_BODY_OFF:], key, iv))
    else:
        attempts.append((data, key, iv))
    for payload, k, v in attempts:
        url = _try_decrypt(payload, k, v)
        if url:
            return url
    return ""


def pick_nowatermark_url(data: dict) -> tuple:
    """从播放信息中挑选无水印(original/logo 为空)档位并解密, 返回 (url, meta)。"""
    key_seed = data.get("key_seed", "")
    vlist = data.get("video_list", {})
    if not vlist:
        raise SystemExit("错误: 播放接口未返回 video_list。")

    # 优先 original 质量且 logo 为空的条目, 其次任意条目
    def score(item):
        logo = item.get("logo_type") or ""
        qual = item.get("quality") or ""
        s = 0
        if qual == "original":
            s += 2
        if not logo:
            s += 2
        return s

    items = sorted(vlist.items(), key=lambda kv: score(kv[1]), reverse=True)
    for _name, item in items:
        for field in ("main_url", "backup_url_1", "backup_url_2", "backup_url_3"):
            tok = item.get(field)
            if not tok:
                continue
            # 已是明文直链则直接用
            if tok.startswith(("http://", "https://")):
                return tok, item
            url = decode_qaab(tok, key_seed)
            if url:
                return url, item
    raise SystemExit("错误: 所有档位 URL 解密失败, 可能接口已变更。")


# ---------------------------------------------------------------------------
# 下载
# ---------------------------------------------------------------------------
def download(url: str, out: str) -> int:
    _validate_http_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REFERER})
    total = 0
    try:
        with _OPENER.open(req, timeout=TIMEOUT) as resp, open(out, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)  # 1MB
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise SystemExit(
                        f"错误: 下载超过上限 {MAX_DOWNLOAD_BYTES} 字节, 已中止。")
                f.write(chunk)
    except BaseException:
        try:
            os.remove(out)  # 失败时清掉半成品, 避免留下损坏的 .mp4
        except OSError:
            pass
        raise
    if total == 0:
        try:
            os.remove(out)
        except OSError:
            pass
        raise SystemExit("错误: 下载内容为空。")
    return total


def _file_md5(path: str) -> str:
    """分块计算 md5, 避免大文件整读进内存。"""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    # Windows 控制台默认 cp1252/gbk 会因 → ≈ 等字符崩溃, 统一 utf-8
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        description="豆包 /thread/ 分享视频无水印原片下载器")
    ap.add_argument("url", help="豆包分享链接, 如 https://www.doubao.com/thread/xxxx")
    ap.add_argument("-o", "--output", help="输出文件路径(.mp4); 缺省自动命名")
    args = ap.parse_args()

    if "/thread/" not in args.url:
        sys.exit("错误: 仅支持 /thread/ 类型的公开分享链接。")

    print(f"[1/5] 获取分享页: {args.url}")
    html = http_get(args.url).decode("utf-8", "ignore")

    print("[2/5] 提取官方播放接口 fallback_api ...")
    fallback_api = extract_fallback_api(html)

    print("[3/5] 请求无水印(original)档位 codec_type=8 & logo_type=unwatermarked ...")
    data = get_original_play_info(fallback_api)
    vid = data.get("video_id", "video")
    dur = data.get("video_duration", 0)

    print("[4/5] 解密 qAAB 令牌得到真实直链 ...")
    url, item = pick_nowatermark_url(data)
    w, h = item.get("vwidth", 0), item.get("vheight", 0)
    print(f"      档位: quality={item.get('quality')} logo={item.get('logo_type')!r} "
          f"{w}x{h} 码率={item.get('bitrate')} 大小={item.get('size')}")

    out = args.output or f"doubao_{vid}_nowatermark.mp4"
    print(f"[5/5] 下载无水印原片 -> {out}")
    size = download(url, out)

    # 校验: 与服务端 file_hash(md5) 比对
    md5 = _file_md5(out)
    fh = (item.get("file_hash") or "").lower()
    if not fh:
        ok = "无服务端hash"
    elif md5 == fh:
        ok = "一致"
    else:
        ok = "不一致"
    print(f"\n完成: {out}")
    print(f"  大小={size} 字节  md5={md5}  (服务端 file_hash={'匹配' if ok == '一致' else ok})")
    print(f"  时长≈{dur}s  {w}x{h}  已从 CDN 源头获取, 未做画面擦除。")
    if ok == "不一致":
        print("  警告: md5 与服务端不一致, 请检查网络/缓存, 建议重新下载。")


if __name__ == "__main__":
    main()
