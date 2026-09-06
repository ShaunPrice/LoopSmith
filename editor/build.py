#!/usr/bin/env python3
"""Bundle maintained Studio sources into the standalone editor/index.html.
Usage: python3 editor/build.py [--check]
"""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
MARKER = '\n/* @studio-sources */\n'

def render():
    template = (ROOT / 'template.html').read_text()
    if template.count(MARKER) != 1:
        raise ValueError('template must contain exactly one source marker')
    names = json.loads((ROOT / 'src/manifest.json').read_text())
    if not names or len(set(names)) != len(names):
        raise ValueError('source manifest must be nonempty with unique entries')
    pieces = []
    for name in names:
        if Path(name).name != name or not name.endswith('.js'):
            raise ValueError('source manifest entries must name local JavaScript files')
        pieces.append((ROOT / 'src' / name).read_text())
    return template.replace(MARKER, ''.join(pieces))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail if the committed standalone build is stale')
    args = parser.parse_args()
    content = render()
    target = ROOT / 'index.html'
    if args.check:
        if not target.exists() or target.read_text() != content:
            print('editor/index.html is stale; run python3 editor/build.py', file=sys.stderr)
            return 1
        print('Standalone editor matches its maintained sources')
    else:
        target.write_text(content)
        print('Built editor/index.html')
    return 0

if __name__ == '__main__':
    sys.exit(main())
