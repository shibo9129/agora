# Agora — 本地 AI 中枢

一个跑在 localhost 的开源 WebApp，把你机器上所有 AI Agent（Claude Code、Codex、OpenCode、Gemini CLI、Cursor、Hermes…）的**知识库、工具（skill/MCP/插件）、记忆与 token 用量**统一管起来。

> 本地优先 · 零遥测 · 只绑定 127.0.0.1 · 数据全在 `~/.agora/`

## 为什么做 Agora

如果你同时用好几个 AI CLI/桌面 Agent，一定会遇到这些事：

- skill 散落四五个目录，同一 MCP 在三处重复注册还配置不一致
- 想让一个 Agent 接着另一个 Agent 的上下文干活，记忆却互不相通
- 每月烧了多少钱 token、烧在哪个模型哪个项目上，心里没数
- 笔记/wiki 越堆越乱，缺一个能"透视结构、按类型整理"的工具

Agora 把这些问题收进**一个** localhost 页面：

| 模块 | 能力 |
|---|---|
| **用量看板** | 从各 Agent 本地会话记录聚合 token/成本（LiteLLM 定价，未定价模型诚实报 $0），按天/周/月/项目/模型/币种透视 |
| **知识库** | 注册或按模板新建目录 → treemap 透视（CleanMyMac 式钻取）+ 文件名搜索 + 按类型整理（可撤销）+ 一键在 Finder 打开 |
| **工具中心** | skill 统一视图与跨 Agent 开关矩阵（symlink 分发，实体永不被移动）、MCP 统一视图与配置漂移检测、官方 registry 市场 + Git 安装 skill 到中央仓库并联网更新 |
| **记忆中枢** | 一键同步各 Agent 的记忆到中央仓库（Markdown 为唯一事实源，SQLite 只是可删索引），可开自动同步（写入同步规则到各 Agent 入口文件 + 定时汇聚） |
| **一键接入** | 把 Agora 的 MCP server 注册进各 Agent 配置 + 在入口文件注入使用指引（受管区块，全程可逆，写前自动 `.bak` 备份） |

## 快速开始

```bash
npm install -g agora-hub
agora            # 启动 → http://127.0.0.1:7878
agora doctor     # 环境自检
agora collect    # 立即采集一次用量
agora mcp        # stdio MCP server（Agent 接入时配置，通常无需手动跑）
```

要求 **Node.js ≥ 22**。

从源码跑开发模式：

```bash
git clone <repo> && cd agora
pnpm install
pnpm --filter @agora/web build     # 前端产物
pnpm --filter @agora/server dev    # → http://127.0.0.1:7878
```

## Agent 接入

打开 http://127.0.0.1:7878 → 记忆中枢 → Agent 接入 → 对应 Agent 点「一键接入」。

写入各 Agent 配置时支持四种格式且**全部保格式写入**：JSONC（OpenCode，注释保留）、TOML（Codex，段落行级编辑）、YAML（Hermes，块级手术）、纯 JSON（Claude Code/Gemini/Cursor）。写前自动 `.bak-<时间戳>` 备份，「断开」可干净还原。

## 架构

```
pnpm monorepo + TypeScript strict
├── apps/
│   ├── server   Hono(REST+SSE) + better-sqlite3 + chokidar + MCP SDK（esbuild 单 bundle 分发）
│   └── web      React 19 + Vite + Tailwind v4 + echarts（深浅各 3 套皮肤，跟随系统）
└── packages/
    ├── usage      token 采集器（Claude Code/Codex/OpenCode）+ LiteLLM 定价
    ├── knowledge  知识库模板/索引器（gitignore 感知）/treemap/FTS5 搜索/整理器
    ├── tools      skill/MCP 统一视图、开关矩阵、registry 市场、Git 安装、健康检查
    ├── memory     记忆存储（Markdown 真相 + SQLite 可删索引）+ 同步器
    ├── hub        受管区块（AGENTS.md 类入口文件）+ 一键接入编排 + stdio MCP server
    └── adapters   AgentAdapter 接口 + 内置适配器（声明式能力：skillDirs/memoryDirs/mcpConfig…）
```

设计要点：

- **双向集成**：管理面读写各 Agent 配置文件（保格式+备份+原子替换）；运行面暴露 MCP server（`memory_search/read/write`、`kb_list/kb_search`，渐进披露省 token）
- **诚实原则**：未定价模型成本报 0 不虚构；扫描输出全程脱敏（URL token/env/headers 打码）；写操作只动自己管理的文件/区块
- **索引即可删缓存**：知识库与记忆的 SQLite 索引都可整体删除后零损失重建

## 测试与验证

```bash
pnpm -r run test        # 100+ 单测（解析器/fixture 驱动，含并发与回滚路径）
pnpm -r run typecheck
```

## 致谢

- token 用量解析器与定价管道移植自 **[codeburn](https://github.com/getagentseal/codeburn)**（MIT，见 `packages/usage/LICENSE-codeburn`），并参考了 tokscale / ccusage 的各 Agent 数据位置清单
- 记忆架构理念受 **agent-memory**「Markdown 为唯一事实源」启发
- MCP 市场消费 **[modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)** 官方 v0.1 API
- 知识库目录遍历用 `ignore` 包实现 gitignore 语义

## License

MIT
