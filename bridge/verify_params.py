r"""核对 init_hikari 的入参，并实测 Ignore_List 是否真的能"禁用某功能"。

三件事：
  1. 打印 init_hikari 的真实签名与每个参数是否有默认值 —— 判定"哪些必须传"
  2. 用真实查询验证：`me` 正常查得到（说明我们传的参数是对的）
  3. 实测 Ignore_List：传 [get_BindInfo] 后 `bind_list me` 是否被拒绝

用法：
  set PYTHONPATH=.probe2\site
  python bridge/verify_params.py "账号ID:Token"
"""
import asyncio
import inspect
import sys
import time

import hikari_core
from hikari_core import init_hikari, set_hikari_config
from hikari_core.features.bind import get_BindInfo, set_BindInfo

TOKEN = sys.argv[1] if len(sys.argv) > 1 else ''


def show_signature():
    print(f'hikari_core {hikari_core.__version__}')
    sig = inspect.signature(init_hikari)
    print(f'init_hikari 签名：{sig}')
    print('逐参数核对：')
    for name, p in sig.parameters.items():
        has_default = p.default is not inspect.Parameter.empty
        kind = '有默认值' if has_default else '【必填】'
        default = '' if not has_default else f'  默认={p.default!r}'
        print(f'   - {name:14} {kind}{default}')
    print()
    sig2 = inspect.signature(set_hikari_config)
    print(f'set_hikari_config 签名：{sig2}')
    print()


async def main():
    show_signature()
    set_hikari_config(token=TOKEN, use_broswer='chromium', http2=False, image_type='jpeg',
                      game_path='', command_language='zh', proxy=None)

    async def run(cmd, ignore=None, tag=''):
        t = time.time()
        h = await init_hikari(platform='QQ', PlatformId='1000000001', BotId='0',
                              command_text=cmd, GroupId=None, Ignore_List=ignore)
        dt = time.time() - t
        data = h.Output.Data
        size = len(data) if isinstance(data, (bytes, bytearray)) else len(str(data or ''))
        kind = type(data).__name__
        print(f'    {tag or cmd!r:22} Status={h.Status:8} {kind}({size})  {dt:5.2f}s  '
              f'text={str(data)[:60] if isinstance(data, str) else ""}')
        return h

    print('[2] 真实查询（我们桥接传的就是这 5 个参数：platform/PlatformId/BotId/command_text/GroupId）')
    await run('me')

    print('[3] Ignore_List 实测：把 get_BindInfo 放进清单，再看 bind_list 是否被拒')
    await run('bind_list me', None, tag='bind_list(不忽略)')
    await run('bind_list me', [get_BindInfo], tag='bind_list(忽略绑定)')
    await run('ship 大和', [get_BindInfo], tag='ship(忽略绑定,无关)')

    print('[4] Ignore_List 传字符串（不经 import 直接写名字）会怎样')
    await run('bind_list me', ['get_BindInfo'], tag='bind_list(字符串)')


asyncio.run(main())
