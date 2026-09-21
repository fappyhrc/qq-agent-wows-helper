r"""Hikari-core-v2 兼容性 / 性能探针（可选工具，桥接服务本身不依赖它）

用途：
  1. 验证某个 Python 版本到底能不能装、能不能跑 Hikari-core-v2
     （仓库的 pyproject.toml 写的是 requires-python ">=3.11,<3.13"，但 3.13/3.14 实测可用）
  2. 测量真实查询耗时 —— 这是"钩子内预取"能不能用的唯一依据

用法（在插件目录下执行）：
  # 装到一个本地目录（不要把依赖装进 QQ Agent 的 node_modules）
  pip install --target .hikari-deps ./Hikari-core-v2
  set PYTHONPATH=%CD%\.hikari-deps
  python bridge/probe_hikari.py "账号ID:Token"

实测结论（Windows / Python 3.14.7 / chromium / http2 关闭）：
  set_hikari_config 首次 ~150s（下载浏览器 + 18MB 船图缓存），之后几乎为 0
  me              首次 39s，热态 10~13s
  ship 大和        热态 6.4s
  recent 7        热态 5.2s
  <错指令>         0.00s（纯解析，不出图）
→ 单次查询远超钩子的 5 秒硬超时，所以插件默认 hookPrefetch=false，查询交给工具（无 5 秒限制）。

注：群里输入时要带触发词，例如 `@机器人 yuyuko me`；本脚本直接调 SDK，所以这里只写指令正文。
"""
import asyncio
import sys
import time

try:
    from hikari_core import init_hikari, set_hikari_config
except Exception:  # noqa: BLE001
    print('IMPORT FAILED —— 先 pip install --target ... 并设置 PYTHONPATH')
    import traceback

    traceback.print_exc()
    sys.exit(1)

TOKEN = sys.argv[1] if len(sys.argv) > 1 else ''
PLATFORM_ID = sys.argv[2] if len(sys.argv) > 2 else '1000000001'
if not TOKEN:
    print('用法: python probe_hikari.py "账号ID:Token" [PlatformId]')
    sys.exit(2)


async def main():
    t0 = time.time()
    set_hikari_config(
        token=TOKEN,
        # ⚠️ 上游参数名拼错了（少一个 w）：use_broswer，不是 use_browser。
        use_broswer='chromium',
        http2=False,
        image_type='jpeg',
        game_path='',
        command_language='zh',
        proxy=None,
    )
    print(f'[1] set_hikari_config 完成，用时 {time.time() - t0:.1f}s')

    for cmd in ['测试', 'me', 'ship 大和', 'recent 7']:
        t = time.time()
        h = await init_hikari(platform='QQ', PlatformId=PLATFORM_ID, BotId='0', command_text=cmd, GroupId=None)
        data = h.Output.Data
        size = len(data) if isinstance(data, (bytes, bytearray)) else len(str(data or ''))
        kind = type(data).__name__
        print(f'    {cmd!r:14} Status={h.Status:8} {h.Output.Data_Type!s:24} {kind}({size})  用时 {time.time() - t:6.2f}s')
        if isinstance(data, str):
            print('        text:', data[:150].replace('\n', ' / '))


asyncio.run(main())
