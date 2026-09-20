# wows-helper · 战舰世界助手（QQ Agent 插件）

群里喊一句 **`@机器人 wws 大和`**（**@ 机器人与 wws 两个条件都要满足**，与官方 wws 机器人一致），
机器人就把 Hikari-core-v2（yuyuko 平台）查到的战绩**渲染成图片发出来**，
并把真实数据交给 AI，让 AI 用群里的语气接一句人话。

- 确定性型插件：提供 **1 个钩子**（`before-context`）+ **2 个工具**，放在 `plugins/wows-helper/`。
- 数据源：[wows-yuyuko/Hikari-core-v2](https://github.com/wows-yuyuko/Hikari-core-v2)（Python SDK，GPL）。
- **"认领指令"是确定性的**（规则写死，模型忽略不掉）；**"查询 + 出图 + 发图"在工具里**完成。
- Python 3.11 / 3.12 / 3.13 / 3.14 均可（实测 3.14.7 完整跑通）。

---

## 1. 它是怎么跑起来的

```
QQ 群里有人发「@机器人 wws 大和」
        │
        ▼
QQ Agent（OneBot）把消息存进 store，文本形如 "@机器人(QQ:1) wws 大和"
        │
        ▼
wows-helper 的 before-context 钩子（确定性，不经 LLM，微秒级）
  ① 判定"@ 的是不是机器人本人"（按 QQ 号优先，其次昵称）＋"第一个词是不是 wws"
  ② 记下发起人 QQ（工具执行时 ctx 里没有这个信息）
  ③ 把「【wws 指令已认领】发起人 + 指令 + 该调哪个工具」追加到那条消息后面
        │
        ▼
模型看到认领块 → 调 wows-helper__wows-query 工具（这一步由模型决定，但提示写死了）
        │
        ▼
工具 → 本地桥接服务 bridge/hikari_bridge.py（常驻，独立进程）
  · hikari_core.init_hikari() 解析指令 → 调 yuyuko API → 组装外壳 HTML
  · playwright chromium 渲染浏览器端 Nunjucks 模板并截图 → bytes
        │
        ▼
QQ Agent：数据交给模型接话；渲染图默认**直接**走发送队列发出去
          （队列 → 限频 → 去重 → 留档，一个都不少）
```

### 为什么查询放在工具里，而不是钩子里

**实测数据**（Windows / Python 3.14.7 / chromium）：

| 动作 | 耗时 |
|---|---|
| `set_hikari_config`（含首次下载浏览器 + 18MB 船图缓存） | 约 150s（仅首次，之后几乎为 0） |
| `wws me` 首次 | 39s（含浏览器安装） |
| `wws me` / `ws recent 7` / `wws ship 大和` 热态 | **5.2 ~ 13.1s** |
| 无法识别的指令 | 0.00s（纯解析、不出图） |

钩子的硬超时是 **5 秒**（`DEFAULT_HOOK_TIMEOUT_MS`），而一次真实查询要 5~13 秒，
**预取在普通机器上必然超时** —— 那样每次 `@wws` 都白等几秒再退回工具，纯亏。
所以默认 `hookPrefetch = false`：钩子只做"认领 + 交棒"，查询由工具执行（工具没有 5 秒限制）。

> 想验证这个结论、或想在自己的机器上量一遍，用 `bridge/probe_hikari.py`。

### 为什么图片默认由插件直接发，而不是"交给 Agent 选择"

模型看不到图片内容，把"这张渲染图要不要发"交给它判断，实测结果就是
"图躺在缓存里，群里什么都没有"。所以默认 `autoSendImage = true`：**查询成功即发图**，
模型只管接话。关掉它（改为 `false`）后，工具返回里会明确写"渲染图尚未发送"，
并告诉模型调用 `wows-helper__wows-send-image`。

### 为什么中间要有一个 Python 桥接服务

Hikari-core-v2 是 **Python** SDK，模板由**浏览器端 Nunjucks** 渲染后截图，
Node 侧既跑不了这个 SDK，也没有等价渲染链路。所以做成
"Node 薄客户端 + 本地常驻 Python 桥接"：Node 只管 QQ 收发与确定性触发，
Python 只管 wws 的解析与出图，两边用一个 JSON 接口（`/health`、`/query`）对话。

### `init_hikari` 的入参（已逐参数实测核对）

上游**实际签名**是 6 个参数（官方 README 只列了 5 个，漏了 `BotId`）：

```python
async def init_hikari(platform, PlatformId, BotId, command_text='', GroupId=None, Ignore_List=None)
```

| 参数 | 是否必填 | 桥接怎么传 |
|---|---|---|
| `platform` | **必填** | 插件设置「平台标识」，默认 `QQ` |
| `PlatformId` | **必填** | 触发者 QQ 号（wws 的绑定按它查） |
| `BotId` | **必填**（无默认值） | 插件设置 `botId`，默认 `0` |
| `command_text` | 有默认值 | `wws` 后面的指令正文 |
| `GroupId` | 有默认值 | 群聊传群号；私聊传 `None` |
| `Ignore_List` | 有默认值 | `--ignore-list` 解析出的**函数对象**列表 |

实测（真实 yuyuko 凭据）：按这 5 个参数调用 → `wws me` 返回 `Status=success`、
569KB JPEG；`Ignore_List=[get_BindInfo]` + `wws bind_list me` → `Status=error`
"该功能已被禁用"。复核脚本：`bridge/verify_params.py`。

---

## 2. 文件结构

```
plugins/wows-helper/
├── plugin.json                 清单（配置项 + 权限 + 提示词片段）
├── index.js                    钩子（确定性认领 + 发起人记录）与 2 个工具
├── lib/
│   ├── config.js               配置读取与兜底（执行时现读，不在 setup 快照）
│   ├── trigger.js              @提及解析（谁被 @ 了）、触发词判定、序号回复识别
│   ├── bridge.js               桥接服务客户端（真超时、错误分类、可读提示）
│   ├── image-store.js          渲染图暂存（内存 + 磁盘 + TTL + 容量上限）
│   ├── image-server.js         本地只读图片服务（127.0.0.1，token 路径，TTL）
│   └── format.js               组装"给模型看的文本"（数字照抄 / 图片状态 / 截断）
├── bridge/
│   ├── hikari_bridge.py        HTTP 桥接服务（标准库，无额外 Web 框架）
│   ├── start-bridge.ps1        Windows 一键：取源码 → 装依赖 → 装 chromium → 启动
│   ├── probe_hikari.py         兼容性/耗时探针（可选，用来量自己机器的延迟）
│   ├── verify_params.py        核对 init_hikari 入参与 Ignore_List 是否真生效
│   ├── verify_node.mjs         真实通路端到端核验（真桥接 + Node fetch）
│   ├── requirements.txt        依赖与版本说明（不要直接 pip install -r）
│   ├── test_config_mapping.py  桥接侧配置/凭据来源自检
│   └── client-test.mjs         客户端契约自检（假桥接，覆盖 6 类响应）
├── 启动桥接服务.bat             双击即用（内部调用 start-bridge.ps1）
├── selfcheck.mjs               本地逻辑自检（@提及/触发判定/格式化/图片服务，68 项）
├── e2e-test.mjs                端到端自检（假桥接跑通钩子与工具，51 项）
└── README.md                   本文件
```

运行时数据（都在插件目录内，可整体删除后重新生成）：

```
.hikari-src/           Hikari-core-v2 源码（start-bridge.ps1 下载并放宽版本上限）
.hikari-deps/          依赖安装目录（pip --target）
data/wows-yuyuko/      hikari-core 的缓存：chromium(~600MB)、船图缓存(~150MB)
```
> 注意：`plugins/` 下**不能再建共享顶层目录**（加载器只扫一级子目录），
> 所以公共代码都放在本插件自己的 `lib/` 里。

---

## 3. 部署（三步）

> **凭据怎么填？** 两条路，选一条就行：
> **A. QQ Agent 设置页**（推荐，不用碰命令行）——插件设置里的「yuyuko API 凭据」填 `账号ID:Token`，
> 插件会把它随每次查询下发给桥接服务，填完**无需重启**。
> **B. 启动参数/环境变量** —— 无人值守部署时用 `-Token` 或 `HIKARI_TOKEN`。
> 桥接服务启动时**不再强制要求**凭据（以前会直接退出，对只用图形界面的用户很不友好）；
> 两处都没有时，查询会明确提示"去插件设置里填"。

### 步骤 1 · 启动桥接服务

**方式 A：双击运行（最省事）**

```
双击 plugins\wows-helper\启动桥接服务.bat
```

首次会自动装依赖（需要几分钟），并**问你一次凭据**——不想现在填就直接回车，
之后在 QQ Agent 设置页里填也一样。窗口关掉即停止服务。

**方式 B：手动 / PowerShell**

```powershell
cd "C:\QQ-Agent 0.4\plugins\wows-helper"
powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1          # 会提示输入凭据
# 或
$env:HIKARI_TOKEN = "你的账号ID:你的Token"; powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1
```

> **Python 版本**：官方 `pyproject.toml` 写的是 `requires-python = ">=3.11,<3.13"`，
> 但它在 **3.13/3.14 上实测可用** —— 依赖（playwright 1.63、pillow 12.3、greenlet 3.5.6、
> pydantic 2.13）在 3.14 都有正式 wheel。仓库那份版本上限并没有对应的技术原因，
> 所以安装脚本会自动放宽它（见下）。官方推荐的 3.11/3.12 依然最省事。

脚本做的事：找 Python（3.11~3.14 都接受）→ 下载源码到 `.hikari-src/` 并放宽
`requires-python` → 用 `pip --target` 装到 `.hikari-deps/` → `playwright install chromium`
→ 前台启动服务（自动设好 `PYTHONPATH`）。第二次启动加 `-SkipInstall` 可跳过安装检查。

> 为什么用 `--target` 而不是 venv：部分 Windows Python 发行版不带 `ensurepip`，
> `python -m venv` 会直接失败（本机 3.14 就是这种情况）。

**方式 C：完全手动**

```bash
# 1) 取源码（PyPI 上那份 hikari-core 是旧版，与 v2 不是同一份代码）
git clone https://github.com/wows-yuyuko/Hikari-core-v2
# 2) 把 pyproject.toml 里的 requires-python 放宽（3.13/3.14 上需要）
#    requires-python = ">=3.11,<3.13"  →  ">=3.11"
pip install --target .hikari-deps ./Hikari-core-v2
set PYTHONPATH=%CD%\.hikari-deps
python -m playwright install chromium
python plugins/wows-helper/bridge/hikari_bridge.py            # 凭据可在插件设置页里填
```

> ⚠️ `pip install hikari-core` 从 PyPI 装到的是**旧项目**（pydantic v1 + jinja2 架构），
> 与 v2 仓库不是同一份代码。要用 v2 就必须从 GitHub 源码装。

常用启动参数（都有对应环境变量）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host` | `127.0.0.1` | 监听地址。**不要改成 0.0.0.0 暴露到公网** |
| `--port` | `8788` | 端口，要和插件设置里的 `bridgeUrl` 一致 |
| `--token` | 环境变量 `HIKARI_TOKEN` | yuyuko 凭据（可选：也可以只在插件设置页里填） |
| `--access-token` | 环境变量 `WOWS_HELPER_ACCESS_TOKEN` | 本服务的访问口令（可选） |
| `--ignore-list` | 空 | 禁用某些功能（写操作、更新类），见下 |
| `--game-path` | hikari-core 默认 | 缓存目录（船图/模板/浏览器数据） |
| `--proxy` | 无 | 访问 WG 的代理，如 `http://127.0.0.1:7890` |
| `--image-type` | `jpeg` | `jpeg`（快、小）/ `png`（清晰、大）/ `webp` |
| `--use-browser` | `chromium` | 渲染异常时可换 `firefox` |

启动成功的标志（`GET /health`）：

```json
{ "ok": true, "ready": true, "version": "1.2.5", "pending": 0,
  "token_configured": true, "token_source": "plugin",
  "ignored_functions": ["set_BindInfo", "change_BindInfo"] }
```

- `ready: false` 时看 `core_error`：最常见是没装 `hikari-core`，或没执行
  `playwright install chromium`（用 `start-bridge.ps1` 重跑一次安装即可）。
- `token_configured: false` 表示**还没配凭据**（启动参数没有、插件设置也是空的）：
  桥接照常运行，等你填好即可，不需要重启。

### 禁用某些功能（`--ignore-list`）

Hikari 的指令里有会**真的改动数据/文件**的写操作：`bind` / `delete_bind`（改用户在
yuyuko 的绑定）、`update_ship` / `update_style`（更新桥接侧资源）、`check_version`（拉代码）。
想关掉它们就用 `--ignore-list`：

```powershell
powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1 `
  -IgnoreList "set_BindInfo,change_BindInfo,delete_BindInfo,async_update_ship_cache,async_update_template,check_version"
```

被禁用的指令会回一句"该功能已被禁用"。

> ⚠️ **必须传函数名**（`set_BindInfo` 这种），不能传指令词（`bind`）。
> 这是上游的实现细节：`init_hikari` 内部是 `if hikari.Function in Ignore_List`，
> 比的是**函数对象**。实测传字符串 `['get_BindInfo']` **完全无效** —— 查询照常成功，
> 你会以为禁用了其实没禁。桥接侧已按函数名解析并告警解析不到的名字，
> 解析结果在 `/health` 的 `ignored_functions` 里可见（空数组 = 没禁用任何东西）。

可用的函数名：`set_BindInfo` `change_BindInfo` `delete_BindInfo` `get_BindInfo`
`set_special_BindInfo` `update_user_cache` `async_update_ship_cache` `async_update_template`
`check_version` `roll_ship` `get_sx_info` `get_BanInfo` `check_christmas_box` 等
（完整清单见 `hikari_core/commands/router.py` 的 `first_command_list`）。

### 步骤 2 · 在 QQ Agent 里打开插件并填凭据

控制台顶部 → **「插件」页签** → 找到「战舰世界助手（wws）」→ 打开开关。

然后点开它的设置，填这两项：

| 设置项 | 填什么 |
|---|---|
| **yuyuko API 凭据** | `账号ID:Token`（**必填**，除非桥接是用 `-Token` 启动的） |
| 桥接服务口令 | 只有桥接启动时带了 `--access-token` 才需要，两边填一致 |
| 桥接服务地址 | 默认 `http://127.0.0.1:8788`，与桥接的 `--port` 一致 |

> 密文字段在界面上显示为 `******`；**留空提交 = 不修改**，不会把已有值覆盖掉。
> 凭据只存在本机的 `data/config.json` 里，每次查询时才下发给桥接服务。

> 本插件 `enabledByDefault: false`，必须手动开。
> 开关打开即生效（热重载默认开启，不用重启 QQ Agent）。

### 步骤 3 · 自查

```bash
curl http://127.0.0.1:8788/health          # 期望 ready:true 且 token_configured:true
```

然后直接在群里发一句 `@机器人 wws 帮助`（或任何指令）试一次。

在插件设置里确认这几项（默认值已可用）：

| 设置项 | 默认 | 什么时候要改 |
|---|---|---|
| **`yuyukoToken`** | 空 | **必填**（除非桥接用 `-Token` 启动了）：填 `账号ID:Token` |
| `bridgeUrl` | `http://127.0.0.1:8788` | 桥接服务换了端口/机器 |
| `bridgeToken` | 空 | 桥接启动时带了 `--access-token` |
| `requireAt` | `true` | 想允许"不 @ 机器人、只打 wws"时关掉（**不建议**：群里聊到 wws 就会抢话） |
| `hookPrefetch` | `false` | 机器极快、想让钩子直接查到数据时打开（实测查询 5~13 秒，通常够不上 5 秒的钩子） |
| `autoSendImage` | `true` | 想让模型自己决定发不发图时关掉 |
| `atTriggerUser` / `replyToTrigger` | `false` | 发图时想 @ 触发者 / 引用那条指令 |
| `requestTimeoutMs` | `60000` | 网络慢、首次查询经常超时时加大 |
| `triggerKeywords` | `["wws","@wws"]` | 想换成别的触发词（改 `data/config.json`） |
| `debug` | `false` | 排查时打开，会打印认领结果与耗时 |

改完设置**不需要重启**：所有配置都是每次执行时现读的（凭据也是每次查询现取）。

---

## 4. 触发条件（两个条件缺一不可）

```
消息 @ 了机器人  ✓    且    去掉 @提及 后的第一个词是 wws  ✓
                →  认领，把指令交给 wows-query 工具
```

| 群里发 | 结果 |
|---|---|
| `@机器人 wws 大和` | ✅ 认领 |
| `@机器人(QQ:1) wws 单船 大和 recent 30` | ✅ 认领，指令 = `单船 大和 recent 30` |
| `@机器人 wws` | ✅ 认领，等于 `wws 帮助` |
| `wws 大和`（没 @） | ❌ 不认领 |
| `@机器人 大和`（没 wws） | ❌ 不认领 |
| `@队友 wws 大和`（@ 的是别人） | ❌ 不认领 |
| `@机器人 我觉得 wws 不错`（触发词在句中） | ❌ 不认领 |
| `我觉得 wws 不错` | ❌ 不认领 |

### "被 @ 的是不是机器人" 是怎么判的（4 层，从严到宽）

1. **`(QQ:机器人QQ)` 后缀精确匹配** —— 最可靠。QQ Agent 的 OneBot 文本会把 at 段还原成
   `@昵称(QQ:号)`，插件直接在**同一条消息里**学到机器人的 QQ 号（`selfId` 为空时也有效）。
   机器人 QQ 从哪来：`before-context` 钩子拿不到 `selfId`，但能从这条 `@... (QQ:n)` 里学到，
   另外还会异步问一次 `get_login_info`（只读接口）做交叉验证。
2. **昵称匹配** —— 只对**没有 QQ 后缀**的提及生效（`@机器人` / `@小八`），
   昵称取自钩子上下文或 `get_login_info`。带后缀时不会退化成按名字判 ——
   否则群里出现同名成员（实测有）就会误认领。
3. **CQ 码兜底** —— 文本里残留 `[CQ:at,qq=机器人QQ]` 时命中（极少数未归一化的路径）。

> 以上都不成立时不认领，且**不会**去猜"是不是在叫我"—— 判错方向的代价（抢话、答错人）
> 比漏答大得多。查不到机器人身份时（`get_login_info` 不可用且消息里没有 QQ 后缀），
> 只按昵称匹配，匹配不上就不响应。

### 发起人 QQ 号的 4 种来源（按优先级回退）

`wws` 的账号绑定是**按 PlatformId（触发者 QQ）** 存的，所以"谁在问"必须准。

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | **钩子记下的 `triggerEntries[].senderId`** | 当前实现用的就是它。OneBot 事件里就有，最准 |
| 2 | `ctx.trigger[0].senderId` | 工具执行时 `session.trigger` 里仍留着触发消息（`session.triggerText` 的文档里能确认这个字段），是备选来源 |
| 3 | `ctx.store.recent(chatKey, { limit })` 的最后一条 | 兜底：从存档里找最近一条非自己发的消息 |
| 4 | 配置里的 `platformIdOverride` | 主人想固定"所有人查到同一个账号"时用（如给自己配一个公共查询号） |

> 当前代码走 1，并在 miss 时回退到 `ctx.senderId`/`ctx.userId`（若核心将来补上这两个字段）。
> 之所以不用 `ctx.selfId`：那是机器人自己的 QQ，拿它去查会查到机器人账号的水表。

---

## 5. 支持的指令

指令正文就是 `wws` 后面的部分（触发词由插件剥掉，**不会**传给 Hikari）。
完整表见 [Hikari-core-v2 README](https://github.com/wows-yuyuko/Hikari-core-v2/blob/main/README.md)，
常用：

| 群里发 | 作用 |
|---|---|
| `wws me` / `wws 大和` | 查自己的水表（也可 `wws <服务器> <昵称>` 查别人） |
| `wws ship 大和` / `wws 单船 大和` | 单船水表（支持多词英文船名，如 `Jean Bart`） |
| `wws recent 30` / `wws 近期` | 近期战绩 |
| `wws ship 大和 recent 30` | 单船近期战绩 |
| `wws recents` | 单场近期战绩 |
| `wws ship.rank cn 大和` | 单船排行榜 |
| `wws cw.rank [赛季]` | 军团战排行榜 |
| `wws clan <服务器> <公会TAG>` | 公会信息 |
| `wws bind <服务器> <昵称>` | 绑定游戏账号（绑定按 QQ 号存） |
| `wws roll 日本 战列舰 10` | 随机抽船 |
| `wws sx` / `wws ban` / `wws box` | 扫雪 / 封禁记录 / 圣诞船池 |
| `wws help` / `wws 帮助` | H5 帮助页 |

**多选续查**：出现重名舰船之类的情况时 Hikari 会返回 `wait`，插件会把待选项发进群，
用户在**下一句 @ 机器人后回数字**（`2`、`选 2`、`第2个` 都认）即自动带上下文续查 ——
不需要用户重新打 `wws`。要求 @ 是因为群里连着两句"2"太常见，没 @ 就不能算续查。

---

## 6. 实现上的几个关键取舍

**① 钩子只做"确定性认领"，不发消息、不查网络（默认）。**
钩子有 5 秒硬超时（`doc/extend_development/plugin-development.md` §3.2）。
实测一次 wws 查询 5~13 秒，塞不进钩子，所以默认 `hookPrefetch=false`：
钩子只做纯文本判定（微秒级）并把"发起人 + 指令 + 该调哪个工具"写进上下文。
若你打开 `hookPrefetch`，插件会用 `AbortController` 在 `hookPrefetchTimeoutMs`（上限 4.5s）
内**真正掐断**请求 —— 否则被放弃的 fetch 会继续占着桥接侧的渲染进程，
群里连发几条就堆一串僵尸查询。

**② 图片走发送队列，三级通道。**
`ctx.sender.sendImage` 依次尝试：本地文件路径（协议端读盘，body 最小）→
本地图片服务 URL → base64 内联。三条都只是给它一个图片来源，
**队列 / 限频 / 去重 / 留档一个都不少**；全程不碰 `onebot.send*`。

**③ 本地图片服务是"只读 + token + 只本机"。**
只认 `GET /wows/<token>`，token 是随机串，TTL 到期即 404 并删文件，
响应里没有目录列举也没有写入接口，默认绑 `127.0.0.1`。
端口被占用时会自动退回 file/base64 通道，不会让整个功能失效。

**④ 触发判定宁可不触发。** 群里聊到 wws 三个字母是常态，抢话比漏答更糟：
触发词必须在最前，且必须 @ 了机器人本人。（`lib/trigger.js` 里记了三个真实踩到的
解析坑：惰性量词吃错昵称、括号群名片与 QQ 后缀的二义、短号被位数下限挡掉。）

**⑤ 桥接侧兼容上游的参数名笔误。**
`set_hikari_config` 的参数是 `use_broswer`（少一个 w）。插件侧统一用正确的
`use_browser`，由桥接按实际签名做同义映射 —— 否则 `use_browser` 会被签名过滤
**静默丢掉**，表现为"设置里选了 firefox 却一直用 chromium"。

---

## 7. 自检与排障

```bash
# 本地逻辑自检（68 项：@提及解析/触发判定/边界用例/格式化/图片服务；不需要网络与 Python）
node plugins/wows-helper/selfcheck.mjs

# 端到端自检（51 项：起假桥接，跑通"钩子认领"与"工具查询+自动发图"两条链路）
node plugins/wows-helper/e2e-test.mjs

# 桥接客户端契约自检（28 项：success/wait/failed/error/超时/口令/会话键）
node plugins/wows-helper/bridge/client-test.mjs

# 桥接侧配置映射自检（上游 use_broswer 笔误的兼容）
python plugins/wows-helper/bridge/test_config_mapping.py

# 桥接服务探活（ready=false 时看 core_error 字段）
curl http://127.0.0.1:8788/health

# 量自己机器上的真实查询耗时
set PYTHONPATH=%CD%\.hikari-deps
python plugins/wows-helper/bridge/probe_hikari.py "账号ID:Token"

# 核对 init_hikari 入参与 Ignore_List 是否真生效（需要装好依赖）
python plugins/wows-helper/bridge/verify_params.py "账号ID:Token"

# 真实通路端到端核验：起真桥接 → Node fetch 查询 → 查凭据下发 / 禁用清单
node plugins/wows-helper/bridge/verify_node.mjs 32941 "账号ID:Token" python
```

最近一次真实通路的实测结果（Windows / Python 3.14.7 / chromium，浏览器热态）：

```
[health] ready=true token_configured=true ignored_functions=["set_BindInfo","change_BindInfo","delete_BindInfo"]
[1] wws me（凭据由请求下发）  success  source=plugin      556KB  14.4s
[2] wws me（再查一次）        success  source=plugin      556KB  11.2s
[3] wws delete_bind 1（被禁）  error    该功能已被禁用
[4] wws bind_list me（未禁）   success                      53KB   2.1s
```

> 注：`verify_node.mjs` 用 `stdio: 'inherit'` 拉子进程 —— 受限沙箱里 Node 的管道
> stdio 会 `EPERM`（DSH 的已知边界），所以它不捕获桥接日志，直接打在控制台。

| 现象 | 原因 | 修法 |
|---|---|---|
| 回复里出现"还没有配置 yuyuko API 凭据" | 插件设置里没填、桥接也没用 `-Token` 启动 | 在插件设置页填「yuyuko API 凭据」（`账号ID:Token`），填完无需重启 |
| 发 `@机器人 wws 大和` 完全没反应 | 插件没启用 / 没 @ 机器人 / 触发词没写在最前 | 「插件」页确认"生效中"；打开 `debug`，日志会写明是"未 @ 机器人"还是"触发词不在最前" |
| @ 别人时机器人不响应，但它确实该回应 | **设计如此**：只认领 @ 机器人本人的消息 | 想放宽就把 `requireAt` 关掉 |
| 认领了，但模型没查、只回一句空话 | 模型没有调工具 | 提示词片段里已写死"必须调 wows-query"；`debug` 里能看到是否发起查询 |
| 工具返回"桥接服务没启动或地址不对" | 桥接没跑 / 端口不对 | 启动 `hikari_bridge.py`，核对 `bridgeUrl` |
| 工具返回"响应超时" | 首次查询要下载浏览器与船图缓存 | 加大 `requestTimeoutMs`；先手动跑一次 `probe_hikari.py` 预热 |
| 上下文里写"预取超时" | 打开了 `hookPrefetch` 但查询太慢 | 关掉 `hookPrefetch`（默认就是关的），交给工具 |
| `ready: false` | 没装 hikari-core / 没装 chromium | 用 `start-bridge.ps1` 重跑一次安装；看 `core_error` |
| 图画出来了但发不出去 | 协议端与本机不同机，读不到本地文件 | 插件会自动回退到本地图片服务 URL / base64；必要时把 `imageServerHost` 改成协议端能访问的地址 |
| 图片服务启动失败 | 端口被占用 | 换 `imageServerPort`，或关掉 `serveImage`（自动走 file/base64） |
| 模型重复发同一张图 | `autoSendImage` 关着又反复调工具 | 打开 `autoSendImage`；发送队列本身也会按去重拦下 |
| 用户回了数字但没续查 | 回复里没 @ 机器人 | 让他 `@机器人 2`；或关掉 `requireAt` |

排障时先打开插件的 `debug` 开关，日志里能看到：认领了哪条指令（含原因）、
是否发起查询、耗时、图片大小。

---

## 8. 已知限制

- **桥接服务必须常驻**。QQ Agent 不会替你拉起 Python 进程（那等于在本项目里塞一个
  语言运行时托管器）。建议单独开一个窗口，或注册成计划任务/服务。
- **首次查询慢**。要下载 chromium 与 18MB 船图缓存（实测约 150 秒），
  之后每次 5~13 秒。`ready: true` 只代表配置好了，不代表已经预热。
- **渲染依赖浏览器**。playwright chromium 装不上时只能拿到文本数据（关掉 `autoImage`），
  不会有图。
- **令牌与缓存都在本机**。建议用环境变量 `HIKARI_TOKEN`，不要把令牌写进会提交到 git 的文件。
  桥接启动时 hikari-core 会在工作目录下生成 `data/wows-yuyuko/`（chromium 约 600MB +
  船图缓存约 150MB，实测可直接复用）+ `checkAdmin.txt`（本地管理员校验串）+
  `ship_cache_hash.json`。除缓存外都不含密钥，但 `checkAdmin.txt` 是一次性的校验串，
  不需要时删掉即可；整个 `data/` 删掉会在下次查询时自动重建（代价是重新下载）。
- **本插件只做"转发"，不区分指令的读写性质**。除查询类指令外，Hikari 还支持
  `bind` / `delete_bind`（会真的改动用户在 yuyuko 的绑定数据）、
  `update_ship` / `update_style` / `check_version`（会更新桥接侧的资源与代码）。
  当前实现**原样转发所有指令**，没有额外的权限闸门 —— 只在群里 @ 机器人时才会走这条路。
  部署到公共群、或与不确定的群友共用时，请自行评估；需要严格限制可在
  `lib/trigger.js` 的 `matchTrigger` 之后加一层指令白名单（改一处即可生效）。

---

## 9. 参考

- [QQ Agent 确定性型插件开发文档](../../doc/extend_development/plugin-development.md)
- [QQ Agent 共同机制参考（api / ctx / 硬约束）](../../doc/extend_development/skill-reference.md)
- [Hikari-core-v2](https://github.com/wows-yuyuko/Hikari-core-v2) —— 指令表、`set_hikari_config` 全参数
