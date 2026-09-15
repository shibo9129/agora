import type { KbTemplate } from './types.js';

/**
 * Built-in knowledge base templates. Generic by design — no machine-local
 * paths, no personal information. Users can also register any existing
 * directory as a kb without a template.
 */

export const generalWikiTemplate: KbTemplate = {
  id: 'general-wiki',
  name: '通用知识库',
  description: '轻量三区分层：docs 沉淀、raw 原始资料、archive 归档。适合个人笔记与项目知识。',
  dirs: ['docs', 'raw', 'archive'],
  files: [
    {
      path: 'index.md',
      content: `# 知识库索引

- **docs/** — 沉淀后的文档（知识库的正式内容）
- **raw/** — 原始资料（未加工的输入：摘录、导出、截图说明）
- **archive/** — 归档（不再活跃但保留的内容）

> 由 Agora 创建。按需修改本文件维护你的索引。
`,
    },
    {
      path: 'AGENTS.md',
      content: `# AGENTS.md

AI Agent 读本知识库的入口说明。

## 结构
- \`docs/\`：正式文档，按主题组织
- \`raw/\`：原始资料，未经整理
- \`archive/\`：归档内容

## 约定
- 写入前先读 \`index.md\` 了解现有结构
- 新文档放入 \`docs/\`，保持文件名可检索（主题-日期.md）
`,
    },
  ],
};

export const layeredWikiTemplate: KbTemplate = {
  id: 'layered-wiki',
  name: '分层 Wiki（Schema/Raw/Wiki/Archive）',
  description: '四层协议：Schema 定规则、Raw 存证据、Wiki 出成品、Archive 归档。适合长期维护的领域知识库。',
  dirs: ['00 Schema', '01 Raw', '02 Wiki', '99_Archive'],
  files: [
    {
      path: 'WIKI_ONBOARDING.md',
      content: `# Wiki Onboarding

本知识库采用四层协议：

| 层 | 目录 | 职责 |
|---|---|---|
| Schema | \`00 Schema/\` | 规则、约定、数据模型（改内容先看这里） |
| Raw | \`01 Raw/\` | 原始证据（只增不改，是 Wiki 的事实来源） |
| Wiki | \`02 Wiki/\` | 编译后的知识成品（含 index.md 与 _maps/） |
| Archive | \`99_Archive/\` | 归档层 |

## 读取顺序
1. 本文件 → \`00 Schema/\` → \`02 Wiki/index.md\` → 相关 \`02 Wiki/_maps/\` → 具体 Wiki 页
2. 需要证据时回溯 \`01 Raw/\`

## 写入约定
- Raw 是证据层，不擅自改写历史原件
- Wiki 页改动后同步更新 \`02 Wiki/index.md\` 与相关 map
`,
    },
    {
      path: '02 Wiki/index.md',
      content: `# Wiki 索引

（在此维护知识库的主题索引）
`,
    },
    {
      path: 'AGENTS.md',
      content: `# AGENTS.md

AI Agent 读本知识库的入口说明。先读 \`WIKI_ONBOARDING.md\` 了解四层协议。

- 写 Wiki 前必须读 \`00 Schema/\` 的约定
- 不在 Wiki 页存放令牌、密码、Cookie 等敏感信息
`,
    },
  ],
};

export const builtinTemplates: readonly KbTemplate[] = [generalWikiTemplate, layeredWikiTemplate];

export function getTemplate(id: string): KbTemplate | undefined {
  return builtinTemplates.find((t) => t.id === id);
}
