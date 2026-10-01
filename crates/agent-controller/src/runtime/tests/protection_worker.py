#!/usr/bin/env python3
"""Synthetic ACP worker. Gates expose real sandbox and listener lifecycle ordering."""
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
import time

assert sys.argv[1:] == ['acp'], sys.argv

def denied(operation):
    try:
        operation()
    except PermissionError:
        return
    raise AssertionError('protected operation succeeded')

def probe(p):
    # Broad profile writes must actually be allowed; a restrictive workspace
    # grant would mask the cross-run defect and make this test a false positive.
    with tempfile.TemporaryFile(dir=p['config']) as ordinary:
        ordinary.write(b'ordinary profile writes are allowed')
    oauth = Path(p['config']) / 'buzz-agent/oauth/databricks'
    with (oauth / 'fixture.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.NamedTemporaryFile(dir=oauth, delete=False) as tmp:
            tmp.write(b'synthetic cache')
        os.replace(tmp.name, oauth / (Path.cwd().name + '.json'))
    for directory in [p['scratch'], os.environ['TMPDIR']]:
        with tempfile.TemporaryFile(dir=directory) as tmp:
            tmp.write(b'temp works')
    for target in map(Path, p['files']):
        if target.exists():
            denied(lambda: target.chmod(0o700))
            denied(target.unlink)
        denied(lambda: target.open('wb'))
        source = Path(p['scratch']) / 'replacement'
        source.write_text('must not replace control')
        denied(lambda: os.replace(source, target))
        source.unlink()
    for directory in map(Path, p['directories']):
        denied(lambda: (directory / 'injected').write_text('bad'))
        denied(lambda: directory.rename(str(directory) + '-moved'))
    denied(lambda: Path(p['config']).rename(p['config'] + '-moved'))

def wait(path):
    deadline = time.monotonic() + 30
    while not path.exists():
        assert time.monotonic() < deadline, 'gate not released'
        time.sleep(.01)

sequence = 0
for line in sys.stdin:
    msg = json.loads(line)
    if 'id' not in msg:
        continue
    result = {}
    if msg.get('method') == 'initialize':
        with open('initialized', 'a') as log:
            log.write(str(os.getpid()) + '\n')
        result = {'protocolVersion': 1, 'agentCapabilities': {}}
    elif msg.get('method') == 'session/new':
        result = {'sessionId': 'probe'}
    elif msg.get('method') == 'session/prompt':
        sequence += 1
        token = f'gate-{os.getpid()}-{sequence}'
        Path('ready.tmp').write_text(json.dumps({'pid':os.getpid(), 'token':token}))
        os.replace('ready.tmp', 'ready.json')
        wait(Path(token + '.probe'))
        probe(json.loads(Path('probe.json').read_text()))
        Path(token + '.checked').touch()
        wait(Path(token + '.reply'))
        with open('completed', 'a') as log:
            log.write(str(os.getpid()) + '\n')
        print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{
            'sessionId':'probe','update':{'sessionUpdate':'agent_message_chunk',
            'content':{'type':'text','text':'fixture complete'}}}}), flush=True)
        result = {'stopReason': 'end_turn'}
    print(json.dumps({'jsonrpc':'2.0','id':msg['id'],'result':result}), flush=True)
