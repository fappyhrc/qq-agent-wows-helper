"""模板清单同步自保层自检：瞬时失败重试一次、traceback 降级为一行 WARNING、确定性失败不吞。

不需要真网络、也不需要真 hikari_core：用假的 `hikari_core.features.system.update_template`
驱动 `sync_templates_quietly()`，并用 loguru 的临时 sink 断言"到底打了什么日志"。

loguru 只装在 `.hikari-deps` 里（桥接真实运行时靠 PYTHONPATH 拿到它），所以本脚本会在
缺依赖时自动用正确的 PYTHONPATH 重新执行自己。

用法：python bridge/test_template_sync.py
"""
import importlib.util
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve()
DEPS = HERE.parent.parent / '.hikari-deps'

# ── 自举：把 .hikari-deps 挂上 PYTHONPATH 再重跑，保证拿到与桥接一致的依赖 ──────────
if importlib.util.find_spec('loguru') is None and os.environ.get('WOWS_TEST_BOOTSTRAPPED') != '1':
    if not DEPS.is_dir():
        print(f'缺少依赖目录 {DEPS}，请先运行 bridge/start-bridge.ps1 完成安装')
        sys.exit(2)
    env = dict(os.environ)
    env['PYTHONPATH'] = os.pathsep.join([str(DEPS)] + ([env['PYTHONPATH']] if env.get('PYTHONPATH') else []))
    env['WOWS_TEST_BOOTSTRAPPED'] = '1'
    os.execve(sys.executable, [sys.executable, str(HERE)], env)

import types

# ── 假 hikari_core：桥接只用到顶层这几个名字 ─────────────────────────────────
fake = types.ModuleType('hikari_core')
fake.Hikari_Model = type('Hikari_Model', (), {})
fake.callback_hikari = lambda *a, **k: None
fake.init_hikari = lambda **kwargs: None
fake.set_hikari_config = lambda **kwargs: None
fake.__version__ = '1.2.5-test'
sys.modules['hikari_core'] = fake

# features.system 子模块：桥接会 import 它并取 update_template
fake_system = types.ModuleType('hikari_core.features.system')
sys.modules['hikari_core.features.system'] = fake_system
# 假包必须是"真包"才有子模块可 import：hikari_core/__init__.py 里没有 import features，
# 只有真实的 hikari_core 因为加载过子模块才有这个属性。手工补上并登记 features 包。
fake_features = types.ModuleType('hikari_core.features')
fake_features.system = fake_system
fake.features = fake_features
sys.modules['hikari_core.features'] = fake_features

spec = importlib.util.spec_from_file_location('bg', HERE.with_name('hikari_bridge.py'))
bg = importlib.util.module_from_spec(spec)
sys.argv = ['hikari_bridge.py']
spec.loader.exec_module(bg)

assert bg._IS_LOGURU, '本用例依赖 loguru 才能断言日志内容'
from loguru import logger

fails = []


def check(cond, name, extra=''):
    print(('OK   ' if cond else 'FAIL ') + name + ('' if cond else f'   {extra}'))
    if not cond:
        fails.append(name)


def install_scenario(fn):
    """把一个假的 update_template 装成"上游实现"，并让自保层忘掉之前的缓存。

    ⚠️ 顺序很重要：必须先清缓存、再赋给 fake_system.update_template，
    否则 sync_templates_quietly 里 install_template_sync_guard() 会把上一次用例的
    函数包进去，本次剧本根本不会被调用（本文件实测踩过这个坑）。
    """
    bg._template_sync.pop('original', None)
    bg._template_sync.pop('guard_installed', None)
    fake_system.update_template = fn


def reset(delay=0.0):
    """每个用例前重置自保层状态，并让重试没有等待时间（跑得快）。

    ⚠️ `clear()` 已经删掉了 `done` 键，不要再写回 `done = False`：那样虽然也能跑，
    但只要有人把它写成 `True`，所有用例都会在 sync_templates_quietly 的第一行提前返回，
    表现为"场景函数一次都没被调用"（本文件实测踩过）。
    """
    bg._template_sync.clear()
    bg.TEMPLATE_SYNC_RETRY_DELAY_S = delay


def run_capture():
    """执行一次 sync_templates_quietly()，返回 ``[(级别, 文本), ...]``。

    观测口径必须和**真实启动**一致：真实环境里外层 sink 带 :func:`bg._error_suppressor`
    过滤，因此自保层抑制窗口内那条上游 ERROR 根本不会出现在用户视野里；本函数给观测 sink
    挂同一个 filter，才能如实反映"用户看到了什么"。
    """
    bg._template_sync.pop('original', None)      # 让桥接重新取一次，拿到本用例的剧本
    return run_capture_plain(with_sync=True)


def run_capture_plain(with_sync=False):
    """挂观测 sink 并执行；``with_sync`` 决定是否走 sync_templates_quietly()。

    第二个参数供"直接调上游 update_template"的用例使用（验证上游那次调用也被接管）。
    ⚠️ 这里**不能**再 pop `original`：那会把 install_scenario 刚缓存好的剧本清掉，
    导致调用走到真上游（表现为"场景一次都没被执行"）。
    """
    seen = []
    # 观测 sink 必须带上与桥接输出 sink **相同**的抑制 filter，否则它会把被抑制的
    # ERROR 也记下来，让"用户看不到 traceback"这类断言假失败（实测踩过）。
    sink = logger.add(lambda m: seen.append((m.record['level'].name, str(m))),
                      level='INFO', format='{message}',
                      filter=lambda r: bg._error_suppressor(r))
    try:
        if with_sync:
            bg.sync_templates_quietly()
        else:
            fake_system.update_template()
    finally:
        logger.remove(sink)
    return seen


def get(seen, level, needle):
    """取出指定级别、且正文含 needle 的记录。"""
    return [t for lvl, t in seen if lvl == level and needle in t]


# 实测到的那条 traceback 的关键内容（httpx 在 TLS 握手上超时）
_TIMEOUT_TB = (
    'Traceback (most recent call last):\n'
    '  File ".../httpx/_transports/default.py", line 101, in map_httpcore_exceptions\n'
    '    raise mapped_exc(message) from exc\n'
    'httpx.ConnectTimeout: _ssl.c:1064: The handshake operation timed out'
)
_FILE_TIMEOUT = ("模板 wws-ship-v6.html 更新失败: "
                 "HTTPSConnectionPool(host='hikari-resource.oss-cn-shanghai.aliyuncs.com', "
                 "port=443): Read timed out.")

print('=== 1) 瞬时 / 确定性失败判定 ===')
cases = [
    ([_TIMEOUT_TB], True, 'httpx 握手超时 traceback'),
    ([_FILE_TIMEOUT], True, '单个模板下载超时'),
    (['请求超时了，请稍后再试'], True, '含"超时"'),
    (['模板清单为空或格式不认识，本次不更新'], False, '清单为空（确定性）'),
    (['OCError: disk I/O error'], False, '磁盘错误（确定性）'),
    (["模板清单里有可疑的键，已忽略: '../x'"], False, '清单键非法（确定性）'),
    ([], False, '空日志'),
]
for msgs, expect, label in cases:
    got = bg.template_failure_is_transient(msgs)
    check(got == expect, f'{label} → 瞬时={expect}', f'实际={got}')

print()
print('=== 1b) 降级判定 record_is_benign_transport_failure（必须是"Traceback + 网络类型"）===')
benign_cases = [
    (_TIMEOUT_TB, True, '拉清单时的 ConnectTimeout traceback'),
    ('Traceback (most recent call last):\n  File "x", line 1\nRuntimeError: boom', False,
     '有 Traceback 但不是网络故障（应保留 ERROR）'),
    (_FILE_TIMEOUT, False, '单个模板文件下载失败（无 Traceback，应保留 ERROR）'),
    ('模板清单为空或格式不认识，本次不更新', False, '清单为空'),
    ('OCError: disk I/O error', False, '磁盘错误'),
    ('', False, '空文本'),
]
for text, expect, label in benign_cases:
    got = bg.record_is_benign_transport_failure(text)
    check(got == expect, f'{label} → 无害={expect}', f'实际={got}')

print()
print('=== 1c) 重试判定 is_retryable_manifest_failure（只有拉清单失败才重试）===')
retry_cases = [
    ([_TIMEOUT_TB], True, '拉清单失败（有 Traceback）'),
    ([_FILE_TIMEOUT], False, '只有单个文件失败 → 不重试同一个坏文件'),
    (['模板清单为空或格式不认识，本次不更新'], False, '清单为空 → 不重试'),
    ([], False, '没有日志'),
]
for msgs, expect, label in retry_cases:
    got = bg.is_retryable_manifest_failure(msgs)
    check(got == expect, f'{label} → 重试={expect}', f'实际={got}')

print()
print('=== 2) 同步成功：不产生任何日志（避免每次配置都刷屏）===')
reset()
state = {'n': 0}


def ok_once():
    state['n'] += 1
    return True


install_scenario(ok_once)
seen = run_capture()
check(state['n'] == 1, '只调用 1 次', f"实际 {state['n']}")
check(seen == [], '无任何日志输出', f'seen={seen}')

print()
print('=== 3) 瞬时失败：重试 1 次后仍失败 → 只有一行 WARNING，没有 ERROR ===')
reset()
calls = {'n': 0}


def always_timeout():
    calls['n'] += 1
    logger.error(_TIMEOUT_TB)          # 模拟上游：内部 logger.error(traceback)
    return False


install_scenario(always_timeout)
seen = run_capture()
warns = [t for lvl, t in seen if lvl == 'WARNING']
check(calls['n'] == 2, '首次 + 重试 = 2 次调用', f"实际 {calls['n']}")
check(not get(seen, 'ERROR', 'Traceback'), '没有 ERROR 级的 traceback 泄漏', f'seen={seen}')
check(len(warns) == 1, '恰好 1 行 WARNING', f'warn={warns}')
check(bool(warns) and '本地模板' in warns[0], '提示继续使用本地模板', f'warn={warns}')
check(bool(warns) and 'handshake operation timed out' in warns[0], 'WARNING 带一行原因摘要', f'warn={warns}')
check(bool(warns) and 'Traceback' not in warns[0], 'WARNING 是单行、不含堆栈', f'warn={warns}')

print()
print('=== 3b) 只有个别模板文件失败：不重试，且保留 ERROR（不能降级）===')
reset()
calls = {'n': 0}


def one_file_fails():
    calls['n'] += 1
    logger.error(_FILE_TIMEOUT)        # 上游对个别文件是逐条 logger.error(f'模板 …')
    return False


install_scenario(one_file_fails)
seen = run_capture()
check(calls['n'] == 1, '不重试（重试同一个坏文件没意义）', f"实际 {calls['n']}")
check(len(get(seen, 'ERROR', 'ws-ship-v6.html')) == 1, 'ERROR 被保留', f'seen={seen}')

print()
print('=== 4) 瞬时失败后重试成功：给出提示且不算失败 ===')
reset()
state = {'n': 0}


def fail_then_ok():
    state['n'] += 1
    if state['n'] == 1:
        logger.error(_TIMEOUT_TB)
        return False
    return True


install_scenario(fail_then_ok)
seen = run_capture()
warns = [t for lvl, t in seen if lvl == 'WARNING']
check(state['n'] == 2, '调用了 2 次', f"实际 {state['n']}")
check(not get(seen, 'ERROR', 'Traceback'), '没有 ERROR 级的 traceback 泄漏', f'seen={seen}')
check(len(warns) == 1 and '重试后已同步完成' in warns[0], '一行"重试后已同步完成"', f'warn={warns}')

print()
print('=== 5) 确定性失败：原样保留 ERROR，绝不吞掉（也不能重试）===')
reset()
state = {'n': 0}


def deterministic_fail():
    state['n'] += 1
    logger.error('模板清单为空或格式不认识，本次不更新')
    return False


install_scenario(deterministic_fail)
seen = run_capture()
replayed = get(seen, 'ERROR', '清单为空')
check(state['n'] == 1, '不重试（确定性故障重试无意义）', f"实际 {state['n']}")
check(len(replayed) >= 1, 'ERROR 被保留（用户仍能看到原报错）', f'seen={seen}')
check(all(not t.endswith('\n\n') for t in replayed), '重放时不留多余空行', f'{replayed}')
check(not [t for lvl, t in seen if lvl == 'WARNING'], '不产生"已跳过"的 WARNING（避免误导）', f'seen={seen}')

print()
print('=== 6) 幂等：每个进程只检查一次（不能每次查询都白等一次超时）===')
reset()
state = {'n': 0}


def counting_ok():
    state['n'] += 1
    return True


install_scenario(counting_ok)
for _ in range(3):
    bg.sync_templates_quietly()
check(state['n'] == 1, '调用三次只真正同步一次', f"实际 {state['n']}")

print()
print('=== 7) 上游函数缺失时不影响流程 ===')
reset()
saved = fake_system.update_template
del fake_system.update_template
seen = run_capture()
check(seen == [], '无任何日志（视为"无事发生"）', f'seen={seen}')
install_scenario(saved)

print()
print('=== 8) 上游函数直接抛网络异常：也只会变成一行 WARNING（绝不让桥接起不来）===')
reset()
state = {'n': 0}


class ConnectTimeout(Exception):
    """名字刻意与 httpx 的透明网络异常一致：真实场景里抛出来的就是它。"""


def raising():
    state['n'] += 1
    raise ConnectTimeout('_ssl.c:1064: The handshake operation timed out')


install_scenario(raising)
seen = run_capture()
warns = [t for lvl, t in seen if lvl == 'WARNING']
check(state['n'] == 2, '同样重试了一次', f"实际 {state['n']}")
check(not get(seen, 'ERROR', 'Traceback'), '没有 ERROR 级 traceback 泄漏', f'seen={seen}')
check(bool(warns) and '本地模板' in warns[0], '降级为一行 WARNING', f'warn={warns}')

print()
print('=== 9) 上游自己那次 update_template() 也被接管（本机实测漏过的关键路径）===')
# 场景：自保层已同步过（done=True），随后上游 set_hikari_config 内部再调一次
# upgrade_template()。未接管时它会在抑制窗口之外把整段 traceback 打进启动日志。
reset()
calls = {'n': 0}


def upstream_sync():
    calls['n'] += 1
    logger.error(_TIMEOUT_TB)
    return False


install_scenario(upstream_sync)
installed = bg.install_template_sync_guard()
check(installed, '自保版安装成功', f'installed={installed}')
check(fake_system.update_template is not upstream_sync, '模块属性已被替换', '')

bg._template_sync['done'] = True             # 模拟"启动期已经同步过"
seen = run_capture_plain()                   # 不经过 sync_templates_quietly，直接调上游那次
errs = [t for lvl, t in seen if lvl == 'ERROR']
check(calls['n'] == 0, '重复调用被短路（不再打网络请求）', f"实际 {calls['n']}")
check(not errs, '不产生任何 ERROR', f'err={errs}')

print()
print('=== 10) 上游那次调用若真失败：同样只留一行 WARNING ===')
reset()
calls = {'n': 0}
install_scenario(upstream_sync)
bg.install_template_sync_guard()
seen = run_capture_plain()                   # reset() 已清掉 done → 走真实同步路径
warns = [t for lvl, t in seen if lvl == 'WARNING']
check(calls['n'] == 1, '调用了一次', f"实际 {calls['n']}")
check(not [t for lvl, t in seen if lvl == 'ERROR'], '没有 ERROR 泄漏', f'seen={seen}')
check(bool(warns) and '本地模板' in warns[0], '降级为一行 WARNING', f'warn={warns}')

print()
print('=== 11) 续查会话查找：精确优先、同会话回退、跨会话不串 ===')
# 依据实测事故：会话键是 <chatKey>#<platformId>，而首次查询的 platformId 是"被查对象"，
# 续查的 platformId 是"触发者"（工具路径）——同一个会话算出两个键，续查必然落空，
# 群里表现就是"回了序号又弹一次选择列表、始终没有图"。
class _FakeHikari:
    def __init__(self, tag):
        self.tag = tag


bg.PENDING.clear()
bg.pending_put('group:1#2000000001', _FakeHikari('wait-对象是别人'))
check(bg.pending_get('group:1#2000000001').tag == 'wait-对象是别人', '精确键命中')
check(bg.pending_get('group:1#2000000002').tag == 'wait-对象是别人',
      '键不同但同会话 → 回退命中（这就是修复点）')
check(bg.pending_get('group:2#2000000001') is None, '不同会话 → 不回退（不串会话）')
check(bg.pending_get('') is None, '空键 → None')

# 回退取"最新"的那一个；精确键永远优先
bg.PENDING.clear()
bg.pending_put('group:1#111', _FakeHikari('旧'))
import time as _t
_t.sleep(0.01)
bg.pending_put('group:1#222', _FakeHikari('新'))
check(bg.pending_get('group:1#999').tag == '新', '同会话多个挂起项时取最新')
check(bg.pending_get('group:1#111').tag == '旧', '精确键仍然优先于"最新"')
bg.PENDING.clear()

if fails:
    print('\n失败项：')
    for f in fails:
        print('  -', f)
    sys.exit(1)
print('\n模板同步自保层自检全部通过')
