# Interactive workspace shell identity.
# Sourced from /etc/zsh/zshrc and from the seeded startup file
# (~/.zshrc -> /workspace/.adm/zsh/.zshrc). Safe to source more than once.
# Non-interactive zsh (adm exec, adm shell -- COMMAND, coding tools) does not
# load this file.

if [ -z "${HOME:-}" ]; then
  HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
  export HOME
fi
if [ -z "${USER:-}" ]; then
  USER=${LOGNAME:-$(id -un)}
  export USER
fi
export SHELL=/usr/bin/zsh

# pip, cargo, and other installers put executables in ~/.local/bin.
# A managed shell keeps its client directory ahead of that.
adm_local_bin="${HOME}/.local/bin"
case ":${PATH}:" in
  *":${adm_local_bin}:"*) ;;
  *)
    if [ -n "${ADM_MANAGE_SOCKET:-}" ] && [ "${PATH#*:}" != "${PATH}" ]; then
      PATH="${PATH%%:*}:${adm_local_bin}:${PATH#*:}"
    else
      PATH="${adm_local_bin}:${PATH}"
    fi
    ;;
esac
unset adm_local_bin
export PATH
