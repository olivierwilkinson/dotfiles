# Stuff that is specific to my personal Mac, that I don't want to setup again on install

source /Users/olivier/.docker/init-zsh.sh || true # Added by Docker Desktop

# The next line updates PATH for the Google Cloud SDK.
if [ -f '/Users/olivier/Developer/google-cloud-sdk/path.zsh.inc' ]; then . '/Users/olivier/Developer/google-cloud-sdk/path.zsh.inc'; fi

# The next line enables shell command completion for gcloud.
if [ -f '/Users/olivier/Developer/google-cloud-sdk/completion.zsh.inc' ]; then . '/Users/olivier/Developer/google-cloud-sdk/completion.zsh.inc'; fi

# LaTeX setup
export LATEXMK=/Library/TeX/texbin/latexmk
export LATEXINDENT=/Library/TeX/texbin/latexindent
export PATH=$PATH:$LATEXMK
export PATH=$PATH:$LATEXINDENT
export PATH=$PATH:/usr/local/texlive/2023/bin/universal-darwin

# Perl setup
eval "$(perl -I$HOME/perl5/lib/perl5 -Mlocal::lib)"

# grit
export GRIT_INSTALL="$HOME/.grit"
export PATH="$GRIT_INSTALL/bin:$PATH"

# Android SDK
export ANDROID_HOME=~/Library/Android/sdk

# use cursor over code
alias code="cursor"
