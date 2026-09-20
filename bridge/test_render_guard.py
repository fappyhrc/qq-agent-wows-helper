"""渲染等待兜底自检：把上游那次"10 秒 networkidle 等待"从硬失败改成有依据的兜底。

不需要真浏览器、也不需要真 hikari_core：用假的 hikari_core 与假的 playwright.async_api.Page
驱动 `install_render_goto_guard()`，断言"页面其实加载好了就放过、页面真挂了仍失败"。

用法：python bridge/test_render_guard.py
（依赖只装在 .hikari-deps，脚本会自己带上正确的 PYTHONPATH 重跑一遍）
"""
import importlib.util
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve()
DEPS = HERE.parent.parent / '.hikari-deps'

if importlib.util.find_spec('playwright') is None and os.environ.get('WOWS_TEST_BOOTSTRAPPED') != '1':
    if not DEPS.is_dir():
        print(f'缺少依赖目录 {DEPS}，请先运行 bridge/start-bridge.ps1 完成安装')
        sys.exit(2)
    env = dict(os.environ)
    env['PYTHONPATH'] = os.pathsep.join([str(DEPS)] + ([env['PYTHONPATH']] if env.get('PYTHONPATH') else []))
    env['WOWS_TEST_BOOTSTRAPPED'] = '1'
    os.execve(sys.executable, [sys.executable, str(HERE)], env)

import types

# ── 假 hikari_core：桥接只用到顶层这几个名字 ─────────────────────────────────
fake_core = types.ModuleType('hikari_core')
fake_core.Hikari_Model = type('Hikari_Model', (), {})
fake_core.callback_hikari = lambda *a, **k: None
fake_core.init_hikari = lambda **kwargs: None
fake_core.set_hikari_config = lambda **kwargs: None
fake_core.__version__ = '1.2.5-test'
sys.modules['hikari_core'] = fake_core

# ── 假 playwright.async_api：只需 Page 类与 TimeoutError ─────────────────────
fake_api = types.ModuleType('playwright.async_api')


class FakeTimeoutError(Exception):
    """对应 playwright 的 TimeoutError（真实类继承自 Exception）。"""


class FakePage:
    """可控的假页面：三个独立开关驱动三种剧本。

    * ``load_ready``：``wait_for_load_state('load')`` 是否立即成功；
    * ``is_blank``：DOM 是否为空（``evaluate`` 的兜底判据，对应真实页面的
      ``document.body`` 是否有内容）；
    * ``ready_state``：仅用于断言"判据没退回 readyState"，真实页面里只要有一个外部资源
      永不返回它就**永远不是 complete** —— 所以兜底绝不能依赖它。
    """

    load_ready = True
    is_blank = False
    ready_state = 'complete'

    def __init__(self):
        self.goto_calls = []
        self.load_waits = 0
        self.eval_calls = []

    async def goto(self, url, **kwargs):
        self.goto_calls.append((url, kwargs))
        raise FakeTimeoutError('Page.goto: Timeout 10000ms exceeded.')

    async def wait_for_load_state(self, state, timeout=None):
        self.load_waits += 1
        if not FakePage.load_ready:
            raise FakeTimeoutError(f'Timeout {timeout}ms exceeded')

    async def evaluate(self, script):
        self.eval_calls.append(script)
        return not FakePage.is_blank

class RealPage:
    """代表"上游原本的行为"：goto 同步成功。"""

    def __init__(self):
        self.goto_calls = []

    async def goto(self, url, **kwargs):
        self.goto_calls.append((url, kwargs))
        return 'resp'


fake_api.Page = FakePage
fake_api.TimeoutError = FakeTimeoutError
# 保存未被包装过的原始实现：FakePage 与 fake_api.Page 是同一个对象，
# 一旦桥接包装了 Page.goto，FakePage.goto 也就跟着变成包装版了（见 reset_guard）。
plain_goto = FakePage.goto
sys.modules['playwright.async_api'] = fake_api
fake_pw = types.ModuleType('playwright')
fake_pw.async_api = fake_api
sys.modules['playwright'] = fake_pw

spec = importlib.util.spec_from_file_location('bg', HERE.with_name('hikari_bridge.py'))
bg = importlib.util.module_from_spec(spec)
sys.argv = ['hikari_bridge.py']
spec.loader.exec_module(bg)

import asyncio  # noqa: E402

from loguru import logger  # noqa: E402

fails = []


def check(cond, name, extra=''):
    print(('OK   ' if cond else 'FAIL ') + name + ('' if cond else f'   {extra}'))
    if not cond:
        fails.append(name)


def reset_guard():
    """把 Page.goto 还原成 fake 并清掉安装标记，让每个用例都能重装。

    ⚠️ `fake_api.Page` 就是 `FakePage` 本身（本来如此），所以 `api.Page.goto = FakePage.goto`
    是**空操作**：`FakePage.goto` 早已被上一轮替换成包装版了。必须保存一份"未被包装过的"
    原始引用（`plain_goto`）来还原，否则每轮都会拿到上一轮的包装，
    表现为 `load_waits` 累加、甚至 closure 嵌套（本文件实测踩过）。
    """
    fake_api.Page.goto = plain_goto
    # 剧本开关也一起复位，避免上一个用例的设定影响下一个
    FakePage.load_ready = True
    FakePage.is_blank = False
    FakePage.ready_state = 'complete'
    bg._render_goto.clear()
    bg._render_goto.update({'installed': False, 'original': None, 'relaxed': 0})


def capture_info():
    """执行期间收集 INFO/WARNING 日志，返回列表。"""
    seen = []
    sink = logger.add(lambda m: seen.append((m.record['level'].name, str(m))),
                      level='INFO', format='{message}')
    return seen, sink


print('=== 1) 安装：包装 Page.goto，且保留上游引用 ===')
reset_guard()
plain_goto = FakePage.goto          # reset_guard 之后（此刻还没被包装）的原方法
check(bg.install_render_goto_guard() is True, '安装成功')
check(fake_api.Page.goto is not plain_goto, 'Page.goto 已被替换',
      f'实际 {fake_api.Page.goto}')
check(bg._render_goto.get('original') is plain_goto, '保留了上游原方法引用',
      f"实际 {bg._render_goto.get('original')}")
check(bg.install_render_goto_guard() is True, '重复安装幂等（不报错）')

print()
print('=== 2) networkidle 超时 + 页面其实加载完成 → 放过并继续渲染 ===')
reset_guard()
bg.install_render_goto_guard()
FakePage.goto_times_out = True
FakePage.load_ready = True
page = FakePage()
seen, sink = capture_info()
try:
    result = asyncio.run(fake_api.Page.goto(page, 'file:///tmp/x.html', wait_until='networkidle', timeout=10000))
finally:
    logger.remove(sink)
infos = [t for lvl, t in seen if lvl == 'INFO']
check(result is None, 'goto 返回 None（不抛异常）', f'实际 {result!r}')
check(page.load_waits == 1, '确实验证过 load 事件', f'实际 {page.load_waits}')
check(any('networkidle' in t for t in infos), '给出一行 INFO 说明', f'info={infos}')
check(bg._render_goto.get('relaxed') == 1, 'relaxed 计数 +1', f"实际 {bg._render_goto.get('relaxed')}")

print()
print('=== 3) networkidle 超时 + 页面真的没起来（DOM 也空）→ 仍然失败（不能掩盖真故障）===')
reset_guard()
bg.install_render_goto_guard()
FakePage.load_ready = False
FakePage.is_blank = True               # 文档没解析出可用 DOM
page = FakePage()
seen, sink = capture_info()
raised = None
try:
    asyncio.run(fake_api.Page.goto(page, 'file:///tmp/x.html', wait_until='networkidle', timeout=10000))
except Exception as exc:  # noqa: BLE001
    raised = exc
finally:
    logger.remove(sink)
check(raised is not None and raised.__class__ is FakeTimeoutError, '原异常被保留', f'实际 {raised!r}')
check(page.load_waits == 1, '尝试过等 load', f'实际 {page.load_waits}')
check(bg._render_goto.get('relaxed') == 0, '不计入放过次数', f"实际 {bg._render_goto.get('relaxed')}")

print()
print('=== 4) load 等不到，但 DOM 已可用（readyState 仍是 loading）→ 仍应放过 ===')
# 这是真实 Chromium 里最常见的情形：某个外部图标永不返回 → readyState 永远不是 complete，
# 但 DOM 完好、能渲染能截图。早期版本用 readyState === 'complete' 判断，会在这里误判为
# "页面没起来"而把异常抛出去 —— 真实浏览器实测踩到的正是这条。
reset_guard()
bg.install_render_goto_guard()
FakePage.load_ready = False
FakePage.is_blank = False
FakePage.ready_state = 'loading'
page = FakePage()
seen, sink = capture_info()
try:
    result = asyncio.run(fake_api.Page.goto(page, 'file:///tmp/x.html', wait_until='networkidle', timeout=10000))
finally:
    logger.remove(sink)
check(result is None, '放过（DOM 可用兜底）', f'实际 {result!r}')
check(page.load_waits == 1, '先尝试过等 load', f'实际 {page.load_waits}')
check(page.eval_calls and 'document.body' in page.eval_calls[0],
      '判据是 DOM（document.body）而不是 readyState', f'实际脚本={page.eval_calls}')

print()
print('=== 4b) load 等不到 + DOM 也空 → 仍然失败（真的坏页面）===')
reset_guard()
bg.install_render_goto_guard()
FakePage.load_ready = False
FakePage.is_blank = True               # evaluate 返回 False
page = FakePage()
raised = None
try:
    asyncio.run(fake_api.Page.goto(page, 'file:///tmp/x.html', wait_until='networkidle', timeout=10000))
except Exception as exc:  # noqa: BLE001
    raised = exc
check(raised is not None, '原异常被保留', f'实际 {raised!r}')
check(page.eval_calls, '尝试过 DOM 兜底判据', f'实际 {page.eval_calls}')

print()
print('=== 4c) networkidle 的等待被缩短（10s → 2s），其余 wait_until 不动 ===')
# 依据：真正保证画面完整的是随后的 _smart_wait（load + 字体 + 图片解码）+ 页内背景图跟踪。
# 原来硬等 10 秒，只要一个图标挂住就吃满；实测缩短后出图与 10 秒版本**字节一致**。
reset_guard()
bg.install_render_goto_guard()
FakePage.load_ready = True
page = FakePage()
try:
    asyncio.run(fake_api.Page.goto(page, 'file:///tmp/x.html', wait_until='networkidle', timeout=10000))
except Exception:  # noqa: BLE001
    pass
net_kwargs = dict(page.goto_calls[0][1])
check(net_kwargs.get('timeout') == 2000, 'networkidle 超时被缩到 2000ms', f'实际 {net_kwargs}')

page2 = FakePage()
try:
    asyncio.run(fake_api.Page.goto(page2, 'file:///tmp/x.html', wait_until='load', timeout=10000))
except Exception:  # noqa: BLE001
    pass
load_kwargs = dict(page2.goto_calls[0][1])
check(load_kwargs.get('timeout') == 10000, '其它 wait_until 的超时原样保留', f'实际 {load_kwargs}')

print()
print('=== 5) 非 networkidle 的 goto 超时：一律不插手 ===')
bg.install_render_goto_guard()
FakePage.load_ready = True
page = FakePage()
raised = None
try:
    asyncio.run(fake_api.Page.goto(page, 'file:///tmp/x.html', wait_until='load', timeout=10000))
except Exception as exc:  # noqa: BLE001
    raised = exc
check(raised is not None, 'wait_until=load 时超时照样抛出', f'实际 {raised!r}')
check(page.load_waits == 0, '不介入', f'实际 {page.load_waits}')

print()
print('=== 6) 正常路径（goto 不超时）行为不变 ===')
reset_guard()


class OkPage:
    def __init__(self):
        self.goto_calls = []

    async def goto(self, url, **kwargs):
        self.goto_calls.append((url, kwargs))
        return 'resp'


fake_api.Page.goto = OkPage.goto
bg.install_render_goto_guard()
ok = OkPage()
seen, sink = capture_info()
try:
    result = asyncio.run(fake_api.Page.goto(ok, 'file:///tmp/x.html', wait_until='networkidle', timeout=10000))
finally:
    logger.remove(sink)
check(result == 'resp', '原样返回上游结果', f'实际 {result!r}')
check(seen == [], '不产生任何日志', f'seen={seen}')

print()
print('=== 7) playwright 不可用时不炸（返回 False，流程照常）===')
reset_guard()
saved = sys.modules.pop('playwright.async_api')
try:
    ok_install = bg.install_render_goto_guard()
finally:
    sys.modules['playwright.async_api'] = saved
check(ok_install is False, '安装失败但返回 False 而非抛异常', f'实际 {ok_install}')

if fails:
    print('\n失败项：')
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('\n渲染等待兜底自检全部通过')
