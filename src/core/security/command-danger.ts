/**
 * Command-danger analysis — the static parser behind the execution authority's
 * containment layer.
 *
 * Split out of execution-authority.ts (which owns POLICY: modes, god mode,
 * owner attribution) so that policy and command parsing evolve separately.
 * This file answers exactly one question: "would this command destroy the
 * system or a raw disk?" It never decides whether to prompt — nothing here is
 * a question to the user.
 *
 * Hardened across four adversarial review rounds; see the regression list in
 * tests/security/execution-authority.test.ts and the honest limits in
 * docs/EXECUTION_AUTHORITY.md.
 */

/**
 * Whole-system destruction detection — a last-resort backstop against an
 * UNRECOVERABLE mistake, not a policy engine.
 *
 * Implemented as a small parser rather than a literal-prefix list because an
 * adversarial review (2026-08-16) defeated the first regex-only version with
 * fifteen realistic variants: `/dev/nvme0n1` (the primary disk on most modern
 * servers), partition suffixes (`/dev/sda1`), quoted root (`rm -rf "/"`),
 * separated flags (`rm -r -f /`), `--no-preserve-root`, `wipefs`, `shred`,
 * `find / -delete`, and `cd / && rm -rf *`.
 *
 * `isDangerousCommand()` (exec-policy's hardened DANGEROUS_PREFIXES) runs
 * alongside this in `authorize()` — that list keeps its force-deny power in
 * autonomous mode instead of being silently replaced by this one.
 */

/** Whole-disk / partition device nodes. Destroying one is unrecoverable. */
const BLOCK_DEVICE =
  /\/dev\/(sd[a-z]\d*|nvme\d+n\d+(p\d+)?|vd[a-z]\d*|hd[a-z]\d*|xvd[a-z]\d*|mmcblk\d+(p\d+)?|disk\d+)\b/;

/**
 * Top-level directories whose deletion destroys the system or the owner's
 * work. Their SUBPATHS stay freely deletable — `rm -rf /var/log/myapp` and
 * `rm -rf /root/sudo-ai-v4/dist` are ordinary sysadmin work and must run.
 */
const PROTECTED_ROOTS = new Set([
  // '/@home' is the sentinel expandHome() maps `~` / `$HOME` onto.
  '/@home',
  '/', '//', '/.', '/*', '/bin', '/boot', '/dev', '/etc', '/home', '/lib',
  '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys',
  '/usr', '/var',
]);

/** Remove quoting so `rm -rf "/"` and `rm -rf '/'` normalise to `rm -rf /`. */
function unquote(token: string): string {
  return token.replace(/['"]/g, '');
}

/** Split a compound command on shell separators into individual commands. */
function splitSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;\n|])/).map((s) => s.trim()).filter(Boolean);
}

/** True when an `rm` invocation is both recursive and forced, any flag form. */
function rmIsRecursiveForce(tokens: string[]): boolean {
  let recursive = false;
  let force = false;
  for (const raw of tokens.slice(1)) {
    const t = unquote(raw);
    if (!t.startsWith('-')) continue;
    if (t === '--recursive') recursive = true;
    else if (t === '--force') force = true;
    else if (/^-[a-zA-Z]+$/.test(t)) {
      if (/[rR]/.test(t)) recursive = true;
      if (/f/.test(t)) force = true;
    }
  }
  return recursive && force;
}

/** Non-flag arguments of a command, unquoted. */
function operandsOf(tokens: string[]): string[] {
  return tokens
    .slice(1)
    .map(unquote)
    .filter((t) => t.length > 0 && !t.startsWith('-'));
}

/**
 * Expand the home shorthands so `rm -rf $HOME/`, `rm -rf "$HOME"` and
 * `rm -rf ~/` compare equal to the home root itself (round-5 defect: a
 * trailing slash or a pair of quotes defeated the audited substring ban,
 * and a bare `$HOME/` still wipes the whole home directory).
 */
function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return '/@home' + p.slice(1);
  const m = /^\$\{?HOME\}?(\/.*)?$/.exec(p);
  if (m) return '/@home' + (m[1] ?? '');
  return p;
}

/** Normalise a path operand for protected-root comparison. */
function normalisePath(raw: string): string {
  // Always fully normalise: runs of slashes (`//////`), `.` segments and
  // trailing slashes (`/etc//`) all previously defeated the protected-root
  // comparison (adversarial review round 3). Home shorthands are expanded
  // first so `$HOME/`, `"$HOME"` and `~/` reduce to the home root (round 5).
  const p = expandHome(raw);
  if (!p.startsWith('/')) return p;
  const resolved = resolveDots(p);
  return resolved === '' ? '/' : resolved;
}

/**
 * Normalise a command before analysis so trivial wrappers and expansions
 * cannot hide intent (adversarial review 2026-08-16 defeated the first parser
 * with `bash -c "rm -rf /"`, `${HOME}`, `` `echo /` ``, and `/etc/../`).
 *
 * Static analysis can never resolve every runtime expansion — `rm -rf $(pwd)`
 * depends on the working directory. This is a best-effort backstop layered
 * under the bwrap sandbox, not a security boundary; it closes the cheap,
 * obvious evasions of the audited bans.
 */
export function normalizeForAnalysis(command: string): string {
  let out = command.trim();

  // Neutral prefixes and shell wrappers are peeled ALTERNATELY to a fixed
  // point: stripping once then unwrapping once missed a prefix revealed
  // inside the unwrapped payload (`sh -c "env bash -c \\"rm -rf /\\""` —
  // adversarial review round 4, defect D2).
  for (let i = 0; i < 6; i++) {
    const before = out;
    out = out.replace(/^(sudo|doas|env|nohup|stdbuf|command|ionice|nice)\s+(-{1,2}[A-Za-z][\w-]*(=\S+)?\s+)*/, '');
    out = out.replace(/^timeout\s+(-{1,2}\S+\s+)*[\d.]+[smhd]?\s+/, '');
    const m = /^(?:\/bin\/)?(?:ba|z|k)?sh\s+-[a-zA-Z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(out.trim());
    if (m && m[2] !== undefined) {
      // Un-escape the payload's own quotes so a nested wrapper is visible.
      out = m[2].trim().replace(/\\(['"])/g, '$1');
    }
    if (out === before) break;
  }

  // `${VAR}` → `$VAR` so the audited `$HOME` ban applies to both spellings.
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1');

  // Resolve trivially-static substitutions: `$(echo X)`, `` `echo X` ``,
  // `$(printf X)`, `$(printf '%s' X)`.
  out = out.replace(/\$\(\s*echo\s+([^)]*)\)/g, '$1');
  out = out.replace(/`\s*echo\s+([^`]*)`/g, '$1');
  out = out.replace(/\$\(\s*printf\s+(?:'%s'|"%s"|%s)?\s*([^)]*)\)/g, '$1');
  out = out.replace(/`\s*printf\s+(?:'%s'|"%s"|%s)?\s*([^`]*)`/g, '$1');

  return out.trim();
}

/**
 * A `${VAR:-default}` can expand to either branch and static analysis cannot
 * know which. Return BOTH readings so a catastrophic one is never missed:
 * `rm -rf ${HOME:-/}` must be refused whether HOME is set or not.
 */
export function analysisVariants(command: string): string[] {
  const BRACE_DEFAULT = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-=+])([^}]*)\}/g;
  const asVar = command.replace(BRACE_DEFAULT, '$$$1');
  const asDefault = command.replace(BRACE_DEFAULT, '$2');
  const out = [normalizeForAnalysis(asVar)];
  if (asDefault !== asVar) out.push(normalizeForAnalysis(asDefault));
  return out;
}

/** Collapse `.` and `..` segments so `/etc/../` resolves to `/`. */
function resolveDots(p: string): string {
  if (!p.startsWith('/')) return p;
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

/**
 * True when the command would destroy the whole system or a raw disk.
 *
 * Deliberately narrow on the permissive side: ordinary destructive sysadmin
 * work (`rm -rf /tmp/build`, `rm -rf node_modules`, `mkfs.ext4 /tmp/loopfile`,
 * `dd of=/tmp/img`) must keep running without asking — that is the directive.
 */
export function isCatastrophicCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false;

  const normalised = normalizeForAnalysis(command);

  const segments = splitSegments(normalised);
  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i] ?? '';
    let tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    let head = unquote(tokens[0] ?? '');

    // `echo / | xargs rm -rf` — the destructive operand arrives over the pipe.
    // Rebuild the effective command from the producing segment.
    if (head === 'xargs') {
      // Drop only xargs' OWN leading flags (-n1, -0, -I{}); everything from
      // the command name onward keeps its flags — `rm -rf` must stay `rm -rf`.
      const rest = tokens.slice(1);
      let k = 0;
      while (k < rest.length && /^-/.test(unquote(rest[k] ?? ''))) k++;
      const inner = rest.slice(k);
      // Operands arriving over the pipe. Only STATIC emitters are threaded —
      // echo/printf/yes literally reproduce their arguments. Producers whose
      // output is derived (find, ls, grep) are deliberately NOT threaded, or
      // `grep -rl foo /etc | xargs rm -rf` would be wrongly refused.
      const prevTokens = (segments[i - 1] ?? '').split(/\s+/).filter(Boolean);
      const producer = unquote(prevTokens[0] ?? '');
      let piped: string[] = [];
      if (producer === 'echo' || producer === 'yes') {
        piped = prevTokens.slice(1);
      } else if (producer === 'printf') {
        // Drop a leading format string (`printf '%s\n' /`).
        piped = prevTokens.slice(1).filter((t) => !/%/.test(unquote(t)));
      }
      tokens = [...inner, ...piped];
      segment = tokens.join(' ');
      head = unquote(tokens[0] ?? '');
      if (tokens.length === 0) continue;
    }

    // Raw-device writes: dd of=/dev/sda, > /dev/nvme0n1, mkfs, wipefs, shred.
    if (BLOCK_DEVICE.test(segment)) {
      if (/^(dd|mkfs(\.[a-z0-9]+)?|wipefs|shred|badblocks|parted|sgdisk|fdisk)$/.test(head)) return true;
      if (/>\s*['"]?\/dev\//.test(segment)) return true;
    }

    if (head === 'rm' && rmIsRecursiveForce(tokens)) {
      for (const operand of operandsOf(tokens)) {
        if (PROTECTED_ROOTS.has(normalisePath(operand))) return true;
        // `rm -rf *` is catastrophic only when the shell was moved to / first.
        if ((operand === '*' || operand === './*') && cwdIsRoot(normalised, segment)) return true;
      }
    }

    // `chmod -R <any> /` / `chown -R <any> /` — bricks the system just as
    // thoroughly as deleting it (the audited list only covered mode 777).
    if ((head === 'chmod' || head === 'chown') && tokens.some((t) => /^-[a-zA-Z]*R/.test(unquote(t)))) {
      const paths = operandsOf(tokens).filter((t) => t.startsWith('/'));
      if (paths.some((t) => PROTECTED_ROOTS.has(normalisePath(t)))) return true;
    }

    // Moving a protected root away is equivalent to deleting it.
    if (head === 'mv') {
      const paths = operandsOf(tokens);
      if (paths.length > 1 && paths.slice(0, -1).some((t) => PROTECTED_ROOTS.has(normalisePath(t)))) return true;
    }

    // `find / -delete` / `find / -exec rm -rf {}` — a slower `rm -rf /`.
    if (head === 'find') {
      const targets = operandsOf(tokens).filter((t) => t.startsWith('/') || t.startsWith('~') || t.startsWith('$'));
      const deletes = /\s-delete\b/.test(segment) || /-exec\s+rm\b/.test(segment);
      // A RESTRICTING predicate makes the sweep targeted, not total:
      // `find / -name "*.pyc" -delete` is legitimate cleanup and must run
      // (round-5 false positive). Only an unfiltered `find / -delete` is
      // equivalent to `rm -rf /`.
      const filtered = /\s-(name|iname|path|ipath|regex|iregex|type|size|mtime|mmin|user|group|perm|newer)\b/.test(segment);
      if (deletes && !filtered && targets.some((t) => PROTECTED_ROOTS.has(normalisePath(t)))) return true;
    }
  }

  return false;
}

/** True when an earlier segment of the same command line cd'd to `/`. */
function cwdIsRoot(fullCommand: string, currentSegment: string): boolean {
  for (const segment of splitSegments(fullCommand)) {
    if (segment === currentSegment) break;
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (unquote(tokens[0] ?? '') === 'cd') {
      const target = operandsOf(tokens)[0];
      if (target !== undefined && normalisePath(target) === '/') return true;
    }
  }
  return false;
}
