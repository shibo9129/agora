# macOS 桌面版发布（GitHub 分发）

解决「Agora.app is damaged and can't be opened」的根因：从 Safari 下载的 dmg 带
`com.apple.quarantine`，而 App 之前是 **ad-hoc 签名**（无 Developer ID、未公证），
Gatekeeper 一律按「已损坏」拦截。修复 = **Developer ID 签名 + Apple 公证（notarize）+ stapler**。
App Store 不需要，GitHub 分发同样免弹窗。

## 一次性准备（约 3 分钟，手工两步 + 一个文件）

1. **创建 Developer ID Application 证书**（需要付费开发者账号，已有）
   - 打开 Xcode → Settings → Accounts → 选中 Apple ID → 选中 team（Personal Team 不行，要付费 team）
   - **Manage Certificates… → 左下角「+」→ Developer ID Application**
   - 验证：`security find-identity -v -p codesigning` 应出现 `Developer ID Application: …`

2. **创建 App 专用密码**（用于 notarytool）
   - <https://appleid.apple.com> → Sign-In and Security → **App-Specific Passwords** → 生成，命名如 `agora-notarize`

3. **填写凭证文件**（gitignored，不落库）

   ```bash
   cp scripts/release.env.example scripts/.release.env
   # 编辑填入：APPLE_SIGNING_IDENTITY / APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID
   ```

4. **updater 签名密钥**（应用内更新用，与 Apple 无关）

   ```bash
   cargo tauri signer generate -w ~/.agora/tauri-updater.key
   # 把输出的公钥写进 apps/desktop/src-tauri/tauri.conf.json → plugins.updater.pubkey
   # 私钥路径填进 scripts/.release.env → TAURI_SIGNING_PRIVATE_KEY
   ```

   > 旧私钥已丢失，0.1.4 起轮换为新公钥。老版本的应用内更新会因公钥不匹配拒绝更新，
   > 老用户重新下载 dmg 即可（当前安装量很小，影响可忽略）。

## 发布

```bash
# 1. 版本三处同步：apps/server/package.json、apps/desktop/src-tauri/tauri.conf.json、git 状态干净
# 2. 质量门禁
pnpm -r run test && node scripts/ui-smoke.mjs
# 3. 一键发布（签名→公证→staple→update.json→gh release）
scripts/release-desktop.sh 0.1.4 "设置弹窗修复 + Token 占比"
```

脚本内置验证（任何一步失败即中止）：`codesign --verify --deep --strict`、
`spctl -a -vv`、`xcrun stapler validate`（app 与 dmg 都验）。

## 用户侧验证（发布后的验收）

干净机器/干净账号下载 dmg → 拖入 /Applications → 双击直接打开，
无「damaged」、无「无法验证开发者」。等价命令行验证：

```bash
spctl -a -vv /Applications/Agora.app        # → accepted, source=Notarized Developer ID
```

## 未签名构建的临时绕过（仅旧版 0.1.3 及之前需要）

```bash
xattr -d com.apple.quarantine /Applications/Agora.app
```

新版签名+公证后用户不再需要这一步。
