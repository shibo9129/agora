# Agora 0.1.0 完整需求验收

验收日期：2026-09-15。对象：本目录当前源码、已有 agora-hub-0.1.0.tgz、正在运行的本地界面。

## 结论

**未通过原始六项需求的完整验收；已形成可运行的 Alpha，暂不建议作为成熟产品公开发布。**

已有价值：本地 Web 界面、目录透视、Skill/MCP 配置聚合、Markdown 共享记忆及 MCP 访问、三类用量解析、npm 单包分发均有实际实现。102 个现有测试和类型检查通过，干净目录安装、HTTP 启动和 MCP 握手通过。

主要差距有两类：一是实现缺陷（文件边界、写入保护、统计正确性、配置初始化）；二是范围缺口（LLM Wiki 编译流程、既有记忆同步、插件生命周期、完整 Agent 用量覆盖）。不能用“都有页面”代替需求完成。

本次仅验收，未修改产品源码、真实 Agent 配置或真实知识库/记忆。测试写入均使用 `/tmp/agora-acceptance-20260915`；仓库仅新增本报告和隔离样本截图。未执行发布、提交或推送。

## 六项需求覆盖

| 原需求 | 当前交付 | 判定 | 距离验收还缺什么 |
|---|---|---|---|
| 1. 新建/整理 LLM Wiki | 两个目录模板、注册、扫描、文件名检索、扩展名整理 | 部分完成 | Schema 实质内容、来源摄入、知识编译、引用/索引/log 维护与校验；整理保护规则 |
| 2. CleanMyMac 式透视和跳转目录 | ECharts treemap、文件列表、大小、搜索、系统打开 | 部分通过 | 图块缩放与列表/路径联动；目录计数一致；窄屏适配；服务端与浏览器所在机器的打开语义 |
| 3. Skill/MCP/插件集中管理 | Skill 扫描/链接/安装更新；MCP 配置拷贝和 registry | 部分完成 | 真正插件适配；Skill 同名冲突与事务更新；已有实体关闭；空 Agent 列；MCP 配置向导和实际连接验证 |
| 4. 多 Agent 记忆合流 | 新的中央 Markdown 存储、搜索/读写、项目 scope、MCP | 部分完成 | 原有记忆来源适配、同步游标、去重/冲突、溯源、增量索引、版本恢复；不是现有记忆的自动同步 |
| 5. 自定义/初始化 Agent 入口 | 六种固定 adapter，注入受管区块和 MCP 配置 | 部分完成 | 新目录初始化、入口路径正确性、模板编辑/预览、用户自定义 adapter、实际 Agent 读取回执 |
| 6. 汇总所有 Agent 用量 | Codex / Claude Code / OpenCode 三种 collector | 部分完成 | Hermes/Gemini/Cursor 等覆盖；Codex 模型与 session ID 修复；WAL 增量；未定价状态、来源与口径 |
| 本地部署和向他人分发 | npm 包可装可启动；本机 Node 22 验证通过 | 部分通过 | 干净跨平台验收、发布内容一致性、许可证文件、根 README、服务器访问与认证方案 |

“所有 token”应改成可验证合同：声明支持的来源/版本、读取时间、缺失原因和去重口径。未产生日志的工具或云端网页，不能保证从本机全部抓到。

## 已复现的关键问题

优先级：P1 为公开发布前应解决，P2 为核心体验/可靠性补齐。以下均指出证据层级，避免把推断当复现。

### A01 · P1 · 写接口没有来源/认证保护

- 定位：`apps/server/src/index.ts:42` 仅配置 CORS；写路由直接接收请求。`AGORA_HOST` 还能任意覆盖监听地址。
- 复现：隔离源码服务收到 `Origin: http://untrusted.example`、`Content-Type: text/plain`、JSON 内容的记忆创建请求，返回 **201** 且落盘。伪造 Host 的 health 请求也返回 **200**（在已有 bundle 验证）。
- 影响：CORS 不等于拒绝跨来源写操作；具体浏览器是否另有私网访问限制会影响攻击条件，本次没有声称完成远程浏览器攻击。服务自身明确缺少请求边界，暴露服务器模式风险更大。
- 建议：同源/Host 校验、请求类型限制、写入授权机制；非 loopback 监听必须显式配置认证。验收：不可信来源写请求被拒绝且磁盘不变。

### A02 · P1 · 符号链接可绕过知识库路径边界

- 定位：`packages/knowledge/src/organize.ts` 的 `assertInside/executeMoves` 只检查字符串，不验证真实路径。
- 复现：在测试 Wiki 放置 `escape -> ../outside`；将 `probe.txt` 移动至 `escape/probe.txt`，接口 **200、moved=1、failed=0**，外部目录实际出现文件。源码和 bundle 均复现。
- 建议：源路径、目标已存在祖先及根目录真实路径校验；拒绝越界链接；考虑扫描到执行之间变化。验收：此用例拒绝且源文件不变。

### A03 · P1 · 普通“整理”会移动 Agent 入口与 Wiki 引导文件

- 定位：`packages/knowledge/src/organize.ts` 的扩展名分类。
- 复现：新建分层 Wiki，加入若干 txt/png；UI 默认选中 `AGENTS.md → docs/AGENTS.md` 和 `WIKI_ONBOARDING.md → docs/WIKI_ONBOARDING.md`。API 实际移动成功。
- 影响：把项目自己生成的根入口移走；相对引用、固定路径依赖也未修复。对已有 Wiki/代码目录尤其危险。
- 建议：先识别项目/Wiki 类型及受保护入口；Raw 默认保留；先预览影响，再执行，并提供可用撤销。验收：入口和现有引用不被破坏。
- 截图：[整理建议](organize-protected-files.png)。

### A04 · P1 · Codex 模型与会话识别错误，影响成本统计

- 定位：`packages/usage/src/collectors/codex.ts:175` 检查 `payload.type === 'turn_context'`，未按顶层 `entry.type` 识别；meta 读取 `session_id` 而未读取常见 `id`。
- 复现：样本顶层 `type=turn_context`、`payload.model=gpt-5.5`，解析结果为 **gpt-5**；`session_meta.payload.id=sample-id` 被替换为文件名。界面也观察到 Codex 数据集中在 gpt-5，但没有把整库历史费用重算为正确账单。
- 建议：支持真实日志结构、会话内模型切换；未知模型不猜默认收费模型；用真实脱敏样本回归，并对已入库记录提供重算/迁移。

### A05 · P1 · OpenCode WAL 新数据可能被判“未变化”

- 定位：`packages/usage/src/engine.ts:76` 与 `collectors/shared.ts` 仅对主 `.db` 的 stat 建指纹。
- 复现：SQLite WAL 模式 checkpoint 后写入新行，主 DB 前后指纹相同，`sameFingerprint=true`，同时查询已能读到新行。
- 影响：collector 会跳过这一类变化，直到 checkpoint 或其他主文件变化。不是所有采集都失败，属于增量漏采窗口。
- 建议：用数据库级游标/内容版本，或至少正确纳入 WAL 状态；回归测试必须保持 writer 连接打开。

### A06 · P1 · 同名 Skill 无提示替换；更新不是原子交换

- 定位：`packages/tools/src/skills/install.ts:208`，先删除目标再复制。
- 复现：从两个本地来源安装同名 `same-skill`，第二次直接覆盖，最终内容从 original 变为 replacement，无冲突提示。
- 影响：不同作者同名 skill 混淆；复制中断可能损失旧安装（此中断场景为代码风险判断，未注入磁盘故障）。
- 建议：source-qualified 标识；安装冲突显示 diff；临时目录验证后原子替换，旧版本保留可回滚。

### A07 · P1 · 记忆文件与索引不能自动保持一致

- 定位：`packages/memory/src/store.ts`，查询依赖 SQLite，构造只 migrate；文件直接 `writeFile`，无文件 watcher/启动重建。
- 复现：在中央目录手工增加合法 Markdown，搜索返回空；手动 POST reindex 后才可搜索。
- 影响：其他 Agent/用户直接编辑时检索过期。README 的“SQLite 可删索引”需要恢复流程，否则文件在但新进程看不到。多进程同时写同名条目缺版本冲突检测/原子文件写入（并发丢失属待专项验证风险）。
- 建议：启动一致性检查、增量 watcher、恢复入口、版本号/CAS、写入历史；旧 Agent 记忆同步另建来源适配，不与 reindex 混称。

### A08 · P2 · 新 Agent 配置目录不存在时初始化失败

- 定位：`packages/tools/src/mcp/write.ts` 的 `atomicWrite` 没有创建父目录。
- 复现：传入全新测试 home，向 Codex 写 MCP 注册，报 **ENOENT**，指向 `.codex/.agora-tmp-*`。
- 建议：安全创建目录、逐步结果与回滚；失败时保留错误原因；将“配置写入”和“Agent 已连接”分开显示。

### A09 · P2 · Skill 清单与目标 Agent 列不准确

- 定位：`packages/tools/src/skills/scan.ts` 即使没有 SKILL.md 也添加目录；`apps/web/src/tools/ToolsPage.tsx` 从已有 skill locations 推导列。
- 实际 UI：`.archive`、`.curator_backups`、`.hub`、`.system` 被当成可安装 Skill；未有 skill 的 OpenCode/Gemini 不出现在矩阵列中，无法从该矩阵启用第一个 skill。
- 建议：区分集合目录与叶子 skill，按支持能力生成 Agent 列；不要把共享目录/插件里的能力等同于显式安装。实体安装的“不能关闭”应明确呈现，后续提供受控迁入中央仓库或原生关闭策略。

### A10 · P2 · API 有撤销，界面没有；treemap 与当前目录未联动

- 定位：`apps/web/src/kb/KbDetail.tsx`；`components/Chart.tsx` 无图表点击事件回传。
- 验证：8 个文件普通整理成功，API 撤销 8 个成功；UI 未提供撤销记录/按钮。图表 `zoomToNode` 仅在 ECharts 内缩放，React `currentPath` 没有相应更新，因此旁边文件列表和“在 Finder 打开”仍按原目录工作（代码确认）。
- 另有：列表卡片目录数包含根与详情不一致；390px 视口测得文档宽 **523px**。
- 建议：撤销作为完成提示的主操作；图块/面包屑/文件列表共用路径状态；窄屏工具栏换行或折叠。
- 截图：[桌面](kb-desktop.png)、[窄屏](kb-narrow.png)。

### A11 · P1 · 发布物遗漏署名文件且前端版本不一致

- 定位：`scripts/bundle.mjs` 只复制已有 `apps/web/dist`，没有实际执行前端 build；`scripts/pack.mjs` 的注释称会刷新前端，实际依赖旧产物。
- 证据：现有 tgz、server/dist 的资源是 `index-Fg6jPFuj.js`；当前源码构建为 `index-BslFu37J.js`。浏览器观察到已有 bundle 与当前构建的导航样式不同。
- `tar -tzf`：发布包没有 LICENSE，也没有 `packages/usage/LICENSE-codeburn`；源码解析器明确声明移植 codeburn MIT 逻辑。需要将署名/许可证随产物分发，不能只放开发目录。
- 此目录 `git status` 返回“not a git repository”，没有根 README；不据此推断远端仓库不存在，但当前交付不能追溯 commit。页面 v0.1.0 链接指向 github.com 首页。
- 建议：单一 build→pack 流水线，版本+源码 revision+内容 hash，发布包许可证清单，干净安装检查静态资源和 MCP 路径。

## 尚未闭环的范围与待验证项

1. **LLM Wiki 的“LLM”部分**：当前模板创建目录和简短说明，不执行 ingest/query/lint，不维护知识引用与 log。可以由已接入 Agent 执行，不必再开发完整聊天 Agent，但需要任务协议、预览、执行回执与产物验收。
2. **既有记忆同步**：没有 Codex/OpenCode/Hermes 历史记忆的 importer、去重、冲突及同步状态。首版建议用户选择来源、只读导入候选、确认后写中央库；不要默认复制所有隐私记忆。
3. **插件管理**：未见插件 manifest、来源、版本、依赖、宿主绑定和卸载路径。Skill 链接不等同于插件安装。
4. **MCP 市场**：本次 registry 查询返回 502，联网安装链路记为 Blocked，不能说通过。转换代码忽略包版本、环境变量/参数需求；将条目写进配置后没有 initialize/tools/list 验证。需配置向导、凭据占位、锁版本与连接结果。
5. **入口生效**：单测证明文件写入；未逐一启动六种真实 Agent 证明加载。Cursor 当前写入 `~/.cursor/.cursorrules`，应对照官方全局 rules 机制校正；其他 Agent 也需区分配置存在、MCP 可启动、指令被加载、记忆可读四种状态。
6. **统计口径**：成本是价格估算而非实际订阅账单；未定价不应显示为“免费”。需列出未定价模型/占比、价格来源和更新时间、collector 失败/缺失来源。现有 API 在 force 下仍 INSERT OR IGNORE，重解析不等于重算旧记录。
7. **服务器部署**：原型默认 loopback 是合理起点，但开放 host 没有认证，且系统打开动作发生在服务端，不会打开远程浏览器用户的 Finder。服务器模式暂不能按完成验收。
8. **公开分发**：macOS 当前 Node 22 通过；Linux/Windows、无 Git/uvx、离线/代理、不同 Node、并发写入与中断恢复未全面运行。根 package 声明 Node>=20，而 server 分发要求>=22，需要统一。

## 实际执行与证据

| 检查 | 结果 | 边界 |
|---|---|---|
| pnpm test | PASS，102 tests / 16 files | knowledge 17、memory 7、usage 33、tools 32、hub 13；没有把单测当端到端验收 |
| pnpm typecheck | PASS | 所有有该脚本的 workspace 包 |
| 当前前端生产构建 | PASS | 输出隔离目录；JS 901.79KB，gzip 297.60KB，有大 chunk 提示 |
| 现有 tgz 干净 npm install | PASS | 本机 Node v22.22.3；不是干净 OS |
| tgz doctor/start/UI | PASS | health 正确、首页 HTTP 200；doctor 仅按目录探测不能证明 Agent 安装/可用 |
| tgz MCP initialize/tools/list | PASS | 五个工具：memory_search/read/write、kb_list/search |
| Web API 写记忆→独立 MCP 进程搜索 | PASS | 合成数据，证明共享存储跨进程可读；不是原有记忆迁移 |
| UI 写入记忆 | PASS | 界面显示“已写入”及新条目 |
| Wiki 创建/扫描/treemap/search | PASS | 新建分层模板与名称检索 |
| 普通整理→API 撤销 | PASS | 8 移动、0 失败，8 撤销、0 失败；入口也被移动是另一个缺陷 |
| 不可信 Origin 写入拦截 | FAIL | 返回 201 |
| symlink 边界 | FAIL | 外部测试目录实际收到文件 |
| Codex model/session 识别 | FAIL | gpt-5.5→gpt-5；payload.id 未使用 |
| SQLite WAL 增量判断 | FAIL | 有新行但主库指纹不变 |
| 新 Agent 配置初始化 | FAIL | ENOENT |
| 同名 Skill 冲突保护 | FAIL | 第二来源直接替换 |
| 外部 Markdown 自动入索引 | FAIL | 手动 reindex 前不可见 |
| Skills/MCP/健康界面 | 可加载 | 清单误识别；未操作真实 Agent 开关 |
| registry 联网搜索/安装 | BLOCKED | 搜索接口 502；未成功安装真实市场包 |
| 六种 Agent 真正接入与互相接棒 | NOT RUN | 仅现有单测+隔离 MCP 客户端验证 |
| 系统文件管理器打开 | NOT RUN | 代码路径存在；未把后端返回当成已看到 Finder |
| Linux/Windows/远程服务器 | NOT RUN | 本次执行环境为 macOS |

测试记录开始于 16:36（Asia/Shanghai）。源码内容指纹见 `source-sha256.json`，用于无 Git checkout 的版本追溯。临时样本目录保留供复查，非正式用户数据。报告中的网络资料于当天打开核验；不是穷尽互联网，也没有对所有候选项目进行集成 benchmark。

## 开源复用建议

推荐保留现有 Web/adapter 架构，补齐最有价值的闭环。不要为追求“统一”重新实现每个 Agent 的全部格式。

| 方向 | 已核验项目 | 建议采用方式 |
|---|---|---|
| Skill 发现/安装/更新 | [vercel-labs/skills](https://github.com/vercel-labs/skills) | 优先评估 CLI/库适配，让 Agora 负责 UI、策略、预览与审计；复用多 Agent 支持和安装语义。许可证文件已检查为 MIT。 |
| MCP/入口/配置生命周期 | [cc-switch](https://github.com/farion1231/cc-switch) | 参考 adapter、配置管理和 prompts/skills/MCP 的产品流程；其桌面架构不适合整套搬进 Web。许可证文件已检查为 MIT。 |
| 多 Agent 用量 | [tokscale](https://github.com/junhoyeo/tokscale) | 优先评估结构化输出作为 provider，或维护有上游版本记录的 collector 移植；声明本地/云端来源区别。许可证文件已检查为 MIT。 |
| 本地知识全文/语义检索 | [QMD](https://github.com/tobi/qmd) | 可选搜索后端，提供本地 BM25、向量与重排及 MCP；先解决名称搜索不够的问题，向量模型按需启用。仓库标识 MIT。 |
| 文件式共享记忆 | [Basic Memory](https://github.com/basicmachines-co/basic-memory) | 参考文件同步、知识链接和跨客户端读取；当前官方仓库标识 AGPL-3.0，不应默认当 MIT 源码直接并入。可先评估独立服务适配。 |
| LLM Wiki 工作协议 | [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | 它是模式说明，不是库：Raw/Wiki/Schema，ingest/query/lint、index/log。用此补模板和 Agent 工作协议，避免另造复杂执行引擎。 |

现有代码已经使用 ECharts、Hono、MCP SDK、SQLite/FTS、gray-matter，并声明复用 codeburn 解析逻辑；应保留这些基础，重点修复边界及跟随上游格式。上述复用选择为基于本次代码与官方项目资料的工程判断，尚未实施。

## 推荐下一版范围与验收门槛

### 第一阶段：可信可用的本地 Alpha

先修 A01–A07、A11，再处理 A08–A10。补回归样本，完成：

- 不可信写请求与路径越界全部拒绝，原始数据保持不变。
- 同名安装必须明确选来源；失败/中断保留旧版本；Agent 配置变更可恢复。
- Codex 模型切换、session、OpenCode WAL、重复采集与历史重算有确定测试。
- 整理不移动入口/Raw，UI 可撤销，文件名与内容哈希恢复一致。
- 所有“成功”明确表示写入/启动/连通中的哪个阶段，失败不能显示空结果或免费。
- 从源码单命令构建的包与 UI 一致，包含许可证和 revision。

### 第二阶段：完成“跨 Agent 接棒”主闭环

选两种主要 Agent 做完整验收，后续逐个扩展：

1. 新用户初始化中枢，选目录建立 Wiki 框架。
2. 从选定历史记忆来源导入一条有溯源的候选，人工确认合并。
3. Agent A 读取规则、写入项目决定；Agent B 新任务检索并正确复述决定和来源。
4. 从 UI 安装一项真实 skill/MCP，验证 Agent 实际可用，再关闭/卸载并确认旧配置可恢复。
5. 用量采集显示两端增量、模型、来源、未定价状态，重复采集不重复计数。

验收以实际 Agent 回执、文件 diff、MCP 连通结果和计数对账为准。

### 第三阶段：公开 Beta

补 Linux/Windows 支持矩阵、备份恢复、安装/升级文档、可复现 CI 和服务器模式边界。原生 macOS 继续延后。首发可以明确仅支持有限 Agent，避免先承诺“全 Agent/全 token/全插件”。
