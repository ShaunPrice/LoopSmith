#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 editor/build.py --check
node --test tests/editor_core.test.mjs editor/tests/diagnostics.test.mjs tests/test_transport.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 pi/test_fake_pedal.py
bash firmware/test/host/run.sh
halt_test=$(mktemp)
trap 'rm -f "$halt_test"' EXIT
c++ -std=c++17 -Itests/looper_stubs -Ifirmware/src tests/test_looper_halt.cpp firmware/src/AudioEffectLooper.cpp -o "$halt_test"
"$halt_test"
python3 - <<'PY'
from pathlib import Path
import re, subprocess, tempfile
for path in (Path('editor/index.html'), Path('pi/www/setup.html')):
    for script in re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', path.read_text(), re.S):
        with tempfile.NamedTemporaryFile(suffix='.js') as f:
            f.write(script.encode()); f.flush()
            subprocess.run(['node', '--check', f.name], check=True)
for path in Path('pi').rglob('*.sh'):
    subprocess.run(['bash', '-n', str(path)], check=True)
PY
