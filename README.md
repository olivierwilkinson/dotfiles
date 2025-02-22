Opinionated dotfiles starter template

Uses [oh-my-zsh](https://ohmyz.sh/) with [Antigen](https://github.com/zsh-users/antigen) to manage dependencies and themes.
Default theme is [Staples](https://github.com/dersam/staples).

### Installation
1. Clone the repo to `~/dotfiles`:
```
git clone git@github.com:olivierwilkinson/dotfiles.git ~/dotfiles
```
2. Run `install.sh`. This will symlink configs and .zshrc, overwriting anything you already have.
3. Open a new terminal, or `exec zsh`. Antigen bundles will be installed and you should be ready to go.

#### Available customizations
Files are listed in the order they are loaded. Conflicts between files, such as
environment variable definitions, will be resolved by "last definition wins".

Load order can be seen in `.zshrc`.

- `environment.zsh`: Define any environment variables you always want.
- `macos.zsh`: Customizations that should only be run on MacOS.
- `antigen_bundles.zsh`: Define additional zsh plugins to include. Your theme selection should be set here as well (default is Staples).
- `custom.zsh`: Customizations that should apply everywhere. This is the LAST file
loaded, so any conflicting changes made here will override any previous files.

#### Custom install
`personal/install.sh` is a special case. It is run as part of the `install.sh` script, and should be where you put
any customizations around initial setup and installation. For example, if you want to symlink a config from `personal`
into your home directory, that's where you'd run that command.
