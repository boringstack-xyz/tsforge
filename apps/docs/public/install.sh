#!/usr/bin/env bash
# Install tsforge CLI — https://tsforge.dev
#
# Usage:
#   curl -fsSL https://tsforge.dev/install.sh | bash
#
# Environment:
#   TSFORGE_REF=main|v0.1.0     git ref when installing from GitHub (default: main)
#   TSFORGE_LIB=~/.local/share/tsforge   clone location for git install
#   TSFORGE_REPO=https://github.com/boringstack-xyz/tsforge.git
#   BUN_INSTALL=~/.bun          Bun install root (installed automatically if missing)

set -euo pipefail

TSFORGE_REPO="${TSFORGE_REPO:-https://github.com/boringstack-xyz/tsforge.git}"
TSFORGE_REF="${TSFORGE_REF:-main}"
TSFORGE_LIB="${TSFORGE_LIB:-${HOME}/.local/share/tsforge}"

info() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return 0
  fi

  info "Bun not found. Installing Bun (tsforge requires Bun >= 1.4.0)..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
  export PATH="${BUN_INSTALL}/bin:${PATH}"

  if ! command -v bun >/dev/null 2>&1; then
    echo "error: Bun install finished but bun is not on PATH." >&2
    echo "Add ${BUN_INSTALL}/bin to your PATH and re-run this script." >&2
    exit 1
  fi
}

install_from_npm() {
  # Prefer real npm over `bun install -g` here: as of Bun 1.4.x, the global
  # installer mishandles @agjs/tsforge's `@typescript/native` dependency
  # (TypeScript 7's platform-specific optionalDependencies — only one of
  # ~20 resolves on any given machine, and an unresolved one can be left
  # with an internal empty name that Bun's global-install safety check then
  # rejects outright instead of skipping). Bun fixed the same class of bug
  # in its dependency-tree builder (oven-sh/bun#31652) but not in this
  # installer-level check, so it's still broken on 1.4.0. npm doesn't share
  # that code path.
  #
  # --prefer-online / --no-cache: both package managers otherwise resolve
  # `@latest` from a locally cached copy of the package metadata, so for a while
  # after a release the installer kept reinstalling the PREVIOUS version while
  # reporting success.
  if command -v npm >/dev/null 2>&1; then
    info "Trying npm registry (npm install -g @agjs/tsforge)..."
    if npm install -g @agjs/tsforge@latest --prefer-online; then
      info "Installed tsforge from npm."
      print_done
      return 0
    fi
    return 1
  fi

  info "Trying npm registry (bun install -g @agjs/tsforge)..."
  if bun install -g @agjs/tsforge@latest --no-cache; then
    info "Installed tsforge from npm."
    print_done
    return 0
  fi
  return 1
}

install_from_git() {
  info "Installing tsforge from ${TSFORGE_REPO} (${TSFORGE_REF})..."

  mkdir -p "$(dirname "${TSFORGE_LIB}")"

  if [ -d "${TSFORGE_LIB}/.git" ]; then
    git -C "${TSFORGE_LIB}" fetch --depth 1 origin "${TSFORGE_REF}"
    git -C "${TSFORGE_LIB}" reset --hard FETCH_HEAD
  else
    rm -rf "${TSFORGE_LIB}"
    git clone --depth 1 --branch "${TSFORGE_REF}" "${TSFORGE_REPO}" "${TSFORGE_LIB}"
  fi

  (
    cd "${TSFORGE_LIB}/packages/core"
    bun install
    # NOT `bun link --global`: on Bun 1.4.x it fails with `error: package.json
    # missing "name"` against the global project file it just created itself
    # (a separate Bun 1.4 regression from the one in install_from_npm above).
    # A direct symlink into Bun's own global bin dir sidesteps it — but that
    # global project file has to exist with a "name" first, or a totally
    # fresh Bun install fails the same way on `bun pm bin -g` itself. Seed a
    # minimal one (only if missing, so a real one is never overwritten).
    bun_install_dir="${BUN_INSTALL:-${HOME}/.bun}"
    global_dir="${bun_install_dir}/install/global"
    if [ ! -f "${global_dir}/package.json" ]; then
      mkdir -p "${global_dir}"
      printf '{"name":"bun-global","dependencies":{}}' >"${global_dir}/package.json"
    fi

    bin_dir="$(bun pm bin -g)"
    mkdir -p "${bin_dir}"
    ln -sf "${TSFORGE_LIB}/packages/core/bin/tsforge.js" "${bin_dir}/tsforge"
  )

  info "Linked tsforge globally from ${TSFORGE_LIB}/packages/core"
}

# Report what actually runs as `tsforge`: the installed version, and a warning
# when a different (usually older) install earlier on PATH shadows this one.
report_installed() {
  local found
  found="$(command -v tsforge 2>/dev/null || true)"

  if [ -z "${found}" ]; then
    return 0
  fi

  info "tsforge on PATH: ${found} ($(tsforge --version 2>/dev/null || echo 'version unknown'))"

  # Unique paths only: a PATH that lists one directory twice is not two installs.
  local all
  all="$(type -a -p tsforge 2>/dev/null | awk '!seen[$0]++' || true)"

  if [ "$(printf '%s\n' "${all}" | grep -c .)" -gt 1 ]; then
    warn "more than one tsforge is on your PATH — the first one wins:"
    printf '%s\n' "${all}" | sed 's/^/  /' >&2
    warn "remove the ones you don't use so an old copy can't shadow this install."
  fi
}

print_done() {
  hash -r 2>/dev/null || true
  report_installed

  cat <<EOF

tsforge is installed.

  tsforge --help          show flags
  tsforge                   interactive session

Configure your model in ~/.tsforge/models.json — see:
  https://tsforge.dev/quickstart/

If \`tsforge\` is not found, add your package manager's global bin dir to PATH:

  npm:  export PATH="\$(npm config get prefix)/bin:\${PATH}"
  bun:  export PATH="\$(bun pm bin -g):\${PATH}"

EOF
}

main() {
  ensure_bun

  if [ "${TSFORGE_INSTALL:-auto}" = "npm" ]; then
    install_from_npm
    exit 0
  fi

  if [ "${TSFORGE_INSTALL:-auto}" = "git" ]; then
    install_from_git
    print_done
    exit 0
  fi

  # auto: prefer npm when the package is published; fall back to git
  if install_from_npm; then
    exit 0
  fi

  warn "npm install failed or tsforge is not published yet; installing from GitHub."
  install_from_git
  print_done
}

main "$@"
