#!/usr/bin/env python3
"""Local-only UI fixture. Simulated serial/MIDI; never opens real hardware.
Run: python3 tests/demo_server.py [port]. Uses temporary music storage.
"""
import asyncio
import os
from pathlib import Path
import shutil
import sys
import tempfile
import tty

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'pi'))
from looper_bridge import Bridge, MidiLink, PiSystem, Server, WebAuth
from fake_pedal import FakePedal


class DemoMidi(MidiLink):
    def midi_dir(self):
        return self.storage_dir

    def send(self, msg):
        self.out_events += 1
        return True  # simulated sink: no MIDI device or audio generated


class DemoAuth(WebAuth):
    def enabled(self):
        return False

    def claimed(self):
        return True


class DemoServer(Server):
    async def route(self, r, w, method, path, headers, body, peer):
        if path.startswith(('/api/admin/', '/api/system/', '/api/update/', '/api/network/')):
            await self._json(w, {'ok': False, 'message': 'System actions disabled in simulator'})
            return
        return await super().route(r, w, method, path, headers, body, peer)

    async def _file(self, w, path, download=False):
        if Path(path).name == 'index.html':
            text = Path(path).read_text().replace('<span>Studio</span>', '<span>Studio · SIMULATOR</span>', 1)
            await self._respond(w, '200 OK', text, 'text/html; charset=utf-8')
            return
        return await super()._file(w, path, download)


async def main(port):
    master, slave = os.openpty()
    tty.setraw(master); tty.setraw(slave)
    os.set_blocking(master, False)
    pedal = FakePedal(str(ROOT / 'sdcard/presets'))
    loop = asyncio.get_running_loop()
    output = bytearray()
    def send(data):
        output.extend(data)
    def pump():
        try:
            data = os.read(master, 65536)
            if data: pedal.feed(data, send)
        except BlockingIOError:
            pass
    loop.add_reader(master, pump)
    async def ticker():
        while True:
            pedal.tick(send)
            if output:
                try:
                    count = os.write(master, output)
                    del output[:count]
                except BlockingIOError:
                    pass
            await asyncio.sleep(.01)
    with tempfile.TemporaryDirectory(prefix='looper-ui-') as temp:
        for path in (ROOT / 'midi').glob('*.mid'):
            shutil.copyfile(path, Path(temp) / path.name)
        bridge = Bridge(os.ttyname(slave))
        midi = DemoMidi(None, temp)
        midi.fd, midi.dev = 1, 'SIMULATED MIDI'
        system = PiSystem(temp)
        server = DemoServer(bridge, str(ROOT / 'editor'), str(ROOT / 'pi/www'), system, midi)
        server.auth = DemoAuth()
        tasks = [asyncio.create_task(bridge.serial_manager()), asyncio.create_task(ticker())]
        srv = await asyncio.start_server(server.handle, '127.0.0.1', port, limit=65536)
        print(f'SIMULATOR http://127.0.0.1:{port}', flush=True)
        try:
            async with srv: await srv.serve_forever()
        finally:
            for task in tasks: task.cancel()
            await midi.stop()
            loop.remove_reader(master)
            os.close(master); os.close(slave)


if __name__ == '__main__':
    try:
        asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 8195))
    except KeyboardInterrupt:
        pass
