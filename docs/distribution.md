# Agora 分发指南

## 发布物形态

单 npm 包 `agora-hub`：

```
agora-hub/
├── bin/agora.js          # bin 路由：start(默认) / mcp / collect / doctor
├── dist/
│   ├── server.mjs        # 完整后端（esbuild 单 bundle，~1MB）
│   ├── mcp-stdio.mjs     # 中枢 MCP server（stdio）
│   ├── cli.mjs           # collect/doctor
│   └── web/              # 前端静态产物（SPA）
└── node_modules/
    └── better-sqlite3    # 唯一运行时依赖（原生模块，prebuild 自动获取）
```

除 `better-sqlite3` 外所有依赖（含全部 `@agora/*` workspace 包）都编译进 bundle。
Node ≥ 22。

## 打包与发布

```bash
node scripts/pack.mjs           # 生成 agora-hub-<version>.tgz（bundle + 重写发布版 package.json）
npm publish ./agora-hub-<version>.tgz --access public
```

本地验证（模拟干净机器）：

```bash
rm -rf /tmp/agora-clean && mkdir -p /tmp/agora-clean
cd /tmp/agora-clean && npm install --prefix . /path/to/agora-hub-0.1.0.tgz
./node_modules/.bin/agora doctor
./node_modules/.bin/agora            # → http://127.0.0.1:7878
```

发布 checklist：
1. `pnpm -r run test` 全绿（usage/knowledge/tools/memory/hub）
2. `node scripts/ui-smoke.mjs` UI 冒烟全绿（弹窗位置/版本号/图表口径）
3. `pnpm --filter @agora/web build` 刷新前端产物
4. `node scripts/pack.mjs` 生成 tarball
5. 干净目录安装验证（doctor/start/collect/mcp initialize）
6. 版本号 bump（apps/server/package.json）

macOS 桌面版（dmg + 应用内更新）发布见 `docs/release-desktop.md`（Developer ID 签名 + 公证 + `scripts/release-desktop.sh`）。

## Homebrew

`packaging/homebrew/agora-hub.rb` 为 formula 模板。发布后：

1. 用 tarball 的 sha256 更新 formula
2. 推送到自己的 tap（`brew tap <you>/agora`）
3. 用户 `brew install <you>/agora/agora-hub`

## Tauri macOS 预研结论

**结论：暂缓集成，先跑通 npm 分发；macOS native 时走 sidecar 方案。**

| 方案 | 做法 | 评估 |
|---|---|---|
| A. sidecar + localhost（推荐起步） | Tauri shell 启动时 spawn `agora` bin，webview 加载 http://127.0.0.1:7878 | 前后端零改动；依赖系统 Node（或用 pkg/SEA 消除）；预估 1-2 天工作量 |
| B. SEA 单可执行 | `node --experimental-sea` 把 cli.mjs 打成单二进制，Tauri 打包之 | 摆脱 Node 依赖的最终形态；`--experimental-sea` 对 better-sqlite3 原生 .node 需外置验证，experimental 风险 |
| C. Rust 重写 | cc-switch 的路径 | 工作量大，放弃 TS 生态复用，不考虑 |

方案 A 的已知问题清单（集成时再处理）：
- Tauri 进程退出时回收 spawn 的 Node 子进程（生命周期绑定）
- 端口冲突检测（7878 被占时递增探测）
- 菜单栏常驻 + 开机启动（Tauri 插件都有现成方案）
- 前端无需改动（webview 直接加载 localhost 页面）
