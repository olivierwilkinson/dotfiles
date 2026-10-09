export DF_HOME=~/dotfiles
export DF_CORE=$DF_HOME/core
export DF_USER=$DF_HOME/personal

# Create common color functions.
autoload -U colors
colors

# Set up custom environment variables
source $DF_CORE/environment.zsh
source $DF_USER/environment.zsh
source $DF_USER/environment.local.zsh

# Homebrew - must be early, before macos.zsh files that use brew
if [[ -f /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# Load configs for MacOS. Does nothing if not on MacOS
if [ "$ZSH_HOST_OS" = "darwin" ]; then
  source $DF_CORE/macos.zsh
  if [ -e $DF_USER/macos.zsh ]; then
    source $DF_USER/macos.zsh
  fi
fi

# Load zsh plugins via Antigen
source $DF_CORE/default_bundles.zsh
source $DF_USER/antigen_bundles.zsh
antigen apply

source $DF_CORE/filter_history.zsh

source $DF_USER/custom.zsh

source $DF_HOME/extra.zsh

[ -f /opt/dev/dev.sh ] && source /opt/dev/dev.sh

[[ -f /opt/dev/sh/chruby/chruby.sh ]] && { type chruby >/dev/null 2>&1 || chruby () { source /opt/dev/sh/chruby/chruby.sh; chruby "$@"; } }

# Added by tec agent
[[ -x /Users/olivier/.local/state/tec/profiles/base/current/global/init ]] && eval "$(/Users/olivier/.local/state/tec/profiles/base/current/global/init zsh)"

export PATH="$HOME/.local/bin:$PATH"

# pnpm
export PNPM_HOME="/Users/olivier/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

# bun completions
[ -s "/Users/olivier/.bun/_bun" ] && source "/Users/olivier/.bun/_bun"
