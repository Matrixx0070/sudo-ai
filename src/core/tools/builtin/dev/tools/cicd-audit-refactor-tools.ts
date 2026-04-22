/**
 * dev.ci-cd-setup, dev.dependency-audit, and dev.refactor tool definitions.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('dev-builtin');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// dev.ci-cd-setup
// ---------------------------------------------------------------------------

export const ciCdSetupTool: ToolDefinition = {
  name: 'dev.ci-cd-setup',
  description:
    'Generate a CI/CD pipeline configuration for a project. Produces ' +
    'GitHub Actions workflow YAML with lint, test, build, and optional deploy stages.',
  category: 'dev',
  timeout: 10_000,
  parameters: {
    projectType: {
      type: 'string',
      required: true,
      description: 'Type of project.',
      enum: ['node', 'python', 'go', 'docker', 'fullstack'],
    },
    projectName: { type: 'string', description: 'Project name.' },
    deployTarget: {
      type: 'string',
      description: 'Optional deploy target.',
      enum: ['none', 'aws', 'gcp', 'azure', 'heroku', 'vercel', 'docker-hub'],
      default: 'none',
    },
    nodeVersion: { type: 'string', description: 'Node.js version (default: 20).', default: '20' },
    testCommand: { type: 'string', description: 'Test command (default: npm test).', default: 'npm test' },
    branches: {
      type: 'array',
      description: 'Branches that trigger the workflow (default: [main]).',
      items: { type: 'string', description: 'Branch name.' },
      default: ['main'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const projectType = params['projectType'];
    logger.info({ session: ctx.sessionId, projectType }, 'dev.ci-cd-setup invoked');

    if (typeof projectType !== 'string' || !projectType.trim()) {
      return { success: false, output: 'dev.ci-cd-setup: projectType is required.' };
    }

    const validTypes = ['node', 'python', 'go', 'docker', 'fullstack'];
    if (!validTypes.includes(projectType)) {
      return { success: false, output: `dev.ci-cd-setup: projectType must be one of: ${validTypes.join(', ')}` };
    }

    const projectName = (params['projectName'] as string | undefined) ?? 'Project';
    const deployTarget = (params['deployTarget'] as string | undefined) ?? 'none';
    const nodeVersion = (params['nodeVersion'] as string | undefined) ?? '20';
    const testCommand = (params['testCommand'] as string | undefined) ?? 'npm test';
    const branches = (params['branches'] as string[] | undefined) ?? ['main'];
    const branchList = branches.map((b) => `      - ${b}`).join('\n');

    const isNode = projectType === 'node' || projectType === 'fullstack';
    const isPython = projectType === 'python';
    const isGo = projectType === 'go';

    const setupStep = isPython
      ? `      - name: Set up Python\n        uses: actions/setup-python@v5\n        with:\n          python-version: "3.11"\n\n      - name: Install\n        run: pip install -r requirements.txt`
      : isGo
      ? `      - name: Set up Go\n        uses: actions/setup-go@v5\n        with:\n          go-version: "1.21"\n\n      - name: Download modules\n        run: go mod download`
      : `      - name: Set up Node.js ${nodeVersion}\n        uses: actions/setup-node@v4\n        with:\n          node-version: "${nodeVersion}"\n          cache: npm\n\n      - name: Install\n        run: npm ci`;

    const lintStep = isPython
      ? `      - name: Lint\n        run: |\n          pip install ruff\n          ruff check .`
      : isGo
      ? `      - name: Lint\n        uses: golangci/golangci-lint-action@v4`
      : `      - name: Lint\n        run: npm run lint --if-present`;

    const testStep = isPython
      ? `      - name: Test\n        run: pytest --tb=short -q`
      : isGo
      ? `      - name: Test\n        run: go test ./... -race -cover`
      : `      - name: Test\n        run: ${testCommand}`;

    const buildStep = isPython ? ''
      : isGo ? `      - name: Build\n        run: go build -v ./...`
      : `      - name: Build\n        run: npm run build --if-present`;

    const deployJob =
      deployTarget === 'docker-hub'
        ? `\n  deploy:\n    name: Push Docker image\n    needs: [ci]\n    runs-on: ubuntu-latest\n    if: github.ref == 'refs/heads/main'\n    steps:\n      - uses: actions/checkout@v4\n      - name: Log in to Docker Hub\n        uses: docker/login-action@v3\n        with:\n          username: \${{ secrets.DOCKERHUB_USERNAME }}\n          password: \${{ secrets.DOCKERHUB_TOKEN }}\n      - name: Build and push\n        uses: docker/build-push-action@v5\n        with:\n          push: true\n          tags: \${{ secrets.DOCKERHUB_USERNAME }}/${projectName.toLowerCase()}:latest`
        : deployTarget === 'vercel'
        ? `\n  deploy:\n    name: Deploy to Vercel\n    needs: [ci]\n    runs-on: ubuntu-latest\n    if: github.ref == 'refs/heads/main'\n    steps:\n      - uses: actions/checkout@v4\n      - name: Deploy\n        run: npx vercel --prod --token=\${{ secrets.VERCEL_TOKEN }}`
        : deployTarget !== 'none'
        ? `\n  # TODO: Add deploy job for ${deployTarget}`
        : '';

    const workflow = `name: CI/CD — ${projectName}

on:
  push:
    branches:
${branchList}
  pull_request:
    branches:
${branchList}

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    name: Lint, Test & Build
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

${setupStep}

${lintStep}

${testStep}

${buildStep ? buildStep + '\n' : ''}      - name: Upload coverage
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
          retention-days: 7
${deployJob}
`;

    logger.info({ session: ctx.sessionId, projectType, deployTarget }, 'dev.ci-cd-setup complete');
    return {
      success: true,
      output: workflow,
      data: { projectType, projectName, deployTarget, branches },
      artifacts: [{ path: '.github/workflows/ci.yml', action: 'created' as const }],
    };
  },
};

// ---------------------------------------------------------------------------
// dev.dependency-audit
// ---------------------------------------------------------------------------

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low'] as const;
type Severity = typeof SEVERITY_ORDER[number];

export const dependencyAuditTool: ToolDefinition = {
  name: 'dev.dependency-audit',
  description:
    'Audit npm dependencies for security vulnerabilities. Runs npm audit in ' +
    'the working directory and returns a structured report grouped by severity ' +
    'with remediation suggestions.',
  category: 'dev',
  timeout: 60_000,
  parameters: {
    directory: { type: 'string', description: 'Project directory to audit (default: ctx.workingDir).' },
    minSeverity: {
      type: 'string',
      description: 'Minimum severity to report (default: low).',
      enum: ['critical', 'high', 'moderate', 'low'],
      default: 'low',
    },
    fix: {
      type: 'boolean',
      description: 'Attempt to auto-fix with npm audit fix (default: false).',
      default: false,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    logger.info({ session: ctx.sessionId }, 'dev.dependency-audit invoked');

    const directory = (params['directory'] as string | undefined) ?? ctx.workingDir;
    const minSeverity = ((params['minSeverity'] as string | undefined) ?? 'low') as Severity;
    const fix = params['fix'] === true;

    if (!directory?.trim()) {
      return { success: false, output: 'dev.dependency-audit: directory cannot be empty.' };
    }

    const minIdx = SEVERITY_ORDER.indexOf(minSeverity);
    if (minIdx === -1) {
      return { success: false, output: `dev.dependency-audit: invalid minSeverity "${minSeverity}".` };
    }

    try {
      if (fix) {
        logger.info({ directory }, 'Running npm audit fix');
        try {
          await execFileAsync('npm', ['audit', 'fix', '--json'], { cwd: directory, timeout: 30_000 });
        } catch {
          // npm audit fix exits non-zero on partial success; stdout still useful
        }
      }

      let auditOutput = '';
      try {
        const { stdout } = await execFileAsync('npm', ['audit', '--json'], { cwd: directory, timeout: 30_000 });
        auditOutput = stdout;
      } catch (execErr) {
        const err = execErr as { stdout?: string; stderr?: string };
        auditOutput = err.stdout ?? '';
        if (!auditOutput) {
          const msg = err.stderr ?? 'npm audit produced no output';
          logger.error({ directory, err: msg }, 'dev.dependency-audit npm error');
          return { success: false, output: `dev.dependency-audit: ${msg}` };
        }
      }

      let report: Record<string, unknown>;
      try {
        report = JSON.parse(auditOutput) as Record<string, unknown>;
      } catch {
        return { success: false, output: 'dev.dependency-audit: could not parse npm audit output.' };
      }

      const vulns = (report['vulnerabilities'] as Record<string, unknown> | undefined) ?? {};
      const metadata = report['metadata'] as Record<string, unknown> | undefined;
      const entries = Object.values(vulns) as Array<Record<string, unknown>>;

      const filtered = entries.filter((v) => {
        const sev = String(v['severity'] ?? 'low') as Severity;
        const sevIdx = SEVERITY_ORDER.indexOf(sev);
        return sevIdx !== -1 && sevIdx <= minIdx;
      });

      if (filtered.length === 0) {
        return {
          success: true,
          output: `No vulnerabilities found at or above "${minSeverity}" in ${directory}.`,
          data: { directory, total: 0, vulnerabilities: [] },
        };
      }

      const grouped: Partial<Record<Severity, Array<Record<string, unknown>>>> = {};
      for (const v of filtered) {
        const sev = String(v['severity'] ?? 'low') as Severity;
        (grouped[sev] ??= []).push(v);
      }

      const lines: string[] = [
        `# Dependency Audit Report`,
        `**Directory:** ${directory}`,
        `**Packages audited:** ${String(metadata?.['totalDependencies'] ?? 'unknown')}`,
        `**Vulnerabilities (${minSeverity}+):** ${filtered.length}`,
        '',
      ];

      for (const sev of SEVERITY_ORDER) {
        const group = grouped[sev];
        if (!group || group.length === 0) continue;
        lines.push(`## ${sev.charAt(0).toUpperCase() + sev.slice(1)} (${group.length})`);
        for (const v of group.slice(0, 10)) {
          const name = String(v['name'] ?? 'unknown');
          const via = Array.isArray(v['via'])
            ? v['via'].map((x) => typeof x === 'string' ? x : String((x as Record<string, unknown>)?.['title'] ?? '')).filter(Boolean).join(', ')
            : '';
          const fixLabel = v['fixAvailable'] === true ? 'Fix available' : v['fixAvailable'] === false ? 'No fix' : 'Check manually';
          lines.push(`- **${name}**: ${via || 'see npm audit'} — ${fixLabel}`);
        }
        if (group.length > 10) lines.push(`  *...and ${group.length - 10} more*`);
        lines.push('');
      }

      if (!fix) {
        lines.push('**Remediation:** Run `npm audit fix` to auto-fix compatible issues.');
        lines.push('For breaking changes: `npm audit fix --force` (review changelog first).');
      }

      logger.info({ directory, total: filtered.length }, 'dev.dependency-audit complete');
      return {
        success: true,
        output: lines.join('\n'),
        data: { directory, total: filtered.length, grouped: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v?.length ?? 0])) },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ directory, err: msg }, 'dev.dependency-audit error');
      return { success: false, output: `dev.dependency-audit error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// dev.refactor
// ---------------------------------------------------------------------------

interface RefactorIssue {
  priority: 'high' | 'medium' | 'low';
  pattern: string;
  finding: string;
  suggestion: string;
}

function detectIssues(code: string, focus: string[]): RefactorIssue[] {
  const lines = code.split('\n');
  const issues: RefactorIssue[] = [];

  if (focus.includes('long-functions')) {
    const funcPat = /^\s*(function|async function|const\s+\w+\s*=\s*(async\s+)?\(|def |func |public |private |protected )/;
    let funcStart = -1;
    let funcLineCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (funcPat.test(lines[i] ?? '')) {
        if (funcStart >= 0 && funcLineCount > 30) {
          issues.push({
            priority: 'high', pattern: 'long-functions',
            finding: `Function at line ${funcStart + 1} has ~${funcLineCount} lines.`,
            suggestion: 'Split into smaller single-responsibility functions (aim < 20 lines).',
          });
        }
        funcStart = i; funcLineCount = 0;
      }
      funcLineCount++;
    }
  }

  if (focus.includes('nesting')) {
    let maxDepth = 0; let deepLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const depth = ((lines[i] ?? '').match(/^\s*/)?.[0].length ?? 0) / 2;
      if (depth > maxDepth) { maxDepth = depth; deepLine = i + 1; }
    }
    if (maxDepth > 4) {
      issues.push({
        priority: 'high', pattern: 'nesting',
        finding: `Max nesting depth ${maxDepth} near line ${deepLine}.`,
        suggestion: 'Use early returns, extract helpers, or apply strategy pattern.',
      });
    }
  }

  if (focus.includes('naming')) {
    const badNames = /\b(tmp|temp|data|foo|bar|baz|x|y|z)\s*[=:]/g;
    const matches = code.match(badNames) ?? [];
    if (matches.length > 3) {
      issues.push({
        priority: 'medium', pattern: 'naming',
        finding: `${matches.length} potentially vague variable names (${[...new Set(matches)].slice(0, 5).join(', ')}).`,
        suggestion: 'Use descriptive names that convey intent.',
      });
    }
  }

  if (focus.includes('types')) {
    const anyCount = (code.match(/:\s*any\b/g) ?? []).length;
    if (anyCount > 0) {
      issues.push({
        priority: 'medium', pattern: 'types',
        finding: `${anyCount} explicit "any" type(s) found.`,
        suggestion: 'Replace "any" with specific types or use "unknown" + type guards.',
      });
    }
  }

  if (focus.includes('complexity')) {
    const conditionals = (code.match(/\b(if|else if|switch|while|for|catch|&&|\|\|)\b/g) ?? []).length;
    if (conditionals > 20) {
      issues.push({
        priority: 'medium', pattern: 'complexity',
        finding: `High cyclomatic complexity — ${conditionals} conditional branches.`,
        suggestion: 'Extract complex conditions to named booleans; consider state machines.',
      });
    }
  }

  if (focus.includes('duplication')) {
    const nonBlank = lines.filter((l) => l.trim().length > 20);
    const lineSet = new Set<string>(); let dupeCount = 0;
    for (const l of nonBlank) {
      const key = l.trim();
      if (lineSet.has(key)) dupeCount++;
      lineSet.add(key);
    }
    if (dupeCount > 3) {
      issues.push({
        priority: 'low', pattern: 'duplication',
        finding: `~${dupeCount} duplicate lines detected.`,
        suggestion: 'Extract repeated logic into shared utility functions.',
      });
    }
  }

  return issues;
}

export const refactorTool: ToolDefinition = {
  name: 'dev.refactor',
  description:
    'Analyse code for anti-patterns and produce a structured refactoring plan. ' +
    'Detects long functions, deep nesting, poor naming, missing types, ' +
    'high complexity, and duplication. Returns a prioritised improvement list.',
  category: 'dev',
  timeout: 15_000,
  parameters: {
    code: { type: 'string', required: true, description: 'Source code to analyse.' },
    language: {
      type: 'string',
      description: 'Programming language (default: auto).',
      default: 'auto',
    },
    focus: {
      type: 'array',
      description: 'Patterns to check (default: all).',
      items: {
        type: 'string',
        description: 'Pattern name.',
        enum: ['long-functions', 'duplication', 'naming', 'nesting', 'types', 'complexity'],
      },
      default: ['long-functions', 'duplication', 'naming', 'nesting', 'types', 'complexity'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const code = params['code'];
    logger.info({ session: ctx.sessionId }, 'dev.refactor invoked');

    if (typeof code !== 'string' || !code.trim()) {
      return { success: false, output: 'dev.refactor: code is required.' };
    }

    const language = (params['language'] as string | undefined) ?? 'auto';
    const focus = (params['focus'] as string[] | undefined) ??
      ['long-functions', 'duplication', 'naming', 'nesting', 'types', 'complexity'];

    const lines = code.split('\n');
    const issues = detectIssues(code, focus);

    if (issues.length === 0) {
      return {
        success: true,
        output: `No refactoring issues detected. Code looks clean for: ${focus.join(', ')}.`,
        data: { language, issueCount: 0, issues: [] },
      };
    }

    const priorityOrder: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];
    const sorted = [...issues].sort(
      (a, b) => priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority)
    );

    const report = [
      `# Refactoring Analysis`,
      `**Language:** ${language} | **Lines:** ${lines.length} | **Issues:** ${sorted.length}`,
      '',
      ...sorted.map((issue, i) =>
        `## ${i + 1}. [${issue.priority.toUpperCase()}] ${issue.pattern}\n` +
        `**Finding:** ${issue.finding}\n` +
        `**Suggestion:** ${issue.suggestion}`
      ),
      '',
      `## Summary`,
      `- High:   ${sorted.filter((i) => i.priority === 'high').length}`,
      `- Medium: ${sorted.filter((i) => i.priority === 'medium').length}`,
      `- Low:    ${sorted.filter((i) => i.priority === 'low').length}`,
      '',
      `Address high-priority items first as they most impact maintainability.`,
    ].join('\n\n');

    logger.info({ session: ctx.sessionId, issueCount: sorted.length }, 'dev.refactor complete');
    return { success: true, output: report, data: { language, issueCount: sorted.length, issues: sorted } };
  },
};
