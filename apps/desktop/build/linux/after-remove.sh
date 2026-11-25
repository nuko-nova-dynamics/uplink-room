#!/bin/bash

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
# >>> uplink-bridge
# Uplink Room: removes the `uplink-bridge`, `uplink` and `uplink-mcp` links the after-install made,
# and nothing else. On an upgrade, the new version's after-install makes them again. Everything above
# this block is electron-builder's default after-remove.tpl, unchanged (src/main/debScripts.test.ts checks it).
UPLINK_LINK_DIR='/usr/bin'
UPLINK_LAUNCHER_DIR='/opt/${sanitizedProductName}/resources/bin'
for UPLINK_NAME in uplink-bridge uplink uplink-mcp; do
  UPLINK_LINK="$UPLINK_LINK_DIR/$UPLINK_NAME"
  if [ -L "$UPLINK_LINK" ] && [ "$(readlink "$UPLINK_LINK")" = "$UPLINK_LAUNCHER_DIR/$UPLINK_NAME" ]; then
    rm -f "$UPLINK_LINK"
  fi
done
# <<< uplink-bridge
