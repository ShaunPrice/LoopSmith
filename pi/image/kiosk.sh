#!/bin/sh
# cage = single-app Wayland compositor; Chromium in kiosk mode on top of it.
CHROME=/usr/bin/chromium; [ -x "$CHROME" ] || CHROME=/usr/bin/chromium-browser
exec /usr/bin/cage -d -- "$CHROME" \
  --kiosk --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble \
  --ozone-platform=wayland --enable-features=UseOzonePlatform --disable-features=TranslateUI \
  --check-for-update-interval=31536000 --disable-component-update --password-store=basic \
  --autoplay-policy=no-user-gesture-required --overscroll-history-navigation=0 \
  --disk-cache-size=16777216 --user-data-dir=/home/looper/.kiosk \
  http://127.0.0.1/
