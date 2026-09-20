"""桥接服务 apply_config 的参数映射自检（不需要真的装 hikari-core）。

验证两件事：
  1. 上游把参数拼成 use_broswer（少一个 w）时，我们传的 use_browser 能被映射过去
     —— 否则会被 inspect 过滤静默丢掉，表现为"选了 firefox 却一直用 chromium"
  2. 不支持的键被安全丢弃，不会抛 TypeError

用法：python bridge/test_config_mapping.py
"""
import sys
import types

# 用假的 hikari_core 顶替真包：只需要 set_hikari_config 这个签名
fake = types.ModuleType('hikari_core')


def set_hikari_config(token=None, image_type='jpeg', use_broswer='chromium', command_language='zh',
                      game_path='', proxy=None, auto_rendering=True, auto_image=True, http2=True):
    set_hikari_config.called = dict(
        token=token, image_type=image_type, use_broswer=use_broswer, command_language=command_language,
        game_path=game_path, proxy=proxy, auto_rendering=auto_rendering, auto_image=auto_image, http2=http2,
    )


set_hikari_config.called = {}
fake.set_hikari_config = set_hikari_config
# 桥接模块顶部会 import 这几个名字，必须齐全，否则走的是"导入失败"分支
fake.Hikari_Model = type('Hikari_Model', (), {})
fake.callback_hikari = lambda *a, **k: None
fake.init_hikari = lambda *a, **k: None
fake.__version__ = '1.2.5'
sys.modules['hikari_core'] = fake

import importlib.util  # noqa: E402
import pathlib  # noqa: E402

path = pathlib.Path(__file__).with_name('hikari_bridge.py')
spec = importlib.util.spec_from_file_location('hikari_bridge_under_test', path)
bridge = importlib.util.module_from_spec(spec)
sys.argv = ['hikari_bridge.py', '--token', 'fake:token']
spec.loader.exec_module(bridge)

fails = []

bridge.apply_config({'image_type': 'webp', 'use_browser': 'firefox', 'http2': False, 'unknown_key': 'x'})
called = set_hikari_config.called
print('called =', called)
if called.get('use_broswer') != 'firefox':
    fails.append(f'use_browser 未映射到 use_broswer（实际 {called.get("use_broswer")!r}）')
if called.get('image_type') != 'webp':
    fails.append('image_type 未透传')
if called.get('http2') is not False:
    fails.append('http2 未透传')
if 'unknown_key' in called:
    fails.append('未知键没有被过滤')

# 上游改名成正确拼写时也要能用
def set_hikari_config2(token=None, use_browser='chromium'):  # noqa: N802
    set_hikari_config2.called = dict(token=token, use_browser=use_browser)


set_hikari_config2.called = {}
bridge.set_hikari_config = set_hikari_config2
bridge.apply_config({'use_browser': 'firefox'})
print('called(2) =', set_hikari_config2.called)
if set_hikari_config2.called.get('use_browser') != 'firefox':
    fails.append('上游用正确拼写 use_browser 时未透传')

if fails:
    print('\n失败：')
    for f in fails:
        print('  -', f)
    sys.exit(1)

# ── 凭据来源：插件设置 vs 启动参数 ─────────────────────────────────────────────
# 这是"用户不会敲命令行"时唯一的通路，必须单独验证优先级。
# ⚠️ 先把 set_hikari_config 换回上面那个带 token 参数的 fake —— 上一个用例为了测
#    "上游改名"把它换成了 set_hikari_config2，而 apply_config 是动态取模块属性的。
bridge.set_hikari_config = set_hikari_config
fails = []
for label, argv_token, override, expect in [
    ('插件设置优先于启动参数', 'cli:token', 'plugin:token', 'plugin:token'),
    ('插件留空则回落启动参数', 'cli:token', '', 'cli:token'),
    ('两处都没有 → 不传 token（调用方据此报错）', '', '', None),
]:
    bridge.ARGS = types.SimpleNamespace(
        token=argv_token, access_token='', image_type='jpeg', use_browser='chromium',
        command_language='zh', game_path='', proxy='', host='127.0.0.1', port=0,
    )
    set_hikari_config.called = {}
    bridge.apply_config({'hikari_token': override})
    got = set_hikari_config.called.get('token')
    got_source = bridge.ACTIVE_TOKEN_SOURCE
    expect_source = {'plugin:token': 'plugin', 'cli:token': 'bridge-arg', None: ''}[expect]
    # 注意 fake 的 set_hikari_config(token=None) 默认值是 None：没传 token 时它不进 called
    ok = got == expect and got_source == expect_source
    print(f'{"OK " if ok else "FAIL"} {label}: token={got!r} source={got_source!r} '
          f'(expect token={expect!r} source={expect_source!r})')
    if not ok:
        fails.append(label)

if fails:
    print('\n失败：')
    for f in fails:
        print('  -', f)
    sys.exit(1)

# ── 没配凭据时：查询必须给出"去插件设置里填"的人话，而不是上游的未授权 ──────────────
import asyncio  # noqa: E402


async def _run_no_token_case():
    bridge.ARGS = types.SimpleNamespace(
        token='', access_token='', image_type='jpeg', use_browser='chromium',
        command_language='zh', game_path='', proxy='', host='127.0.0.1', port=0,
    )
    try:
        await bridge.call_hikari(command='me', platform='QQ', platform_id='1', bot_id='0',
                                 group_id=None, select_index=None, session_key=None,
                                 config_overrides={})
        return '（没有抛错，不符合预期）'
    except RuntimeError as exc:
        return str(exc)


msg = asyncio.run(_run_no_token_case())
print('无凭据报错 =', msg)
ok = ('yuyuko API 凭据' in msg) and ('插件设置' in msg or '--token' in msg)
print(('OK  ' if ok else 'FAIL ') + '无凭据时给出可照做的提示')
if not ok:
    print('\n失败：无凭据的报错不友好')
    sys.exit(1)

# ── Node 侧要能识别这句话并换成中文指引（正则不能泛泛匹配）──────────────────────
node_re = '没有配置 yuyuko API 凭据'
print(('OK  ' if node_re in msg else 'FAIL ') + f'报错含 Node 侧识别用的关键字（{node_re}）')
if node_re not in msg:
    sys.exit(1)

print('\n参数映射 + 凭据来源 + 无凭据提示 自检通过')
