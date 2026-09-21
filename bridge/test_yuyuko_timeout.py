"""yuyuko 短超时补时自检：只把 `check_yuyuko_cache` 那 5 秒提到 20 秒，别的一律不动。

背景（本机实测）：上游 `features/api.py:171/186` 给 `POST /api/wows/cache/check`
只留 5 秒，而它每次查询都要发、冷启动还要做 TLS 握手 —— 实测同一请求第一次 5.07s
被掐断、第二次 7.95s 才成功。结果"第一次查询必失败、重试才成功"成了常态。

用法：python bridge/test_yuyuko_timeout.py
"""
import asyncio
import importlib.util
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve()
DEPS = HERE.parent.parent / '.hikari-deps'

if importlib.util.find_spec('httpx') is None and os.environ.get('WOWS_TEST_BOOTSTRAPPED') != '1':
    if not DEPS.is_dir():
        print(f'缺少依赖目录 {DEPS}，请先运行 bridge/start-bridge.ps1 完成安装')
        sys.exit(2)
    env = dict(os.environ)
    env['PYTHONPATH'] = os.pathsep.join([str(DEPS)] + ([env['PYTHONPATH']] if env.get('PYTHONPATH') else []))
    env['WOWS_TEST_BOOTSTRAPPED'] = '1'
    os.execve(sys.executable, [sys.executable, str(HERE)], env)

import httpx  # noqa: E402
import types  # noqa: E402

# 桥接导入时会尝试 from hikari_core import ...，给个最小替身即可
fake = types.ModuleType('hikari_core')
fake.Hikari_Model = type('Hikari_Model', (), {})
fake.callback_hikari = lambda *a, **k: None
fake.init_hikari = lambda **k: None
fake.set_hikari_config = lambda **k: None
fake.__version__ = 'test'
sys.modules['hikari_core'] = fake

spec = importlib.util.spec_from_file_location('bg', HERE.with_name('hikari_bridge.py'))
bg = importlib.util.module_from_spec(spec)
sys.argv = ['hikari_bridge.py']
spec.loader.exec_module(bg)

fails = []


def check(cond, name, extra=''):
    print(('OK   ' if cond else 'FAIL ') + name + ('' if cond else f'   {extra}'))
    if not cond:
        fails.append(name)


CACHE = 'https://v3-api.wows.shinoaki.com/api/wows/cache/check'
INFO = 'https://v3-api.wows.shinoaki.com/public/wows/account/info'

captured = []


class _Resp:
    status_code = 200
    content = b'{}'
    text = '{}'


def _install_recorder():
    """把底层 post 换成记录器，再重新安装包装，这样能看到实际透传的 timeout。"""
    async def _recorder(self, url, **kwargs):
        captured.append((str(url), kwargs.get('timeout')))
        return _Resp()

    httpx.AsyncClient.post = _recorder
    bg._yuyuko_timeout['installed'] = False
    bg._yuyuko_timeout.pop('original', None)
    return bg.install_yuyuko_timeout_guard()


print('=== 1) 安装与幂等 ===')
check(_install_recorder() is True, '安装成功')
check(bg.install_yuyuko_timeout_guard() is True, '重复安装幂等')

print()
print('=== 2) 只给那一个接口补时，且绝不降低已有超时 ===')
captured.clear()


async def _run():
    async with httpx.AsyncClient() as c:
        await c.post(CACHE, json={}, timeout=5)      # 应提到 20
        await c.post(CACHE, json={}, timeout=30)     # 已更长 → 不动
        await c.post(CACHE, json={})                 # 没给 timeout → 不动
        await c.post(INFO, json={}, timeout=5)       # 不是这个接口 → 不动
        await c.post('https://other.example/api/wows/cache/check', json={}, timeout=5)  # 命中路径但非本站
        await c.post(CACHE, json={}, timeout=20.0)   # 正好 20 → 不动


asyncio.run(_run())
got = [t for _u, t in captured]
check(got[0] == bg.YUYUKO_MIN_TIMEOUT_S, '5 秒 → 提到 YUYUKO_MIN_TIMEOUT_S', f'实际 {got[0]}')
check(got[1] == 30, '已更长的超时不降低', f'实际 {got[1]}')
check(got[2] is None, '未指定 timeout 时不擅自加', f'实际 {got[2]}')
check(got[3] == 5, '其它接口原样透传', f'实际 {got[3]}')
check(got[4] == 5, '路径相同但域名不同 → 仍不碰', f'实际 {got[4]}')
check(got[5] == 20.0, '恰好 20 秒时不重复改写', f'实际 {got[5]}')

print()
print('=== 3) 判据函数本身 ===')
check(bg._needs_longer_timeout(CACHE) is True, '命中：cache/check')
check(bg._needs_longer_timeout(INFO) is False, '不命中：account/info')
check(bg._needs_longer_timeout('') is False, '不命中：空 URL')
check(bg._needs_longer_timeout(None) is False, '不命中：None')

if fails:
    print('\n失败项：')
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('\nyuyuko 短超时补时自检全部通过')
