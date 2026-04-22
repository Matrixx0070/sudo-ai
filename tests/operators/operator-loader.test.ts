/**
 * @file tests/operators/operator-loader.test.ts
 * @description Tests for OperatorLoader — Wave 10 TOML operator loading.
 *
 * Tests:
 *  1.  loadAll() returns empty array if directory does not exist
 *  2.  loadAll() returns empty array if directory is empty
 *  3.  loadAll() loads valid TOML files correctly
 *  4.  loadAll() skips files with parse errors
 *  5.  loadAll() skips files with missing required fields (name)
 *  6.  loadAll() skips files with invalid schedule.type
 *  7.  interval operator parsed with numeric value
 *  8.  cron operator parsed with string value
 *  9.  enabled: false operator is included (scheduler decides to skip)
 *  10. Multiple operators loaded from multiple files
 *  11. Optional fields (tags, agent.prompt) are loaded correctly
 *  12. loadOne() returns null manifest on bad TOML
 *  13. loadOne() returns null manifest when file does not exist
 *  14. agent.tools array parsed correctly
 *  15. Missing schedule section → null manifest
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OperatorLoader } from '../../src/core/operators/operator-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let operatorsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-ai-op-test-'));
  operatorsDir = path.join(tmpDir, 'workspace', 'operators');
  fs.mkdirSync(operatorsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeOperator(name: string, content: string): void {
  fs.writeFileSync(path.join(operatorsDir, name), content, 'utf8');
}

const VALID_INTERVAL_TOML = `
name = "test-heartbeat"
version = "1.0.0"
description = "Test heartbeat operator"
enabled = true
tags = ["health", "test"]

[schedule]
type = "interval"
value = 1800

[agent]
max_turns = 5
temperature = 0.3
tools = ["system.shell"]
prompt = "Run health check."
`;

const VALID_CRON_TOML = `
name = "daily-check"
version = "1.0.0"
description = "Daily check operator"
enabled = true

[schedule]
type = "cron"
value = "0 9 * * *"

[agent]
max_turns = 10
temperature = 0.5
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OperatorLoader', () => {
  it('1. loadAll() returns empty array when operators dir does not exist', async () => {
    const loader = new OperatorLoader(path.join(tmpDir, 'nonexistent'));
    const result = await loader.loadAll();
    expect(result).toEqual([]);
  });

  it('2. loadAll() returns empty array when directory is empty', async () => {
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result).toEqual([]);
  });

  it('3. loadAll() loads valid TOML operator correctly', async () => {
    writeOperator('heartbeat.toml', VALID_INTERVAL_TOML);
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('test-heartbeat');
    expect(result[0]?.enabled).toBe(true);
    expect(result[0]?.schedule.type).toBe('interval');
    expect(result[0]?.schedule.value).toBe(1800);
  });

  it('4. loadAll() skips files with TOML parse errors', async () => {
    writeOperator('valid.toml', VALID_INTERVAL_TOML);
    writeOperator('invalid.toml', 'NOT VALID [[[bad');
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('test-heartbeat');
  });

  it('5. loadAll() skips files with missing name field', async () => {
    writeOperator('no-name.toml', `
version = "1.0.0"
description = "Missing name"
enabled = true
[schedule]
type = "interval"
value = 300
[agent]
`);
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result).toHaveLength(0);
  });

  it('6. loadAll() skips files with invalid schedule.type', async () => {
    writeOperator('bad-schedule.toml', `
name = "bad-op"
version = "1.0.0"
description = "Bad schedule type"
enabled = true
[schedule]
type = "invalid_type"
value = 300
[agent]
`);
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result).toHaveLength(0);
  });

  it('7. interval operator parsed with numeric value', async () => {
    writeOperator('interval.toml', VALID_INTERVAL_TOML);
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result[0]?.schedule.type).toBe('interval');
    expect(typeof result[0]?.schedule.value).toBe('number');
    expect(result[0]?.schedule.value).toBe(1800);
  });

  it('8. cron operator parsed with string value', async () => {
    writeOperator('cron.toml', VALID_CRON_TOML);
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result[0]?.schedule.type).toBe('cron');
    expect(typeof result[0]?.schedule.value).toBe('string');
    expect(result[0]?.schedule.value).toBe('0 9 * * *');
  });

  it('9. enabled: false operator is included in results', async () => {
    writeOperator('disabled.toml', `
name = "disabled-op"
version = "1.0.0"
description = "A disabled operator"
enabled = false
[schedule]
type = "interval"
value = 600
[agent]
`);
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result).toHaveLength(1);
    expect(result[0]?.enabled).toBe(false);
  });

  it('10. multiple operators loaded from multiple files', async () => {
    writeOperator('op1.toml', VALID_INTERVAL_TOML);
    writeOperator('op2.toml', VALID_CRON_TOML);
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result).toHaveLength(2);
    const names = result.map((r) => r.name).sort();
    expect(names).toContain('test-heartbeat');
    expect(names).toContain('daily-check');
  });

  it('11. optional fields (tags, agent.prompt) are loaded', async () => {
    writeOperator('with-tags.toml', VALID_INTERVAL_TOML);
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result[0]?.tags).toEqual(['health', 'test']);
    expect(result[0]?.agent.prompt).toBe('Run health check.');
    expect(result[0]?.agent.tools).toEqual(['system.shell']);
  });

  it('12. loadOne() returns null manifest for bad TOML', async () => {
    const badPath = path.join(operatorsDir, 'bad.toml');
    fs.writeFileSync(badPath, 'INVALID [[[ TOML', 'utf8');
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadOne(badPath);
    expect(result.manifest).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('13. loadOne() returns null when file does not exist', async () => {
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadOne('/nonexistent/operator.toml');
    expect(result.manifest).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('14. agent.tools array parsed correctly', async () => {
    writeOperator('tools.toml', `
name = "tool-test"
version = "1.0.0"
description = "Tests tool parsing"
enabled = true
[schedule]
type = "interval"
value = 900
[agent]
tools = ["system.shell", "coder.read-file", "knowledge.search"]
`);
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadAll();
    expect(result[0]?.agent.tools).toEqual(['system.shell', 'coder.read-file', 'knowledge.search']);
  });

  it('15. missing schedule section → null manifest', async () => {
    const badPath = path.join(operatorsDir, 'no-schedule.toml');
    fs.writeFileSync(badPath, `
name = "no-schedule"
version = "1.0.0"
description = "No schedule"
enabled = true
[agent]
`, 'utf8');
    const loader = new OperatorLoader(tmpDir);
    const result = await loader.loadOne(badPath);
    expect(result.manifest).toBeNull();
  });
});
