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
2. `pnpm --filter @agora/web build` 刷新前端产物
3. `node scripts/pack.mjs` 生成 tarball
4. 干净目录安装验证（doctor/start/collect/mcp initialize）
5. 版本号 bump（apps/server/package.json）

## Homebrew

`packaging/homebrew/agora-hub.rb` 为 formula 模板。发布后：

1. 用 tarball 的 sha256 更新 formula
2. 推送到自己的 tap（`brew tap <you>/agora`）
3. 用户 `brew install <you>/agora/agora-hub`

## Tauri macOS 桌面版（已实现）

`apps/desktop/` 是 Tauri v2 壳，把 Node 运行时与后端 bundle 作为 sidecar 打进 `Agora.app`，webview 指向动态空闲端口上的本地 server。前后端零重写。

**构建**：

```bash
node scripts/prepare-sidecar.mjs    # 刷新 bundle 并组装 sidecar（node runtime + dist + better-sqlite3）
cd apps/desktop/src-tauri
cargo tauri build                   # 产出 Agora.app 与 Agora_<version>_aarch64.dmg
```

**已知坑（必须知道）**：

1. **`strip` 会破坏 proc-macro dylib**：release 默认 `strip=debuginfo` 在本工具链组合下产出 `mis-aligned LINKEDIT string pool` 的损坏 dylib，dyld 拒绝加载，rustc 报 `can't find crate`（zerofrom_derive/phf_macros/serde_derive 全中招）。`Cargo.toml [profile.release] strip = "none"` 已固化修复，**不要打开 lto/strip**。
2. **Finder 的 minimal PATH**：`whichBin` 会补扫常见 bin 目录（homebrew、~/.local/bin、~/.hermes/node/bin 等），桌面壳子进程也会注入扩充 PATH——改动 agent 探测逻辑时不要退回纯 PATH 依赖。
3. **tauri dmg bundler 与新版 hdiutil 的兼容问题**：`bundle_dmg.sh` 直跑报参数错误，用 `bash bundle_dmg.sh --volname "Agora" "Agora_<v>_aarch64.dmg" "../macos/Agora.app"` 手动打包。

**运行时行为**：启动时回收旧 sidecar PID（`~/.agora/app-sidecar.pid`）→ 选空闲端口 spawn sidecar → 等待 health → webview navigate 到 `http://127.0.0.1:<port>` → 退出时优雅 kill。单实例由 `tauri-plugin-single-instance` 保证。sidecar 日志在 `~/.agora/app-sidecar.log`。

**分发**：GitHub release 附 `.dmg`（免签名，用户首次右键→打开；要双击即用需 Apple Developer ID 签名+公证）。

## 历史：Tauri 预研结论（已按方案 A 落地）

方案 A（sidecar + localhost）已采用并验证通过；方案 B（SEA）因 Node 22 SEA 仅支持 CJS 且我们的 bundle 为 ESM 含顶层 await 而放弃；方案 C（Rust 重写）不考虑。
