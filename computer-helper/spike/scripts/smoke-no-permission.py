#!/usr/bin/env python3
"""Generic protocol and denied-access checks. Never sends valid input arguments."""
import json
from pathlib import Path
import select
import subprocess

helper = Path.home() / 'Library/Application Support/Apex Computer Spike/Apex Computer Spike.app/Contents/Helpers/SpikeMCP'
proc = subprocess.Popen([str(helper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
try:
    def call(identifier, method, params=None):
        payload = {'jsonrpc': '2.0', 'id': identifier, 'method': method}
        if params is not None:
            payload['params'] = params
        proc.stdin.write(json.dumps(payload) + '\n')
        proc.stdin.flush()
        assert select.select([proc.stdout], [], [], 8)[0], 'bounded response timeout'
        response = json.loads(proc.stdout.readline())
        assert response['id'] == identifier
        return response
    status = call(1, 'spike/status')['result']
    assert status['accessibilityTrusted'] is False, 'Run denied-access smoke only before the Human grants Accessibility'
    assert call(2, 'initialize')['result']['protocolVersion'] == '2025-06-18'
    tools = call(3, 'tools/list')['result']['tools']
    assert {t['name'] for t in tools} == {'request_app','read_screen','click','type_text','press_key'}
    assert [t['name'] for t in tools if t['annotations']['readOnlyHint']] == ['read_screen']
    assert call(4, 'unknown_method')['error']['code'] == -32601
    assert call(5, 'tools/call', {'name':'read_screen','arguments':{}})['result']['isError'] is True
    invalid = [('request_app',{'app':'local.ds4.app'}),('click',{'snapshot':'invalid','element':-1}),('type_text',{'snapshot':'invalid','text':''}),('press_key',{'snapshot':'invalid','key':'Cmd-Q'})]
    for i,(name,args) in enumerate(invalid,6):
        assert call(i,'tools/call',{'name':name,'arguments':args})['result']['isError'] is True
    print('PASS: protocol, five truthful tool schemas, denied read, four invalid control refusals; no input sent')
finally:
    proc.stdin.close()
    proc.wait(timeout=8)
    stderr = proc.stderr.read()
    assert not stderr, 'Unexpected stderr (contents deliberately not printed)'
