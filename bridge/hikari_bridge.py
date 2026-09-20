#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wows-helper · Hikari-core-v2 桥接服务
=====================================

把 Python 侧的 Hikari-core-v2（指令解析 + yuyuko API 查询 + 浏览器端模板渲染出图）
包成一个只在本机监听的 JSON HTTP 服务，供 QQ Agent 的 wows-helper 插件调用。

为什么必须存在这一层
--------------------
Hikari-core-v2 是 Python SDK：
  · `init_hikari(platform, PlatformId, BotId, command_text, GroupId)` 解析 wws 指令
  · 模板由**浏览器端 Nunjucks** 渲染，Python 只负责组装外壳 HTML 并用 playwright 截图
Node 侧既跑不了这个 SDK，也没有可用的等价渲染链路，所以最干净的接法是"薄客户端 + 本地常驻桥接"。

接口（只有两个，刻意不做更多）
------------------------------
  GET  /health         → {"ok":true,"ready":bool,"version":...,"pending":n}
  POST /query          → 查询/续查一次

POST /query 请求体：
  {
    "command": "ship 大和 recent 30",   // 不带 wws 前缀；续查时可为空
    "platform": "QQ",                   // QQ / QQ_CHANNEL / QQ_OFFICIAL
    "platform_id": "1000000001",        // 触发者；wws 的绑定按它存
    "bot_id": "0",
    "group_id": null,
    "select_index": null,               // 续查：用户回复的序号（1 起）
    "session_key": null,                // 续查：上一轮的会话键
    "config": { "image_type": "jpeg", "use_browser": "chromium", ... }   // 可选覆盖
  }

POST /query 响应体：
  {
    "ok": true,
    "status": "success" | "wait" | "failed" | "error",
    "text": "文本结果或提示文案",
    "data_type": "bytes" | "str" | ...,
    "image_base64": "...",              // 有图时才有
    "image_mime": "image/jpeg",
    "options": [{"name": "..."}],       // status=wait 时的待选项
    "elapsed_ms": 1234,
    "command": "..."
  }

启动
----
  pip install -r bridge/requirements.txt
  python -m playwright install chromium          # 首次：下载渲染用浏览器
  python bridge/hikari_bridge.py --token "账号ID:Token"

QQ Agent 侧的「桥接服务地址 / 口令」要与 --host/--port/--token 保持一致。

安全说明
--------
默认只监听 127.0.0.1，并可用 --token 加一道口令（插件侧对应「桥接服务口令」配置项）。
不要把它暴露到公网：它是**无鉴权的转发器**，拿到地址的人可以用你的 yuyuko 配额查数据。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import traceback
from http import HTTPStatus

# ── 提前把参数解析出来：hikari_core 的导入会触发模板目录日志，先配置好更干净 ──────────
DEFAULT_TOKEN_PLACEHOLDER = "你的账号ID:你的Token"
ENV_TOKEN_KEYS = ("HIKARI_TOKEN", "WOWS_HELPER_TOKEN")


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="wows-helper 的 Hikari-core-v2 桥接服务")
    p.add_argument("--host", default=os.environ.get("WOWS_HELPER_BRIDGE_HOST", "127.0.0.1"),
                   help="监听地址，默认 127.0.0.1（仅本机）")
    p.add_argument("--port", type=int, default=int(os.environ.get("WOWS_HELPER_BRIDGE_PORT", "8788")),
                   help="监听端口，默认 8788")
    p.add_argument("--token", default=os.environ.get(ENV_TOKEN_KEYS[0], "").strip(),
                   help="yuyuko API 凭据，格式 账号ID:Token。也可用环境变量 HIKARI_TOKEN")
    p.add_argument("--access-token", default=os.environ.get("WOWS_HELPER_ACCESS_TOKEN", "").strip(),
                   help="本服务的访问口令（可选）。设置后请求需带 X-Hikari-Token 头")
    p.add_argument("--game-path", default=os.environ.get("WOWS_HELPER_GAME_PATH", "").strip(),
                   help="缓存目录（船图/模板/浏览器数据）。留空用 hikari-core 默认目录")
    p.add_argument("--proxy", default=os.environ.get("WOWS_HELPER_PROXY", "").strip(),
                   help="访问 WG 的代理，如 http://127.0.0.1:7890")
    p.add_argument("--image-type", default=os.environ.get("WOWS_HELPER_IMAGE_TYPE", "jpeg"),
                   choices=["jpeg", "png", "webp"], help="出图格式，默认 jpeg")
    p.add_argument("--use-browser", default=os.environ.get("WOWS_HELPER_BROWSER", "chromium"),
                   choices=["chromium", "firefox"], help="渲染用浏览器，默认 chromium")
    p.add_argument("--command-language", default=os.environ.get("WOWS_HELPER_LANG", "zh"),
                   choices=["zh", "en"], help="指令提示语言，默认 zh")
    p.add_argument("--ignore-list", default=os.environ.get("WOWS_HELPER_IGNORE_LIST", ""),
                   help="禁用的功能函数名，逗号分隔。例：--ignore-list set_BindInfo,change_BindInfo,delete_BindInfo,"
                        "async_update_ship_cache（注意必须用函数名，字符串列表是无效的）")
    p.add_argument("--pending-ttl", type=int, default=300, help="多选会话保留秒数，默认 300")
    p.add_argument("--max-pending", type=int, default=32, help="多选会话最多保留条数，默认 32")
    p.add_argument("--log-level", default=os.environ.get("WOWS_HELPER_LOG_LEVEL", "INFO"),
                   choices=["DEBUG", "INFO", "WARNING", "ERROR"], help="日志级别，默认 INFO")
    return p.parse_args(argv)


ARGS = parse_args()


# ── 依赖加载：失败时不要崩掉，留在 /health 里报告，便于插件把原因说清楚 ────────────────
try:
    from loguru import logger

    logger.remove()
    logger.add(sys.stdout, level=ARGS.log_level,
               format="<green>{time:HH:mm:ss}</green> | <level>{level: <7}</level> | {message}")
except Exception:  # pragma: no cover - loguru 一定会随 hikari-core 装上
    import logging

    logging.basicConfig(level=getattr(logging, ARGS.log_level, logging.INFO))
    logger = logging.getLogger("wows-bridge")

CORE_ERROR = None
Hikari_Model = None
callback_hikari = None
init_hikari = None
set_hikari_config = None
CORE_VERSION = ""

try:
    from hikari_core import (
        Hikari_Model as _Hikari_Model,
        callback_hikari as _callback_hikari,
        init_hikari as _init_hikari,
        set_hikari_config as _set_hikari_config,
        __version__ as _core_version,
    )

    Hikari_Model = _Hikari_Model
    callback_hikari = _callback_hikari
    init_hikari = _init_hikari
    set_hikari_config = _set_hikari_config
    CORE_VERSION = str(_core_version)
except Exception as exc:  # pragma: no cover - 部署期才会走到
    CORE_ERROR = f"{type(exc).__name__}: {exc}"
    logger.error(f"无法导入 hikari_core：{CORE_ERROR}")
    logger.error("请先执行：pip install -r bridge/requirements.txt 且 python -m playwright install chromium")


CONFIGURED = False
# 上一次实际用的 token：插件可以在设置里改它（改完下一次查询就生效，不用重启桥接）。
# 为 None 表示"还没配置过"，此时用启动参数/环境变量里的那份。
ACTIVE_TOKEN: str | None = None
# 上次凭据的来源：'plugin'（插件设置页下发）| 'bridge-arg'（启动参数/环境变量）| ''（还没有）
# ⚠️ 必须**显式记录来源**，不能靠"值是否等于 ARGS.token"反推：两处填同一串时
#    反推必然判成 bridge-arg（本次核验就实测到了这个误报）。
ACTIVE_TOKEN_SOURCE = ''
# 已解析成功的禁用功能函数列表（--ignore-list 的结果，见 resolve_ignore_list）
ACTIVE_IGNORE: list = []


def resolve_ignore_list(names) -> list:
    """
    把 `--ignore-list set_BindInfo,get_BindInfo` 这样的名字解析成**函数对象**列表。

    为什么必须是函数对象：`init_hikari` 内部是 `if hikari.Function in Ignore_List`，
    比的是函数本身。实测传字符串 `['get_BindInfo']` **完全无效**（查询照常成功），
    只有 `[get_BindInfo]`（真函数）才会返回"该功能已被禁用"。

    名字从 hikari_core 顶层命名空间取（它的 __init__ 显式再导出了这些函数）。
    解析不到的会明确告警 —— 静默失败在这里后果是"以为禁用了其实没禁"。
    """
    if init_hikari is None or not names:
        return []
    import hikari_core

    resolved, missing = [], []
    for raw in names:
        name = str(raw).split('.')[-1].strip()
        if not name:
            continue
        fn = getattr(hikari_core, name, None)
        if fn is None:
            missing.append(name)
        elif fn not in resolved:
            resolved.append(fn)
    if missing:
        logger.warning(f"--ignore-list 里有解析不到的名字（会被忽略）：{', '.join(missing)}。"
                       f"可用名字形如 set_BindInfo / get_BindInfo / change_BindInfo / delete_BindInfo / "
                       f"async_update_ship_cache / async_update_template / check_version")
    if resolved:
        logger.info(f"已禁用功能：{', '.join(getattr(f, '__name__', str(f)) for f in resolved)}")
    return resolved


def resolve_token(overrides: dict | None = None) -> tuple[str, str]:
    """
    决定这次查询用哪个 yuyuko 凭据，并返回 (凭据, 来源)。优先级：

      1. 插件请求里带的 `hikari_token`（用户在 QQ Agent 设置页填的）→ 'plugin'
         —— 让"不会敲命令行"的用户也能配好，这是主要通路；
      2. 启动参数 --token / 环境变量 HIKARI_TOKEN → 'bridge-arg'（无人值守部署时用）。

    两处都没配时返回 ('', '')，由调用方决定怎么报错。
    """
    token = str((overrides or {}).get("hikari_token") or "").strip()
    if token:
        return token, 'plugin'
    cli = str(ARGS.token or "").strip()
    if cli and cli != DEFAULT_TOKEN_PLACEHOLDER:
        return cli, 'bridge-arg'
    return '', ''


def apply_config(overrides: dict | None = None) -> None:
    """
    把配置交给 Hikari-core。**每次查询前都会调用**（幂等、开销极小），
    这样插件改了"出图方式/浏览器/代理/凭据"等设置后不用重启桥接服务即刻生效。
    """
    global CONFIGURED, ACTIVE_TOKEN, ACTIVE_TOKEN_SOURCE
    if set_hikari_config is None:
        return
    ov = {k: v for k, v in (overrides or {}).items() if v not in (None, "")}

    token, token_source = resolve_token(overrides)
    kwargs = {
        "token": token or None,          # 空串会被签名过滤掉，不如显式 None
        "image_type": str(ov.get("image_type") or ARGS.image_type),
        "use_browser": str(ov.get("use_browser") or ARGS.use_browser),
        "command_language": str(ov.get("command_language") or ARGS.command_language),
        "game_path": str(ov.get("game_path") or ARGS.game_path or ""),
        "proxy": (str(ov.get("proxy") or ARGS.proxy) or None),
        # auto_rendering / auto_image 用 None = 不覆盖（hikari-core 默认 True）
        "auto_rendering": _tri(ov.get("auto_rendering")),
        "auto_image": _tri(ov.get("auto_image")),
        "http2": _tri(ov.get("http2")),
    }
    kwargs = {k: v for k, v in kwargs.items() if v is not None}
    # ⚠️ 参数名兼容：hikari-core 的 `set_hikari_config` 把浏览器参数拼成了 `use_broswer`（少一个 w）。
    #    这里按实际签名做同义映射，否则 `use_browser` 会被签名过滤静默丢掉 ——
    #    表现为"设置里选了 firefox 却一直用 chromium"，且没有任何报错。
    try:
        import inspect

        accepted = set(inspect.signature(set_hikari_config).parameters)
        if 'use_browser' in kwargs and 'use_browser' not in accepted and 'use_broswer' in accepted:
            kwargs['use_broswer'] = kwargs.pop('use_browser')
        kwargs = {k: v for k, v in kwargs.items() if k in accepted}
    except Exception:
        pass
    set_hikari_config(**kwargs)
    ACTIVE_TOKEN = token
    ACTIVE_TOKEN_SOURCE = token_source
    if not CONFIGURED:
        CONFIGURED = True
        browser = kwargs.get('use_browser') or kwargs.get('use_broswer')
        logger.info(f"hikari-core {CORE_VERSION} 配置完成（image_type={kwargs.get('image_type')}, "
                    f"browser={browser}）")


def _tri(value):
    """三态布尔：None=不覆盖，其余转成真布尔。"""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in ("0", "false", "no", "off", "")


# ── 多选（wait）会话：用户回复序号后续查 ────────────────────────────────────────────
PENDING: dict[str, dict] = {}


def pending_put(key: str, hikari) -> None:
    now = time.time()
    for k in [k for k, v in PENDING.items() if now - v["at"] > ARGS.pending_ttl]:
        PENDING.pop(k, None)
    PENDING[key] = {"at": now, "hikari": hikari}
    while len(PENDING) > max(1, ARGS.max_pending):
        oldest = min(PENDING.items(), key=lambda kv: kv[1]["at"])[0]
        PENDING.pop(oldest, None)


def extract_options(data) -> list:
    """把 Hikari 的 Select_Data 归一化成 [{"name": ...}, ...]，失败就返回空列表。"""
    out = []
    if not isinstance(data, (list, tuple)):
        return out
    for item in data[:12]:
        if isinstance(item, dict):
            name = item.get("name") or item.get("Name") or item.get("text") or item.get("shipName")
            if name is None:
                # 兜底：取第一个字符串值
                for v in item.values():
                    if isinstance(v, str) and v.strip():
                        name = v
                        break
            out.append({"name": str(name if name is not None else item)[:80]})
        else:
            out.append({"name": str(item)[:80]})
    return out


def package(hikari, command: str, elapsed_ms: int, session_key: str | None = None) -> dict:
    """把 Hikari_Model 转成本服务的响应体。"""
    status = str(getattr(hikari, "Status", "error") or "error")
    out = getattr(hikari, "Output", None)
    data = getattr(out, "Data", None)
    # Data_Type 可能是 str(type(x)) 这种类描述，不是 mime：只在 shape 靠谱时才用
    raw_type = getattr(out, "Data_Type", "") or ""
    data_type = raw_type if isinstance(raw_type, str) else str(raw_type)
    resp = {
        "ok": status in ("success", "wait"),
        "status": status,
        # command 可能不是 str（模型/上游给过非字符串），统一成 JSON 可序列化的形式
        "command": command if isinstance(command, str) else str(command),
        "text": "",
        "data_type": data_type,
        "image_base64": None,
        "image_mime": None,
        "options": [],
        "elapsed_ms": elapsed_ms,
    }

    if isinstance(data, (bytes, bytearray)):
        import base64

        mime = "image/jpeg"
        if data_type and "/" in data_type:
            mime = data_type
        elif data_type and data_type.isalpha():
            mime = f"image/{data_type}"
        try:
            resp["image_base64"] = base64.b64encode(bytes(data)).decode("ascii")
            resp["image_mime"] = mime
        except Exception as exc:  # pragma: no cover - 内存/编码异常
            # 宁可回一句人话，也不要把整个响应打成 500（前端拿到的是"桥接内部错误"）
            logger.error(f"渲染图 base64 编码失败：{exc}")
            resp["ok"] = False
            resp["status"] = "error"
            resp["text"] = "渲染图编码失败（服务端内存或编码异常），请重试一次"
        resp["text"] = resp["text"] or ""
    elif isinstance(data, str):
        resp["text"] = data
    elif data is None:
        resp["text"] = ""
    else:
        # dict / list：没有渲染成图时（auto_image 关闭）给 JSON，方便排查。
        # default=str 兜底：模型里可能混入 datetime 之类的不可序列化对象。
        try:
            resp["text"] = json.dumps(data, ensure_ascii=False, default=str)[:4000]
        except Exception:
            resp["text"] = str(data)[:4000]

    if status == "wait":
        resp["options"] = extract_options(getattr(getattr(hikari, "Input", None), "Select_Data", None))
        if session_key:
            pending_put(session_key, hikari)
    # 把"这次到底用了哪份凭据"回给调用方：用户最常犯的错就是没配 token，
    # 若无提示，表现只是"Hikari 返回未授权"，很难定位。
    resp["token_source"] = ACTIVE_TOKEN_SOURCE or 'none'
    return resp


async def call_hikari(*, command: str, platform: str, platform_id: str, bot_id: str,
                      group_id, select_index, session_key, config_overrides) -> dict:
    """真正的查询：续查走 callback_hikari，新查询走 init_hikari。"""
    if init_hikari is None:
        raise RuntimeError(f"hikari-core 未就绪：{CORE_ERROR or '未安装'}")
    # ⚠️ resolve_token 返回 (凭据, 来源) 元组 —— 元组恒为真，必须取第一个元素判断，
    #    否则"没配凭据"这条分支永远不会触发（改成元组返回时踩到的坑）。
    if not resolve_token(config_overrides)[0]:
        # 两处都没配：与其让 Hikari 回一句"未授权"，不如直接告诉用户去哪填
        raise RuntimeError("没有配置 yuyuko API 凭据：请在 QQ Agent 的插件设置里填「yuyuko API 凭据」，"
                           "或用 --token/环境变量 HIKARI_TOKEN 启动桥接服务")

    apply_config(config_overrides)
    started = time.time()

    pend = PENDING.get(session_key) if (select_index is not None and session_key) else None
    if pend is not None:
        hikari = pend["hikari"]
        hikari.Input.Select_Index = int(select_index)
        # 续查时把平台信息补齐（同一会话内用户与群不会变，但平台标识可能被插件改过）
        hikari = await callback_hikari(hikari)
        PENDING.pop(session_key, None)
        elapsed = int((time.time() - started) * 1000)
        logger.info(f"续查 select={select_index} → {hikari.Status} ({elapsed}ms)")
        return package(hikari, command or f"select:{select_index}", elapsed, session_key)

    if not str(command or "").strip():
        raise ValueError("续查失败：没有挂起的会话，且没有给出指令")

    # 同一个会话又发起了新查询：把上一次挂起的多选会话丢掉（否则它会一直占着内存，
    # 而且用户之后回一个序号会被拿去接一个早就过期的上下文）
    if session_key:
        PENDING.pop(session_key, None)

    hikari = await init_hikari(
        platform=platform,
        PlatformId=str(platform_id),
        BotId=str(bot_id),
        command_text=str(command),
        GroupId=(str(group_id) if group_id not in (None, "") else None),
        # 禁用清单（可选）。注意：必须传**函数对象**，传字符串无效 —— 见 resolve_ignore_list
        Ignore_List=ACTIVE_IGNORE or None,
    )
    elapsed = int((time.time() - started) * 1000)
    logger.info(f"查询「{command}」platform={platform} pid={platform_id} → {hikari.Status} ({elapsed}ms)")
    return package(hikari, command, elapsed, session_key)


# ── HTTP 服务（标准库，无额外依赖）────────────────────────────────────────────────
class Handler:
    def __init__(self):
        self.access_token = ARGS.access_token

    # —— 路由 ——
    async def __call__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            await self.handle(reader, writer)
        except Exception as exc:  # pragma: no cover
            logger.error(f"请求处理异常：{exc}\n{traceback.format_exc()}")
            await self.respond(writer, HTTPStatus.INTERNAL_SERVER_ERROR,
                               {"ok": False, "error": "internal-error", "hint": str(exc)[:300]})
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def handle(self, reader, writer):
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        method, path, _ = (lines[0].split(" ") + ["", "", ""])[:3]
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        length = int(headers.get("content-length") or 0)
        body = await reader.readexactly(length) if length else b""

        if self.access_token and headers.get("x-hikari-token") != self.access_token:
            await self.respond(writer, HTTPStatus.UNAUTHORIZED,
                               {"ok": False, "error": "unauthorized",
                                "hint": "访问口令不一致：请检查插件的『桥接服务口令』与启动参数的 --access-token"})
            return

        path_only = path.split("?")[0]
        if method == "GET" and path_only in ("/health", "/"):
            await self.respond(writer, HTTPStatus.OK, {
                "ok": True,
                "ready": CORE_ERROR is None,          # 依赖就绪（凭据是每请求决定的，见 token_configured）
                "version": CORE_VERSION,
                "core_error": CORE_ERROR,
                "pending": len(PENDING),
                "image_type": ARGS.image_type,
                "browser": ARGS.use_browser,
                # 凭据状态供插件侧把提示写准：bridge-arg=启动参数里有；none=还没有（等插件设置里填）
                "token_configured": bool(ACTIVE_TOKEN) or bool(str(ARGS.token or '').strip()),
                "token_source": ACTIVE_TOKEN_SOURCE or 'none',
                # 已禁用的功能（--ignore-list），方便确认"我禁的到底生效没有"
                "ignored_functions": [getattr(f, '__name__', str(f)) for f in ACTIVE_IGNORE],
            })
            return

        if method == "POST" and path_only == "/query":
            await self.query(body, writer)
            return

        await self.respond(writer, HTTPStatus.NOT_FOUND, {"ok": False, "error": "not-found", "hint": path_only})

    async def query(self, body: bytes, writer):
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except Exception as exc:
            await self.respond(writer, HTTPStatus.BAD_REQUEST,
                               {"ok": False, "error": "bad-json", "hint": f"请求体不是 JSON：{exc}"})
            return

        command = str(payload.get("command") or "").strip()
        platform = str(payload.get("platform") or "QQ")
        platform_id = str(payload.get("platform_id") or "").strip()
        bot_id = str(payload.get("bot_id") or "0")
        group_id = payload.get("group_id")
        select_index = payload.get("select_index")
        session_key = payload.get("session_key")
        config_overrides = payload.get("config") or {}

        if not platform_id:
            await self.respond(writer, HTTPStatus.BAD_REQUEST,
                               {"ok": False, "error": "missing-platform-id",
                                "hint": "缺少 platform_id（触发者 ID）：wws 的账号绑定按它查询，不能为空"})
            return
        if select_index is None and not command:
            await self.respond(writer, HTTPStatus.BAD_REQUEST,
                               {"ok": False, "error": "missing-command", "hint": "缺少 command"})
            return

        try:
            result = await call_hikari(
                command=command, platform=platform, platform_id=platform_id, bot_id=bot_id,
                group_id=group_id, select_index=select_index, session_key=session_key,
                config_overrides=config_overrides,
            )
        except Exception as exc:
            logger.error(f"查询失败：{exc}\n{traceback.format_exc()}")
            await self.respond(writer, HTTPStatus.OK, {
                "ok": False, "status": "error", "command": command,
                "text": f"桥接服务内部错误：{type(exc).__name__}: {exc}"[:500],
                "image_base64": None, "options": [], "elapsed_ms": 0,
            })
            return

        await self.respond(writer, HTTPStatus.OK, result)

    async def respond(self, writer, status, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        head = (
            f"HTTP/1.1 {int(status)} {HTTPStatus(int(status)).phrase}\r\n"
            f"Content-Type: application/json; charset=utf-8\r\n"
            f"Content-Length: {len(raw)}\r\n"
            f"Access-Control-Allow-Origin: *\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("latin-1")
        writer.write(head + raw)
        await writer.drain()


async def amain() -> int:
    global ACTIVE_IGNORE
    has_cli_token = bool(ARGS.token) and ARGS.token != DEFAULT_TOKEN_PLACEHOLDER
    if CORE_ERROR:
        logger.warning(f"hikari-core 未就绪（{CORE_ERROR}）：/health 会返回 ready=false，"
                       f"查询会直接报错。装完依赖后重启本服务。")
    else:
        try:
            ACTIVE_IGNORE = resolve_ignore_list(
                [x for x in str(ARGS.ignore_list or '').replace('，', ',').split(',') if x.strip()]
            )
            if has_cli_token:
                apply_config({})
            # 没有 --token 也**照常启动**：凭据可以之后在 QQ Agent 的插件设置里填
            # （请求里带 hikari_token，见 resolve_token）。启动就退出的设计对
            # "只用图形界面"的用户太不友好 —— 他们根本没机会填。
        except Exception as exc:
            logger.error(f"初始化 hikari-core 配置失败：{exc}")
            return 3

    server = await asyncio.start_server(Handler(), host=ARGS.host, port=ARGS.port)
    addrs = ", ".join(str(s.getsockname()) for s in server.sockets or [])
    logger.info(f"wows-helper 桥接服务已启动：http://{ARGS.host}:{ARGS.port} （{addrs}）")
    logger.info("请在 QQ Agent 的『插件 → 战舰世界助手』设置里确认：")
    logger.info("   · 桥接服务地址 = http://127.0.0.1:%d" % ARGS.port)
    if has_cli_token:
        logger.info("   · yuyuko API 凭据：已由启动参数提供（设置页留空即可）")
    else:
        logger.info("   · yuyuko API 凭据：**必填**（格式 账号ID:Token），或改用 --token / 环境变量 HIKARI_TOKEN")
    if ARGS.access_token:
        logger.info("   · 桥接服务口令：与启动参数 --access-token 保持一致")
    async with server:
        await server.serve_forever()
    return 0


def main() -> int:
    try:
        return asyncio.run(amain())
    except KeyboardInterrupt:
        logger.info("收到中断，桥接服务退出")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
