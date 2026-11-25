#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# >>> uplink-bridge
# Uplink Room: the `uplink-bridge`, `uplink` and `uplink-mcp` commands, links to the launchers inside
# the app (packages/bridge/README.md, Install; ADR 0042). Only a link to some copy of Uplink Room is
# replaced, such as an earlier install's that moved; anything else at /usr/bin/<name>, such as a
# bridge installed with npm or a link to something unknown, stays as it is. Everything above this
# block is electron-builder's default after-install.tpl, unchanged (src/main/debScripts.test.ts checks it).
UPLINK_LINK_DIR='/usr/bin'
UPLINK_LAUNCHER_DIR='/opt/${sanitizedProductName}/resources/bin'
for UPLINK_NAME in uplink-bridge uplink uplink-mcp; do
  UPLINK_LINK="$UPLINK_LINK_DIR/$UPLINK_NAME"
  UPLINK_LAUNCHER="$UPLINK_LAUNCHER_DIR/$UPLINK_NAME"
  if [ ! -e "$UPLINK_LINK" ] && [ ! -L "$UPLINK_LINK" ]; then
    ln -s "$UPLINK_LAUNCHER" "$UPLINK_LINK"
  elif [ -L "$UPLINK_LINK" ]; then
    UPLINK_TARGET="$(readlink "$UPLINK_LINK")"
    case "$UPLINK_TARGET" in
      "$UPLINK_LAUNCHER") ;;
      */Uplink\ Room/resources/bin/"$UPLINK_NAME" | */.mount_Uplink*/resources/bin/"$UPLINK_NAME")
        ln -sf "$UPLINK_LAUNCHER" "$UPLINK_LINK" ;;
      *)
        echo "Left $UPLINK_LINK as it is: it links to $UPLINK_TARGET, which isn't Uplink Room's. Uplink Room's is $UPLINK_LAUNCHER." ;;
    esac
  else
    echo "Left $UPLINK_LINK as it is: it isn't Uplink Room's. Uplink Room's is $UPLINK_LAUNCHER."
  fi
done
# <<< uplink-bridge
