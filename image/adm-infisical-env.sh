# Sourced by every new zsh (/etc/zsh/zshenv) and bash (BASH_ENV,
# /etc/bash.bashrc) in a coding workspace (TASK-138): exports a fresh
# Infisical access token from the cluster's `adm infisical login` as
# INFISICAL_TOKEN, so `infisical run` (including a project's own npm CLI under
# pnpm) works with no per-workspace login. A token the user or a workspace
# Secret set wins; only a token this hook exported (marked by
# ADM_INFISICAL_TOKEN_FROM_ADM=1) is replaced. Not logged in: silent, no token.
# Any other failure: adm-infisical-token prints one line and the shell starts.
if [ -z "${INFISICAL_TOKEN:-}" ] || [ "${ADM_INFISICAL_TOKEN_FROM_ADM:-}" = 1 ]; then
  unset INFISICAL_TOKEN ADM_INFISICAL_TOKEN_FROM_ADM
  if adm_infisical_token=$(adm-infisical-token); then
    export INFISICAL_TOKEN="$adm_infisical_token" ADM_INFISICAL_TOKEN_FROM_ADM=1
  fi
  unset adm_infisical_token
fi
