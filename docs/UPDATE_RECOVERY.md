# Updates and recovery

Setup → Software distinguishes an absent update source from a configured source
that cannot be reached. An offline update bundle remains supported.

New updates validate archive paths, file types and extraction sizes before writing.
The app and affected systemd, udev and application polkit files are backed up.
The installed version changes only after the new bridge answers its local health
check. A failed restart/health check restores the previous files, including removal
of service files introduced by the failed update. Setup displays transaction progress.

**Restore previous app** in Setup restores this backup without changing your MIDI,
loops, login or Wi-Fi configuration. From the local terminal the equivalent is:

```sh
sudo /opt/looper/pi/looper-update.sh rollback
```

This is an app/service rollback, not a full SD image backup or OS downgrade. It
does not undo operating-system updates, boot splash/initramfs changes or power-loss
damage. Keep separate backups of your SD card and music. Arbitrary post-install
scripts from update bundles are no longer executed. Provisioning dependencies
belongs to the image installer; app updates do not silently install packages.

The first installation of this updater is handled by the older installed updater;
its stronger rollback guarantees apply to subsequent updates. An older backup may
not itself contain the new Restore button. Do not remove power during installation.

## Missing login credentials

Missing credentials keep the Pi 5 in its claim/setup flow; they do not open
remote access to the app or control sockets. Use the Pi’s local screen to claim
the device, or reset the login from local Setup when already configured. The local health endpoint exposes only an `ok` flag and
is used to test bridge availability; it does not verify audio hardware.

## Validation

`python3 -m unittest discover -s tests -v` exercises rollback after a failed health
check, service/rule restoration, new-file removal, version commit ordering, invalid
Python rejection, unsafe archive rejection, and remote credential-loss handling.
Tests use temporary directories and fake service callbacks; they do not reboot or
modify a Pi. Real power-loss recovery is not claimed.
