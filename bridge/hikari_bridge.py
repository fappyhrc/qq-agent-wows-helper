#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wows-helper · Hikari-core-v2 桥接服务。

把 Python 侧的 Hikari-core-v2（指令解析 → yuyuko API 查询 → 浏览器端模板渲染出图）
包装成一个仅监听本机的 JSON HTTP 服务，供 QQ Agent 的 wows-helper 插件调用。

设计动因
--------
Hikari-core-v2 是 Python SDK，且**渲染链路完全在浏览器里**：

* ``init_hikari(platform, PlatformId, BotId, command_text, GroupId, Ignore_List)``
  负责指令解析与数据获取；
* 模板由浏览器端 Nunjucks 渲染 —— Python 只组装外壳 HTML，再用 playwright 截图。

Node 侧既无法运行该 SDK，也没有等价的渲染能力，因此采用
「Node 薄客户端 + 本地常驻 Python 桥接」：Node 只负责 QQ 收发与确定性触发，
Python 只负责 wws 的解析与出图，两侧通过本模块的 JSON 接口通信。

对外接口
--------
仅两个端点，刻意不做更多（端点越少，鉴权与超时边界越清晰）：

``GET /health``
    探活与自检。响应字段：

    ====================  =======  ==================================================
    字段                  类型     说明
    ====================  =======  ==================================================
    ``ok``               bool    服务进程存活（恒为 true）
    ``ready``            bool    依赖是否就绪（hikari-core 可导入）；false 时看 core_error
    ``core_error``       str     导入失败原因，成功时为 null
    ``version``          str     hikari-core 版本号
    ``pending``          int     当前挂起的多选会话数
    ``token_configured`` bool    是否已持有可用凭据（启动参数或已下发过）
    ``token_source``     str     ``bridge-arg`` / ``plugin`` / ``none``
    ``ignored_functions`` list   ``--ignore-list`` 实际生效的函数名（空列表 = 未禁用任何功能）
    ====================  =======  ==================================================

``POST /query``
    执行一次查询或续查。请求体：

    .. code-block:: json

        {
          "command": "ship 大和 recent 30",  // wws 指令正文，**不含 wws 前缀**；续查时可为空
          "platform": "QQ",                  // QQ / QQ_CHANNEL / QQ_OFFICIAL
          "platform_id": "1000000001",       // 触发者 ID；wws 的账号绑定按此查询
          "bot_id": "0",
          "group_id": null,                  // 群聊传群号，私聊传 null
          "select_index": null,              // 续查：用户回复的序号（1 起）
          "session_key": null,               // 续查：上一轮的会话键
          "config": {                        // 可选，覆盖本次查询的运行时配置
            "image_type": "jpeg",
            "use_browser": "chromium",
            "hikari_token": "账号ID:Token"    // 插件设置页填的凭据，优先级最高
          }
        }

    响应体：

    .. code-block:: json

        {
          "ok": true,                        // status 为 success/wait 时为 true
          "status": "success",               // success | wait | failed | error
          "text": "文本结果或服务端提示",
          "data_type": "jpeg",               // 出图格式，或 str(type(Data))
          "image_base64": "...",             // 有图时才有
          "image_mime": "image/jpeg",
          "options": [{"name": "..."}],      // status=wait 时的待选项
          "elapsed_ms": 1234,
          "command": "ship 大和",
          "token_source": "plugin"           // 本次实际使用的凭据来源
        }

    HTTP 状态码语义：``400`` 请求体不合法（缺 platform_id / command），
    ``401`` 访问口令不匹配，``404`` 路径不存在，``500`` 未预期的内部异常。
    **业务失败一律走 200**，由 ``ok`` / ``status`` 表达 —— 这样调用方只需要
    解析一种成功结构，不必为每种业务失败分别写分支。

凭据解析优先级
--------------
1. 请求 ``config.hikari_token``（用户在 QQ Agent 设置页填写，随查询下发）；
2. 启动参数 ``--token`` / 环境变量 ``HIKARI_TOKEN``。

两处都没有时，``/query`` 会返回一条人类可读的指引，而不是让上游抛出"未授权"。

安全边界
--------
默认仅监听 ``127.0.0.1``；``--access-token`` 可再加一道口令（对应插件侧「桥接服务口令」）。
**不要暴露到公网**：本服务是无状态转发器，持有地址者即可消耗你的 yuyuko 配额。

典型启动方式::

    python bridge/hikari_bridge.py --token "账号ID:Token"
    python bridge/hikari_bridge.py                     # 凭据稍后在插件设置页填
    python bridge/hikari_bridge.py --help              # 全部参数
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
    """解析命令行参数（每项都有同名环境变量作为默认值，便于写进启动脚本）。

    参数解析刻意放在 **导入 hikari_core 之前**：后者的模块级代码会打印模板目录日志，
    先定好日志级别与格式，启动输出才干净。

    :param argv: 参数列表；``None`` 表示取 ``sys.argv[1:]``（便于测试注入）。
    :returns: ``argparse.Namespace``。
    """
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


# ── 依赖加载 ─────────────────────────────────────────────────────────────────
# 策略：导入失败**不让进程退出**，而是记录下来由 /health 的 ready/core_error 暴露。
# 理由：桥接常驻运行，用户装依赖往往是在它启动之后；直接崩掉只会得到一个
# "端口没人监听"的现象，排查成本远高于一句明确的报错。
try:
    from loguru import logger

    logger.remove()
    logger.add(sys.stdout, level=ARGS.log_level,
               format="<green>{time:HH:mm:ss}</green> | <level>{level: <7}</level> | {message}")
except Exception:  # pragma: no cover - loguru 随 hikari-core 一起安装，正常不会走到
    import logging

    logging.basicConfig(level=getattr(logging, ARGS.log_level, logging.INFO))
    logger = logging.getLogger("wows-bridge")

# 这些名字在依赖缺失时保持 None，由 call_hikari() 统一拦截并给出可照做的提示
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
except Exception as exc:  # pragma: no cover - 仅部署期会走到
    CORE_ERROR = f"{type(exc).__name__}: {exc}"
    logger.error(f"无法导入 hikari_core：{CORE_ERROR}")
    logger.error("安装方式：pip install --target .hikari-deps <Hikari-core-v2 源码目录>，"
                 "再执行 python -m playwright install chromium（或直接运行 start-bridge.ps1）")


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
    """把 ``--ignore-list`` 的名字列表解析成**函数对象**列表。

    上游 ``init_hikari`` 内部做的是 ``if hikari.Function in Ignore_List`` ——
    比较的是函数对象本身。实测传字符串 ``['get_BindInfo']`` **完全无效**
    （查询照常成功），只有 ``[get_BindInfo]`` 才会返回"该功能已被禁用"。
    这个差异没有任何报错可循，因此本函数会：

    * 从 ``hikari_core`` 顶层命名空间解析名字（其 ``__init__`` 显式再导出了这些函数）；
    * 对解析不到的名字**明确告警** —— 静默失败在此处的后果是"以为禁用了其实没禁"；
    * 去重并保持输入顺序。

    :param names: 函数名字符串序列，例如 ``['set_BindInfo', 'delete_BindInfo']``。
    :returns: 解析成功的函数对象列表；依赖缺失或无输入时返回空列表。
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
    """决定本次查询使用的 yuyuko 凭据，并返回 ``(凭据, 来源)``。

    优先级（顺序即设计意图）：

    1. ``overrides['hikari_token']`` → ``'plugin'``
       用户在 QQ Agent 设置页填写、随每次查询下发。这是**主通路**：
       它让不敲命令行、不配环境变量的用户也能把插件配好。
    2. 启动参数 ``--token`` / 环境变量 ``HIKARI_TOKEN`` → ``'bridge-arg'``
       面向无人值守部署。

    :param overrides: ``/query`` 请求里的 ``config`` 字典，可为 ``None``。
    :returns: ``(token, source)``；两处都没有凭据时返回 ``('', '')``，
        由调用方（``call_hikari``）负责给出可照做的提示。

    .. note::
       返回值必须是**元组**而非单纯的 token 字符串：调用方需要把"来源"原样回给插件，
       以便界面能显示"当前凭据来自哪"。注意不要写成 ``if not resolve_token(...)`` ——
       元组恒为真，必须取 ``[0]`` 判断（这个坑在重构时踩过一次）。
    """
    token = str((overrides or {}).get("hikari_token") or "").strip()
    if token:
        return token, 'plugin'
    cli = str(ARGS.token or "").strip()
    if cli and cli != DEFAULT_TOKEN_PLACEHOLDER:
        return cli, 'bridge-arg'
    return '', ''


def apply_config(overrides: dict | None = None) -> None:
    """把运行时配置交给 Hikari-core。

    **每次查询前都会调用**（幂等，开销可忽略），因此插件侧改了出图格式、浏览器、
    代理或凭据之后，无需重启桥接服务，下一次查询即生效。

    实现上有三处必须保留的自保逻辑：

    1. 空值不覆盖：``None`` / ``""`` 一律视为"本次不改这一项"，回落到启动参数的值；
    2. 参数名同义映射：上游把浏览器参数拼成了 ``use_broswer``（少一个 w），
       直接用正确的 ``use_browser`` 会被签名过滤**静默丢弃**，
       表现为"设置里选了 firefox 却一直用 chromium"；
    3. 未知键过滤：按 ``set_hikari_config`` 的真实签名裁剪，避免上游改签名后抛 TypeError。

    :param overrides: ``/query`` 请求里的 ``config`` 字典。
    :side effect: 更新模块级 ``ACTIVE_TOKEN`` / ``ACTIVE_TOKEN_SOURCE``，
        并（首次调用时）打印一条配置摘要。
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
    """三态布尔转换：``None`` 表示"本次不覆盖这一项"，其余按字符串语义转成真布尔。

    之所以需要三态而不是普通 bool：``apply_config`` 要把"调用方没给这个设置"
    与"调用方明确要求关闭"区分开 —— 前者应回落到启动参数/默认值，后者必须真的生效。

    :param value: ``None`` / ``bool`` / 字符串（``"0"``、``"false"``、``"no"``、``"off"``、``""`` 均视为假）。
    :returns: ``None`` 或 ``bool``。
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in ("0", "false", "no", "off", "")


# ── 多选（wait）会话 ──────────────────────────────────────────────────────────
# 上游在"重名舰船 / 多绑定"这类场景会返回 status=wait，要求调用方带一个序号回调。
# 回调需要**原始 Hikari_Model 对象**（里面保存着解析结果与候选列表），因此这里
# 按会话键挂起对象。生命周期由 TTL + 条数上限双重约束，避免常驻进程内存增长。
PENDING: dict[str, dict] = {}


def pending_put(key: str, hikari) -> None:
    """挂起一个待用户选择的会话，并顺带做 TTL 清理与容量裁剪。

    :param key: 会话键（插件侧构造为 ``<chatKey>#<platformId>``）。
    :param hikari: 处于 ``wait`` 状态的 ``Hikari_Model``。
    :side effect: 就地增删 ``PENDING``。清理策略为"先按 TTL 过期，再按最旧淘汰"，
        两步都是 O(n) 且 n 很小（默认上限 32）。
    """
    now = time.time()
    for k in [k for k, v in PENDING.items() if now - v["at"] > ARGS.pending_ttl]:
        PENDING.pop(k, None)
    PENDING[key] = {"at": now, "hikari": hikari}
    while len(PENDING) > max(1, ARGS.max_pending):
        oldest = min(PENDING.items(), key=lambda kv: kv[1]["at"])[0]
        PENDING.pop(oldest, None)


def extract_options(data) -> list:
    """把 Hikari 的 ``Input.Select_Data`` 归一化为 ``[{"name": str}, ...]``。

    上游的待选项结构随指令而异（可能是 dict 也可能是裸字符串，键名有
    ``name`` / ``Name`` / ``text`` / ``shipName`` 等多种写法），这里统一成
    插件侧唯一认得的形状，并在 80 字符处截断、最多保留 12 条 —— 待选项是
    给人在群里看的，过长会刷屏。

    :param data: ``Select_Data``，期望为 list/tuple；其它类型一律视为"没有选项"。
    :returns: 归一化后的列表；解析失败返回 ``[]``（插件侧据此退化为提示文案）。
    """
    out = []
    if not isinstance(data, (list, tuple)):
        return out
    for item in data[:12]:
        if isinstance(item, dict):
            name = item.get("name") or item.get("Name") or item.get("text") or item.get("shipName")
            if name is None:
                # 兜底：取第一个非空字符串值（上游字段名不固定时仍能给用户看的东西）
                for v in item.values():
                    if isinstance(v, str) and v.strip():
                        name = v
                        break
            out.append({"name": str(name if name is not None else item)[:80]})
        else:
            out.append({"name": str(item)[:80]})
    return out


def package(hikari, command: str, elapsed_ms: int, session_key: str | None = None) -> dict:
    """把 ``Hikari_Model`` 转换成本服务的响应体（见模块 docstring 的字段表）。

    三类 ``Output.Data`` 分别处理：

    * ``bytes``/``bytearray`` → base64 放进 ``image_base64``，并按魔数/类型猜 mime；
    * ``str`` → 原样放进 ``text``（Hikari 的失败提示、帮助页纯文本走这条）；
    * 其它（dict/list）→ 序列化成 JSON 文本，便于关闭 ``auto_image`` 时排查。

    :param hikari: ``Hikari_Model`` 实例。
    :param command: 本次指令正文（用于回显与日志）。
    :param elapsed_ms: 本次查询耗时，毫秒。
    :param session_key: 多选会话键；``status == 'wait'`` 时用它把 hikari 对象挂起。
    :returns: 可直接 JSON 序列化的响应字典。
    :side effect: 当 ``status == 'wait'`` 且给了 ``session_key`` 时，把 hikari 对象
        存入 ``PENDING``（供用户回复序号后 ``callback_hikari`` 续查）。
    """
    status = str(getattr(hikari, "Status", "error") or "error")
    out = getattr(hikari, "Output", None)
    data = getattr(out, "Data", None)
    # Data_Type 可能是 str(type(x)) 这类类描述而非 mime，因此下面只在该形状可信时才用
    raw_type = getattr(out, "Data_Type", "") or ""
    data_type = raw_type if isinstance(raw_type, str) else str(raw_type)
    resp = {
        "ok": status in ("success", "wait"),
        "status": status,
        # command 未必是 str（上游/调用方给过非字符串），统一成可 JSON 序列化的形式
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
        except Exception as exc:  # pragma: no cover - 仅内存/编码异常
            # 编码失败也不要把响应打成 500：调用方需要的是"一句话说明"，
            # 而不是"桥接服务内部错误"这种无从下手的信息。
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
        # dict / list：未渲染成图时（auto_image 关闭）转 JSON 便于排查。
        # default=str 兜底：数据里可能混入 datetime 等不可序列化对象。
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
    """执行一次查询或续查，返回已打包好的响应体。

    两条路径由入参决定：

    * ``select_index`` 有值且 ``PENDING`` 里存在对应会话 → 续查
      （把序号写回挂起的 ``Hikari_Model``，再走 ``callback_hikari``）；
    * 否则 → 新查询（``init_hikari``）。

    :param command: 指令正文（不含 ``wws`` 前缀）。续查时可为空。
    :param platform: ``QQ`` / ``QQ_CHANNEL`` / ``QQ_OFFICIAL`` 等平台标识。
    :param platform_id: 触发者 ID。wws 的账号绑定按此查询，传错人会查到别人的水表。
    :param bot_id: 机器人自身标识（``init_hikari`` 的必填参数之一）。
    :param group_id: 群号；``None``/``""`` 表示私聊。
    :param select_index: 用户回复的序号（1 起）；``None`` 表示新查询。
    :param session_key: 多选会话键；用于挂起与查找 ``PENDING``。
    :param config_overrides: 请求里的 ``config``，逐项覆盖运行时配置。
    :raises RuntimeError: 依赖未就绪，或两处都没有配置凭据（消息均为可照做的中文指引）。
    :raises ValueError: 既没有挂起的会话，又没有给出指令。
    """
    if init_hikari is None:
        raise RuntimeError(f"hikari-core 未就绪：{CORE_ERROR or '未安装'}")
    # ⚠️ resolve_token 返回 (凭据, 来源) 元组，元组恒为真值，必须取 [0] 判断 ——
    #    直接写 `if not resolve_token(...)` 会让"没配凭据"这条分支永远不触发。
    if not resolve_token(config_overrides)[0]:
        # 两处都没配：与其让上游回一句"未授权"，不如直接告诉用户去插件设置里填
        raise RuntimeError("没有配置 yuyuko API 凭据：请在 QQ Agent 的插件设置里填「yuyuko API 凭据」，"
                           "或用 --token/环境变量 HIKARI_TOKEN 启动桥接服务")

    apply_config(config_overrides)
    started = time.time()

    pend = PENDING.get(session_key) if (select_index is not None and session_key) else None
    if pend is not None:
        hikari = pend["hikari"]
        hikari.Input.Select_Index = int(select_index)
        hikari = await callback_hikari(hikari)
        PENDING.pop(session_key, None)
        elapsed = int((time.time() - started) * 1000)
        logger.info(f"续查 select={select_index} → {hikari.Status} ({elapsed}ms)")
        return package(hikari, command or f"select:{select_index}", elapsed, session_key)

    if not str(command or "").strip():
        raise ValueError("续查失败：没有挂起的会话，且没有给出指令")

    # 同一会话又发起新查询：丢弃上一次挂起的多选会话。
    # 否则它会一直占着内存，且用户随后回一个序号会被接到早已过期的上下文上。
    if session_key:
        PENDING.pop(session_key, None)

    hikari = await init_hikari(
        platform=platform,
        PlatformId=str(platform_id),
        BotId=str(bot_id),
        command_text=str(command),
        GroupId=(str(group_id) if group_id not in (None, "") else None),
        # 禁用清单（可选）。必须传**函数对象**，传字符串无效 —— 见 resolve_ignore_list
        Ignore_List=ACTIVE_IGNORE or None,
    )
    elapsed = int((time.time() - started) * 1000)
    logger.info(f"查询「{command}」platform={platform} pid={platform_id} → {hikari.Status} ({elapsed}ms)")
    return package(hikari, command, elapsed, session_key)


# ── HTTP 服务（标准库 asyncio，不引入 Web 框架）────────────────────────────────────
class Handler:
    """极简 HTTP 处理器：一行请求头 + 可选 JSON 体，响应后立即关闭连接。

    刻意用标准库而非 aiohttp/FastAPI：本服务只有一个常驻进程、两个端点，
    额外的框架依赖会让 `start-bridge.ps1` 的安装步骤更脆弱（版本冲突、
    需要编译等），而这里真正需要的能力只有"读一行请求、回一段 JSON"。
    """

    def __init__(self):
        self.access_token = ARGS.access_token

    # ── 入口与兜底 ──
    async def __call__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        """asyncio 服务器回调：处理一个连接，并保证连接一定被关闭。

        未预期的异常在这里被收敛成 500 + 一句说明，绝不让异常冒到事件循环
        （那会打印一大段 traceback 并可能带走整个服务）。
        """
        try:
            await self.handle(reader, writer)
        except Exception as exc:  # pragma: no cover - 仅未预期路径
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
        """解析请求行与请求头，按路径分发；未知路径返回 404。

        认证在此处集中处理：配置了 ``--access-token`` 时，所有端点（含 ``/health``）
        都要求 ``X-Hikari-Token`` 匹配。把口令检查放在路由**之前**是有意的 ——
        避免日后新增端点时忘记加鉴权。
        """
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
                # ready 只表示依赖就绪；凭据是每请求决定的，另有 token_configured 字段
                "ready": CORE_ERROR is None,
                "version": CORE_VERSION,
                "core_error": CORE_ERROR,
                "pending": len(PENDING),
                "image_type": ARGS.image_type,
                "browser": ARGS.use_browser,
                # 凭据状态：让插件把提示写准（bridge-arg=启动参数里有；none=等插件设置里填）
                "token_configured": bool(ACTIVE_TOKEN) or bool(str(ARGS.token or '').strip()),
                "token_source": ACTIVE_TOKEN_SOURCE or 'none',
                # 已生效的禁用清单：用于确认"我禁的到底生效没有"
                "ignored_functions": [getattr(f, '__name__', str(f)) for f in ACTIVE_IGNORE],
            })
            return

        if method == "POST" and path_only == "/query":
            await self.query(body, writer)
            return

        await self.respond(writer, HTTPStatus.NOT_FOUND, {"ok": False, "error": "not-found", "hint": path_only})

    async def query(self, body: bytes, writer):
        """处理 ``POST /query``：解析请求体 → 校验必填项 → 调 ``call_hikari`` → 回包。

        业务失败（Hikari 返回 failed/error）走 **HTTP 200**，由响应体的
        ``ok``/``status`` 表达；只有"请求本身不合法"（400）与"内部异常"（500）
        才用非 2xx。这样调用方只需解析一种成功结构。
        """
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

        # 校验只做"无法继续"的两项，其余交给 Hikari 自己判断（它更清楚各指令需要什么）：
        # platform_id 缺失会让绑定查询指向错误的人；command 为空且非续查则无事可做。
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
            # 统一转成 200 + status=error：异常文案（如"没有配置 yuyuko API 凭据…"）
            # 是给最终用户看的，必须能被插件原样读出并展示。
            logger.error(f"查询失败：{exc}\n{traceback.format_exc()}")
            await self.respond(writer, HTTPStatus.OK, {
                "ok": False, "status": "error", "command": command,
                "text": f"桥接服务内部错误：{type(exc).__name__}: {exc}"[:500],
                "image_base64": None, "options": [], "elapsed_ms": 0,
            })
            return

        await self.respond(writer, HTTPStatus.OK, result)

    async def respond(self, writer, status, obj):
        """回一个 ``application/json; charset=utf-8`` 响应并关闭连接。

        ``Connection: close`` 是有意的：本服务的客户端是单机插件，请求频率极低，
        用短连接换掉 keep-alive 的状态管理更省心（也不必处理半关闭与超时）。
        """
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
    """启动流程：解析禁用清单 → 尝试初始化配置 → 常驻监听。

    **没有 ``--token`` 也照常启动**：凭据可以稍后在 QQ Agent 的设置页里填
    （随每次查询下发，见 :func:`resolve_token`）。早期版本"缺凭据就退出"，
    结果只用图形界面的用户根本没有机会填写 —— 这是一个必须避免的设计。

    :returns: 进程退出码。``3`` 表示 hikari-core 配置失败（依赖装了一半等情况）。
    """
    global ACTIVE_IGNORE
    has_cli_token = bool(ARGS.token) and ARGS.token != DEFAULT_TOKEN_PLACEHOLDER
    if CORE_ERROR:
        logger.warning(f"hikari-core 未就绪（{CORE_ERROR}）：/health 会返回 ready=false，"
                       f"查询会直接报错。装完依赖后重启本服务。")
    else:
        try:
            # 中英文逗号都接受：用户从 README 复制时容易带全角
            ACTIVE_IGNORE = resolve_ignore_list(
                [x for x in str(ARGS.ignore_list or '').replace('，', ',').split(',') if x.strip()]
            )
            if has_cli_token:
                apply_config({})
        except Exception as exc:
            logger.error(f"初始化 hikari-core 配置失败：{exc}")
            return 3

    server = await asyncio.start_server(Handler(), host=ARGS.host, port=ARGS.port)
    addrs = ", ".join(str(s.getsockname()) for s in server.sockets or [])
    logger.info(f"wows-helper 桥接服务已启动：http://{ARGS.host}:{ARGS.port} （{addrs}）")
    # 启动横幅直接把"插件侧还要配什么"讲清楚：这是首次部署最常见的卡点
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
