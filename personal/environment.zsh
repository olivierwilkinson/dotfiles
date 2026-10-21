# Define custom environment variables.
# This will overwrite any environment variables defined by `core/environment.zsh`.
export EDITOR="nvim"

# Add personal bin directory to PATH
export PATH="$HOME/dotfiles/personal/bin:$PATH"

# Shopify-only discovery tools allowed for Pi subagent scouts.
export PI_SUBAGENT_EXTRA_READ_ONLY_TOOLS="lmtools_code_search,lmtools_code_history,lmtools_code_map,lmtools_code_index_status"

