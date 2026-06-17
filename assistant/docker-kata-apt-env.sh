#!/usr/bin/env sh

if [ "${MAX_SANDBOX_RUNTIME:-}" != "kata" ]; then
  return 0 2>/dev/null || exit 0
fi

export MAX_APT_DATA_ROOT="${MAX_APT_DATA_ROOT:-/data/system}"

_max_kata_append_path() {
  case ":${PATH:-}:" in
    *":$1:"*) ;;
    *) PATH="${PATH:+${PATH}:}$1" ;;
  esac
}

_max_kata_prepend_library_path() {
  case ":${LD_LIBRARY_PATH:-}:" in
    *":$1:"*) ;;
    *) LD_LIBRARY_PATH="$1${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}" ;;
  esac
}

_max_kata_append_path "${MAX_APT_DATA_ROOT}/bin"
_max_kata_append_path "${MAX_APT_DATA_ROOT}/usr/local/sbin"
_max_kata_append_path "${MAX_APT_DATA_ROOT}/usr/local/bin"
_max_kata_append_path "${MAX_APT_DATA_ROOT}/usr/sbin"
_max_kata_append_path "${MAX_APT_DATA_ROOT}/usr/bin"
_max_kata_append_path "${MAX_APT_DATA_ROOT}/sbin"
_max_kata_append_path "${MAX_APT_DATA_ROOT}/usr/games"
_max_kata_append_path "${MAX_APT_DATA_ROOT}/games"
export PATH

_max_kata_prepend_library_path "${MAX_APT_DATA_ROOT}/usr/lib/aarch64-linux-gnu"
_max_kata_prepend_library_path "${MAX_APT_DATA_ROOT}/usr/lib/x86_64-linux-gnu"
_max_kata_prepend_library_path "${MAX_APT_DATA_ROOT}/usr/lib"
_max_kata_prepend_library_path "${MAX_APT_DATA_ROOT}/usr/local/lib"
export LD_LIBRARY_PATH

unset -f _max_kata_append_path _max_kata_prepend_library_path
