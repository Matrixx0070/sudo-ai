# Contributing to SUDO-AI

Thank you for your interest in contributing. This document covers how to set up the project, our code standards, and the contribution workflow.

---

## Development Setup

### Prerequisites

- **Node.js** >= 22
- **pnpm** >= 9 (install via `corepack enable` or `npm install -g pnpm`)
- **bubblewrap** (`bwrap`) — optional, required only for sandbox integration tests
- **gcc** — optional, required only for building the synth seccomp seal

### Install

```bash
git clone https://github.com/Matrixx0070/sudo-ai.git
cd sudo-ai
pnpm install        # also runs postinstall build steps
```

### Configure

```bash
cp config/.env.example config/.env
# Edit config/.env and add at least one LLM API key
```

### Verify

```bash
pnpm lint   # TypeScript type-check (tsc --noEmit)
pnpm test   # Full test suite (vitest)
```

---

## Code Standards

### TypeScript

- `const` by default; `let` only when reassignment is necessary; never `var`
- Never `any` — use `unknown` when the type is uncertain
- All regex literals must be complete and properly terminated
- All errors handled with `try/catch`, logged with structured context

### Module System

- **ESM only** — `import`/`export`, never `require()` or `module.exports`
- Never `__dirname` or `__filename` — use `import.meta.url` + `fileURLToPath()`
- Use `fetch()` for HTTP — never `require("http").request()`

### File Organization

- Keep files under **300 lines** — split into modules if needed
- Co-locate tests: `src/core/foo/bar.ts` → `tests/unit/foo/bar.test.ts`
- One concern per file — prefer composition over large god-modules

### Testing

- Write tests for new features and bug fixes
- Mock external dependencies (LLM APIs, databases, file system) in unit tests
- Integration tests may use real resources where necessary — gate behind `skipIf` when unavailable
- Run the full suite before opening a PR: `pnpm test`

---

## Contribution Workflow

1. **Fork** the repository and create a feature branch:
   ```bash
   git checkout -b feature/your-feature
   ```

2. **Make your changes** following the standards above.

3. **Run checks locally:**
   ```bash
   pnpm lint
   pnpm test
   ```

4. **Commit** with a clear message:
   ```bash
   git commit -m "feat: add tool-x parameter validation"
   ```

5. **Push** and open a **Pull Request** with:
   - A clear description of what changed and why
   - Reference to any related issues
   - Confirmation that `pnpm lint` and `pnpm test` pass

---

## Questions?

Open an issue for bugs, feature requests, or general questions. For security concerns, see [SECURITY.md](SECURITY.md).
