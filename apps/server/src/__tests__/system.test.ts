import { describe, expect, it } from 'vitest';
import { appleQuote, chooseFolderScript } from '../system.js';

describe('folder picker AppleScript', () => {
  it('quotes prompts so Finder dialogs cannot break out of the string', () => {
    expect(appleQuote('选择目录')).toBe('"选择目录"');
    expect(appleQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(chooseFolderScript('选择知识库目录')).toContain('choose folder with prompt "选择知识库目录"');
    expect(chooseFolderScript('x')).toContain('on error number -128');
  });
});
