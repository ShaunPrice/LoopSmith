#!/bin/sh
# udev helper: mount the first USB filesystem at /media/usb (the loop library), unmount on removal.
ACT=$1; DEV=$2; FS=${3:-}
MP=/media/usb
case "$ACT" in
  add)
    mkdir -p "$MP"
    OPTS="noatime"
    UID_=$(id -u looper 2>/dev/null || echo 1000); GID_=$(id -g looper 2>/dev/null || echo 1000)
    case "$FS" in
      vfat)        OPTS="$OPTS,uid=$UID_,gid=$GID_,umask=002,flush" ;;
      exfat|ntfs)  OPTS="$OPTS,uid=$UID_,gid=$GID_,umask=002" ;;
    esac
    /usr/bin/systemd-mount --no-block --collect --options="$OPTS" "$DEV" "$MP"
    ;;
  remove)
    /usr/bin/systemd-umount "$MP" 2>/dev/null || true
    ;;
esac
exit 0
