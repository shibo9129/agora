# Agora 0.1.1 修复与验证

日期：2026-09-15。按原验收 A01–A11 修复实现缺陷；原始六项产品需求仍属于部分完成，未声称全产品验收通过。

## 已修改

| 原问题 | 当前行为 | 验证 |
|---|---|---|
| A01 HTTP 写入边界 | 仅回环监听；Host/Origin 校验；写请求标识和 JSON 类型约束；开发 Origin 显式配置 | 中间件回归；独立包恶意 Origin 返回 403 |
| A02 目录越界 | 逐层拒绝符号链接；源必须普通文件；目标独占创建防覆盖 | 符号链接与保护文件回归 |
| A03 Wiki 入口破坏 | Markdown、入口文件、Raw/Schema/Wiki/归档和隐藏目录不自动移动 | UI 整理 4 个普通文件，入口原文保留 |
| A04 Codex 解析 | 支持顶层 turn_context、模型切换和 session meta id；未知模型不猜；历史稳定 key 更新重算 | 模型切换测试、跨来源旧 key 更新且保留遗漏历史 |
| A05 WAL 漏采 | SQLite 指纹加入 WAL 状态、解析器版本 | writer 保持打开、主库不变而 WAL 变化的回归 |
| A06 Skill 覆盖/更新 | 同名不同来源拒绝；暂存、备份、清单提交失败回滚；写锁；内容哈希更新；卸载保留历史，只清理本仓库链接；部分清理失败明确返回 | 本地/Git 安装更新卸载、同名冲突测试；独立代码复核 |
| A07 记忆与索引 | 启动和读取时同步外部文件；临时文件替换；写锁；覆盖要求正文 revision；旧文件归档 | 外部新增/编辑搜索、同时间戳正文冲突、MCP 覆盖与过期拒绝 |
| A08 配置初始化 | 自动创建父目录；唯一临时文件；标准 JSON command/args、OpenCode 数组和 TOML env 各按格式写 | 配置写入测试；独立包 MCP 路径及协议启动 |
| A09 Skill 列表 | 不将无 SKILL.md 的普通目录当 Skill；空 Agent 也有可启用列 | 扫描回归及前端类型检查 |
| A10 目录交互 | UI 撤销记录；树图点击、面包屑和列表同步；目录数不含根；工具栏换行；显式颜色与目录标题 | 实际 UI 整理/撤销、canvas 点击 child；390px 视口文档宽 379px |
| A11 发布一致性 | 先构建前端再打包；临时目录组包；保留许可证和 Codeburn 署名；根 README；版本 0.1.1 / Node >=22；启动器直接 import，退出不留子进程 | 独立 npm 安装；静态文件逐字节一致；HTTP/MCP；SIGTERM 释放端口 |

## 验证结果

- 全量自动测试：**113 tests / 17 files 通过**（knowledge 18、memory 9、usage 36、tools 35、hub 13、server 2）。最终卸载错误语义变更后 tools 35 再次通过。
- 最终全工作区 TypeScript 类型检查通过。
- 独立目录安装最终 tgz 成功（39 packages），发布包 LICENSE、LICENSE-codeburn、依赖许可文本齐全。
- 独立包 HTTP 返回 version 0.1.1，拒绝恶意来源；终止进程后端口释放。
- 独立包 MCP：initialize、5 个工具、写入/读取、revision 更新、旧 revision 拒绝、外部修改正文可检索，均有断言。
- UI 撤销后对 4 个测试文件和两个入口核验原内容；空分类目录保留。
- 两轮独立代码复核所提出的历史数据保留、清单回滚、旧来源迁移和部分卸载失败语义已修正，并复核关闭。

证据：[测试](fixed-tests.log)、[最终 tools](fixed-tools-final.log)、[类型检查](fixed-typecheck.log)、[包运行](fixed-runtime.log)、[目录联动](fixed-drilldown.png)、[窄屏](fixed-narrow.png)、[源码指纹](fixed-source-sha256.json)。

## 保留的边界

1. 本轮未实现 LLM Wiki 编译流程、原生记忆 importer、插件生命周期、Hermes/Gemini/Cursor 用量采集、自定义 adapter 或远程认证。这些属于后续功能开发。
2. MCP Registry 网络安装和六种真实 Agent 的配置加载/连接尚未完整验证；不能由配置文件写入推导已接入。Cursor 入口规则路径问题仍在原报告待验证范围。
3. 文件安全使用路径检查和普通文件操作；无法对恶意外部进程反复替换路径提供内核级沙箱。硬链接移动要求同一文件系统，不提供跨卷搬移或崩溃事务日志。
4. revision 保护协作写入；不遵守锁的外部程序仍可能在校验与替换之间竞争。旧文件备份用于恢复，不等于任意外部编辑严格原子 CAS。锁遗留需核实后人工处理。
5. 外部记忆修改在访问时扫描同步，文件量大时仍需性能优化；根 MEMORY.md 的更新入口为写入/删除/reindex。历史副本暂无恢复 UI。
6. 成本仅为支持来源的估算；未定价可能为 0，旧来源已删除/损坏时保留原记录，无法承诺全部历史费用准确重算。
7. 真实知识库、记忆及 Agent 配置未修改；原 7878 服务未重启。隔离测试服务已关闭。未公开发布、推送或提交；本目录仍非 Git 仓库。

## 产物

- 本地安装包：`../../agora-hub-0.1.1.tgz`
- SHA256：`c72036df6a54a3ff7a91d351dfeb54560fdf9633137778223a8d9563beed4532`
- 修改前源码检查点：`/tmp/agora-before-fixes-20260915-165213.tar.gz`
- 使用说明见根 README 与 apps/server/README.md。打包命令是 `pnpm run pack`，避免调用 pnpm 内置的 `pack` 命令。
