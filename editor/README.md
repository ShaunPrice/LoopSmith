# Maintaining Studio

Studio remains a standalone `index.html`: opening the shipped file requires no
package installation, CDN or build server. Maintainers edit `template.html`
(markup/styles) and the ordered JavaScript files in `src/`, then run:

```sh
python3 editor/build.py
python3 editor/build.py --check
bash tests/run_all.sh
```

Run these commands from the repository root. Commit the source and generated
`editor/index.html` together. `src/manifest.json` records execution order. These
files share the existing browser scope; this change does not introduce an ES
module loader or change deployed URLs. Feature boundaries make maintenance
smaller without changing preset, session or device protocols.

The CI workflow checks source/build agreement, editor and bridge behaviour,
authentication/update recovery, and host builds of the actual looper. A separate
job compiles both Teensy USB configurations. Host simulation cannot establish
analogue audio quality, external MIDI clock jitter or Pi power-loss recovery.

For manual interface checks, `python3 tests/demo_server.py 8196` serves a local
simulator. It uses a fake serial pedal and MIDI sink and disables system actions;
it does not play audio or program connected hardware.
