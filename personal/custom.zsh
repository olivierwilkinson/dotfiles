# Define any custom environment scripts here.
# This file is loaded after everything else, but before Antigen is applied and ~/extra.zsh sourced.
# Put anything here that you want to exist on all your environment, and to have the highest priority
# over any other customization.

# Path to your Oh My Zsh installation.

# use empty string to avoid breaking pure
ZSH_THEME=""

# setup pure theme
autoload -U promptinit; promptinit
prompt pure

# link nvm default packages in zsh since nvm is installed after antigen is applied
if ! [[ -f $NVM_DIR/default-packages ]]; then
    ln -sfn $HOME/dotfiles/personal/nvm/default-packages $NVM_DIR/default-packages
fi
