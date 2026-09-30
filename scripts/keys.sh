#!/usr/bin/env bash
# API keys for local development live in the macOS login Keychain, not in
# dotfiles or .env.local. Policy: docs/SETUP.md, section "API keys".
#
#   scripts/keys.sh set NAME        store a key (prompts, input hidden; or piped on stdin)
#   scripts/keys.sh unset NAME      remove a key
#   scripts/keys.sh list            which of the known keys are stored
#   scripts/keys.sh run -- CMD...   run CMD with every stored key exported
#
# Keys are never printed. `run` exports them into the child process only.
# Each key is one Keychain item named dealz/NAME under the current account.
set -euo pipefail

SERVICE_PREFIX="dealz"
# Every key the project can use. Add a name here and in .env.example together.
KEY_NAMES=(GEMINI_API_KEY SERPAPI_API_KEY)
ACCOUNT="${USER}"

die() {
  echo "keys.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

known() {
  local name
  for name in "${KEY_NAMES[@]}"; do
    [[ "$name" == "$1" ]] && return 0
  done
  return 1
}

require_macos() {
  command -v security >/dev/null 2>&1 || die "the macOS 'security' tool is not available"
}

read_key() {
  security find-generic-password -a "$ACCOUNT" -s "$SERVICE_PREFIX/$1" -w 2>/dev/null
}

cmd="${1:-}"
[[ -n "$cmd" ]] || usage
shift

case "$cmd" in
  set)
    require_macos
    name="${1:-}"
    [[ -n "$name" ]] || usage
    known "$name" || die "unknown key $name; known: ${KEY_NAMES[*]}"
    if [[ -t 0 ]]; then
      read -r -s -p "Value for $name (input hidden): " value
      echo
    else
      value="$(cat)"
    fi
    value="${value//$'\n'/}"
    [[ -n "$value" ]] || die "empty value, nothing stored"
    # -U updates an existing item in place. The value passes on the command
    # line for a few milliseconds, visible only to processes of this user.
    security add-generic-password -U -a "$ACCOUNT" -s "$SERVICE_PREFIX/$name" \
      -j "DealZ local development key" -w "$value"
    echo "stored $name in the login keychain as $SERVICE_PREFIX/$name"
    ;;

  unset)
    require_macos
    name="${1:-}"
    [[ -n "$name" ]] || usage
    security delete-generic-password -a "$ACCOUNT" -s "$SERVICE_PREFIX/$name" >/dev/null 2>&1 \
      || die "$name is not stored"
    echo "removed $name"
    ;;

  list)
    require_macos
    for name in "${KEY_NAMES[@]}"; do
      if read_key "$name" >/dev/null; then
        echo "$name  stored"
      else
        echo "$name  missing"
      fi
    done
    ;;

  run)
    [[ "${1:-}" == "--" ]] && shift
    [[ $# -gt 0 ]] || usage
    if command -v security >/dev/null 2>&1; then
      for name in "${KEY_NAMES[@]}"; do
        if value="$(read_key "$name")" && [[ -n "$value" ]]; then
          export "$name=$value"
        fi
      done
    fi
    exec "$@"
    ;;

  *)
    usage
    ;;
esac
