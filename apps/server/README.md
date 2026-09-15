# Agora — 本地 AI 中枢

一个跑在 localhost 的开源 WebApp，集中管理受支持 Agent 的知识库、Skill/MCP、共享记忆与可采集的 token 用量。

## 功能

- **用量看板**：从各 Agent 本地会话记录（Codex / Claude Code / OpenCode）聚合 token 与成本，LiteLLM 定价，未定价模型暂记 $0，因此费用是估算下界，不能理解为免费
- **知识库**：注册/新建目录 → treemap 透视（CleanMyMac 式钻取）+ 文件名搜索 + 按类型整理（可撤销）+ 一键在 Finder 打开
- **工具中心**：skill 统一视图与跨 Agent 开关矩阵（symlink 分发，实体永不被移动）、MCP 统一视图与配置漂移检测、官方 registry 市场一键安装、Git 安装 skill 到中央仓库并联网更新
- **记忆中枢**：跨 Agent 共享记忆（Markdown 为唯一事实源，SQLite 只是可删索引），stdio MCP server 暴露 `memory_search/read/write` 与 `kb_list/kb_search`
- **一键接入**：把 Agora MCP server 注册进 Agent 配置 + 在入口文件注入使用指引（受管区块，全部可逆，写前自动 .bak 备份）

## 安装与启动

```bash
npm install -g ./agora-hub-0.1.1.tgz
agora            # 启动中枢 → http://127.0.0.1:7878
agora doctor     # 环境自检
agora collect    # 立即采集一次用量
agora mcp        # stdio MCP server（由 Agent 配置调用，通常不需要手动跑）
```

要求 Node.js ≥ 22。数据全部存放在 `~/.agora/`（可用 `AGORA_HOME` 覆盖）。只绑定 127.0.0.1，无遥测。

## Agent 接入

打开 http://127.0.0.1:7878 → 记忆中枢 → Agent 接入 → 对应 Agent 点「一键接入」。支持 Claude Code / Codex / OpenCode / Gemini CLI / Cursor / Hermes（YAML/JSON/JSONC/TOML 四种配置格式均保格式写入，写前自动备份）。

## License

MIT。部分解析器逻辑移植自 codeburn（MIT），见包内署名。

## 0.1.1 使用边界

- 当前仅限本机回环地址；服务器通过 SSH 隧道访问。尚未实现远程认证或公网部署。
- 自动整理只移动普通非 Markdown 文件，跳过 Wiki 入口、Raw、Schema、归档和隐藏目录；不跨符号链接。撤销入口在知识库详情页。硬链接移动要求同一文件系统，跨卷失败会显示原因。
- 修改 API 要求 `X-Agora-Request: 1`，带正文时使用 `Content-Type: application/json`。浏览器来源和 Host 必须匹配本地服务。开发前端另设 `AGORA_DEV_ORIGIN=http://localhost:5173`。
- 共享记忆会在访问时同步外部 Markdown 修改。覆盖已有记忆须先 `memory_read`，传回 `expectedRevision`；旧内容保存在记忆目录 `.history`。这不等于导入所有 Agent 原生历史记忆。
- Skill 更新保留上一版目录在工具仓库旁 `history`。异常退出遗留的 `.mutation-lock` / `.write-lock` 会拒绝后续写入，确认没有进程操作后再人工恢复。
- 用量目前覆盖 Codex、Claude Code 历史记录、OpenCode。首次升级会重新解析可用来源，保留无法重读的历史记录；未定价、缺失来源和其他 Agent 不代表零消耗。
- 插件全生命周期、原生记忆迁移、全部 Agent 真实客户端接入验证尚未完成。Registry 安装依赖网络可用性。
