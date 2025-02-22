#!/usr/bin/env zsh

# Create common color functions.
autoload -U colors
colors

# Create an unversioned script for scripts that are specific to this local environment
# and that you don't want to follow you across environments.
touch ~/extra.zsh

DOTFILES_DIRECTORY_NAME=dotfiles
ZSH_HOST_OS=$(uname | awk '{print tolower($0)}')

case $ZSH_HOST_OS in
  darwin*)

  BREW_EXECUTABLE=/opt/homebrew/bin/brew

  # only setup .dotfile_brew_setup if it does not exist yet
  [[ -f $HOME/.dotfile_brew_setup ]] || $BREW_EXECUTABLE shellenv > $HOME/.dotfile_brew_setup

  $BREW_EXECUTABLE install --quiet coreutils
;;
esac

# Install the antigen plugin/theme manager if it's not already installed.
if [[ ! -d $HOME/antigen ]]; then
	echo -e "Antigen not found, installing..."
	cd $HOME
	git clone https://github.com/shopify/antigen.git
	cd -
fi

# Symlink core configs

# Link in the custom gitconfig.
ln -vsfn ~/dotfiles/core/configs/.gitconfig ~/.gitconfig

# Symlink this repo's .zshrc to ~/.zshrc. Using a symlink ensures that when the repo is
# updated, the terminal will pick up the new version on reload without having to run
# install again. This will overwrite any existing .zshrc.
ln -vsfn ~/dotfiles/.zshrc ~/.zshrc

source ~/dotfiles/personal/install.sh
