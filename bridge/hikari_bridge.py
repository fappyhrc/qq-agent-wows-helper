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
import inspect
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
    p.add_argument("--render-retry", type=int, default=int(os.environ.get("WOWS_HELPER_RENDER_RETRY", "1")),
                   help="渲染失败（多为瞬时的网络/超时）自动重试次数，默认 1，设 0 关闭")
    p.add_argument("--render-retry-delay-ms", type=int, default=int(os.environ.get("WOWS_HELPER_RENDER_RETRY_DELAY_MS", "1200")),
                   help="重试前等待毫秒数，默认 1200（给网络与浏览器一点恢复时间）")
    p.add_argument("--log-level", default=os.environ.get("WOWS_HELPER_LOG_LEVEL", "INFO"),
                   choices=["DEBUG", "INFO", "WARNING", "ERROR"], help="日志级别，默认 INFO")
    return p.parse_args(argv)


ARGS = parse_args()


# ── 依赖加载 ─────────────────────────────────────────────────────────────────
# 策略：导入失败**不让进程退出**，而是记录下来由 /health 的 ready/core_error 暴露。
# 理由：桥接常驻运行，用户装依赖往往是在它启动之后；直接崩掉只会得到一个
# "端口没人监听"的现象，排查成本远高于一句明确的报错。

# 模板同步期间的 ERROR 抑制开关，配合 _error_suppressor 使用。
# 必须定义在下面的 logger 初始化**之前**：初始化时要把它挂成 sink 的 filter。
_suppress_errors = False


def _error_suppressor(record) -> bool:
    """loguru 过滤器：抑制窗口内丢掉 ERROR 级记录。

    刻意只丢 ERROR：WARNING 及以下（如上游的"模板清单里有可疑的键"）保留，
    它们不影响"瞬时故障还是确定性故障"的判断。
    """
    return not (_suppress_errors and record['level'].no >= 40)


try:
    from loguru import logger

    _IS_LOGURU = True
    logger.remove()
    # 给唯一的输出 sink 挂上 ERROR 抑制器：模板同步那一段需要"先拦下、再决定是否重放"。
    # ⚠️ 之所以挂在已有 sink 上而不是"临时再加一个 sink"：loguru 的 sink **不可重入**，
    #    在 sink 里调 logger.remove() 会抛 RuntimeError（且原始 ERROR 照样会泄漏到别的 sink），
    #    详见 _collect_loguru_messages。
    logger.add(sys.stdout, level=ARGS.log_level,
               format="<green>{time:HH:mm:ss}</green> | <level>{level: <7}</level> | {message}",
               filter=_error_suppressor)
except Exception:  # pragma: no cover - loguru 随 hikari-core 一起安装，正常不会走到
    import logging

    _IS_LOGURU = False
    logging.basicConfig(level=getattr(logging, ARGS.log_level, logging.INFO))
    logger = logging.getLogger("wows-bridge")

# 这些名字在依赖缺失时保持 None，由 call_hikari() 统一拦截并给出可照做的提示
CORE_ERROR = None
Hikari_Model = None
callback_hikari = None
init_hikari = None
set_hikari_config = None
# 上游 set_hikari_config 的原始引用，供 guarded_set_hikari_config 转发（见该函数）
_set_hikari_config_impl = None
CORE_VERSION = ""


def guarded_set_hikari_config(**kwargs):
    """``set_hikari_config`` 的包装版：先接管模板清单同步，再转发给上游实现。

    为什么必须包在**调用点**、而不只是包 ``hikari_core`` 里那个名字：上游自己会在
    ``set_hikari_config`` **内部**（``core/config.py`` 第 123-124 行，仅在 ``_initial_scheduler``
    为真时）再调一次 ``update_template()``。那次调用发生在我们的抑制窗口之外，会把一模一样的
    ConnectTimeout traceback 原样打进启动日志 —— 实测确认过（表现为"WARNING 之后又跟一段
    ERROR traceback"）。

    :func:`sync_templates_quietly` 自身幂等：**第一次**调用时它真正做网络检查，
    之后只是空转；而后续任何同步请求（含上游自己那次、以及 4 点/12 点的定时任务）
    都由 :func:`install_template_sync_guard` 装上的替身接管，走同一套判定。

    ⚠️ 本函数必须定义在下面的 `from hikari_core import ...` **之前**：那个 try 块在成功分支里
    就把模块级 ``set_hikari_config`` 换成本函数，定义晚了会 NameError（实测踩到）。

    :param kwargs: 原样转发给上游的配置项。
    """
    # ⚠️ 必须在调用上游之前重新读模块级名字：测试会替换 `set_hikari_config`，
    #    若用定义时的旧引用就会"包自己"或绕过替换。
    original = globals().get('set_hikari_config')
    if original is guarded_set_hikari_config:
        original = _set_hikari_config_impl
    if original is None:                       # 依赖缺失：交给调用方按 CORE_ERROR 处理
        return None
    # 只在真正传了配置时接管；启动期零参数的 apply_config({}) 不需要。
    if kwargs:
        sync_templates_quietly()
    return original(**kwargs)


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
    CORE_VERSION = str(_core_version)
    # 把上游实现存起来，再把模块级名字换成"带模板同步自保层"的包装版。
    # ⚠️ 必须一起换：apply_config 调的是模块级 set_hikari_config；只包 hikari_core 那边的话，
    #    上游在 set_hikari_config 内部那次 update_template() 仍会在抑制窗口之外打出堆栈 ——
    #    这正是本机用死代理实测到的"WARNING 之后又跟一段 ERROR traceback"。
    _set_hikari_config_impl = _set_hikari_config
    set_hikari_config = guarded_set_hikari_config
    # ⚠️ 必须把上游签名映射到包装函数上。apply_config 会用
    #    `inspect.signature(set_hikari_config)` 裁剪参数，包装函数若是光秃秃的
    #    `(**kwargs)`，裁剪结果只剩 `{'kwargs'}`，**所有配置项会被静默丢掉** ——
    #    表现为"选 firefox 却用 chromium、image_type 也不生效"。
    #    这两个属性也是标准做法（等价于 functools.wraps 的效果）。
    guarded_set_hikari_config.__signature__ = inspect.signature(_set_hikari_config)
    guarded_set_hikari_config.__wrapped__ = _set_hikari_config
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


# ── 模板清单同步的自保层（见 sync_templates_quietly / template_failure_is_transient）──
# 模板目录 = `.hikari-deps/hikari_core/Template`，随 hikari-core 一起安装。
# 背景：上游 `core/config.py` 第 123-124 行在**首次** `set_hikari_config` 时直接调
# `update_template()`；该函数把"检查更新时握手超时"这种无关痛痒的失败也用
# `logger.error(traceback.format_exc())` 汇报，于是启动日志里出现一大段像崩溃的堆栈。
# 实测（本机）：渲染用的模板早就装好了，模板清单（OSS）连不上时渲染照常出图。
TEMPLATE_SYNC_ATTEMPTS = 2               # 首次 + 重试 1 次
TEMPLATE_SYNC_RETRY_DELAY_S = 2.0        # 重试前等待：给 TLS 握手/网络一点恢复时间
# 每个进程只需检查一次：上游的模板同步只在 `_initial_scheduler` 为真时发生一次，
# 而它是否已经跑过是模块私有状态。这里用乐观标志避免「每次查询都白等一次网络超时」。
_template_sync = {'done': False, 'checked': False}

# 渲染等待兜底（见 install_render_goto_guard）
_render_goto = {'installed': False, 'original': None, 'relaxed': 0}

# 瞬时故障的特征串：出现在截获到的日志文本里即认为"重试有意义"。
# 只覆盖网络/TLS 一类，**故意不含文件写入与解析类异常**（见 template_failure_is_transient）。
# ⚠️ 三种"超时"写法都要列：Python 内建 `TimeoutError`、httpx 的 `TimeoutException`、
#    httpcore 文案 `Read timed out.` —— 漏掉任一都会把可重试的故障误判成确定性故障。
# 中文两条（`请求超时了…` / `链接池异常…`）来自上游 core/http_error_handler.py 的
# Timeout / PoolTimeout 分支文案。
_TRANSIENT_MARKERS = (
    'ConnectError', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout',
    'PoolTimeout', 'TimeoutError', 'TimeoutException', 'RemoteProtocolError',
    'ProxyError', 'handshake operation timed out', 'timed out',
    'Connection reset', '超时', '链接池异常',
)


def template_failure_is_transient(messages) -> bool:
    """判断一批日志里有没有"瞬时网络故障"特征（宽判定，主要给测试与人工排查用）。

    ⚠️ 真正决定"重试/降级"的是另外两个更精确的判定，别用本函数下判断：
    重试看 :func:`is_retryable_manifest_failure`，降级看 :func:`record_is_benign_transport_failure`。

    :param messages: 截获到的日志正文序列。
    :returns: 命中任一瞬时特征返回 ``True``。
    """
    for text in messages or ():
        # 大小写不敏感：不同库打出来的是 `Read timed out.` / `ReadTimeout` 两种写法。
        low = str(text).lower()
        for marker in _TRANSIENT_MARKERS:
            if marker.lower() in low:
                return True
    return False


# 传输层故障的特征串：命中即认为这条 ERROR **不值得**把堆栈给用户看。
# 比 _TRANSIENT_MARKERS 窄 —— 这里只看网络/连接类，不含 `超时`、`链接池异常` 这类
# 也可能是"服务器真有问题"的措辞。漏判的代价只是"多留一段堆栈"，不是错误降级。
_TRANSPORT_MARKERS = (
    'ConnectError', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout',
    'RemoteProtocolError', 'ProxyError', 'handshake operation timed out',
    'timed out', 'Connection reset',
)


def record_is_benign_transport_failure(text) -> bool:
    """判断一条 ERROR 日志是否只是"拉取模板清单时连不上网"这类**无害**故障。

    命中时自保层会把整段 traceback 换成一行 WARNING —— 本地模板已经装好，渲染不受影响。
    实测：本机用不监听的代理启动桥接，这里判定成立，启动日志里再没有出现模板相关堆栈。

    刻意比 :func:`template_failure_is_transient` 更严格：**必须同时**满足
    "含 Traceback 字样" 且 "带网络类异常类型"。这样才能把两种失败分开：

    * 拉清单失败 → 一条 ``traceback.format_exc()``（带 ConnectTimeout 等类型名）→ 无害；
    * 单个模板文件下载失败 → ``模板 x 更新失败: <异常>``（**没有** Traceback 字样）→ 保留 ERROR，
      因为"某个模板文件取不到"是值得知道的真问题。

    :param text: 单条日志正文。
    """
    body = str(text or '')
    if 'Traceback' not in body:
        return False
    low = body.lower()
    return any(m.lower() in low for m in _TRANSPORT_MARKERS)


def is_retryable_manifest_failure(records) -> bool:
    """判断这次失败是否值得重试：**清单拉取**失败，而不是个别模板文件下载失败。

    依据：上游唯一写出 ``traceback.format_exc()`` 的地方就是 ``update_template`` 最外层
    那个 try/except —— 正是拉清单那一步；个别文件失败走的是每文件一条
    ``logger.error(f'模板 …')``，重试同一个坏文件没有意义。

    :param records: 截获到的日志正文序列。
    """
    return any('Traceback' in str(t) for t in records or ())


def _collect_loguru_messages(fn):
    """执行 ``fn`` 并截获它在 ERROR 级写出的日志，返回 ``(fn 的返回值, 截获到的文本列表)``。

    实现要点（踩过坑，勿改）：

    * 必须用 loguru 的 ``filter`` 做**抑制**，不能用"临时挂一个 sink 再去 remove"那套：
      loguru 的 sink 不可重入 —— 在 sink 里调 :func:`logger.remove` 会抛
      ``RuntimeError: Could not acquire internal lock ...``（而且它只会打印一条
      "Logging error in Loguru Handler" 到 stderr，原始 ERROR 依旧会正常落到别的 sink）。
      最初就是这么做，结果"降级"完全没生效。
    * 过滤开关 ``_suppress_errors`` 是模块级布尔值，且整个函数体**没有 await**，
      因此不存在"异步 sink 稍后看到已复位开关"的竞态。
    * 只拦 ERROR：清单为空、磁盘错误等确定性故障需要能被上层原样重放。

    :param fn: 无参可调用对象（即上游的 ``update_template``）。
    """
    global _suppress_errors
    records: list = []
    # 注意 loguru 的 sink 只接受**一个**参数（0.7.3 实测：两参 lambda 会让 handler 报
    # "Logging error in Loguru Handler"，且 `ref=0` 不存在于 add() 签名里）。
    # 好消息是上游全部用 ``logger.error(<字符串>)`` 而非 ``logger.exception``，
    # 因此 ``record['exception']`` 恒为 None，完整 traceback 本来就在 message 里，不会丢。
    sink_id = logger.add(lambda msg: records.append(str(msg)), level='ERROR', format='{message}')
    _suppress_errors = True
    try:
        result = fn()
    except Exception:                                            # noqa: BLE001
        # 极端情况：连上游函数本身都抛了。返回 False 并把 traceback 交给调用方判定。
        result, records = False, [traceback.format_exc()]
    finally:
        _suppress_errors = False
        try:
            logger.remove(sink_id)
        except Exception:                                        # noqa: BLE001
            pass
    return result, records


def sync_templates_once() -> tuple[bool, list, bool]:
    """调用一次上游的 ``update_template``，并把它的日志截获下来。

    为什么要截获：上游用 ``logger.error`` + 完整 traceback 汇报这次失败，哪怕只是
    "检查更新时握手超时"。启动日志里因此会出现一大段看起来像崩溃的堆栈。

    :returns: ``(是否成功, 截获到的日志文本列表, 本次是否真的执行了同步)``。
        第三项为 ``False`` 表示上游已经把模板同步做过了（私有状态 ``_initial_scheduler``
        是否已消费无法从外部读取，只能靠调用点保证顺序），此时前两项无意义。

    :note: loguru 不可用时（理论上不会发生）退化为"直接调用 + 用标准库 logging 截获"。
    """
    if _IS_LOGURU:
        result, records = _collect_loguru_messages(_template_sync_callable())
        return bool(result), records, True

    # 退化路径：标准库 logging（loguru 随 hikari-core 一起装，正常不会走到）
    import logging

    records = []

    class _Collect(logging.Handler):
        def emit(self, record):                                  # noqa: D102
            records.append(record.getMessage())

    handler = _Collect(level=logging.ERROR)
    logger.addHandler(handler)
    try:
        return bool(_template_sync_callable()()), records, True
    except Exception:                                            # noqa: BLE001
        return False, [traceback.format_exc()], True
    finally:
        logger.removeHandler(handler)


def _template_sync_callable():
    """取出 ``hikari_core.features.system.update_template``。

    上游是在 ``set_hikari_config`` **函数体内** ``from ...features.system import update_template``，
    每次调用都重新取模块属性，所以替换模块属性即可生效 —— 这是在不改动 ``.hikari-deps``
    里第三方源码（重装即被覆盖）的前提下挂自保层的唯一稳妥办法。

    这里**只在第一次**把原函数记到 ``_template_sync`` 上：之后无论谁替换了模块属性，
    都仍然调用最初的那个真实实现。若不做这层缓存，未来一旦真的包了 wrapper，
    就会"包自己"形成无限递归。

    :returns: 可调用的同步函数；拿不到上游函数时返回恒返回 ``True`` 的占位（视为"无事发生"）。
    """
    # 整段都要防御式：上游若改了模块布局（或测试里用的是残缺假包），这里失败不应该
    # 让 set_hikari_config 的调用方炸掉 —— 模板同步只是锦上添花。
    try:
        import hikari_core.features.system as _system
    except Exception as exc:                                     # noqa: BLE001
        if not _template_sync.get('warned'):
            _template_sync['warned'] = True
            logger.debug(f'取不到 hikari_core.features.system（{type(exc).__name__}: {exc}），'
                         f'跳过模板清单同步的日志降级')
        return lambda: True

    if 'original' not in _template_sync:
        original = getattr(_system, 'update_template', None)
        if original is None:
            return lambda: True
        _template_sync['original'] = original
    return _template_sync['original']


def install_template_sync_guard() -> bool:
    """把 ``hikari_core.features.system.update_template`` 换成自保版（只做一次）。

    为什么非包不可：上游 ``set_hikari_config`` 内部会**自己**再调一次 ``update_template()``
    （``core/config.py`` 第 124 行）。我们的模块级包装只保证"调用 set_hikari_config 之前"
    先同步过一次，而 :func:`sync_templates_quietly` 是幂等的 —— 上游那次调用会因此跑到
    抑制窗口之外，把一模一样的 ConnectTimeout traceback 原样打进启动日志。
    本机实测确认了这个顺序：先一行 WARNING，20 秒后又跟一段 ERROR traceback。

    包好之后，上游那次调用变成"静默同步 + 结果按同一套策略处理"：
    传输层故障 → 一行 WARNING；确定性故障 → 原样重放 ERROR。重复调用直接短路。

    :returns: 安装成功（或已安装）返回 ``True``。
    """
    if _template_sync.get('guard_installed'):
        return True
    try:
        import hikari_core.features.system as _system
    except Exception:                                            # noqa: BLE001
        return False
    original = getattr(_system, 'update_template', None)
    if original is None:
        return False
    # ⚠️ 顺序不能反：必须在替换之前先把"真正的上游实现"缓存下来。
    #    否则 _template_sync_callable 缓存到的会是下面那个包装版，形成自己调自己 ——
    #    表现为"场景函数一次都没被执行、什么日志都没有"（实测踩过）。
    _template_sync['original'] = original

    def guarded_update_template():
        """upstream.update_template 的自保替身：不抛异常，日志按策略降级。"""
        if _template_sync.get('done'):
            return True                        # 启动期已经同步过，别重复打网络请求
        _template_sync['done'] = True
        ok, messages, _ran = sync_templates_once()
        if not ok:
            report_template_sync_failure(messages)
        return ok

    try:
        _system.update_template = guarded_update_template
    except Exception:                                            # noqa: BLE001
        return False
    # 让定时任务（core/config.py 的 cron）也走到自保层；它按名字取模块属性，所以能生效。
    _template_sync['guard_installed'] = True
    return True


def sync_templates_quietly() -> None:
    """在 hikari-core 首次配置**之前**调用，接管本次模板清单同步。

    上游默认行为（``core/config.py`` 第 123-124 行）是直接 ``update_template()``：
    一次网络抖动就会在启动横幅前打出整段 traceback，并让人误以为服务坏了。

    本函数把这一段换成：

    1. 先同步一次；失败且是**清单拉取**失败 → 等 :data:`TEMPLATE_SYNC_RETRY_DELAY_S` 秒重试；
    2. 若失败原因只是"连不上网"（:func:`record_is_benign_transport_failure`），
       无论重试几次，最终**只留一行 WARNING**，说明"继续用本地模板"；
    3. 其余确定性故障（清单为空、磁盘错误、个别文件取不到）→ 原样把 ERROR 重放，绝不吞掉。

    ⚠️ "可重试"与"可降级"是**两个独立判定**，不能合一：完全断网的机器上重试必然也失败，
    若把二者混在一起，第二次失败又会把整段 traceback 打回来 —— 这正是本机用死代理
    实测发现的。

    全程**不抛异常**：模板同步只是锦上添花，绝不能因为它让桥接起不来。
    同步成功时不产生任何额外输出（避免每次配置都刷日志）。

    :side effect: 置位 :data:`_template_sync` 的 ``done``，保证每个进程只检查一次。
    """
    if _template_sync.get('done'):
        return
    # 先占位再执行：即使下面出意外也不至于每次查询都重跑一遍（那会白等一次网络超时）。
    _template_sync['done'] = True
    # 顺带把上游自己那次调用也接管掉（否则它会在抑制窗口之外打堆栈）。
    install_template_sync_guard()

    ok, messages, ran = sync_templates_once()
    if ok or not ran:
        return
    for _ in range(max(0, TEMPLATE_SYNC_ATTEMPTS - 1)):
        if not is_retryable_manifest_failure(messages):
            break
        time.sleep(TEMPLATE_SYNC_RETRY_DELAY_S)
        ok, messages, _ran = sync_templates_once()
        if ok:
            logger.warning('模板清单首次检查失败（临时网络故障），重试后已同步完成')
            return
    report_template_sync_failure(messages)


def report_template_sync_failure(messages) -> None:
    """按策略汇报一次模板同步失败：无害的降级为一行 WARNING，其余原样重放 ERROR。

    :param messages: 截获到的 ERROR 日志正文序列。
    """
    if any(record_is_benign_transport_failure(m) for m in messages):
        # 只取最后一行当摘要：完整 traceback 已经拦下，没必要再泼一屏给用户。
        first = next((m for m in messages if str(m).strip()), '网络超时')
        lines = str(first).strip().splitlines()
        detail = lines[-1].strip() if lines else '网络超时'
        logger.warning(f'模板清单检查临时失败，已跳过本次模板更新，继续使用本地模板（不影响查询）：{detail}')
    else:
        # 确定性故障：不能降级。把上游的 ERROR 原样重放，保持原有的可诊断性。
        # 末尾多余的换行要剥掉：上游那条 traceback 本身就以换行结尾，loguru 还会再加一个。
        for text in messages:
            logger.error(str(text).rstrip('\n'))


# 页内脚本：让"CSS background-image"也进入上游的就绪计数。
#
# 为什么必须补这一段（真实截图对比得到的结论）：
#   上游 `_smart_wait()` 会给 `window.__images_total / __images_loaded` 把关，
#   等"图片全部加载完"。但它**只统计 `<img>` 元素与部分 CSS 背景**，而舰船大图恰恰是
#   CSS `background-image`（实测：生成的 HTML 里 `<img>` 标签数为 0、`background-image` 1 处）。
#   于是那道就绪闸门以为"没有图片要等"，**立刻放行** —— 真正拦住截图时间的只剩
#   `page.goto(wait_until='networkidle')` 那 10 秒。
#   实测对比：把 networkidle 从 10s 砍到 2.5s，出图**整块舰船背景丢失**（白底卡片），
#   说明那 10 秒并非白等，只是"等错了东西"。
#
# 做法：在页面里补登记 background-image（用 getComputedStyle 找出实际生效的那些），
# 计入 __images_total，并在 onload 时计入 __images_loaded。这样 `_smart_wait` 会真正
# 等到背景图就绪，我们才敢把 networkidle 的等待砍短。
# 兜底：8 秒后强制 +1 一次，保证"某张背景图永不返回"时不会把页面卡死在这里。
_BG_IMAGE_TRACKER_JS = r"""
(function () {
    if (window.__bg_images_tracked_by_wows) return;
    window.__bg_images_tracked_by_wows = true;
    window.__bg_pending = 0;
    var settled = false;
    function reconcile() {
        if (settled) return;
        settled = true;                 // 只登记一次，避免重复计数
        try {
            var all = document.querySelectorAll('*');
            var total = 0, loaded = 0;
            for (var i = 0; i < all.length; i++) {
                var bg = getComputedStyle(all[i]).backgroundImage;
                if (!bg || bg === 'none' || bg.indexOf('url(') !== 0) continue;
                var url = bg.slice(4, -1).replace(/^["']|["']$/g, '');
                if (!url || url.indexOf('data:') === 0) continue;
                total++;
                var probe = new Image();
                probe.src = url;
                if (probe.complete) { loaded++; }
                else {
                    probe.onload = probe.onerror = function () {
                        loaded++;
                        window.__images_loaded = (window.__images_loaded || 0) + 1;
                    };
                }
            }
            if (total) {
                window.__images_total = (window.__images_total || 0) + total;
                window.__images_loaded = (window.__images_loaded || 0) + loaded;
            }
        } catch (e) { /* 任何异常都不阻塞截图 */ }
    }
    // 等 DOM 出来再登记；上游紧接着会调 _smart_wait，所以这里必须尽早完成。
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', reconcile, { once: true });
    } else {
        reconcile();
    }
    // 兜底：万一某张背景图永不返回，8 秒后放行，不让整页卡住
    setTimeout(function () {
        window.__images_total = window.__images_total || 0;
        window.__images_loaded = window.__images_total;
    }, 8000);
})();
"""


def install_render_goto_guard() -> bool:
    """接管上游那次"10 秒 networkidle 等待"，把它从**硬失败**改成**有依据的兜底**。

    背景（本机实测到的日志）：

    ```
    playwright._impl._errors.TimeoutError: Page.goto: Timeout 10000ms exceeded.
    navigated to "file:///.../browser_temp/temp_7cd583f6.html", waiting until "networkidle"
    ```

    ``minimal_screens_hot_service.screenshot()`` 第 382-386 行硬编码：

    ```python
    await page.goto(f"file://{temp_file}", wait_until='networkidle', timeout=10000)
    ```

    ``networkidle`` 要求"500ms 内没有任何网络请求在飞"。而这些模板要加载十余个
    **境外/OSS** 资源（`hikari-resource` OSS 的舰种图标、`v3-api.wows.shinoaki.com`
    的服务器图标等），本机代理到它们的 TLS 握手本身就不稳定 —— 一次抖动就吃满 10 秒，
    于是整个渲染被判定为失败，**只能靠我们外层的重试再花十几秒重来一遍**。

    关键观察：**这 10 秒等待与后面的等待是重复的**。同一函数紧接着还有两道更可靠的
    闸门 —— 第 416 行等浏览器端渲染完成标记（15 秒），第 428 行 ``_smart_wait()``
    等 ``load`` 事件 + 字体就绪 + 图片解码。也就是说即使 ``goto`` 超时，
    后续两道闸门仍能保证页面渲染完成。

    因此这里把 ``Page.goto`` 包一层：

    * 仍是 ``networkidle``、仍等 10 秒（行为不变），只是**超时不再抛异常**；
    * 超时后**先验证** ``load`` 事件是否真的发生过（等最多 3 秒）；
    * 真发生过 → 说明页面本身没问题，只是几个外部资源慢，降级为一行 INFO 继续渲染；
    * 真没发生（页面根本没起来）→ 保留原有异常，让上层按原逻辑失败。

    这样既不为"慢性子资源"白等 10 秒的失败路径，也不会把"页面真的挂了"掩盖掉。

    :returns: 安装成功（或已安装）返回 ``True``。
    """
    if _render_goto.get('installed'):
        return True
    try:
        from playwright.async_api import Page as _Page
    except Exception:                                            # noqa: BLE001
        return False

    # ⚠️ 必须从类的 __dict__ 里取**未绑定**的原始函数，不能用 getattr(_Page, 'goto')：
    #    后者拿到的是"绑定到类"的 method，再 original(self, url, ...) 调用会把 self 传两遍，
    #    抛 TypeError —— 而 TypeError 会被外层误当成渲染失败，表现为"兜底压根没生效"。
    #    （真实 Chromium 实测踩到这个坑：goto 抛的明明是 TimeoutError，外面看到的却是别的异常。）
    original = _Page.__dict__.get('goto')
    if original is None:
        original = getattr(_Page, 'goto', None)
    if original is None:
        return False
    # 防叠加：若当前已经是我们的包装版（例如测试里重置了 installed 标记后重装、
    # 或本模块被重新加载），直接返回。否则会把包装版当"上游实现"再包一层，
    # original 指向自己 → 递归 → networkidle 超时被处理两遍（实测踩过）。
    if getattr(original, '__wows_goto_guarded__', False):
        _render_goto['installed'] = True
        return True
    _render_goto['original'] = original
    install_background_image_tracker()
    return _wrap_page_goto(original)


def install_background_image_tracker() -> bool:
    """给上游的 `create_page` 加一段页内脚本，把 CSS background-image 纳入就绪计数。

    上游 `_smart_wait()` 靠 `window.__images_total/__images_loaded` 判断"图片都加载完了"，
    但它只统计 `<img>`；舰船大图是 CSS `background-image`，因此那道闸门会**立刻放行**，
    真正的阻塞点只剩 `networkidle` 那 10 秒（详见 :data:`_BG_IMAGE_TRACKER_JS` 的说明）。

    :returns: 安装成功（或已安装）返回 ``True``。
    """
    if _render_goto.get('bg_tracker_installed'):
        return True
    try:
        # ⚠️ 上游这个类名是**小写开头**的 `minimal_screens_hot_service`（不是驼峰）。
        #    写错大小写会 ModuleNotFoundError 被下面的 except 吞掉，表现为"跟踪脚本没装上"
        #    却不报错 —— 实测踩过。
        from hikari_core.Html_Render.minimal_screens_hot_service import (
            minimal_screens_hot_service as _Service,
        )
    except Exception:                                            # noqa: BLE001
        return False
    original = _Service.__dict__.get('create_page')
    if original is None or getattr(original, '__wows_bg_tracked__', False):
        _render_goto['bg_tracker_installed'] = True
        return True

    async def create_page_with_tracker(self, session_id=None):
        page = await original(self, session_id)
        try:
            await page.add_init_script(_BG_IMAGE_TRACKER_JS)
        except Exception as exc:                                 # noqa: BLE001
            logger.debug(f'注入背景图跟踪脚本失败（不影响渲染）：{exc}')
        return page

    create_page_with_tracker.__wows_bg_tracked__ = True
    try:
        _Service.create_page = create_page_with_tracker
    except Exception:                                            # noqa: BLE001
        return False
    _render_goto['bg_tracker_installed'] = True
    return True


def _wrap_page_goto(original) -> bool:
    """把 ``Page.goto`` 换成"检查后放行"的版本（见 :func:`install_render_goto_guard`）。"""
    try:
        from playwright.async_api import Page as _Page
        from playwright.async_api import TimeoutError as _PWTimeout
    except Exception:                                            # noqa: BLE001
        return False
    # networkidle 只用来"给外部资源一个机会"，真正保证画面完整的是随后的
    # `_smart_wait()`（load + 字体 + 图片解码）+ 页内背景图跟踪。原来硬等 10 秒纯属浪费：
    # 只要有一个图标挂住就吃满 10 秒，而画面早就齐了。
    # 缩短到 2 秒：给快资源留出 settle 时间，又不再为慢资源白等 10 秒。
    # 实测依据见模块内 `_BG_IMAGE_TRACKER_JS` 的说明与 DEVELOPMENT.md §10.5。
    relaxed_timeout_ms = 2000

    async def guarded_goto(self, url, **kwargs):
        """``Page.goto`` 的包装版：networkidle 超时改为"验证后再决定是否放过"。"""
        started = time.time()
        if kwargs.get('wait_until') == 'networkidle':
            configured = kwargs.get('timeout')
            if configured is None or configured > relaxed_timeout_ms:
                kwargs['timeout'] = relaxed_timeout_ms
                _render_goto['shortened'] = _render_goto.get('shortened', 0) + 1
        try:
            return await original(self, url, **kwargs)
        except _PWTimeout:
            if kwargs.get('wait_until') != 'networkidle':
                raise                       # 只管 networkidle 这一种，其它照旧失败
            loaded = False
            # ⚠️ 判据不能是 ``readyState === 'complete'``：只要有一个外部资源永远不返回，
            #    ``readyState`` 就**永远停在 loading**（真实 Chromium 实测：DOM 完好、
            #    能渲染能截图，但 readyState 不是 complete）。正确的判据是"文档是否已经
            #    解析出可用的 DOM" —— ``document.body`` 存在且有内容即说明 HTML 解析完、
            #    脚本已执行；这类页面对我们来说就是可渲染的。
            try:
                await self.wait_for_load_state('load', timeout=3000)
                loaded = True
            except Exception:                                     # noqa: BLE001
                try:
                    loaded = bool(await self.evaluate(
                        '() => !!(document.body && (document.body.childElementCount > 0 '
                        '|| document.body.textContent.trim().length > 0))'))
                except Exception:                                 # noqa: BLE001
                    loaded = False
            if loaded:
                _render_goto['relaxed'] = _render_goto.get('relaxed', 0) + 1
                logger.info(f'页面 networkidle 未在 {relaxed_timeout_ms}ms 内达成（外部图标资源偏慢），'
                            f'已确认页面本身加载完成，继续渲染（{time.time() - started:.1f}s）')
                return None
            raise                            # 页面真的没起来：保持原异常

    guarded_goto.__wows_goto_guarded__ = True     # 供上面的"防叠加"判定识别
    try:
        from playwright.async_api import Page as _Page

        _Page.goto = guarded_goto
    except Exception:                                            # noqa: BLE001
        return False
    _render_goto['installed'] = True
    return True


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
        # 渲染失败时不要回一坨 playwright 堆栈：上游的 render_error_fallback=True 会把它
        # 归一化成一条 BrowserRenderError 文本，我们才能据此识别"这是渲染失败、可以重试"。
        "render_error_fallback": True,
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
    # 上游的模板清单同步只会在**第一次** set_hikari_config 时执行（core/config.py:119）。
    # 提前把这一小段接管掉：网络抖动时只重试一次并留一行 WARNING，而不是泼一整段 traceback。
    # 本函数幂等且不抛异常，放在这里可以覆盖"启动时有 --token"和"首次查询才带 token"两条路径。
    sync_templates_quietly()
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


# ── 渲染失败的识别与重试 ──────────────────────────────────────────────────────
# 背景（实测）：上游渲染使用 `page.goto(wait_until='networkidle', timeout=10000)` ——
# 硬编码 10 秒、且要求"500ms 内没有任何网络请求在飞"。模板会加载十余个远程资源
# （舰船图/国家旗/前端库，见 Template/*.html），网络稍有抖动就会触发超时；
# 上游**没有重试**，一次抖动就直接变成一条错误回复。
#
# 实测到的两类瞬时失败（同一条指令一次失败、下一次却成功）：
#   1. "playwright错误…Page.goto: Timeout 10000ms exceeded"（渲染超时）
#   2. "wuwuwu出了点问题，请联系麻麻解决"（上游兜底的 except Exception，多为网络类异常）
#
# 这两类都不代表指令有问题，重试一次通常就过。因此在这里补一层重试：
# 与"指令错误/玩家不存在"这类确定性失败严格区分开，后者绝不重试。
RENDER_RETRY_MARKERS = (
    'playwright错误',
    'Page.goto',
    'Timeout',
    '超时',
    'BrowserRenderError',
    '模板渲染错误',
    '浏览器端渲染',
    'wuwuwu出了点问题',
)


def is_render_failure(payload: dict) -> bool:
    """判断一次查询结果是不是"渲染阶段"的失败（即重试可能有意义的那种）。

    :param payload: ``package()`` 产出的响应体。
    :returns: 命中渲染失败特征时为 True；``failed``（玩家不存在等业务失败）永远为 False。
    """
    if str(payload.get('status')) == 'failed':
        # failed = 上游明确告知业务失败（如"未找到该玩家"），重试无意义
        return False
    if str(payload.get('status')) not in ('error',):
        return False
    text = str(payload.get('text') or '')
    return any(marker in text for marker in RENDER_RETRY_MARKERS)


async def init_hikari_with_retry(*, platform: str, platform_id: str, bot_id: str,
                                 command: str, group_id, attempts: int = 1,
                                 delay_ms: int = 1200) -> tuple[object, list]:
    """执行 ``init_hikari``，渲染失败时按 ``attempts`` 重试。

    :param attempts: 额外重试次数（0 = 只跑一次）。
    :returns: ``(hikari, notes)``；``notes`` 记录每次尝试的失败原因，供日志与回显。
    :side effect: 重试之间 ``await asyncio.sleep``（不阻塞事件循环，其他会话仍可查询）。
    """
    notes: list[str] = []
    for i in range(max(1, attempts + 1)):
        hikari = await init_hikari(
            platform=platform,
            PlatformId=str(platform_id),
            BotId=str(bot_id),
            command_text=str(command),
            GroupId=(str(group_id) if group_id not in (None, "") else None),
            # 禁用清单（可选）。必须传**函数对象**，传字符串无效 —— 见 resolve_ignore_list
            Ignore_List=ACTIVE_IGNORE or None,
        )
        payload = package(hikari, command, 0)
        if i < attempts and is_render_failure(payload):
            reason = str(payload.get('text') or '').splitlines()[0][:160]
            notes.append(reason)
            logger.warning(f"渲染失败，准备重试（{i + 1}/{attempts}）：{reason}")
            await asyncio.sleep(max(0, delay_ms) / 1000)
            continue
        return hikari, notes
    return hikari, notes  # pragma: no cover - 循环必然在内部 return


def _describe_output(hikari) -> str:
    """把 "这次到底出没出图" 压成一小段短文本，供日志使用。

    为什么值得单独写一个：``status=success`` **不代表有图**。上游在
    ``output_hikari`` 里若因为 ``Output.Template`` 为空等原因跳过渲染，状态照样是
    success，只是 ``Output.Data`` 变成了文字 —— 而日志只打 status 时这两种情况
    完全无法区分。排查"回序号后没图"时就是卡在这里。

    :param hikari: 上游的 ``Hikari_Model``。
    :returns: 形如 ``图=208KB tpl=wws-ship-v6.html`` 或 ``无图(data=str)``；拿不到时返回空串。
    """
    try:
        out = getattr(hikari, "Output", None)
        data = getattr(out, "Data", None)
        tpl = getattr(out, "Template", None) or "-"
        if isinstance(data, (bytes, bytearray)):
            return f"图={len(data) / 1024:.0f}KB tpl={tpl}"
        return f"无图(data={type(data).__name__}) tpl={tpl}"
    except Exception:                                            # noqa: BLE001
        return ""


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
    if pend is None and select_index is not None:
        # 续查请求但找不到挂起的会话：几乎总是"首次查询没带 session_key"，
        # 于是桥接从未挂起候选，只能把它当成一次全新的查询 —— 用户看到的就是
        # "回了序号又弹一次选择列表、始终没有图"。这条日志是排查该问题的第一现场。
        logger.warning(f"收到续查（select={select_index}）但没有挂起的会话"
                       f"（session_key={session_key!r}，PENDING={list(PENDING.keys())}）："
                       f"将按新查询处理。请确认首次查询（status=wait）带了同一个 session_key。")
    if pend is not None:
        hikari = pend["hikari"]
        hikari.Input.Select_Index = int(select_index)
        hikari = await callback_hikari(hikari)
        PENDING.pop(session_key, None)
        elapsed = int((time.time() - started) * 1000)
        # ⚠️ 必须把"有没有出图"一起打出来。只记 status 的话，"success 但没图"和
        #    "success 且有图"在日志里长得一模一样 —— 排查"回序号后没图"时吃过这个亏
        #    （实测一次续查 3588ms 出图 208KB，而另一次 369ms 无图，只看 status 无法区分）。
        logger.info(f"续查 select={select_index} → {hikari.Status} ({elapsed}ms) "
                    f"{_describe_output(hikari)}")
        return package(hikari, command or f"select:{select_index}", elapsed, session_key)

    if not str(command or "").strip():
        raise ValueError("续查失败：没有挂起的会话，且没有给出指令")

    # 同一会话又发起新查询：丢弃上一次挂起的多选会话。
    # 否则它会一直占着内存，且用户随后回一个序号会被接到早已过期的上下文上。
    if session_key:
        PENDING.pop(session_key, None)

    hikari, retry_notes = await init_hikari_with_retry(
        platform=platform,
        platform_id=platform_id,
        bot_id=bot_id,
        command=command,
        group_id=group_id,
        attempts=max(0, int(ARGS.render_retry)),
        delay_ms=max(0, int(ARGS.render_retry_delay_ms)),
    )
    elapsed = int((time.time() - started) * 1000)
    if retry_notes:
        logger.info(f"重试后取得结果（此前失败 {len(retry_notes)} 次）")
    logger.info(f"查询「{command}」platform={platform} pid={platform_id} → {hikari.Status} "
                f"({elapsed}ms) {_describe_output(hikari)}")
    result = package(hikari, command, elapsed, session_key)
    if retry_notes:
        # 把重试事实回给插件：便于在日志里解释"为什么这次慢了十几秒"
        result['retried'] = len(retry_notes)
        result['retry_reasons'] = retry_notes
    return result


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
            # 渲染等待兜底：与 hikari-core 配置无关，独立安装（失败也不影响启动）
            install_render_goto_guard()
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
