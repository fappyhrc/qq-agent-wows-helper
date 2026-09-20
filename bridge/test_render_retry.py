"""重试逻辑自检：验证"渲染失败会自动重试，且不误伤业务失败"。

不需要真浏览器：用假的 hikari_core + 可控的 package() 行为来驱动。

用法：python bridge/test_render_retry.py
"""
import asyncio
import importlib.util
import pathlib
import sys
import types

# ── 假 hikari_core：只需提供被 import 的名字 ──────────────────────────────────
fake = types.ModuleType('hikari_core')
fake.Hikari_Model = type('Hikari_Model', (), {})
fake.callback_hikari = lambda *a, **k: None


class _StatusHolder:
    def __init__(self, status):
        self.Status = status


CALLS = {'n': 0}
RESPONSES = []   # 依序返回的 (status, text)


async def _fake_init_hikari(**kwargs):
    CALLS['n'] += 1
    return _StatusHolder('success')


fake.init_hikari = _fake_init_hikari
fake.set_hikari_config = lambda **kwargs: None
fake.__version__ = '1.2.5-test'
sys.modules['hikari_core'] = fake

spec = importlib.util.spec_from_file_location('bg', pathlib.Path(__file__).with_name('hikari_bridge.py'))
bg = importlib.util.module_from_spec(spec)
sys.argv = ['hikari_bridge.py']
spec.loader.exec_module(bg)

# 让 package() 按剧本返回，从而精确模拟"渲染失败 → 重试 → 成功"
def fake_package(hikari, command, elapsed_ms, session_key=None):
    idx = min(CALLS['n'] - 1, len(RESPONSES) - 1)
    status, text = RESPONSES[idx]
    bg.package.calls.append(status)
    return {'ok': status == 'success', 'status': status, 'text': text, 'command': command,
            'image_base64': 'AAA' if status == 'success' else None, 'options': [], 'elapsed_ms': elapsed_ms}


bg.package.calls = []
bg.package = fake_package

fails = []


def check(cond, name, extra=''):
    print(('OK   ' if cond else 'FAIL ') + name + ('' if cond else f'   {extra}'))
    if not cond:
        fails.append(name)


print('=== 1) 渲染失败识别（用实测到的真实错误文案）===')
observed = [
    ('error', 'playwright错误，请检查浏览器内核是否异常结束…\nPage.goto: Timeout 10000ms exceeded.', True),
    ('error', 'wuwuwu出了点问题，请联系麻麻解决\nhttpx.ConnectError: ...', True),
    ('error', '模板渲染错误（浏览器端），请将日志中的报错提交给开发者', True),
    ('error', '等待浏览器端渲染超时（模板报错 / 资源缺失？）', True),
    ('failed', '未找到该玩家', False),                       # 业务失败绝不能重试
    ('failed', '服务器繁忙，请稍后重试', False),
    ('success', '', False),
]
for status, text, expect in observed:
    got = bg.is_render_failure({'status': status, 'text': text})
    check(got == expect, f'{status} / {text[:34]!r} → 重试={expect}', f'实际={got}')

print()
print('=== 2) 渲染失败时重试一次并成功 ===')
CALLS['n'] = 0
RESPONSES[:] = [('error', 'playwright错误… Page.goto: Timeout 10000ms exceeded.'), ('success', '')]
bg.package.calls = []
hikari, notes = asyncio.run(bg.init_hikari_with_retry(
    platform='QQ', platform_id='1', bot_id='0', command='ship 大和', group_id=None,
    attempts=1, delay_ms=0))
check(CALLS['n'] == 2, '调用了 2 次 init_hikari', f"实际 {CALLS['n']}")
check(len(notes) == 1, '记录了 1 条失败原因', str(notes))
check(bg.package.calls == ['error', 'success'], '先失败后成功', str(bg.package.calls))

print()
print('=== 3) 业务失败不重试（关键：不能把"玩家不存在"重查一遍）===')
CALLS['n'] = 0
RESPONSES[:] = [('failed', '未找到该玩家')]
bg.package.calls = []
asyncio.run(bg.init_hikari_with_retry(platform='QQ', platform_id='1', bot_id='0',
                                      command='me', group_id=None, attempts=1, delay_ms=0))
check(CALLS['n'] == 1, '只调用 1 次', f"实际 {CALLS['n']}")

print()
print('=== 4) 连续失败时用尽重试次数后返回最后一次结果 ===')
CALLS['n'] = 0
RESPONSES[:] = [('error', 'Page.goto: Timeout 10000ms exceeded.')]
bg.package.calls = []
hikari, notes = asyncio.run(bg.init_hikari_with_retry(
    platform='QQ', platform_id='1', bot_id='0', command='me', group_id=None,
    attempts=1, delay_ms=0))
check(CALLS['n'] == 2, '总共调用 2 次（1 次 + 1 次重试）', f"实际 {CALLS['n']}")
check(len(notes) == 1, '记录失败原因', str(notes))

print()
print('=== 5) attempts=0 时完全不重试（可关闭）===')
CALLS['n'] = 0
RESPONSES[:] = [('error', 'Page.goto: Timeout 10000ms exceeded.')]
asyncio.run(bg.init_hikari_with_retry(platform='QQ', platform_id='1', bot_id='0',
                                      command='me', group_id=None, attempts=0, delay_ms=0))
check(CALLS['n'] == 1, '只调用 1 次', f"实际 {CALLS['n']}")

if fails:
    print('\n失败项：')
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('\n渲染重试自检全部通过')
