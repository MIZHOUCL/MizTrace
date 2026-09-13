<p align="center"><img src="./web/logo.png" width="120" alt="MizTrace"></p>
<h1 align="center">MizTrace（觅迹）</h1>
<p align="center">你今天到底做了什么？它替你记下来，写成一篇<b>每一句都能点回证据</b>的日记。</p>
<p align="center"><a href="./README.en.md">English</a></p>

---

一天下来，你改过的文件、提交的代码、问过 AI 的问题、翻过的网页、敲过的命令，都散落在电脑各处。MizTrace 在本机把这些痕迹收集起来，铺成一张时间板，你戳掉不想写的，剩下的交给你自己配的模型，写成一篇像样的日记。

零依赖，默认不联网，没有 API key 也能用。macOS 和 Windows 通用。

## 一分钟跑起来

需要 Node 22.13 以上（或 23.4 以上）。没有任何第三方依赖，不需要 `npm install`。

```bash
git clone https://github.com/MIZHOUCL/MizTrace.git
cd MizTrace
node bin/miztrace.js ui
```

浏览器会自动打开一个只有你能访问的本地页面。第一次进来它会问你：去哪些目录找痕迹、读哪些来源。推荐目录、检测到的浏览器和 AI 工具都已经替你勾好，点「开始采集」就行。

想当成全局命令用：

```bash
npm link
miztrace ui
```

之后每天：打开页面 → 看一眼时间板 → 戳掉不想写的 → 点「生成日记」→ 保存。两分钟。

## 它为什么值得用

**别的工具让你自己回忆，它替你把证据摆出来。** 日报难写不是因为不会写，是因为记不清。MizTrace 读的是真实发生过的事：git 提交、改动过的文件、AI 会话里你问了什么和它最后答了什么、浏览记录（含停留时长）、终端命令。你只需要做选择题。

**每一句话都能点回来源。** AI 写的日记里每一段都对应几条证据，网页里点一下就能看到是哪次提问、哪个文件、哪个网页。模型编不出证据里没有的事，编了也会被标出来。落盘的文件是干净的日记，不带脚注。

**懂 AI 工具，而且懂得多。** Claude Code、Codex、Gemini CLI、Cursor、Cline、opencode、Hermes Agent、Windsurf、Trae、CodeBuddy 等二十多种，读你的提问和 AI 的最终回复，日记里会写「我让 Codex 改了 X，它把 Y 换掉了」，而不是笼统的「用了 AI」。

**你说的最算数。** 页面上有一块「我的手记」，随手写几句、贴张图，模型优先采信。每个泡泡也能补一句说明：浏览记录只知道你在某个站待了一小时，你告诉它「在看 Vue 教程」，日记就这么写。

**日记像日记，不像流水账。** 两层：先是几条「今日概览」，一眼知道做成了什么；再是第一人称的「过程」，卡在哪、怎么解决的，留给以后的自己回味。四个内置模板可选，也能自己改。

**不写代码也能用。** 一天都在做表格、写方案、开会？文档大纲、浏览记录、手记同样能撑起一篇日记。

**隐私是默认值，不是选项。** 只读你指定的目录，不扫全盘；不读文件正文、不读 diff；浏览器和终端默认关闭；数据只存本机 SQLite；出站请求只有你点了「确认发送」那一次，发送前每个字都能看到。公司电脑可以一键永久禁网。中英文界面一键切换。

## 它读什么

| 来源 | 读到的 | 默认 |
|---|---|---|
| git | 当日提交、工作树改动、今天 clone 的仓库 | 开 |
| 文件 | 指定目录下今天改过或新出现的文件（只记路径和时间）；文档另读大纲 | 开 |
| AI 会话 | 你的提问、AI 执行的命令 / 改的文件、每轮最终回复的前 300 字 | 开 |
| 手记 | 你自己写的几句话和贴的图 | 开 |
| 浏览器 | 页面标题、去掉参数的地址、搜索词、停留时长 | 关 |
| 终端 | 你敲的命令和所在目录（装一段 shell 钩子） | 关 |

`miztrace sources` 会列出这台电脑上实际能读到什么。

## 常用命令

| 命令 | 作用 |
|---|---|
| `miztrace ui` | 打开网页：时间板、手记、生成日记、设置 |
| `miztrace today` | 在终端直接输出今天的规则版日记 |
| `miztrace date 2026-09-03` | 指定日期 |
| `miztrace week` | 最近 7 天汇总 |
| `miztrace write` | 命令行里用 AI 写日记，`--preview` 只看将发送的内容 |
| `miztrace sources` | 本机能读到哪些来源 |
| `miztrace shell-hook --install` | 装上记录终端命令的钩子 |
| `miztrace where` | 数据目录与配置路径 |
| `miztrace purge --yes` | 删除全部本地数据 |

常用选项：`--root <目录>`（可重复，最重要的一个）、`--out <目录>`（日记写到哪，可以是 Obsidian 库）、`--author <名字或邮箱>`（公共仓库里只算自己的提交）、`--tz Asia/Shanghai`、`--cutoff 4`（凌晨四点前算前一天）。

## 配置模型

网页右上角「设置」里填三样：Base URL、API key、模型名。DeepSeek、智谱、Moonshot、通义、OpenRouter、Ollama 都是 OpenAI 兼容协议，填到 `/v1` 为止；Anthropic 协议按 URL 自动识别。点「测试连接」通了就行，没有别的开关。

模型名用服务商的**稳定名字**（DeepSeek 是 `deepseek-chat`，推理版 `deepseek-reasoner`）。名字里带 `expires` / `preview` 的限时模型下线后，服务常常仍返回 200 但内容为空，MizTrace 会报「模型返回了空内容」并提示换模型。带思考的模型（DeepSeek V4 flash / reasoner、o 系列）会把「最大输出」先花在思考上，预算小了正文一个字都出不来。MizTrace 发现这种情况会自动加大预算重试一次（带思考至少 16000，普通截断至少 8000），成功后把这个数存回设置，下次一次成功。OpenAI 推理模型那套 `max_completion_tokens`、不接受 `temperature` 的差异也会按 400 里的提示自动适配。

多模态模型勾上「模型支持图片」，手记和补充说明里的图就会发原图。

## 隐私细则

- 只读 `--root` 下的目录和各 AI 工具自己的会话目录。跳过点文件、`node_modules`、以及 `.env` / `*.pem` / `id_rsa` 这类文件（连路径都不记）。
- 文件只记路径、时间、大小；文档只读标题层级 / 工作表名 / 页标题。
- 会话不读思考过程、工具输出、代码块正文。
- 终端命令里带 `password=`、`token=`、`export XXX_KEY=` 的连本地库都不进。
- 发送前做家目录替换、邮箱 / 手机号 / IP 替换；疑似密钥直接熔断，不发。
- 出站请求只在 `src/ai/`，本地服务只在 `src/server/` 且只绑 127.0.0.1，CI 用 grep 守着这两条边界。
- `config.json` 里 `managedDevice: true` 可永久禁用一切外发，网页里故意不提供这个开关。

数据目录：macOS `~/Library/Application Support/miztrace`，Windows `%APPDATA%\miztrace`；`MIZTRACE_DATA_DIR` 可覆盖。

## 开发

```bash
npm test
```

测试统一钉在 Asia/Shanghai 时区跑（`scripts/pin-timezone.mjs`），所以在 UTC 的 CI 和任何时区的机器上结果一致。

`src/collect/` 采集，`src/modules.js` 聚成模块，`src/ai/` 写作（唯一允许出站），`src/server/` 本地服务（唯一允许监听），`web/` 无构建的 Vue 前端。

新的 AI 工具适配欢迎提 issue，附一份脱敏后的会话样例文件就能加。

## 许可

MIT。
