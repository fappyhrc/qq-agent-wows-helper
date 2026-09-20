# wows-helper · 战舰世界助手

> **QQ Agent 插件** · 仓库 <https://github.com/fappyhrc/qq-agent-wows-helper>（私有）
> 群里发 `@机器人 wws 大和`，机器人把 Hikari-core-v2（yuyuko 平台）查到的战绩
> **渲染成图片发出来**，并把真实数据交给 AI，由 AI 用群里的语气接一句人话。

| 项目 | 说明 |
|---|---|
| 类型 | 确定性型插件（`before-context` 钩子）+ 2 个 LLM 工具 |
| 放置位置 | `plugins/wows-helper/` |
| 数据源 | [wows-yuyuko/Hikari-core-v2](https://github.com/wows-yuyuko/Hikari-core-v2)（Python SDK，GPL） |
| 运行前提 | Python 3.11~3.14（实测 3.14.7 可用）+ 本地常驻桥接服务 |
| 默认状态 | **关闭**（`enabledByDefault: false`，需在「插件」页手动开启） |

**目录**

- [1. 它解决什么问题](#1-它解决什么问题)
- [2. 架构与设计决策](#2-架构与设计决策)
- [3. 文件结构](#3-文件结构)
- [4. 部署](#4-部署)
- [5. 可用指令](#5-可用指令)
- [6. 触发判定与身份解析](#6-触发判定与身份解析)
- [7. 配置项](#7-配置项)
- [8. 实测性能](#8-实测性能)
- [9. 实现取舍](#9-实现取舍)
- [10. 自检与排障](#10-自检与排障)
- [11. 已知限制](#11-已知限制)
- [12. 参考](#12-参考)

---

## 1. 它解决什么问题

直接让模型"自己想办法查战舰世界数据"有三个不可控点：

1. **可能不查**。模型判断"我没有数据"，回一句"聊点别的吧"。
2. **可能编造**。战绩、胜率、场次是最忌讳幻觉的一类查询。
3. **可能发不出去**。渲染图需要走完整发送管道（队列/限频/去重/留档），
   模型不知道这层约束。

因此本插件把链路拆成两段，各用各的扩展机制：

- **确定性一段**（`before-context` 钩子）：判定「@ 了机器人本人」+「去掉 @提及 后
  第一个词是 `wws`」，命中即**必然**认领 —— 不经过模型，模型忽略不掉。
- **LLM 一段**（`wows-query` 工具）：工具是模型唯一能主动发起查询的入口；
  数据到手后由模型决定怎么接话。

---

## 2. 架构与设计决策

### 2.1 数据流

```
QQ 群里有人发「@机器人 wws 大和」
        │
        ▼
QQ Agent（OneBot）解析消息，文本形如 "@机器人(QQ:1) wws 大和"
        │
        ▼
before-context 钩子（确定性，微秒级，默认不发网络请求）
  ① 判定「@ 的是不是机器人本人」+「第一个词是不是 wws」
  ② 记下发起人 QQ（工具执行时的 ctx 里没有这个信息）
  ③ 把「【wws 指令已认领】发起人 + 指令 + 该调哪个工具」追加到该条消息
        │
        ▼
模型读到认领块 → 调用 wows-helper__wows-query 工具
        │
        ▼
bridge/hikari_bridge.py（本地常驻，独立进程）
  · hikari_core.init_hikari() 解析指令 → 调用 yuyuko API 取数据
  · 组装外壳 HTML → playwright chromium 渲染浏览器端 Nunjucks 模板 → 截图
        │
        ▼
查询成功：数据交给模型接话；渲染图默认**由插件直接**经发送队列发出
          （队列 → 限频 → 去重 → 留档，一个都不少）
```

### 2.2 为什么需要一层 Python 桥接服务

Hikari-core-v2 是 Python SDK，且**渲染链路完全在浏览器里**（模板由浏览器端 Nunjucks
渲染，Python 只组装外壳 HTML 并用 playwright 截图）。Node 侧既无法运行该 SDK，
也没有等价的渲染能力。

因此采用「Node 薄客户端 + 本地常驻 Python 桥接」：Node 负责 QQ 收发与确定性触发，
Python 负责 wws 的解析与出图，两侧通过一个 JSON 接口（`/health`、`/query`）通信。
接口契约（请求/响应字段、状态码语义、凭据优先级）写在
`bridge/hikari_bridge.py` 的模块 docstring 里 —— 那是唯一的权威定义。

### 2.3 为什么查询放在工具里，而不是钩子里

钩子的硬超时是 **5 秒**，而一次真实查询需要 **5~13 秒**（见 [§8 实测性能](#8-实测性能)）。
把查询放进钩子必然超时，结果是"每次 `@wws` 白等几秒，再退回工具重查一遍"，
净亏一倍时间。因此 `hookPrefetch` 默认关闭，钩子只做零网络的文本判定，
查询交给没有时限的工具。

### 2.4 为什么渲染图默认由插件直接发

模型看不到图片内容。把"这张图要不要发"交给它判断，实测结果是
**"图躺在缓存里、群里什么都没有"**。因此默认 `autoSendImage = true`：
查询成功即走 `ctx.sender.sendImage` 发出，模型只负责接话。
关闭该项后，工具返回里会写明"渲染图尚未发送"并指出应调用哪个工具。

---

## 3. 文件结构

```
plugins/wows-helper/
├── plugin.json                 清单：31 项设置 + configSchema + 权限 + 提示词片段
├── index.js                    入口：钩子（确定性认领）+ 2 个工具
├── lib/
│   ├── config.js               配置读取（每次现读，不在 setup 快照）
│   ├── trigger.js              @提及解析、触发判定、序号续查识别（纯函数，可单测）
│   ├── bridge.js               桥接客户端（真超时、错误分类、凭据下发）
│   ├── format.js               面向模型的文本组装（数字照抄 / 图片状态 / 截断）
│   ├── image-store.js          渲染图暂存（内存 + 磁盘 + TTL + 容量上限）
│   └── image-server.js         本地只读图片服务（127.0.0.1 / token 路径 / TTL）
├── bridge/
│   ├── hikari_bridge.py        桥接服务（标准库 HTTP，接口契约见其 docstring）
│   ├── start-bridge.ps1        一键部署：取源码 → 装依赖 → 装 chromium → 启动
│   ├── create-repo.mjs         用 API 建仓库（幂等；首次发布用，之后不需要）
│   ├── probe_hikari.py         兼容性与耗时探针（在你自己机器上量一遍）
│   ├── verify_params.py        核对 init_hikari 入参与 Ignore_List 是否真生效
│   ├── verify_node.mjs         真实通路端到端核验（真桥接 + Node fetch）
│   ├── test_config_mapping.py  桥接侧配置映射与凭据来源自检
│   └── client-test.mjs         客户端契约自检（假桥接，覆盖 6 类响应）
├── selfcheck.mjs               本地逻辑自检（68 项）
├── e2e-test.mjs                端到端自检（55 项，需起本地 HTTP 假桥接）
├── 启动桥接服务.bat              双击即用（内部调用 start-bridge.ps1）
├── push-to-github.ps1          推送到 GitHub（含本机两个环境坑的绕法）
├── .precommit-scan.mjs         提交前扫描：凭据 / 异常大文件
├── .gitignore / .gitattributes 版本库排除清单与跨平台约定
└── README.md                   本文件
```

**运行时数据**（均在插件目录内，已被 `.gitignore` 排除，可整体删除后重新生成）：

| 路径 | 体积 | 说明 |
|---|---|---|
| `.hikari-src/` | ~1 MB | `start-bridge.ps1` 下载的 Hikari-core-v2 源码 |
| `.hikari-deps/` | ~145 MB | `pip --target` 安装的依赖 |
| `data/wows-yuyuko/` | ~740 MB | hikari-core 缓存：chromium、船图、模板 |

---

## 4. 部署

### 4.1 启动桥接服务

**方式 A：双击运行（最省事）**

```
双击 plugins\wows-helper\启动桥接服务.bat
```

首次会自动安装依赖（数分钟），并询问一次凭据 —— 不想现在填可直接回车，
之后在 QQ Agent 设置页里填亦可。窗口关闭即停止服务。

**方式 B：PowerShell**

```powershell
cd "C:\QQ-Agent 0.4\plugins\wows-helper"
powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1          # 会提示输入凭据
# 或
$env:HIKARI_TOKEN = "你的账号ID:你的Token"
powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1 -SkipInstall
```

脚本执行的步骤：定位 Python（3.11~3.14）→ 下载源码到 `.hikari-src/` 并放宽
`requires-python` → 用 `pip --target` 安装到 `.hikari-deps/` →
`playwright install chromium` → 前台启动服务（自动设置 `PYTHONPATH`）。

> **为何用 `--target` 而非 venv**：部分 Windows Python 发行版不带 `ensurepip`，
> `python -m venv` 会直接失败（本机 3.14 即如此）。
>
> **为何要放宽版本上限**：上游 `pyproject.toml` 声明 `requires-python = ">=3.11,<3.13"`，
> 但该上限并无对应技术原因 —— 依赖（playwright 1.63 / pillow 12.3 / greenlet 3.5.6 /
> pydantic 2.13）在 3.13、3.14 都有正式 wheel，实测可在 3.14.7 上完整跑通。

**方式 C：完全手动**

```bash
git clone https://github.com/wows-yuyuko/Hikari-core-v2
# 将 pyproject.toml 中 requires-python = ">=3.11,<3.13" 改为 ">=3.11"（3.13/3.14 需要）
pip install --target .hikari-deps ./Hikari-core-v2
set PYTHONPATH=%CD%\.hikari-deps
python -m playwright install chromium
python plugins/wows-helper/bridge/hikari_bridge.py
```

> ⚠️ **不要直接 `pip install hikari-core`**：PyPI 上那个包是**旧项目**
> （pydantic v1 + jinja2 架构），与本插件使用的 v2 仓库不是同一份代码。

### 4.2 启动参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host` | `127.0.0.1` | 监听地址。**不要改为 `0.0.0.0` 暴露到公网** |
| `--port` | `8788` | 端口，须与插件设置里的 `bridgeUrl` 一致 |
| `--token` | 环境变量 `HIKARI_TOKEN` | yuyuko 凭据；也可完全依赖插件设置页填写 |
| `--access-token` | 环境变量 `WOWS_HELPER_ACCESS_TOKEN` | 本服务的访问口令（可选） |
| `--ignore-list` | 空 | 禁用指定功能，见 §4.3 |
| `--game-path` | hikari-core 默认 | 缓存目录 |
| `--proxy` | 无 | 访问 WG 的代理，如 `http://127.0.0.1:7890` |
| `--image-type` | `jpeg` | `jpeg`（快、小）/ `png`（清晰、大）/ `webp` |
| `--use-browser` | `chromium` | 渲染异常时可换 `firefox` |
| `--command-language` | `zh` | 指令提示语言 `zh` / `en` |
| `--log-level` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |

### 4.3 禁用写操作类指令（`--ignore-list`）

Hikari 的部分指令会**真的改动数据或文件**：`bind` / `delete_bind`（修改用户在 yuyuko
的绑定）、`update_ship` / `update_style`（更新桥接侧资源）、`check_version`（拉取代码）。
需要关闭时：

```powershell
powershell -ExecutionPolicy Bypass -File bridge\start-bridge.ps1 `
  -IgnoreList "set_BindInfo,change_BindInfo,delete_BindInfo,async_update_ship_cache,async_update_template,check_version"
```

被禁用的指令会返回"该功能已被禁用"。

> ⚠️ **必须传函数名**（`set_BindInfo`），不能传指令词（`bind`）。
> 上游实现是 `if hikari.Function in Ignore_List`，比较的是**函数对象**；
> 实测传字符串 `['get_BindInfo']` **完全无效**（查询照常成功），
> 会造成"以为禁用了其实没禁"的静默失效。
> 桥接侧会按名字解析并告警无法解析的项，实际生效结果可在 `/health` 的
> `ignored_functions` 字段确认。

可用函数名：`set_BindInfo` `change_BindInfo` `delete_BindInfo` `get_BindInfo`
`set_special_BindInfo` `update_user_cache` `async_update_ship_cache`
`async_update_template` `check_version` `roll_ship` `get_sx_info` `get_BanInfo`
`check_christmas_box` 等（完整清单见上游 `hikari_core/commands/router.py`）。

### 4.4 在 QQ Agent 中启用并配置

控制台顶部 → **「插件」页签** → 找到「战舰世界助手（wws）」→ 打开开关 → 打开其设置：

| 设置项 | 填写内容 |
|---|---|
| **yuyuko API 凭据** | `账号ID:Token`（**必填**，除非桥接以 `-Token` 启动） |
| 桥接服务地址 | 默认 `http://127.0.0.1:8788`，与桥接 `--port` 一致 |
| 桥接服务口令 | 仅当桥接启动时带了 `--access-token` 才需要，两边必须相同 |

> 密文字段在界面上显示为 `******`；**留空提交 = 不修改**，不会覆盖已有值。
> 凭据仅存在于本机 `data/config.json`，在每次查询时下发给桥接服务，填完无需重启。

### 4.5 部署自查

```bash
curl http://127.0.0.1:8788/health
```

期望得到 `ready: true` 且 `token_configured: true`（`core_error` 为 `null`）。
随后在群里发 `@机器人 wws 帮助` 验证。

---

## 5. 可用指令

指令正文即 `wws` 之后的部分（触发词由插件剥离，不会传给 Hikari）。
完整指令表见 [Hikari-core-v2 README](https://github.com/wows-yuyuko/Hikari-core-v2/blob/main/README.md)，
常用如下：

| 群里发送 | 作用 |
|---|---|
| `wws me` / `wws 大和` | 查询自己的水表（`wws <服务器> <昵称>` 可查他人） |
| `wws ship 大和` / `wws 单船 大和` | 单船水表（支持多词英文船名，如 `Jean Bart`） |
| `wws recent 30` / `wws 近期` | 近期战绩 |
| `wws ship 大和 recent 30` | 单船近期战绩 |
| `wws recents` | 单场近期战绩 |
| `wws ship.rank cn 大和` | 单船排行榜 |
| `wws cw.rank [赛季]` | 军团战排行榜 |
| `wws clan <服务器> <公会TAG>` | 公会信息 |
| `wws bind <服务器> <昵称>` | 绑定游戏账号（绑定按 QQ 号存储） |
| `wws roll 日本 战列舰 10` | 随机抽船 |
| `wws sx` / `wws ban` / `wws box` | 扫雪收益 / 封禁记录 / 圣诞船池 |
| `wws help` / `wws 帮助` | H5 帮助页 |

**多选续查**：当上游返回 `wait`（如舰船重名），插件会把待选项发进群；
用户在下一句 **@机器人 后回复数字**（`2`、`选 2`、`第2个` 均识别）即自动带上下文续查，
无需重新输入 `wws`。要求 @ 是因为群里连续两句"2"是常态，没有 @ 不足以判定为续查。

---

## 6. 触发判定与身份解析

### 6.1 触发条件（两个条件缺一不可）

```
消息 @ 了机器人本人  ✓    且    去掉 @提及 后第一个词是 wws  ✓
                      →  认领，交给 wows-query 工具
```

| 群里发送 | 结果 |
|---|---|
| `@机器人 wws 大和` | ✅ 认领 |
| `@机器人(QQ:1) wws 单船 大和 recent 30` | ✅ 认领，指令 = `单船 大和 recent 30` |
| `@机器人 wws` | ✅ 认领，等同 `wws 帮助` |
| `wws 大和`（未 @） | ❌ 不认领 |
| `@机器人 大和`（无 wws） | ❌ 不认领 |
| `@队友 wws 大和`（@ 的是别人） | ❌ 不认领 |
| `@机器人 我觉得 wws 不错`（触发词在句中） | ❌ 不认领 |
| `我觉得 wws 不错` | ❌ 不认领 |

> 设计取向是**宁可不触发**：群里聊到 `wws` 三个字母是常态，抢话的代价高于漏答。
> 判定失败时只在 `debug` 日志里留一条原因，不做任何猜测。

### 6.2 「被 @ 的是不是机器人」如何判定

按顺序判定，命中即返回：

1. **带 `(QQ:n)` 后缀的提及** —— 仅当 `n` 属于已知的机器人 QQ 号时命中。
   QQ 号是唯一身份，最可靠。
2. **不带 QQ 后缀的提及**（如 `@机器人`）—— 名字等于已知昵称/人设名时命中。
3. **CQ 码兜底** —— 文本中残留 `[CQ:at,qq=机器人QQ]` 时命中（极少数未归一化的路径）。

带 QQ 后缀的提及**不会**再退回按名字判定：`@机器人(QQ:999)` 名字虽然相同，
但 QQ 明确指向他人 —— 群里确实出现过同名成员，按名字判会误认领。

机器人自身 QQ 的来源，按以下顺序获取：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | 钩子上下文的 `selfId` | 最直接，但并非所有版本都会传入 |
| 2 | 消息文本推断 | `@机器人 wws` 中紧邻触发词的提及即机器人。**只学 QQ 号、绝不学昵称** —— 否则 `@群友 wws 大和` 会把群友名字记成机器人昵称 |
| 3 | `get_login_info`（只读接口） | 后台异步补问，失败后每 60 秒可重试一次 |

### 6.3 发起人 QQ 号的来源

`wws` 的账号绑定按 `PlatformId`（触发者 QQ）存储，因此"谁在问"必须准确。
工具执行时的 `ctx` 中**没有**发送者 QQ，故由钩子在认领时记录：

| 优先级 | 来源 |
|---|---|
| 1 | 钩子记录的 `triggerEntries[].senderId`（当前实现） |
| 2 | `ctx.trigger[0].senderId`（工具执行时 `session.trigger` 仍在） |
| 3 | `ctx.store.recent(chatKey)` 中最近一条非自身消息 |
| 4 | 配置项 `platformIdOverride`（固定查询某一账号） |

> 不使用 `ctx.selfId`：那是机器人自己的 QQ，用它查询会得到机器人账号的数据。

---

## 7. 配置项

在「插件 → 战舰世界助手」设置页修改，**改完无需重启**（配置每次执行时现读）。

| 设置项 | 默认 | 何时需要修改 |
|---|---|---|
| **`yuyukoToken`** | 空 | **必填**（除非桥接以 `-Token` 启动） |
| `bridgeUrl` | `http://127.0.0.1:8788` | 桥接服务端口或地址变更 |
| `bridgeToken` | 空 | 桥接启动时带了 `--access-token` |
| `requireAt` | `true` | 允许"不 @ 机器人、只打 wws"时关闭（**不建议**：会抢话） |
| `hookPrefetch` | `false` | 机器极快、希望钩子直接返回数据时开启（见 §2.3） |
| `autoSendImage` | `true` | 希望由模型决定是否发图时关闭 |
| `atTriggerUser` / `replyToTrigger` | `false` | 发图时 @ 触发者 / 引用原指令 |
| `requestTimeoutMs` | `60000` | 网络较慢、首次查询频繁超时时调大 |
| `includeDataInContext` | `true` | 不希望把数据文本注入提示词时关闭 |
| `serveImage` | `true` | 端口冲突等情况下可关闭（自动退回 file/base64） |
| `imageServerPort` | `32801` | 端口冲突时更换 |
| `triggerKeywords` | `["wws","@wws"]` | 换用其它触发词（需编辑 `data/config.json`） |
| `debug` | `false` | 排查问题：打印认领结果、耗时与图片大小 |

其余设置项（平台标识、出图格式、缓存目录、代理、浏览器、`--ignore-list` 对应项等）
见 `plugin.json` 的 `configSchema`，每项均带说明。

---

## 8. 实测性能

环境：Windows 10 / Python 3.14.7 / chromium / 真实 yuyuko 凭据。
数据来自 `bridge/probe_hikari.py` 与 `bridge/verify_node.mjs`，可复现。

| 场景 | 耗时 | 备注 |
|---|---|---|
| 首次 `set_hikari_config` | **~150 s** | 下载 chromium（约 600 MB）与船图缓存（18 MB），一次性 |
| 首次查询（依赖已装） | 13~15 s | 含浏览器冷启动 |
| 热态 `wws me` | **11~13 s** | 水表长图，模板复杂 |
| 热态 `wws ship 大和` | 6.4 s | |
| 热态 `wws recent 7` | 5.2 s | |
| 热态 `wws bind_list me` | **2.1 s** | 简单列表模板（53 KB 图） |
| 无法识别的指令 | 0.00 s | 纯解析、不出图 |

耗时几乎全部集中在**页面加载/模板渲染**阶段；截图本身仅 0.07~0.34 s，
yuyuko API 取数 0.3~1.5 s。因此"渲染型长图约 10 秒、简单模板 2~3 秒"的差异
来自模板复杂度，而非机器性能。

**用户体感**：部署后的第一次查询需 1~3 分钟（一次性成本）；
桥接启动后首次查询 10~15 秒；此后热态 5~13 秒（简单结果约 2 秒）。
查询期间群里不会出现"卡住"感 —— 图片由插件直接发出，模型随后接话。

---

## 9. 实现取舍

**① 钩子只做确定性认领，默认零网络请求。**
钩子有 5 秒硬超时（见
[plugin-development.md §3.2](../../doc/extend_development/plugin-development.md)）。
实测查询 5~13 秒塞不进钩子，故默认 `hookPrefetch=false`：钩子只做纯文本判定
（微秒级）并注入"发起人 + 指令 + 该调哪个工具"。若开启该项，插件会用
`AbortController` 在 `hookPrefetchTimeoutMs`（上限 4.5 s）内**真正掐断**请求 ——
否则被放弃的请求仍会占用桥接侧的渲染进程，连发几条指令即堆积僵尸查询。

**② 图片走发送队列，三级来源依次回退。**
`ctx.sender.sendImage` 依次尝试：本地文件路径（协议端读盘，body 最小）→
本地图片服务 URL → base64 内联。三条都只是给它一个图片来源，
**队列 / 限频 / 去重 / 留档一个都不少**，全程不触碰 `onebot.send*`。

**③ 本地图片服务是"只读 + token + 仅本机"。**
仅接受 `GET`/`HEAD` 与 `/wows/<token>` 一条路径，token 为随机串，过期即 404 并删除文件；
无目录列举、无写入接口，默认绑定 `127.0.0.1`。端口被占用时自动降级，
不影响其余功能。

**④ 触发判定宁可不触发。**
（见 §6.1。）`lib/trigger.js` 中记录了三处实际踩过的解析陷阱：
惰性量词吃错昵称、括号群名片与 QQ 后缀的二义、短号被位数下限挡住 ——
修改该文件前建议先读那段注释。

**⑤ 桥接侧兼容上游的参数名笔误。**
上游 `set_hikari_config` 的浏览器参数拼作 `use_broswer`（少一个 w）。
插件侧统一使用正确的 `use_browser`，由桥接按实际签名做同义映射 ——
否则该参数会被签名过滤**静默丢弃**，表现为"设置里选了 firefox 却一直使用 chromium"。

**⑥ 凭据随查询下发，而非只认启动参数。**
yuyuko 凭据的**主通路是插件设置页**：它让不敲命令行、不配环境变量的用户也能完成配置。
启动参数 `--token` 保留给无人值守部署；两处都没有时，查询会返回一条
"去哪里填"的明确提示，而不是让上游抛出"未授权"。

---

## 10. 自检与排障

### 10.1 自检脚本

```bash
# 本地逻辑自检（68 项：@提及解析 / 触发判定 / 边界用例 / 文本组装 / 图片服务）
# 不需要网络，也不需要 Python
node plugins/wows-helper/selfcheck.mjs

# 端到端自检（55 项：起本地假桥接，跑通"钩子认领"与"工具查询+自动发图"两条链路）
node plugins/wows-helper/e2e-test.mjs

# 桥接客户端契约自检（28 项：success/wait/failed/error/超时/口令/会话键）
node plugins/wows-helper/bridge/client-test.mjs

# 桥接侧配置映射与凭据来源自检（含上游 use_broswer 笔误的兼容）
python plugins/wows-helper/bridge/test_config_mapping.py

# 提交前扫描：检查是否误纳入凭据或异常大文件
node plugins/wows-helper/.precommit-scan.mjs
```

### 10.2 真实环境核验

```bash
# 桥接服务探活（ready=false 时查看 core_error）
curl http://127.0.0.1:8788/health

# 在你自己机器上测量真实查询耗时
set PYTHONPATH=%CD%\.hikari-deps
python plugins/wows-helper/bridge/probe_hikari.py "账号ID:Token"

# 核对 init_hikari 入参、以及 Ignore_List 是否真的生效
python plugins/wows-helper/bridge/verify_params.py "账号ID:Token"

# 真实通路端到端：起真桥接 → Node fetch 查询 → 核验凭据下发与禁用清单
node plugins/wows-helper/bridge/verify_node.mjs 32941 "账号ID:Token" python
```

最近一次真实通路核验结果：

```
[health] ready=true token_configured=true
         ignored_functions=["set_BindInfo","change_BindInfo","delete_BindInfo"]
[1] wws me（凭据随请求下发）  success  source=plugin   556KB  14.4s
[2] wws me（再次查询）         success  source=plugin   556KB  11.2s
[3] wws delete_bind 1（已禁用） error    「该功能已被禁用」
[4] wws bind_list me（未禁用）  success                   53KB   2.1s
```

> `verify_node.mjs` 使用 `stdio: 'inherit'` 启动子进程：受限沙箱环境下
> Node 的管道 stdio 会 `EPERM`，故它不捕获桥接日志，而是直接输出到控制台。

### 10.3 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 回复中出现"还没有配置 yuyuko API 凭据" | 插件设置未填，且桥接未以 `-Token` 启动 | 在插件设置页填写「yuyuko API 凭据」，填完无需重启 |
| 发 `@机器人 wws 大和` 完全无反应 | 插件未启用 / 未 @ 机器人 / 触发词不在最前 | 确认「插件」页状态为"生效中"；打开 `debug`，日志会写明具体原因 |
| @ 他人时机器人不响应 | **设计如此**：仅认领 @ 机器人本人的消息 | 需要放宽则关闭 `requireAt` |
| 已认领但模型未查询、只回一句空话 | 模型未调用工具 | 提示词片段已写死该要求；`debug` 日志可确认是否发起查询 |
| 返回"桥接服务没启动或地址不对" | 桥接未运行 / 端口不一致 | 启动 `hikari_bridge.py`，核对 `bridgeUrl` |
| 返回"响应超时" | 首次查询需下载浏览器与船图缓存 | 调大 `requestTimeoutMs`；或先运行一次 `probe_hikari.py` 预热 |
| 上下文出现"预取超时" | 开启了 `hookPrefetch` 但查询较慢 | 关闭该项（默认已关闭），交给工具执行 |
| `/health` 返回 `ready: false` | 未装 hikari-core 或 chromium | 重新运行 `start-bridge.ps1`；查看 `core_error` 字段 |
| 图片已生成但发送失败 | 协议端与本机不同机，读不到本地文件 | 插件会自动回退到本地图片服务 URL 或 base64；必要时把 `imageServerHost` 改为协议端可访问的地址 |
| 图片服务启动失败 | 端口被占用 | 更换 `imageServerPort`，或关闭 `serveImage`（自动走 file/base64） |
| 模型重复发送同一张图 | `autoSendImage` 关闭后反复调用工具 | 开启 `autoSendImage`；发送队列本身也会按去重拦截 |
| 用户回复了数字但没有续查 | 回复中未 @ 机器人 | 让其使用 `@机器人 2`；或关闭 `requireAt` |

排障时建议先开启插件的 `debug` 开关：日志会记录认领了哪条指令（含判定原因）、
是否发起查询、耗时以及图片大小。

---

## 11. 已知限制

- **桥接服务必须常驻**。QQ Agent 不会代为拉起 Python 进程（那相当于在 Node 项目中
  托管一个语言运行时）。建议单独开一个终端窗口，或注册为计划任务/服务。
- **首次查询较慢**。需下载 chromium 与 18 MB 船图缓存（实测约 150 秒），
  之后每次 5~13 秒。`/health` 的 `ready: true` 只表示依赖就绪，不代表已预热。
- **渲染依赖浏览器**。playwright chromium 安装失败时只能获得文本数据
  （需关闭 `autoImage`），不会有图片。
- **本插件只做转发，不区分指令的读写性质**。除查询外，Hikari 还支持
  `bind` / `delete_bind`（修改用户在 yuyuko 的绑定）与
  `update_ship` / `update_style` / `check_version`（更新桥接侧资源与代码）。
  当前实现原样转发所有指令，仅以"群里 @ 机器人才会触发"作为准入。
  需要严格限制时使用 `--ignore-list`（见 §4.3）。
- **令牌与缓存均为本机文件**。建议通过环境变量 `HIKARI_TOKEN` 传递凭据，
  避免写入会提交到 git 的文件。桥接启动后会在工作目录生成
  `data/wows-yuyuko/`（浏览器与船图缓存）与 `checkAdmin.txt`（一次性管理校验串）；
  整个 `data/` 可删除，下次查询会自动重建（代价是重新下载）。

---

## 12. 参考

- [QQ Agent 确定性型插件开发文档](../../doc/extend_development/plugin-development.md)
- [QQ Agent 共同机制参考（api / ctx / 硬约束）](../../doc/extend_development/skill-reference.md)
- [Hikari-core-v2](https://github.com/wows-yuyuko/Hikari-core-v2)
  —— 指令表、`set_hikari_config` 全部参数
- 桥接接口契约：见 `bridge/hikari_bridge.py` 模块 docstring
