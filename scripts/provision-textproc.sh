#!/usr/bin/env bash
# =============================================================================
# provision-textproc.sh — Spec 10 host provisioning for the text-processing
# toolchain (docs/textproc-toolchain-spec.md §4).
#
# Idempotent. Operator-run (the agent must never apt-install autonomously).
#   ./scripts/provision-textproc.sh            install everything
#   ./scripts/provision-textproc.sh --check    print coverage table, exit 0/1
#   ./scripts/provision-textproc.sh --offline  skip GitHub downloads
#
# Sources:
#   apt      — distro packages (Ubuntu 24.04 verified 2026-07-14)
#   pip      — dedicated venv at data/textproc-venv (PEP 668: never system pip)
#   github   — release binaries pinned by TAG + SHA256 → /usr/local/bin
#   symlink  — Debian-renamed binaries get their upstream names
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${REPO_ROOT}/data/textproc-venv"
BIN_DIR="/usr/local/bin"
MODE="${1:-install}"

# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

APT_PKGS=(
  moreutils datamash colordiff miller gawk parallel entr jo
  html-xml-utils ugrep gron sd dasel xq git-delta yq
  unzip # needed by the github section's .zip assets
)

# pip packages installed into the dedicated venv; exposed via symlinks below.
PIP_PKGS=(pyyaml csvkit pyp visidata)
# venv console scripts symlinked into /usr/local/bin (csvkit's full set).
VENV_LINKS=(
  csvlook csvcut csvgrep csvjson csvstat csvsql csvstack csvformat csvclean
  csvjoin csvsort in2csv sql2csv pyp vd
)

# name|repo|tag|asset|sha256|how
# how: raw   — asset IS the binary (rename to name, chmod +x)
#      tgz:P — tar.gz, extract member P
#      zip:P — zip, extract member P
#      deb:P — .deb, dpkg-deb -x then copy member P
GITHUB_BINS=(
  "choose|theryangeary/choose|v1.3.7|choose-x86_64-unknown-linux-gnu|9f7e5f6f02e53dc3869cf216db5d481d48f365bdbbebe2f08969734c8443784e|raw"
  "fx|antonmedv/fx|39.2.0|fx_linux_amd64|17ea6549c7cf0b8be5ec109d04da7fbf1d5de9f7b99d957a6215081933528afe|raw"
  "jless|PaulJuliusMartinez/jless|v0.9.0|jless-v0.9.0-x86_64-unknown-linux-gnu.zip|a1e0eb63ef347adc649989ac5c7d2dc896df6d494622b953c86e3a248e733a93|zip:jless"
  "htmlq|mgdm/htmlq|v0.4.0|htmlq-x86_64-linux.tar.gz|4f63c8d9d835aa1f18f472da2eb5fc88295ede6aebcc7949fd428403707fc74a|tgz:htmlq"
  "difft|Wilfred/difftastic|0.69.0|difft-x86_64-unknown-linux-gnu.tar.gz|038db96a0e8fce69f2554e33e04ff75fbf6f96ea45cb4edb9ed6203a2c4750ff|tgz:difft"
  "qsv|dathere/qsv|21.1.0|qsv-21.1.0-x86_64-unknown-linux-gnu.zip|849c5907862b9ec1228cb307b3eec3b1cc78439baf6e142b07b8940c94b34f7b|zip:qsv"
  "teip|greymd/teip|v2.3.3|teip-2.3.3.x86_64-unknown-linux-musl.deb|70efc313de721df2129cc1185def87aae10cc26e3c6aeed67348e8b36a2f36fb|deb:./usr/bin/teip"
  "rga|phiresky/ripgrep-all|v0.10.10|ripgrep_all-v0.10.10-x86_64-unknown-linux-musl.tar.gz|a969c25b182ac84aa672518313b5f741091decf7d93d03a020bcfe517b9ff4e8|tgz:*/rga"
)

# target|source — created only when source exists and target doesn't resolve.
SYMLINKS=(
  "${BIN_DIR}/bat|$(command -v batcat || true)"
  "${BIN_DIR}/fd|$(command -v fdfind || true)"
)

# Everything --check verifies (union of the above + preexisting spine).
CHECK_BINS=(
  sed awk gawk grep head tail cut tr sort uniq nl tac rev shuf fold paste
  join csplit tee xargs comm diff patch wc file strings base64 iconv fmt
  sdiff perl python3 rg fzf jq curl
  sponge ifne ts combine pee vipe datamash colordiff mlr parallel entr jo
  hxselect ugrep gron sd dasel xq delta yq unzip
  bat fd choose fx jless htmlq difft qsv teip rga
  csvlook csvstat in2csv pyp vd
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log()  { printf '[textproc] %s\n' "$*"; }
skip() { printf '[textproc] SKIPPED: %s — %s\n' "$1" "$2"; SKIPPED+=("$1 ($2)"); }
SKIPPED=()

have() { command -v "$1" >/dev/null 2>&1; }

check_coverage() {
  local missing=0
  printf '%-12s %s\n' 'BINARY' 'STATUS'
  for b in "${CHECK_BINS[@]}"; do
    if have "$b"; then
      printf '%-12s %s\n' "$b" "$(command -v "$b")"
    else
      printf '%-12s %s\n' "$b" 'MISSING'
      missing=$((missing + 1))
    fi
  done
  log "coverage: $(( ${#CHECK_BINS[@]} - missing ))/${#CHECK_BINS[@]} present"
  return $(( missing > 0 ? 1 : 0 ))
}

if [[ "$MODE" == "--check" ]]; then
  check_coverage
  exit $?
fi

if [[ "$(id -u)" != "0" ]]; then
  log "must run as root (apt + ${BIN_DIR} writes)"; exit 1
fi

# ---------------------------------------------------------------------------
# 1. apt
# ---------------------------------------------------------------------------

log "apt: ${APT_PKGS[*]}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
for pkg in "${APT_PKGS[@]}"; do
  if apt-get install -y -qq --no-install-recommends "$pkg" >/dev/null; then
    log "apt ok: $pkg"
  else
    skip "$pkg" "apt install failed (name missing on this distro?)"
  fi
done

# ---------------------------------------------------------------------------
# 2. pip venv
# ---------------------------------------------------------------------------

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  log "creating venv ${VENV_DIR}"
  python3 -m venv "${VENV_DIR}"
fi
"${VENV_DIR}/bin/pip" install --quiet --upgrade pip
for pkg in "${PIP_PKGS[@]}"; do
  if "${VENV_DIR}/bin/pip" install --quiet "$pkg"; then
    log "pip ok: $pkg"
  else
    skip "$pkg" "pip install failed"
  fi
done
for name in "${VENV_LINKS[@]}"; do
  if [[ -x "${VENV_DIR}/bin/${name}" && ! -e "${BIN_DIR}/${name}" ]]; then
    ln -s "${VENV_DIR}/bin/${name}" "${BIN_DIR}/${name}"
    log "linked ${name} -> venv"
  fi
done

# ---------------------------------------------------------------------------
# 3. GitHub release binaries (sha256-pinned; no curl|bash, ever)
# ---------------------------------------------------------------------------

if [[ "$MODE" == "--offline" ]]; then
  log "offline mode: skipping GitHub downloads"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  for entry in "${GITHUB_BINS[@]}"; do
    IFS='|' read -r name repo tag asset sha how <<<"$entry"
    if have "$name"; then log "already present: $name"; continue; fi
    url="https://github.com/${repo}/releases/download/${tag}/${asset}"
    log "fetching ${name} (${tag})"
    if ! curl -fsSL --retry 3 -o "${TMP}/${asset}" "$url"; then
      skip "$name" "download failed"; continue
    fi
    if ! echo "${sha}  ${TMP}/${asset}" | sha256sum -c --quiet -; then
      skip "$name" "SHA256 MISMATCH — refusing to install"; continue
    fi
    case "$how" in
      raw)
        install -m 0755 "${TMP}/${asset}" "${BIN_DIR}/${name}" ;;
      tgz:*)
        tar -xzf "${TMP}/${asset}" -C "$TMP" --wildcards "${how#tgz:}" 2>/dev/null || tar -xzf "${TMP}/${asset}" -C "$TMP"
        found="$(find "$TMP" -type f -name "$name" | head -1)"
        [[ -n "$found" ]] && install -m 0755 "$found" "${BIN_DIR}/${name}" || { skip "$name" "member not found in tarball"; continue; } ;;
      zip:*)
        unzip -qo "${TMP}/${asset}" -d "${TMP}/${name}-zip"
        found="$(find "${TMP}/${name}-zip" -type f -name "${how#zip:}" | head -1)"
        [[ -n "$found" ]] && install -m 0755 "$found" "${BIN_DIR}/${name}" || { skip "$name" "member not found in zip"; continue; } ;;
      deb:*)
        dpkg-deb -x "${TMP}/${asset}" "${TMP}/${name}-deb"
        member="${TMP}/${name}-deb/${how#deb:}"
        [[ -f "$member" ]] && install -m 0755 "$member" "${BIN_DIR}/${name}" || { skip "$name" "member not found in deb"; continue; } ;;
    esac
    have "$name" && log "installed: $name -> ${BIN_DIR}/${name}"
  done
fi

# ---------------------------------------------------------------------------
# 4. Symlinks for Debian-renamed binaries
# ---------------------------------------------------------------------------

for entry in "${SYMLINKS[@]}"; do
  IFS='|' read -r target source <<<"$entry"
  name="$(basename "$target")"
  if have "$name"; then log "already present: $name"; continue; fi
  if [[ -n "$source" && -x "$source" ]]; then
    ln -s "$source" "$target"
    log "linked ${name} -> ${source}"
  else
    skip "$name" "source binary missing"
  fi
done

# ---------------------------------------------------------------------------
# 5. Report
# ---------------------------------------------------------------------------

log "=== provisioning done — coverage: ==="
check_coverage || true
if (( ${#SKIPPED[@]} > 0 )); then
  log "SKIPPED items (${#SKIPPED[@]}):"
  for s in "${SKIPPED[@]}"; do log "  - $s"; done
fi
log "next: refresh the capability manifest (textproc.capabilities {refresh:true} or restart the daemon)"
