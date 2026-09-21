# qq-agent-yuyuko-helper 开发文档 · 战舰世界助手（yuyuko）

> **这是开发文档**（架构、设计取舍、自检脚本、排障细节）。只是想把插件用起来的话，
> 请看面向使用者的 [`README.md`](README.md)。
>
> **QQ Agent 插件** · 仓库 <https://github.com/fappyhrc/qq-agent-yuyuko-helper>（公开）
> 群里发 `@机器人 yuyuko ship 大和`，机器人把 Hikari-core-v2 查到的战绩
> **渲染成图片发出来**，并把真实数据交给 AI，由 AI 用群里的语气接一句人话。

| 项目 | 说明 |
|---|---|
| 类型 | 确定性型插件（`before-context` 钩子）+ 2 个 LLM 工具 |
| 放置位置 | `plugins/yuyuko-helper/` |
| 数据源 | [wows-yuyuko/Hikari-core-v2](https://github.com/wows-yuyuko/Hikari-core-v2)（Python SDK，GPL） |
| 运行前提 | Python 3.11~3.14（实测 3.14.7 可用）+ 本地常驻桥接服务 |
| 默认状态 | **关闭**（`enabledByDefault: false`，需在「插件」页手动开启） |

**目录**

- [0. 文档分工](#0-文档分工)
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

## 0. 文档分工

本插件有两份文档，职责不重叠：

| 文档 | 读者 | 内容 |
|---|---|---|
| [`README.md`](README.md) | **使用者** | 怎么装、怎么开、群里怎么用、设置项是什么意思、出问题先看哪里 |
| `DEVELOPMENT.md`（本文件） | 维护者 / 二次开发者 | 架构与数据流、为什么这样设计、文件结构、自检脚本、真实环境核验、日志判读、已知限制 |

面向使用者的说明**只在 README 里写一遍**，本文件不再重复；反过来，本文件里的
实测数据、上游行为分析、踩坑记录也不往 README 里搬 —— 那会让用户手册变得无法阅读。

---

## 1. 它解决什么问题

直接让模型"自己想办法查战舰世界数据"有三个不可控点：

1. **可能不查**。模型判断"我没有数据"，回一句"聊点别的吧"。
2. **可能编造**。战绩、胜率、场次是最忌讳幻觉的一类查询。
3. **可能发不出去**。渲染图需要走完整发送管道（队列/限频/去重/留档），
   模型不知道这层约束。

因此本插件把链路拆成两段，各用各的扩展机制：

- **确定性一段**（`before-context` 钩子）：判定「@ 了机器人本人」+「去掉 @提及 后
  第一个词是 `yuyuko`」，命中即**必然**认领 —— 不经过模型，模型忽略不掉。
- **LLM 一段**（`wows-query` 工具）：工具是模型唯一能主动发起查询的入口；
  数据到手后由模型决定怎么接话。

---

## 2. 架构与设计决策

### 2.1 数据流

```
QQ 群里有人发「@机器人 yuyuko ship 大和」
        │
        ▼
QQ Agent（OneBot）解析消息，文本形如 "@机器人(QQ:1) yuyuko ship 大和"
        │
        ▼
before-context 钩子（确定性，微秒级，默认不发网络请求）
  ① 判定「@ 的是不是机器人本人」+「第一个词是不是 yuyuko」
  ② 记下发起人 QQ（工具执行时的 ctx 里没有这个信息）
  ③ 把「【yuyuko 指令已认领】发起人 + 指令 + 该调哪个工具」追加到该条消息
        │
        ▼
模型读到认领块 → 调用 yuyuko-helper__wows-query 工具（前缀是插件 id，短名保留 `wows-`，见 §3）
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
把查询放进钩子必然超时，结果是"每次 `@机器人 yuyuko …` 白等几秒，再退回工具重查一遍"，
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
plugins/yuyuko-helper/
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
│   ├── test_render_retry.py    渲染失败识别与自动重试自检
│   ├── test_template_sync.py   模板清单同步自保层自检（重试 / 降级 / 不吞错）
│   ├── test_render_guard.py    渲染等待兜底自检（networkidle 超时放过 / DOM 判据）
│   ├── test_upstream_noise.py  上游超时堆栈降噪自检（抖动不刷屏 / 失败才补打）
│   ├── test_yuyuko_timeout.py  yuyuko 短超时补时自检（只补那一个接口 / 不降低已有超时）
│   └── client-test.mjs         客户端契约自检（假桥接，覆盖 6 类响应）
├── selfcheck.mjs               本地逻辑自检（87 项）
├── e2e-test.mjs                端到端自检（80 项，需起本地 HTTP 假桥接）
├── 启动桥接服务.bat              双击即用（内部调用 start-bridge.ps1）
├── .precommit-scan.mjs         提交前扫描：凭据 / 异常大文件
├── .gitignore / .gitattributes 版本库排除清单与跨平台约定
├── README.md                   面向使用者的手册（安装 / 使用 / 配置 / 常见问题）
└── DEVELOPMENT.md              本文件（开发文档：架构 / 取舍 / 自检 / 排障）
```

**命名对照**（四方习惯不同，最容易搞混，先看这张表）：

| 场合 | 用的名字 | 说明 |
|---|---|---|
| 仓库名 | `qq-agent-yuyuko-helper` | GitHub 仓库（旧名 `qq-agent-wows-helper`，GitHub 侧自动重定向） |
| 部署目录 | `plugins/yuyuko-helper/` | 与仓库名对齐 |
| 插件清单 `id` | `yuyuko-helper` | 设置页配置、`data/config.json` 的键、禁用清单都按它索引 |
| 工具名前缀 | `yuyuko-helper__wows-query`、`yuyuko-helper__wows-send-image` | 前缀由插件 `id` 拼出（核心逻辑见 `src/plugin-loader.js`）；**短名保留 `wows-`**：工具语义确实是"查 World of Warships" |
| 提示词片段 id | `yuyuko-helper-rules` | 同上，随 `id` 走 |
| 触发词 | `yuyuko` | 只有它；`wws` 不是触发词 |
| 上游（Hikari-core-v2） | `wws` | 上游自身的帮助页与文档仍这么写，照它把 `wws` 换成 `yuyuko` |

> 一句话记法：**群友看得见的一律 `yuyuko`；工具短名与上游原文保留 `wows`/`wws`。**
>
> ⚠️ 本次把 `id` 从 `wows-helper` 改成了 `yuyuko-helper`，这属于**破坏性变更**：
> 旧 id 下的设置不会自动跟过来。本机已顺带把 `data/config.json` 里的键手工迁移
> （见 §4.5），别人的机器需要重填一次「yuyuko API 凭据」并重新开启插件。

**运行时数据**（均在插件目录内，已被 `.gitignore` 排除，可整体删除后重新生成）：

| 路径 | 体积 | 说明 |
|---|---|---|
| `.hikari-src/` | ~1 MB | `start-bridge.ps1` 下载的 Hikari-core-v2 源码（含自带的 31 个模板文件） |
| `.hikari-deps/` | ~145 MB | `pip --target` 安装的依赖；**渲染真正使用的 54 个模板文件在 `hikari_core/Template`** |
| `data/wows-yuyuko/` | ~740 MB | hikari-core 缓存：chromium、船图（`ship_cache`，1902 个文件） |

> 模板不是运行时从网络拉的：它跟 hikari-core 一起安装进 `.hikari-deps/hikari_core/Template`
> （43 个 `.html` + 5 个 `.css` + 5 个 `.js` + 1 个许可文件，约 4.0 MB）。网络只用于
> "检查有没有新版本"，拉不到清单不影响出图 —— 详见 §10.5。

---

## 4. 部署

### 4.1 启动桥接服务

**方式 A：双击运行（最省事）**

```
双击 plugins\yuyuko-helper\启动桥接服务.bat
```

首次会自动安装依赖（数分钟），并询问一次凭据 —— 不想现在填可直接回车，
之后在 QQ Agent 设置页里填亦可。窗口关闭即停止服务。

**方式 B：PowerShell**

```powershell
cd "C:\QQ-Agent 0.4\plugins\yuyuko-helper"
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
python plugins/yuyuko-helper/bridge/hikari_bridge.py
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
| `--render-retry` | `1` | 渲染失败自动重试次数（`0` 关闭），见 §10.4 |
| `--render-retry-delay-ms` | `1200` | 重试前等待毫秒数 |
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

控制台顶部 → **「插件」页签** → 找到「战舰世界助手（yuyuko）」→ 打开开关 → 打开其设置：

| 设置项 | 填写内容 |
|---|---|
| **yuyuko API 凭据** | `账号ID:Token`（**必填**，除非桥接以 `-Token` 启动） |
| 桥接服务地址 | 默认 `http://127.0.0.1:8788`，与桥接 `--port` 一致 |
| 桥接服务口令 | 仅当桥接启动时带了 `--access-token` 才需要，两边必须相同 |

> 密文字段在界面上显示为 `******`；**留空提交 = 不修改**，不会覆盖已有值。
> 凭据仅存在于本机 `data/config.json`，在每次查询时下发给桥接服务，填完无需重启。

### 4.5 从旧 id 迁移配置（只在改过 `id` 时需要，做一次即可）

插件 `id` 从 `wows-helper` 改为 `yuyuko-helper` 后，旧设置不会自动跟过来：
不迁移的表现是"插件显示已启用，但每次查询都提示没配凭据"。

**先关掉 QQ Agent**（改配置时它会回写 `data/config.json`，边改边写容易互相覆盖），
然后编辑 `data/config.json`，把 `plugins` 下这个键**只改键名、整块值原样保留**：

```jsonc
{
  "plugins": {
    "yuyuko-helper": {          // ← 原来是 "wows-helper"，值一个字都不用动
      "enabled": true,
      "yuyukoToken": "账号ID:Token",
      "...": "其余调优项照旧"
    }
  }
}
```

也可以用一条命令做（先备份，再解析 JSON 校验，避免手改漏了逗号）：

```powershell
$p = 'data/config.json'
Copy-Item $p "$p.bak" -Force
node -e "const fs=require('fs');const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,'utf8'));const P=j.plugins||j.skills;if(P['wows-helper']&&!P['yuyuko-helper']){P['yuyuko-helper']=P['wows-helper'];delete P['wows-helper'];fs.writeFileSync(f,JSON.stringify(j,null,2));console.log('已迁移');}else{console.log('无需迁移或已迁移');}" $p
```

迁移后 `data/config.json` 里不应再有 `wows-helper` 这个键。

### 4.6 部署自查

```bash
curl http://127.0.0.1:8788/health
```

期望得到 `ready: true` 且 `token_configured: true`（`core_error` 为 `null`）。
随后在群里发 `@机器人 yuyuko help` 验证。

---

## 5. 可用指令

指令正文即**触发词之后**的部分（触发词由插件剥离，不会传给 Hikari-core-v2）。
完整指令表见 [Hikari-core-v2 README](https://github.com/wows-yuyuko/Hikari-core-v2/blob/main/README.md)，
常用如下：

| 群里发送 | 作用 |
|---|---|
| `yuyuko me` | 查询自己的水表（`yuyuko <服务器> <昵称>` 可查他人） |
| `yuyuko ship 大和` / `yuyuko 单船 大和` | 单船水表（支持多词英文船名，如 `Jean Bart`） |
| `yuyuko recent 30` / `yuyuko 近期` | 近期战绩 |
| `yuyuko ship 大和 recent 30` | 单船近期战绩 |
| `yuyuko recents` | 单场近期战绩 |
| `yuyuko ship.rank cn 大和` | 单船排行榜 |
| `yuyuko cw.rank [赛季]` | 军团战排行榜 |
| `yuyuko clan <服务器> <公会TAG>` | 公会信息 |
| `yuyuko bind <服务器> <昵称>` | 绑定游戏账号（绑定按 QQ 号存储） |
| `yuyuko roll 日本 战列舰 10` | 随机抽船 |
| `yuyuko sx` / `yuyuko ban` / `yuyuko box` | 扫雪收益 / 封禁记录 / 圣诞船池 |
| `yuyuko help` / `yuyuko 帮助` | H5 帮助页 |

> ⚠️ **表里原来的写法是 `wws`**：上游自身的帮助页与文档至今仍用 `wws` 作示例，
> 那不是本插件的触发词。把上表的 `yuyuko` 换成 `wws` 后直接发给机器人**不会被认领**；
> 同理，上游帮助图里印的 `wws xxx` 示例，在本插件里一律要换成 `yuyuko xxx`。

**多选续查**：当上游返回 `wait`（如舰船重名），插件会把待选项发进群；
用户在下一句 **@机器人 后回复数字**（`2`、`选 2`、`第2个` 均识别）即自动带上下文续查，
无需重新输入触发词。要求 @ 是因为群里连续两句"2"是常态，没有 @ 不足以判定为续查。

> ⚠️ 续查**和正常查询走同一条路**：钩子只认领、把"该调哪个工具 + 序号 + 原指令"写进上下文，
> 真正的查询由 `wows-query` 工具执行（可以用几十秒），因此渲染图会照常自动发出来。
> 早期版本在钩子里直接续查，被 `hookPrefetchTimeoutMs`（默认 3.6 秒）掐断 ——
> 而一次渲染实测 5.5~10 秒，于是续查**永远**没有数据和图，模型只能自己编
> （群里表现为"回复序号后原本有的图不见了"）。这条路径已由 e2e 自检覆盖。

---

## 6. 触发判定与身份解析

### 6.1 触发条件（两个条件缺一不可）

```
消息 @ 了机器人本人  ✓    且    去掉 @提及 后第一个词是 yuyuko  ✓
                      →  认领，交给 wows-query 工具
```

| 群里发送 | 结果 |
|---|---|
| `@机器人 yuyuko ship 大和` | ✅ 认领，指令 = `ship 大和`（**触发词后面的内容原样转发给 Hikari-core-v2**） |
| `@机器人 yuyuko ship 大和 recent 30` | ✅ 认领，指令 = `ship 大和 recent 30` |
| `@机器人 wws 大和` | ❌ **不认领**（只认 yuyuko；上游帮助页里的 wws 写法要换成 yuyuko） |
| `@机器人 yuyuko` | ✅ 认领，等同于空指令 → 上游回帮助图 |
| `yuyuko ship 大和`（未 @） | ❌ 不认领 |
| `@机器人 大和`（无触发词） | ❌ 不认领 |
| `@队友 yuyuko ship 大和`（@ 的是别人） | ❌ 不认领 |
| `@机器人 用 yuyuko 查一下`（触发词在句中） | ❌ 不认领 |
| `@机器人 @yuyuko me`（把触发词连 @ 一起打） | ❌ 不认领（曾有个 reused 兼容分支放行它，已按用户要求砍掉） |
| `我觉得 yuyuko 不错` | ❌ 不认领 |

> 设计取向是**宁可不触发**：群里聊到 `yuyuko` 是常态，抢话的代价高于漏答。
> 判定失败时只在 `debug` 日志里留一条原因，不做任何猜测。
> 触发词可换成任意词（改 `triggerKeywords`），但"必须 @ 机器人 + 触发词在最前"这两条不变。

> ⚠️ **不要重新加回"@提及的名字等于触发词就认领"那种兼容**。曾经 `lib/trigger.js` 里有
> 一个 `reused` 分支（当时是为了支持 `@wws 大和`），它会让 `@机器人 @yuyuko me` 也认领。
> 已删除，理由：`@` 是"叫某人"的语法，拿它当触发词属于意料之外的输入。
> 注意 `@机器人 yuyuko me` **不依赖**该分支 —— 那时 `yuyuko` 只是普通词，走 head 判断即可。

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
| 2 | 消息文本推断 | `@机器人 yuyuko` 中紧邻触发词的提及即机器人。**只学 QQ 号、绝不学昵称** —— 否则 `@群友 yuyuko 大和` 会把群友名字记成机器人昵称 |
| 3 | `get_login_info`（只读接口） | 后台异步补问，失败后每 60 秒可重试一次 |

### 6.3 发起人 QQ 号的来源

`yuyuko` 的账号绑定按 `PlatformId`（触发者 QQ）存储，因此"谁在问"必须准确。
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

在「插件 → 战舰世界助手（yuyuko）」设置页修改，**改完无需重启**（配置每次执行时现读）。

| 设置项 | 默认 | 何时需要修改 |
|---|---|---|
| **`yuyukoToken`** | 空 | **必填**（除非桥接以 `-Token` 启动） |
| `bridgeUrl` | `http://127.0.0.1:8788` | 桥接服务端口或地址变更 |
| `bridgeToken` | 空 | 桥接启动时带了 `--access-token` |
| `requireAt` | `true` | 允许"不 @ 机器人、只打触发词"时关闭（**不建议**：会抢话） |
| `hookPrefetch` | `false` | 机器极快、希望钩子直接返回数据时开启（见 §2.3） |
| `autoSendImage` | `true` | 希望由模型决定是否发图时关闭 |
| `atTriggerUser` / `replyToTrigger` | `false` | 发图时 @ 触发者 / 引用原指令 |
| `requestTimeoutMs` | `60000` | 网络较慢、首次查询频繁超时时调大 |
| `includeDataInContext` | `true` | 不希望把数据文本注入提示词时关闭 |
| `serveImage` | `true` | 端口冲突等情况下可关闭（自动退回 file/base64） |
| `imageServerPort` | `32801` | 端口冲突时更换 |
| `triggerKeywords` | `["yuyuko"]` | 换用其它触发词（需编辑 `data/config.json`） |
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
| 首次查询（依赖已装） | 45~52 s | 含浏览器冷启动 + 首次取船图缓存 |
| 热态 `yuyuko ship 圣文森特` | **5.5~6.7 s** | 单船水表，带舰船大背景图 |
| 热态 `yuyuko me` | 10.2 s | 水表长图，模板更复杂 |
| 热态 `yuyuko recent 7` | 5.5 s | |
| 热态 `yuyuko bind_list me` | **2.1 s** | 简单列表模板（53 KB 图） |
| 无法识别的指令 | 0.00 s | 纯解析、不出图 |

耗时几乎全部集中在**页面加载/模板渲染**阶段；截图本身仅 0.07~0.34 s，
yuyuko API 取数 0.3~1.5 s。其中"等页面加载"一段原本硬等 10 秒、
5 次实测**每次**都吃满，已由桥接层压到 2 秒左右（见 §10.5）。

**用户体感**：部署后的第一次查询需 1~3 分钟（一次性成本）；
桥接启动后首次查询 45~52 秒；此后热态 5~10 秒（简单结果约 2 秒）。
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

**⑦ 无害的网络故障不该在启动日志里刷出一段堆栈。**
上游把"模板检查更新时连不上网"也用 `logger.error(traceback.format_exc())` 汇报，
启动日志因此常出现一段像崩溃的堆栈，而本地模板早已装好、出图完全不受影响。
桥接层把 `update_template` 与调用它的 `set_hikari_config` 一并接管：**只用网络特征**
判断无害并降级为一行 WARNING，确定性故障仍原样保留 ERROR。
这里有两处只有实测才会发现的坑，都已写进代码注释：loguru 的 sink **不可重入**
（在 sink 里 `logger.remove()` 会抛 `RuntimeError`，必须改用 `filter` 抑制），
以及包装 `set_hikari_config` 后**必须映射 `__signature__`**
（否则 `apply_config` 的签名裁剪会把所有配置项静默丢掉）。详见 §10.6。

**⑧ 渲染那次"白等 10 秒"被换成"补上等错的闸门 + 缩短等待"。**
上游用 `wait_until='networkidle'` 等页面加载，只要一个外部图标资源慢就吃满 10 秒并判失败。
但真正该等的舰船大图是 CSS `background-image`，而上游的就绪闸门只统计 `<img>` ——
**等错了东西**。实测：直接砍短等待会整块丢背景图；先补上背景图跟踪、再砍到 2 秒，
出图与 10 秒版本**字节完全一致**，单船查询从 13~16 秒降到 5.5~6.7 秒。
判据用的是 **DOM 是否存在内容**而不是 `readyState === 'complete'`
（真实 Chromium 实测：资源挂住时 readyState 永远是 `loading`，用它会误杀正常页面）。详见 §10.5。

**⑨ 多选时的"选择列表图"由插件直接发，模型只负责 @ 提醒。**
上游在 `wait` 状态会渲染一张选择列表图（`select-ship-v6.html`）。早期实现只把选项拼成文字
交给模型，**图被丢掉** —— 群里看不到那张图，模型也只是照着文字复述，用户根本不知道该怎么选。
现在 `handleQuery` 的 `wait` 分支与成功路径共用同一套 `attachImage` + `autoSend`：
图直接发进群（并按配置 @ 触发者），交给模型的内容里明确写"图已发出，别再发一次"。
配套把提示词第 3 条改成"提醒群友 **@机器人** 后回序号" —— 旧文案写的是"直接回数字即可"，
与认领规则（不 @ 不认）自相矛盾，群友照做就认不上。详见 §5 的「多选续查」。

**⑩ 瞬时网络故障不许在日志里泼堆栈（启动期与查询期各一处）。**
上游有两处把"无关痛痒的网络抖动"用 `logger.warning/error(traceback.format_exc())` 汇报：
启动期的模板清单检查（§10.6）、查询期的 yuyuko 超时（§10.7）。两处的处理原则相同 ——
**先扣下、成功就不提、真失败才补打**。查询期那处更值得说：上游其实**没有重试**，
救回查询的是我们自己那层重试，所以那段堆栈既无诊断价值、又会被用户当成"服务坏了"。

**⑪ 上游给某几个接口的超时短得不合理，该补就补。**
`check_yuyuko_cache` 只给 5 秒，而它每次查询都要发、冷启动要握手 —— 实测同一请求
第一次 5.07s 被掐断、第二次 7.95s 才成功。桥接层把它补到 20 秒（与上游其它接口一致），
**只补这一个接口、只提高不降低**（§10.8）。这类"上游参数不合理"的坑，
与其在上层加重试，不如先把参数补对 —— 重试是兜底，不该是常规路径。

---

## 10. 自检与排障

### 10.1 自检脚本

```bash
# 本地逻辑自检（87 项：@提及解析 / 触发判定 / 边界用例 / 文本组装 / 图片服务）
# 不需要网络，也不需要 Python
node plugins/yuyuko-helper/selfcheck.mjs

# 端到端自检（80 项：起本地假桥接，跑通"钩子认领""工具查询+自动发图""多选序号续查"三条链路）
node plugins/yuyuko-helper/e2e-test.mjs

# 桥接客户端契约自检（29 项：success/wait/failed/error/超时/口令/会话键）
node plugins/yuyuko-helper/bridge/client-test.mjs

# 桥接侧配置映射与凭据来源自检（含上游 use_broswer 笔误的兼容）
python plugins/yuyuko-helper/bridge/test_config_mapping.py

# 模板清单同步自保层自检（46 项：重试判定 / 日志降级 / 确定性故障不吞 / 幂等）
# loguru 只装在 .hikari-deps，脚本会自动带上正确的 PYTHONPATH 重跑自己
python plugins/yuyuko-helper/bridge/test_template_sync.py

# 渲染等待兜底自检（23 项：networkidle 超时放过 / 背景图跟踪 / DOM 空仍失败 / 防叠加）
python plugins/yuyuko-helper/bridge/test_render_guard.py

# 上游超时堆栈降噪自检（9 项：抖动成功后不打堆栈 / 真失败必补打 / 无关 ERROR 不拦）
python plugins/yuyuko-helper/bridge/test_upstream_noise.py

# yuyuko 短超时补时自检（10 项：只补 cache/check 那一个接口 / 绝不降低已有超时 / 域名判据）
python plugins/yuyuko-helper/bridge/test_yuyuko_timeout.py

# 提交前扫描：检查是否误纳入凭据或异常大文件
node plugins/yuyuko-helper/.precommit-scan.mjs
```

> **在受限沙箱里跑 Python 用例**：`test_render_guard.py` / `test_template_sync.py` /
> `test_upstream_noise.py` / `test_yuyuko_timeout.py` 开头会用 `os.execve` **重启自己**并注入
> `PYTHONPATH`（依赖只装在 `.hikari-deps`）。若运行环境禁止替换进程镜像（如文件沙箱），
> 这一步会直接崩在 `0xC0000005`（**不是用例失败**）。绕过方式是自己先把依赖注入好，
> 让脚本判断"依赖已可见"而跳过自我重启：
>
> ```bash
> # PowerShell（先设两个环境变量，再跑）
> $env:PYTHONPATH = "$PWD\.hikari-deps"
> $env:WOWS_TEST_BOOTSTRAPPED = '1'
> python bridge/test_render_guard.py
> ```

### 10.2 真实环境核验

```bash
# 桥接服务探活（ready=false 时查看 core_error）
curl http://127.0.0.1:8788/health

# 在你自己机器上测量真实查询耗时
set PYTHONPATH=%CD%\.hikari-deps
python plugins/yuyuko-helper/bridge/probe_hikari.py "账号ID:Token"

# 核对 init_hikari 入参、以及 Ignore_List 是否真的生效
python plugins/yuyuko-helper/bridge/verify_params.py "账号ID:Token"

# 真实通路端到端：起真桥接 → Node fetch 查询 → 核验凭据下发与禁用清单
node plugins/yuyuko-helper/bridge/verify_node.mjs 32941 "账号ID:Token" python
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
| 回复中出现 `page.goto Timeout 10000ms` / `playwright错误` | **渲染阶段的瞬时失败**（模板要加载十余个远程资源，网络抖动即超时） | 已内置自动重试一次（§10.4）；若频繁出现请检查网络与代理 |
| 回复中出现 `wuwuwu出了点问题，请联系麻麻解决` | 上游的兜底异常（多为网络类），异常详情在**桥接窗口**的日志里 | 同上；要定位具体原因需查看桥接窗口中的 `Traceback` |
| 发 `@机器人 yuyuko ship 大和` 完全无反应 | 插件未启用 / 未 @ 机器人 / 触发词不在最前 | 确认「插件」页状态为"生效中"；打开 `debug`，日志会写明具体原因 |
| @ 他人时机器人不响应 | **设计如此**：仅认领 @ 机器人本人的消息 | 需要放宽则关闭 `requireAt` |
| 已认领但模型未查询、只回一句空话 | 模型未调用工具 | 提示词片段已写死该要求；`debug` 日志可确认是否发起查询 |
| 返回"桥接服务没启动或地址不对" | 桥接未运行 / 端口不一致 | 启动 `hikari_bridge.py`（或双击 `启动桥接服务.bat`），核对 `bridgeUrl` |
| 返回"响应超时" | 首次查询需下载浏览器与船图缓存 | 调大 `requestTimeoutMs`；或先运行一次 `probe_hikari.py` 预热 |
| 上下文出现"预取超时" | 开启了 `hookPrefetch` 但查询较慢 | 关闭该项（默认已关闭），交给工具执行 |
| `/health` 返回 `ready: false` | 未装 hikari-core 或 chromium | 重新运行 `start-bridge.ps1`；查看 `core_error` 字段 |
| 图片已生成但发送失败 | 协议端与本机不同机，读不到本地文件 | 插件会自动回退到本地图片服务 URL 或 base64；必要时把 `imageServerHost` 改为协议端可访问的地址 |
| 图片服务启动失败 | 端口被占用 | 更换 `imageServerPort`，或关闭 `serveImage`（自动走 file/base64） |
| 模型重复发送同一张图 | `autoSendImage` 关闭后反复调用工具 | 开启 `autoSendImage`；发送队列本身也会按去重拦截 |
| 用户回复了数字但没有续查 | 回复中未 @ 机器人 | 让其使用 `@机器人 2`；或关闭 `requireAt` |
| 改名后插件显示"已启用"，但每次查询提示"还没有配置 yuyuko API 凭据" | 插件 `id` 从 `wows-helper` 改成了 `yuyuko-helper`，而 `data/config.json` 里仍是旧键，配置等于空的 | 把该键改名为 `yuyuko-helper`（整块值保留），或用设置页重填凭据；见 §3 命名对照 |
| 提交时 `git diff` 里中文注释整个文件都变了 / 文件不再被识别为 UTF-8 | 用 `Add-Content` 以 ANSI 追加过内容（**本插件真的踩过**：`.gitignore` 末行注释被写成 GBK，整文件因此不是合法 UTF-8） | 用 UTF-8 重写该文件；追加文本请改用 `[System.IO.File]::AppendAllText($p,$s,[Text.Encoding]::UTF8)` 或 `Out-File -Encoding utf8` |

排障时建议先开启插件的 `debug` 开关：日志会记录认领了哪条指令（含判定原因）、
是否发起查询、耗时以及图片大小。

### 10.4 渲染失败与自动重试

实测发现渲染失败是**瞬时且可复现**的：对同一条指令连查三次，会出现"失败 / 失败 / 成功"
这种不确定结果。原因在上游：

```python
# hikari_core/Html_Render/minimal_screens_hot_service.py:382
await page.goto(f"file://{temp_file}",
                wait_until='networkidle',   # 要求 500ms 内没有任何网络请求在飞
                timeout=10000)              # 硬编码 10 秒，无法从外部调大
```

模板会加载十余个远程资源（`hikari-resource` OSS 16 处、`jsdelivr` 6 处、
`bootcdn` 2 处），网络稍有抖动就触发超时；而**上游没有任何重试逻辑**，
一次抖动直接变成一条错误回复。

因此桥接层补了一层重试（默认开启，重试 1 次、间隔 1200ms）：

| 失败类型 | 是否重试 | 原因 |
|---|---|---|
| `playwright错误` / `Page.goto Timeout` / `浏览器端渲染超时` | ✅ 重试 | 典型的瞬时失败 |
| `wuwuwu出了点问题`（上游兜底异常，多为网络类） | ✅ 重试 | 同上 |
| `status=failed`（如"未找到该玩家"） | ❌ **不重试** | 业务性失败，重查无意义 |
| 正常成功 | ❌ | — |

关闭方式：`--render-retry 0`，或设置环境变量 `WOWS_HELPER_RENDER_RETRY=0`。
发生重试时，响应体会附带 `retried` 与 `retry_reasons`，便于解释"这次为什么慢了些"。

> 相关自检：`python bridge/test_render_retry.py`（用真实错误文案驱动，
> 覆盖失败识别、重试后成功、用尽次数、可关闭，以及"业务失败不重试"这一关键约束）。

### 10.5 渲染等待的兜底（把"白等 10 秒"变成"有依据的兜底 + 2 秒"）

除了上面的重试，桥接层还接管了上游那次**硬编码 10 秒的 `networkidle` 等待**：

```python
# hikari_core/Html_Render/minimal_screens_hot_service.py:382-386
await page.goto(f"file://{temp_file}",
                wait_until='networkidle',   # 要求 500ms 内没有任何网络请求在飞
                timeout=10000)              # 硬编码 10 秒
```

模板要加载十余个外部图标（OSS 的舰种/资源图标、服务器图标等）。这些请求在本机走系统代理，
TLS 握手偶尔会卡住；只要有**一个**资源迟迟不返回，`networkidle` 就永远达不成，
于是整个渲染被判失败 —— 实测日志就是：

```
playwright._impl._errors.TimeoutError: Page.goto: Timeout 10000ms exceeded.
  - navigating to "file:///.../browser_temp/temp_7cd583f6.html", waiting until "networkidle"
```

**但这 10 秒其实等错了地方。** 两件事实测确认：

1. **它不等你要等的东西。** 上游 `_smart_wait()` 靠 `window.__images_total/__images_loaded`
   判断"图片都加载完了"，可它**只统计 `<img>` 元素**；而舰船大图是 CSS `background-image`
   （实测生成的 HTML 里 `<img>` 标签数为 **0**、`background-image` **1 处**）。
   于是那道就绪闸门以为"没有图片要等"、立刻放行，真正拦住截图时间的只剩 `networkidle` 的 10 秒。
2. **直接砍短它会丢画面。** 把 `networkidle` 从 10 秒砍到 2.5 秒、不作其他改动，
   出图**整块舰船背景丢失**（只剩白底卡片，281 KB vs 完整的 407 KB）。

所以修法是"先补上等错的闸门，再缩短等待"：

| 改动 | 作用 |
|---|---|
| 给上游 `create_page` 注入一段页内脚本，用 `getComputedStyle` 找出实际生效的 `background-image`，登记进 `__images_total` 并在 `onload` 时计入 `__images_loaded` | 让 `_smart_wait()` **真正等到背景图就绪**（兜底：8 秒强制放行，避免某张图永不返回时卡死） |
| 把 `networkidle` 的超时从 10 秒缩到 **2 秒**（只改 `wait_until='networkidle'` 那一种调用） | 只当"给外部资源一个机会"，不再为慢资源白等 |

超时后的判定仍然保留完整的安全网：

| 超时后的验证 | 判定 | 结果 |
|---|---|---|
| `load` 事件已触发 | 页面正常，只是外部资源慢 | 一行 INFO，继续渲染 |
| `load` 未触发，但 `document.body` 有内容 | 同上（真实情形） | 一行 INFO，继续渲染 |
| 两者都不成立（DOM 是空的） | 页面真的挂了 | **保留原异常**，交给重试/报错逻辑 |

> ⚠️ 判据**不能**用 `readyState === 'complete'`：只要有一个外部资源永不返回，
> `readyState` 就永远停在 `loading`。真实 Chromium 实测确认过这一点 —— 用 readyState 判断
> 会把"DOM 完好、能渲染能截图"的正常页面误判成"页面没起来"。这个坑已写成单元用例。

**实测效果**（同机、同指令）：

| 指标 | 改前 | 改后 |
|---|---|---|
| `networkidle` 段耗时 | 吃满 10 秒 | **2.1 ~ 5.0 秒**（多为 2.5 秒） |
| `screenshot()` 整体 | ~13 秒 | **3.3 秒**（其中 `_smart_wait` 仅 0.15 秒） |
| 单船查询端到端 | 13 ~ 16 秒 | **5.5 ~ 6.7 秒** |
| 出图 | 完整（407.4 KB） | **字节完全一致**（sha `31aacdde2e302f76`） |

> 5 次真实查询**全部**触发了 `networkidle` 兜底 —— 说明改前每次查询都在白等那 10 秒。

> 相关自检：`python bridge/test_render_guard.py`（23 项，含"DOM 空时必须仍然失败"、
> "非 networkidle 的超时一律不插手"、"超时确实被缩到 2 秒"三条关键约束）。

### 10.6 启动日志：哪些可以忽略，哪些必须看

启动时上游会对模板做一次"检查更新"（拉 OSS 清单 → 逐文件比对 → 只写变化的部分）。
模板**早已随 hikari-core 装在 `.hikari-deps/hikari_core/Template`**（54 个文件，约 4.0 MB），
所以清单拉不到**不影响出图**。桥接层为此加了一层自保逻辑，把这类无害故障压成一行：

| 日志 | 含义 | 要不要处理 |
|---|---|---|
| `WARNING 未加载 data_user 私有模块…wws auth 指令将提示未部署` | 上游的可选私有模块，本部署未提供 | 忽略（除非要用 `wws 授权`） |
| `WARNING 模板清单检查临时失败，已跳过本次模板更新，继续使用本地模板（不影响查询）：httpx.ConnectTimeout…` | 拉模板清单时网络/TLS 抖动，已自动重试 1 次仍失败 | **可忽略**。当天 4 点 / 12 点的定时任务会重试，或下次启动自动追平 |
| `WARNING 模板清单首次检查失败（临时网络故障），重试后已同步完成` | 同上，但重试成功了 | 忽略 |
| `INFO 执行初始缓存更新... / 更新战舰资源完成` | 船图缓存检查（本地有 `ship_cache` 时很快） | 忽略 |
| `INFO 管理员校验串已生成（请私信发送给机器人）：…` | 上游生成的随机串，用于鉴权指令 | 需要管理功能时才理会 |
| `ERROR 初始化 hikari-core 配置失败: 'NoneType' object is not iterable` | **网络完全不通**且缓存也取不到时上游的崩溃点 | **必须看**：检查代理/网络后重启 |
| `INFO 页面 networkidle 未在 2000ms 内达成（外部图标资源偏慢），已确认页面本身加载完成，继续渲染（3.6s）` | 外部图标资源慢，但页面本身正常，已直接继续渲染 | **可忽略**，见 §10.5 |
| `WARNING 网络/渲染抖动，准备重试（1/1）：请求超时了…` + `INFO 上游超时已自愈（共出现 N 次网络异常，重试后成功），堆栈未打印` | yuyuko 接口或渲染抖了一下，已自动重试成功；上游那段超时 traceback 被扣下没打 | **可忽略**，见 §10.7 |
| 同上，但**没有**"已自愈"行，而是补打出大段 `Traceback` | 重试也没成功 | **必须看**：堆栈是"失败才补打"的，出现即代表这次真的没救回来 |
| `ERROR` + `Traceback` 里含 `update_template` | 模板同步出现**确定性**故障（清单为空、磁盘写入失败等） | **必须看**：这类不会降级，会原样打印 |
| `ERROR` + `Traceback` 里含 `Page.goto` / `playwright` | 渲染阶段失败 | 见 §10.4（已自动重试一次） |
| `INFO 查询「…」→ success (…ms) 图=208KB tpl=wws-ship-v6.html` | 正常结果行 | **注意结尾的"图=…/无图(…)"**：`status=success` **不代表有图**，上游可能因 `Output.Template` 为空而跳过渲染。早期日志只打 status，"success 但没图"与"success 且有图"长得一模一样 |
| `WARNING 收到续查（select=N）但没有挂起的会话（session_key=… PENDING=[…]）` | 续查请求找不到上一轮的多选会话，只能按新查询处理 | **必须看**。成因见下方"会话键为什么会错位" |
| `WARNING 续查按会话键 … 已回退到同会话的最新挂起项 …` | 键里的 `platformId` 与首次查询不同，走回退查找 | **可忽略**，这是已知且已处理的情形（回退后照常出图） |

> 「回序号后没图」这类问题，**先看这两行**：续查行有没有 `图=…`、有没有上面第一条 WARNING。
> 实测踩过：只用 `status` 判断时，一次 3588ms 出图 208KB 和一次 369ms 无图在日志里无法区分。

**会话键为什么会错位（重要，别再踩）**

会话键由插件构造成 `<chatKey>#<platformId>`，而 **`platformId` 在两条路径上含义不同**：

| 路径 | `platformId` 是谁 | 例子 |
|---|---|---|
| 首次查询「查别人」 | **被查对象**的账号 | `ship 大胆 2000000001` → `… #2000000001` |
| 续查（回序号，走工具） | 工具解析出的**触发者** | 同一个人回 `1` → `… #2000000002` |

于是**同一个会话算出两个键**。历史上"续查在钩子里查"时两处都用触发者，键是一致的；
改成"续查交给工具"之后才暴露出来 —— 表现为用户回序号后桥接找不到会话、
只能再查一遍，群里看到的就是"又弹一次选择列表、始终没有图"。

处理方式：`pending_get()` **精确键优先，命中不到时按 `#` 之前的会话标识回退**（取最新一个）。
一个聊天里同时挂起多个多选会话极不常见，因此该回退是安全的；回退时打一条 WARNING 便于追查。
对应回归用例在 `bridge/test_template_sync.py` 第 11 组。

设计要点：**"可重试"和"可降级"是两个独立判定**。只有"拉清单时连不上网"才降级成一行
WARNING；个别模板文件下载失败、清单为空、磁盘错误等一律保留 ERROR，避免把真问题藏起来。
另外，上游在 `set_hikari_config` 内部还会**自己**再调一次模板同步，桥接层把
`update_template` 也一并接管，否则那次调用会跑在抑制窗口之外、照样打出一整段堆栈。

> 相关自检：`python bridge/test_template_sync.py`（46 项，含"上游那次调用也被接管"
> 与"确定性故障必须保留 ERROR"两条关键约束）。

### 10.7 查询路径的同一类噪音：yuyuko 超时堆栈

§10.6 讲的是**启动期**的模板清单噪音。查询期还有一处同源问题，来自
`core/http_error_handler.py` 第 106-113 行：

```python
except (TimeoutError, ConnectTimeout):
    logger.warning(traceback.format_exc())      # 先打一整段堆栈
    hikari = _get_hikari(func, args, kwargs)
    if hikari is not None:
        return hikari.error(timeout_message)    # 再返回"请求超时了…"
```

也就是：**一次 TLS 握手抖动 = 一段看起来像崩溃的堆栈 + 一次成功的重试**。
实测日志（本机到 `v3-api.wows.shinoaki.com` 的 `POST /api/wows/cache/check`）：

```
WARNING | Traceback (most recent call last):
  File ".../httpx/_transports/default.py", line 101, in map_httpcore_exceptions
  ...
httpcore.ConnectTimeout: _ssl.c:1064: The handshake operation timed out
```

好在它返回的那几种文案（`请求超时了` / `连接池异常` / `wuwuwu出了点问题`）**正是我们
自动重试的标记**，所以查询本身会自动救回来 —— 需要处理的只是那段堆栈。

做法与模板同步一致：**抑制 → 成功就不提，真失败才补打**。

| 环节 | 实现 |
|---|---|
| 抑制 | `_yuyuko_timeout_filter` 收进 `_yuyuko_noise['capture']` 缓冲区，不让它落到 sink |
| 窗口 | `init_hikari_with_retry` 每次尝试包一层窗口（`try/finally` 复位） |
| 成功 | 打印一行 `INFO 上游超时已自愈（共出现 N 次网络异常，重试后成功），堆栈未打印`，**不补堆栈** |
| 失败 | `logger.warning(原堆栈)` 补打出来 —— 此时它才有诊断价值 |

⚠️ **判据必须用"网络/传输类特征"，不能用结果文案**。实测踩过：上游打出来的是
`logger.warning(traceback.format_exc())`，文本里只有 `httpx.ConnectTimeout` 与
`handshake operation timed out`，**根本没有** `请求超时了`（那是随后返回给调用方的 error 文案）。
第一版按结果文案匹配 → 永远匹配不上 → 降噪完全失效，而单元测试里我把样例堆栈"简化"了，
恰好掩盖了这个缺陷。所以 `test_upstream_noise.py` 里的样例堆栈是**照抄实测截图**的。

> 相关自检：`python bridge/test_upstream_noise.py`（9 项：抖动后成功不打堆栈、
> 真失败必补打、无关 ERROR 不拦、窗口外不吞）。

### 10.8 上游给 `check_yuyuko_cache` 只留了 5 秒（已补时）

`features/api.py` 里除两处外全是 `timeout=20`，唯独 `api.py:171/186` 的
`check_yuyuko_cache`（`POST /api/wows/cache/check`）是 **`timeout=5`**。
而这个请求**每次查询都要发**，且冷启动时还得完成 TLS 握手。本机实测：

```
accountId=2000000003 第1次  失败 ConnectError   5.07s   ← 被 5 秒掐断
accountId=2000000003 第2次  HTTP 200           7.95s   ← 同一请求其实要 8 秒
accountId=2000000002 第1次  HTTP 200           0.16s   ← 连接复用后很快
```

于是"第一次查询必失败、靠重试救回来"成了常态；网络再差一点（两次都超 5 秒），
整个查询就直接回错误 —— 用户实际遇到的就是 `重试后取得结果（此前失败 1 次）→ error 无图`。

处理：`install_yuyuko_timeout_guard()` 包装 `httpx.AsyncClient.post`，
**只对命中「yuyuko 域名 + `/api/wows/cache/check` 路径」且超时值小于 20 秒**的请求补时，
其它一律原样透传（绝不降低已有超时，也不给未指定超时的请求硬塞一个）。

⚠️ 判据必须**同时**要求域名与路径：只认路径的话，任何第三方地址只要路径相同也会被改写
（这条是写自检时按"同路径不同域名"的用例才发现并修掉的）。
（`api.py:202` 的 `get_wg_info` 同为 5 秒，但它是 GET 且有 `follow_redirects`，不在本次范围。）

> 相关自检：`python bridge/test_yuyuko_timeout.py`（6 项 + 判据 4 项：只补那一个接口、
> 不降低已有超时、未指定时不加、同路径不同域名不碰、幂等）。

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
- **插件 `id` 已改，属破坏性变更**。`wows-helper` → `yuyuko-helper`（目录同步改为
  `plugins/yuyuko-helper/`），于是：

  | 受影响的东西 | 变化 |
  |---|---|
  | 设置页配置 / `data/config.json` 的键 | 从 `"wows-helper"` 变为 `"yuyuko-helper"`；**旧键不会自动迁移**，不迁移就等于凭据、`enabled`、全部调优项丢失 |
  | 工具名 | `wows-helper__wows-query` → `yuyuko-helper__wows-query`（发送工具同理）；短名 `wows-query` / `wows-send-image` 不变 |
  | 提示词片段 id | `wows-helper-rules` → `yuyuko-helper-rules` |
  | 日志前缀 | `[skill:wows-helper]` → `[skill:yuyuko-helper]` |

  迁移办法（本机已执行，见 §4.5）：把 `data/config.json` 里 `plugins` 下的
  `"wows-helper"` 这个键**只改键名、整块值原样保留**即可，凭据不用重填。
  别人的机器若没迁移，表现为"插件显示已开启但每次查询都说没配凭据"。

---

## 12. 参考

- [QQ Agent 确定性型插件开发文档](../../doc/extend_development/plugin-development.md)
- [QQ Agent 共同机制参考（api / ctx / 硬约束）](../../doc/extend_development/skill-reference.md)
- [Hikari-core-v2](https://github.com/wows-yuyuko/Hikari-core-v2)
  —— 指令表、`set_hikari_config` 全部参数
- 桥接接口契约：见 `bridge/hikari_bridge.py` 模块 docstring
