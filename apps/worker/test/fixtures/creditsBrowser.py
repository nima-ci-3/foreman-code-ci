"""A CDP fixture whose document is still parsing when its page is discoverable."""
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import types
from unittest.mock import patch

collector, profile, node = sys.argv[1:]
Path(profile).mkdir()
(Path(profile) / 'DevToolsActivePort').write_text('1234\n')
partial = '<html><body>' + 'Copyright license terms\n' * 80
complete = partial + 'FINAL LICENSE: complete upstream notice.</body></html>'

class Channel:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def send(self, message):
        request = json.loads(message)
        value = None
        if request['method'] == 'Runtime.evaluate':
            script = """
const document = {readyState: 'loading', documentElement: {outerHTML: process.argv[2]}};
const listeners = [];
const window = {addEventListener: (_event, callback) => listeners.push(callback)};
setTimeout(() => {
 document.readyState = 'complete'; document.documentElement.outerHTML = process.argv[3];
 for (const callback of listeners) callback();
}, 20);
Promise.resolve(eval(process.argv[1])).then(value => process.stdout.write(JSON.stringify(value)));
"""
            value = json.loads(subprocess.run([node, '-e', script, request['params']['expression'], partial, complete],
                                             capture_output=True, text=True, check=True).stdout)
        self.answer = json.dumps({'id': request['id'], 'result': {'result': {'value': value}}})

    def recv(self, **_kwargs):
        return self.answer

client = types.ModuleType('websockets.sync.client')
client.connect = lambda *_args, **_kwargs: Channel()
modules = {'websockets': types.ModuleType('websockets'), 'websockets.sync': types.ModuleType('websockets.sync'),
           'websockets.sync.client': client}

class Browser:
    returncode = 0

    def poll(self):
        return None

    def wait(self, **_kwargs):
        self.returncode = 0

    def terminate(self):
        pass


def urlopen(url, **_kwargs):
    value = [{'type': 'page', 'url': 'chrome://credits/', 'webSocketDebuggerUrl': 'ws://127.0.0.1/page'}] \
        if url.endswith('/list') else {'webSocketDebuggerUrl': 'ws://127.0.0.1/browser'}
    return io.BytesIO(json.dumps(value).encode())

popen = subprocess.Popen
sys.argv = [collector, 'fixture-chromium', '--user-data-dir=' + profile, 'chrome://credits/']
with patch.dict(sys.modules, modules), patch('subprocess.Popen', side_effect=lambda command, **kwargs: Browser() if command[0] == 'fixture-chromium' else popen(command, **kwargs)), \
        patch('urllib.request.urlopen', side_effect=urlopen):
    runpy.run_path(collector, run_name='__main__')
