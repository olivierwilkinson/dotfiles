# based on jenny-codes branch of dotfiles

LOG_PATH="/tmp/setup-$(date +%s).log"
echo "Find logs at $LOG_PATH"

main() {
  setup_color

  printf "${BOLD}\
╭──────────────────────────────────────╮
│  Running personal/install.sh         │
╰──────────────────────────────────────╯
$RESET"

  link_config ~/dotfiles/personal/nvim ~/.config/nvim
  link_config ~/dotfiles/personal/wezterm.lua ~/.wezterm.lua
  link_config ~/dotfiles/personal/tmux.conf ~/.tmux.conf
  link_config ~/dotfiles/personal/bat ~/.config/bat
  link_config ~/dotfiles/personal/tmuxinator ~/.config/tmuxinator

  # NOTE:- don't link nvm default-packages here, it will be linked in personal/custom.zsh
  # this is because nvm is installed after antigen is applied

  install_with_brew pure fzf bat ripgrep grep watchman tmux withgraphite/tap/graphite aria2 tmuxinator
  install_with_brew --cask temurin
  install_tpm
  setup_mac_system_configs
}

install_with_brew() {
  brew update &>"$LOG_PATH"

  echo "${BLUE}Installing $@ with homebrew...$RESET"

  # only install packages if needed
  if brew install --quiet $@ >"$LOG_PATH"; then
    echo "✅$GREEN Done installing $@ $RESET"
  else
    echo "⚠️ $BOLD$RED $@ installation is not successful $RESET"
  fi
}

link_config() {
  echo "${BLUE}Linking $1 to ${HOME}$2...$RESET"
  if [[ -f $2 ]]; then
    echo "✅$GREEN File $1 is already linked$RESET"
  else
    ln -sfn "$1" "$2" && echo "✅$GREEN Done linking file $1$RESET"
  fi
}

setup_mac_system_configs() {
  # Avoid creating .DS_Store files on network volumes
  defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool true

  # Set a blazingly fast keyboard repeat rate
  defaults write NSGlobalDomain KeyRepeat -int 0 # or 1
  defaults write NSGlobalDomain InitialKeyRepeat -int 15

  # prevent accent menu from appearing
  defaults write -g ApplePressAndHoldEnabled -bool false

  echo "✅$GREEN Done setting up mac system configs $RESET"
}

install_nvim_plugins() {
  echo "${BLUE}Installing nvim plugins...$RESET"
  nvim --headless "+Lazy! sync" +qa
  echo "✅$GREEN Done installing nvim plugins$RESET"
}

install_tpm() {
  echo "${BLUE}Installing tpm...$RESET"
  if [[ ! -d "$HOME/.tmux/plugins/tpm" ]]; then
    git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
  fi
  echo "✅$GREEN Done installing tpm$RESET"
}

setup_color() {
  RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m')
  BLUE=$(printf '\033[34m')
  BOLD=$(printf '\033[1m')
  RESET=$(printf '\033[m')
}

main
