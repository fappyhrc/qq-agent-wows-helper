"""上游超时堆栈的降噪自检：抖动时不再泼堆栈，真失败时才补打。

不需要真网络、也不需要真 hikari_core：用假的 init_hikari 模拟上游
`http_error_handler` 的行为 —— 先 logger.warning(traceback)，再返回超时错误。

用法：python bridge/test_upstream_noise.py
"""
import asyncio
import importlib.util
import io
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve()
DEPS = HERE.parent.parent / '.hikari-deps'

if importlib.util.find_spec('loguru') is None and os.environ.get('WOWS_TEST_BOOTSTRAPPED') != '1':
    if not DEPS.is_dir():
        print(f'缺少依赖目录 {DEPS}，请先运行 bridge/start-bridge.ps1 完成安装')
        sys.exit(2)
    env = dict(os.environ)
    env['PYTHONPATH'] = os.pathsep.join([str(DEPS)] + ([env['PYTHONPATH']] if env.get('PYTHONPATH') else []))
    env['WOWS_TEST_BOOTSTRAPPED'] = '1'
    os.execve(sys.executable, [sys.executable, str(HERE)], env)

import types  # noqa: E402

fake = types.ModuleType('hikari_core')
fake.Hikari_Model = type('Hikari_Model', (), {})
fake.callback_hikari = lambda *a, **k: None
fake.set_hikari_config = lambda **k: None
fake.__version__ = '1.2.5-test'
sys.modules['hikari_core'] = fake
fs = types.ModuleType('hikari_core.features.system')
sys.modules['hikari_core.features.system'] = fs
ff = types.ModuleType('hikari_core.features')
ff.system = fs
fake.features = ff
sys.modules['hikari_core.features'] = ff

spec = importlib.util.spec_from_file_location('bg', HERE.with_name('hikari_bridge.py'))
bg = importlib.util.module_from_spec(spec)
sys.argv = ['hikari_bridge.py']
spec.loader.exec_module(bg)

from loguru import logger  # noqa: E402

# 上游超时的真实堆栈片段（照抄用户实测截图，别简化 —— 简化版会掩盖判据缺陷：
# 它里面没有"请求超时了"这种结果文案，只有异常类型名，按文案匹配就永远匹配不上）
TIMEOUT_TB = (
    'Traceback (most recent call last):\n'
    '  File ".../httpx/_transports/default.py", line 101, in map_httpcore_exceptions\n'
    '    yield\n'
    '  File ".../httpcore/_backends/anyio.py", line 67, in start_tls\n'
    '    raise to_exc(exc) from exc\n'
    'httpcore.ConnectTimeout: _ssl.c:1064: The handshake operation timed out\n'
    'The above exception was the direct cause of the following exception:'
)
TIMEOUT_TEXT = '请求超时了，请过会儿再尝试哦~'

fails = []


def check(cond, name, extra=''):
    print(('OK   ' if cond else 'FAIL ') + name + ('' if cond else f'   {extra}'))
    if not cond:
        fails.append(name)


class _Out:
    """假 hikari 结果：让 package() 产出指定 status/text。"""

    def __init__(self, status, text):
        self.Status = status
        self.Data = text
        self.Data_Type = 'str'
        self.Template = None
        self.Select_Data = None

    class _Input:
        Select_Data = None

    Input = _Input()


def make_init_hikari(script):
    """script: [(status, text, 是否先打超时堆栈), ...] 依次返回。

    ⚠️ 必须是 **async** 函数：桥接里是 `await init_hikari(...)`，
    普通函数会直接抛 TypeError（连带把"捕获窗口"也跳过，表现为降噪不生效）。
    """
    state = {'i': 0}

    async def _fake_init_hikari(**kwargs):
        idx = min(state['i'], len(script) - 1)
        status, text, noisy = script[idx]
        state['i'] += 1
        if noisy:
            logger.warning(TIMEOUT_TB)          # 模拟上游的 logger.warning(traceback)
        h = _Out(status, text)
        h.Output = h
        return h

    return _fake_init_hikari, state


def run_with_capture(script, attempts=1):
    """跑一次 init_hikari_with_retry，返回 (stdout 文本, notes)。"""
    fake_init, state = make_init_hikari(script)
    bg.init_hikari = fake_init
    # 把 loguru 的默认输出换到内存里，才能断言"到底打印了什么"
    logger.remove()
    buf = io.StringIO()
    logger.add(buf, level='INFO',
               format='{level} | {message}',
               filter=lambda r: bg._error_suppressor(r) and bg._yuyuko_timeout_filter(r))
    try:
        _hikari, notes = asyncio.run(bg.init_hikari_with_retry(
            platform='QQ', platform_id='1', bot_id='0', command='ship 大和',
            group_id=None, attempts=attempts, delay_ms=0))
    finally:
        logger.remove()
    return buf.getvalue(), notes


print('=== 1) 抖动一次后重试成功 → 不打堆栈，只留一行"已自愈" ===')
out, notes = run_with_capture(
    [('error', TIMEOUT_TEXT, True), ('success', '胜率 54.3%', False)], attempts=1)
print('---- 实际输出 ----')
print(out.rstrip() or '(无)')
print('-----------------')
check('Traceback' not in out, '没有打印 Traceback')
check('httpcore.ConnectTimeout' not in out, '没有打印 httpx/httpcore 细节')
check('已自愈' in out, '给出一行"已自愈"说明')
check(len(notes) == 1, 'notes 记录了 1 次失败原因', str(notes))

print()
print('=== 2) 每次都被上游判超时（重试也失败）→ 堆栈必须补打出来 ===')
out, _ = run_with_capture([('error', TIMEOUT_TEXT, True)], attempts=1)
print('---- 实际输出 ----')
print(out.rstrip() or '(无)')
print('-----------------')
check('Traceback' in out, '真失败时堆栈被补打（诊断信息不能丢）')
check('ConnectTimeout' in out, '补打的堆栈里含异常类型')

print()
print('=== 3) 与超时无关的上游 ERROR 一律不拦 ===')
fake_init, _state = make_init_hikari([('success', 'ok', False)])
bg.init_hikari = fake_init
logger.remove()
buf = io.StringIO()
logger.add(buf, level='INFO', format='{level} | {message}',
           filter=lambda r: bg._error_suppressor(r) and bg._yuyuko_timeout_filter(r))
try:
    logger.error('模板清单为空或格式不认识，本次不更新')
finally:
    logger.remove()
check('模板清单为空' in buf.getvalue(), '普通 ERROR 照常输出', buf.getvalue())

print()
print('=== 4) 捕获窗口关闭时，上游堆栈照常输出（不影响其它路径）===')
fake_init, _state = make_init_hikari([('success', 'ok', False)])
bg.init_hikari = fake_init
logger.remove()
buf = io.StringIO()
logger.add(buf, level='INFO', format='{level} | {message}',
           filter=lambda r: bg._error_suppressor(r) and bg._yuyuko_timeout_filter(r))
try:
    logger.warning(TIMEOUT_TB)          # 没有开捕获窗口
finally:
    logger.remove()
check('Traceback' in buf.getvalue(), '未开窗口时不吞堆栈', buf.getvalue()[:80])

if fails:
    print('\n失败项：')
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('\n上游超时降噪自检全部通过')
