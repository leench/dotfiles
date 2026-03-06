# gnome-keyring
if [[ -z "$GNOME_KEYRING_CONTROL" ]]; then
    eval $(gnome-keyring-daemon --start --components=secrets)
    export GNOME_KEYRING_CONTROL
fi

# ssh key
if [[ "$HOST" == "archleen" && -z "$SSH_AUTH_SOCK" ]] && command -v keychain >/dev/null 2>&1; then
    /usr/bin/keychain --nogui ~/.ssh/id_ed25519
    source $HOME/.keychain/$HOST-sh
fi
