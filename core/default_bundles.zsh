# Additional plugins can be found at https://github.com/ohmyzsh/ohmyzsh/wiki/Plugins
# Install plugins with `antigen bundle <plugin-name>`
source ~/antigen/antigen.zsh

# Install oh-my-zsh with paths set properly for Antigen bundles
antigen use oh-my-zsh

# Install autocompletion for ripgrep
# https://github.com/ohmyzsh/ohmyzsh/tree/master/plugins/ripgrep
antigen bundle ripgrep
