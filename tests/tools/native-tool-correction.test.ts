/**
 * @file tests/tools/native-tool-correction.test.ts
 * @description Tests for NativeToolCorrection — MCP-to-native tool
 * auto-correction engine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  NativeToolCorrection,
  DEFAULT_MCP_TO_NATIVE_MAPPINGS,
  ToolMapping,
} from '@core/tools/native-tool-correction.js';

// ---------------------------------------------------------------------------
// Default mappings
// ---------------------------------------------------------------------------

describe('DEFAULT_MCP_TO_NATIVE_MAPPINGS', () => {
  it('contains all 10 required mappings', () => {
    expect(DEFAULT_MCP_TO_NATIVE_MAPPINGS).toHaveLength(10);
  });

  it('maps filesystem_read_file to Read', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'filesystem_read_file',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('Read');
  });

  it('maps shell_execute to Bash', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'shell_execute',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('Bash');
  });

  it('maps search_web to WebSearch', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'search_web',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('WebSearch');
  });

  it('maps fetch_url to WebFetch', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'fetch_url',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('WebFetch');
  });

  it('maps grep_* pattern to Grep', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'grep_*',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('Grep');
  });

  it('maps bash_* pattern to Bash', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'bash_*',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('Bash');
  });

  it('maps filesystem_list_directory to Bash', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'filesystem_list_directory',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('Bash');
  });

  it('maps code_search to Grep', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'code_search',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('Grep');
  });

  it('maps code_read to Read', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'code_read',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('Read');
  });

  it('maps filesystem_write_file to Write', () => {
    const m = DEFAULT_MCP_TO_NATIVE_MAPPINGS.find(
      (x) => x.mcpPattern === 'filesystem_write_file',
    );
    expect(m).toBeDefined();
    expect(m!.nativeTool).toBe('Write');
  });
});

// ---------------------------------------------------------------------------
// findNativeEquivalent
// ---------------------------------------------------------------------------

describe('NativeToolCorrection.findNativeEquivalent', () => {
  let correction: NativeToolCorrection;

  beforeEach(() => {
    correction = new NativeToolCorrection();
  });

  it('returns Read for filesystem_read_file (exact match)', () => {
    expect(correction.findNativeEquivalent('filesystem_read_file')).toBe('Read');
  });

  it('returns Write for filesystem_write_file (exact match)', () => {
    expect(correction.findNativeEquivalent('filesystem_write_file')).toBe('Write');
  });

  it('returns Bash for shell_execute (exact match)', () => {
    expect(correction.findNativeEquivalent('shell_execute')).toBe('Bash');
  });

  it('returns WebSearch for search_web (exact match)', () => {
    expect(correction.findNativeEquivalent('search_web')).toBe('WebSearch');
  });

  it('returns Grep for grep_search (prefix match)', () => {
    expect(correction.findNativeEquivalent('grep_search')).toBe('Grep');
  });

  it('returns Bash for bash_run_something (prefix match)', () => {
    expect(correction.findNativeEquivalent('bash_run_something')).toBe('Bash');
  });

  it('returns null for an unknown MCP tool', () => {
    expect(correction.findNativeEquivalent('unknown_tool_xyz')).toBeNull();
  });

  it('prefers exact match over prefix match when both exist', () => {
    // Add an exact mapping that would collide with prefix
    correction.addMapping({ mcpPattern: 'grep_special', nativeTool: 'CustomGrep', priority: 20 });
    expect(correction.findNativeEquivalent('grep_special')).toBe('CustomGrep');
  });

  it('uses highest priority when multiple prefix patterns match', () => {
    correction.addMapping({ mcpPattern: 'grep_*', nativeTool: 'BetterGrep', priority: 15 });
    // The custom mapping has priority 15, default has priority 5
    expect(correction.findNativeEquivalent('grep_search')).toBe('BetterGrep');
  });
});

// ---------------------------------------------------------------------------
// shouldCorrect
// ---------------------------------------------------------------------------

describe('NativeToolCorrection.shouldCorrect', () => {
  let correction: NativeToolCorrection;

  beforeEach(() => {
    correction = new NativeToolCorrection();
  });

  it('returns true when error is provided and native equivalent exists', () => {
    expect(correction.shouldCorrect('filesystem_read_file', 'connection refused')).toBe(true);
  });

  it('returns false when no error and no low-quality pattern in name', () => {
    expect(correction.shouldCorrect('filesystem_read_file')).toBe(false);
  });

  it('returns true when tool name contains "experimental"', () => {
    // Need a mapping for this to work — add one
    correction.addMapping({
      mcpPattern: 'experimental_file_read',
      nativeTool: 'Read',
      priority: 5,
    });
    expect(correction.shouldCorrect('experimental_file_read')).toBe(true);
  });

  it('returns true when tool name contains "beta"', () => {
    correction.addMapping({
      mcpPattern: 'beta_search',
      nativeTool: 'WebSearch',
      priority: 5,
    });
    expect(correction.shouldCorrect('beta_search')).toBe(true);
  });

  it('returns true when tool name contains "legacy"', () => {
    correction.addMapping({
      mcpPattern: 'legacy_shell',
      nativeTool: 'Bash',
      priority: 5,
    });
    expect(correction.shouldCorrect('legacy_shell')).toBe(true);
  });

  it('returns false when no native equivalent exists', () => {
    expect(correction.shouldCorrect('completely_unknown_tool', 'timeout')).toBe(false);
  });

  it('returns false when env SUDO_NATIVE_TOOL_CORRECTION=0', () => {
    process.env.SUDO_NATIVE_TOOL_CORRECTION = '0';
    try {
      expect(correction.shouldCorrect('filesystem_read_file', 'error')).toBe(false);
    } finally {
      delete process.env.SUDO_NATIVE_TOOL_CORRECTION;
    }
  });
});

// ---------------------------------------------------------------------------
// correct — arg conversion
// ---------------------------------------------------------------------------

describe('NativeToolCorrection.correct', () => {
  let correction: NativeToolCorrection;

  beforeEach(() => {
    correction = new NativeToolCorrection();
  });

  it('converts filesystem_read_file args: path -> file_path', () => {
    const result = correction.correct('filesystem_read_file', { path: '/tmp/x.txt' });
    expect(result).toEqual({
      nativeTool: 'Read',
      convertedArgs: { file_path: '/tmp/x.txt' },
    });
  });

  it('converts filesystem_write_file args: path + content -> file_path + content', () => {
    const result = correction.correct('filesystem_write_file', {
      path: '/tmp/out.txt',
      content: 'hello world',
    });
    expect(result).toEqual({
      nativeTool: 'Write',
      convertedArgs: { file_path: '/tmp/out.txt', content: 'hello world' },
    });
  });

  it('converts filesystem_list_directory args to Bash ls command', () => {
    const result = correction.correct('filesystem_list_directory', { path: '/home' });
    expect(result).toEqual({
      nativeTool: 'Bash',
      convertedArgs: { command: 'ls /home' },
    });
  });

  it('converts shell_execute args: command passed through', () => {
    const result = correction.correct('shell_execute', { command: 'npm test' });
    expect(result).toEqual({
      nativeTool: 'Bash',
      convertedArgs: { command: 'npm test' },
    });
  });

  it('converts search_web args: query passed through', () => {
    const result = correction.correct('search_web', { query: 'typescript best practices' });
    expect(result).toEqual({
      nativeTool: 'WebSearch',
      convertedArgs: { query: 'typescript best practices' },
    });
  });

  it('converts fetch_url args: url + prompt', () => {
    const result = correction.correct('fetch_url', {
      url: 'https://example.com',
      prompt: 'summarize',
    });
    expect(result).toEqual({
      nativeTool: 'WebFetch',
      convertedArgs: { url: 'https://example.com', prompt: 'summarize' },
    });
  });

  it('converts fetch_url with missing prompt to empty string', () => {
    const result = correction.correct('fetch_url', { url: 'https://example.com' });
    expect(result).toEqual({
      nativeTool: 'WebFetch',
      convertedArgs: { url: 'https://example.com', prompt: '' },
    });
  });

  it('converts code_read args: path -> file_path', () => {
    const result = correction.correct('code_read', { path: '/src/index.ts' });
    expect(result).toEqual({
      nativeTool: 'Read',
      convertedArgs: { file_path: '/src/index.ts' },
    });
  });

  it('converts code_search args: passed through unchanged', () => {
    const result = correction.correct('code_search', { pattern: 'TODO', path: '/src' });
    expect(result).toEqual({
      nativeTool: 'Grep',
      convertedArgs: { pattern: 'TODO', path: '/src' },
    });
  });

  it('converts grep_* prefix match args: passed through unchanged', () => {
    const result = correction.correct('grep_search', { regex: 'import', cwd: '/app' });
    expect(result).toEqual({
      nativeTool: 'Grep',
      convertedArgs: { regex: 'import', cwd: '/app' },
    });
  });

  it('converts bash_* prefix match args: command or cmd -> command', () => {
    const result = correction.correct('bash_run', { cmd: 'echo hi' });
    expect(result).toEqual({
      nativeTool: 'Bash',
      convertedArgs: { command: 'echo hi' },
    });
  });

  it('returns null for unknown MCP tool', () => {
    const result = correction.correct('unknown_tool', { x: 1 });
    expect(result).toBeNull();
  });

  it('returns null when env SUDO_NATIVE_TOOL_CORRECTION=0', () => {
    process.env.SUDO_NATIVE_TOOL_CORRECTION = '0';
    try {
      const result = correction.correct('filesystem_read_file', { path: '/tmp/x' });
      expect(result).toBeNull();
    } finally {
      delete process.env.SUDO_NATIVE_TOOL_CORRECTION;
    }
  });

  it('increments correctionCount on each successful correction', () => {
    expect(correction.correctionCount).toBe(0);
    correction.correct('filesystem_read_file', { path: '/a' });
    expect(correction.correctionCount).toBe(1);
    correction.correct('shell_execute', { command: 'ls' });
    expect(correction.correctionCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// addMapping / removeMapping
// ---------------------------------------------------------------------------

describe('NativeToolCorrection addMapping / removeMapping', () => {
  let correction: NativeToolCorrection;

  beforeEach(() => {
    correction = new NativeToolCorrection();
  });

  it('adds a new mapping that is then findable', () => {
    correction.addMapping({
      mcpPattern: 'custom_mcp_tool',
      nativeTool: 'CustomNative',
      priority: 12,
    });
    expect(correction.findNativeEquivalent('custom_mcp_tool')).toBe('CustomNative');
  });

  it('overrides an existing mapping with the same mcpPattern', () => {
    correction.addMapping({
      mcpPattern: 'filesystem_read_file',
      nativeTool: 'BetterRead',
      priority: 20,
    });
    expect(correction.findNativeEquivalent('filesystem_read_file')).toBe('BetterRead');
  });

  it('removes a mapping so it is no longer found', () => {
    correction.removeMapping('filesystem_read_file');
    expect(correction.findNativeEquivalent('filesystem_read_file')).toBeNull();
  });

  it('does not throw when removing a non-existent mapping', () => {
    expect(() => correction.removeMapping('non_existent_pattern')).not.toThrow();
  });

  it('custom mappings passed to constructor are available', () => {
    const custom: ToolMapping[] = [
      { mcpPattern: 'my_custom', nativeTool: 'MyNative', priority: 1 },
    ];
    const c = new NativeToolCorrection(custom);
    expect(c.findNativeEquivalent('my_custom')).toBe('MyNative');
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe('NativeToolCorrection.getStats', () => {
  it('starts with zero corrections and empty topCorrections', () => {
    const correction = new NativeToolCorrection();
    const stats = correction.getStats();
    expect(stats.correctionCount).toBe(0);
    expect(stats.topCorrections).toEqual([]);
  });

  it('tracks correction count and top corrections after multiple corrections', () => {
    const correction = new NativeToolCorrection();
    correction.correct('filesystem_read_file', { path: '/a' });
    correction.correct('shell_execute', { command: 'ls' });
    correction.correct('filesystem_read_file', { path: '/b' });

    const stats = correction.getStats();
    expect(stats.correctionCount).toBe(3);
    expect(stats.topCorrections).toHaveLength(2);

    // Most frequent first
    expect(stats.topCorrections[0]).toEqual({
      from: 'filesystem_read_file',
      to: 'Read',
      count: 2,
    });
    expect(stats.topCorrections[1]).toEqual({
      from: 'shell_execute',
      to: 'Bash',
      count: 1,
    });
  });

  it('sorts top corrections by count descending', () => {
    const correction = new NativeToolCorrection();
    correction.correct('shell_execute', { command: 'a' });
    correction.correct('filesystem_read_file', { path: '/x' });
    correction.correct('filesystem_read_file', { path: '/y' });
    correction.correct('filesystem_read_file', { path: '/z' });

    const stats = correction.getStats();
    expect(stats.topCorrections[0].count).toBeGreaterThanOrEqual(
      stats.topCorrections[1].count,
    );
  });
});

// ---------------------------------------------------------------------------
// Pattern matching — exact, prefix, glob
// ---------------------------------------------------------------------------

describe('NativeToolCorrection pattern matching', () => {
  let correction: NativeToolCorrection;

  beforeEach(() => {
    correction = new NativeToolCorrection();
  });

  it('exact match takes priority over prefix match for same tool name', () => {
    // Add exact mapping for grep_special with higher priority
    correction.addMapping({ mcpPattern: 'grep_special', nativeTool: 'ExactGrep', priority: 20 });
    expect(correction.findNativeEquivalent('grep_special')).toBe('ExactGrep');
  });

  it('prefix match works for tools starting with grep_', () => {
    expect(correction.findNativeEquivalent('grep_files')).toBe('Grep');
    expect(correction.findNativeEquivalent('grep_code')).toBe('Grep');
  });

  it('prefix match works for tools starting with bash_', () => {
    expect(correction.findNativeEquivalent('bash_exec')).toBe('Bash');
    expect(correction.findNativeEquivalent('bash_run')).toBe('Bash');
  });

  it('glob match works for patterns with * in middle', () => {
    correction.addMapping({
      mcpPattern: 'tool_*_read',
      nativeTool: 'Read',
      priority: 5,
    });
    expect(correction.findNativeEquivalent('tool_special_read')).toBe('Read');
  });

  it('exact match wins over glob match when both match', () => {
    correction.addMapping({
      mcpPattern: 'tool_*_read',
      nativeTool: 'GlobRead',
      priority: 5,
    });
    correction.addMapping({
      mcpPattern: 'tool_special_read',
      nativeTool: 'ExactRead',
      priority: 3,
    });
    // Exact match beats glob even with lower priority
    expect(correction.findNativeEquivalent('tool_special_read')).toBe('ExactRead');
  });

  it('prefix match wins over glob match when both match', () => {
    correction.addMapping({
      mcpPattern: 'tool_*_read',
      nativeTool: 'GlobRead',
      priority: 15,
    });
    correction.addMapping({
      mcpPattern: 'tool_*',
      nativeTool: 'PrefixTool',
      priority: 3,
    });
    // Prefix match beats glob even with lower priority
    expect(correction.findNativeEquivalent('tool_any_read')).toBe('PrefixTool');
  });
});

// ---------------------------------------------------------------------------
// Environment disable flag
// ---------------------------------------------------------------------------

describe('NativeToolCorrection environment disable', () => {
  afterEach(() => {
    delete process.env.SUDO_NATIVE_TOOL_CORRECTION;
  });

  it('shouldCorrect returns false when SUDO_NATIVE_TOOL_CORRECTION=0', () => {
    process.env.SUDO_NATIVE_TOOL_CORRECTION = '0';
    const correction = new NativeToolCorrection();
    expect(correction.shouldCorrect('filesystem_read_file', 'error')).toBe(false);
  });

  it('correct returns null when SUDO_NATIVE_TOOL_CORRECTION=0', () => {
    process.env.SUDO_NATIVE_TOOL_CORRECTION = '0';
    const correction = new NativeToolCorrection();
    expect(correction.correct('filesystem_read_file', { path: '/x' })).toBeNull();
  });

  it('shouldCorrect works normally when env is set to "1"', () => {
    process.env.SUDO_NATIVE_TOOL_CORRECTION = '1';
    const correction = new NativeToolCorrection();
    expect(correction.shouldCorrect('filesystem_read_file', 'error')).toBe(true);
  });
});