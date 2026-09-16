# Agora

本地 AI 中枢 WebApp。当前版本 0.1.1，仍为早期版本。

## 从源码运行

要求 Node.js >= 22、pnpm 11。

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm bundle
pnpm --filter agora-hub start
```

打开 http://127.0.0.1:7878。数据默认位于 `~/.agora`；测试请设置独立 `AGORA_HOME` 和 `AGORA_PORT`。

开发前后端：设置 `AGORA_DEV_ORIGIN=http://localhost:5173` 后运行 `pnpm dev`。

## 打包

```sh
pnpm run pack
npm install -g ./agora-hub-0.1.1.tgz
agora
```

打包会先重建前端，再编译服务端，通过临时目录生成发布包，不改写源码 package.json。

[使用说明与限制](apps/server/README.md) · [原始验收报告](docs/acceptance-2026-09-15/REPORT.md)

## License

MIT；移植 Codeburn 解析逻辑保留原 MIT 署名。发布包包含依赖许可文本。
