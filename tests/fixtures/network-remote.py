"""Temporary controlled network endpoints. Never installed as a service.

Run in an isolated temporary directory/venv containing aioquic. All payloads
are synthetic. The caller owns filtered packet capture and process cleanup.
"""
import asyncio
import base64
import hashlib
import json
import os
import socket
import signal
import ssl
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.h3.connection import H3Connection
from aioquic.h3.events import HeadersReceived
from aioquic.quic.configuration import QuicConfiguration

root = Path(sys.argv[1])
address = sys.argv[2]
lock = threading.Lock()


def receipt(kind, **fields):
    with lock, (root / 'receipts.jsonl').open('a') as file:
        file.write(json.dumps(dict(at=time.time() * 1000, kind=kind, **fields)) + '\n')


def dns_answer(query, peer):
    offset = 12
    labels = []
    while query[offset]:
        length = query[offset]
        offset += 1
        labels.append(query[offset:offset + length].decode('ascii'))
        offset += length
    offset += 1
    qtype, qclass = struct.unpack('!HH', query[offset:offset + 4])
    name = '.'.join(labels)
    receipt('authoritative-dns', name=name, qtype=qtype, peer=peer[0], peerPort=peer[1], resolverLiveness=name == 'www.gstatic.com')
    question = query[12:offset + 4]
    answer = b''
    if qtype == 1 and (name.endswith('.network-gate.invalid') or name == 'www.gstatic.com'):
        answer = b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 0, 4) + socket.inet_aton(address)
    return query[:2] + struct.pack('!HHHHH', 0x8580, 1, int(bool(answer)), 0, 0) + question + answer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.path.startswith('/dns-query'):
            answer = dns_answer(body, self.client_address)
            self.send_response(200)
            self.send_header('Content-Type', 'application/dns-message')
            self.send_header('Content-Length', str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)
        else:
            self.reply(body)

    def do_GET(self):
        if self.path.startswith('/dns-query?dns='):
            value = self.path.split('dns=', 1)[1].split('&')[0]
            answer = dns_answer(base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)), self.client_address)
            self.send_response(200)
            self.send_header('Content-Type', 'application/dns-message')
            self.send_header('Content-Length', str(len(answer)))
            self.end_headers()
            self.wfile.write(answer)
        else:
            self.reply()

    def do_OPTIONS(self):
        self.reply()

    def reply(self, body=b''):
        receipt('https' if isinstance(self.connection, ssl.SSLSocket) else 'http', path=self.path, method=self.command, host=self.headers.get('host'), bytes=len(body), peer=self.client_address[0], peerPort=self.client_address[1])
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            key = hashlib.sha1((self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', base64.b64encode(key).decode())
            self.end_headers()
            receipt('websocket', path=self.path, peer=self.client_address[0], peerPort=self.client_address[1])
            return
        if '/redirect/' in self.path:
            self.send_response(302)
            self.send_header('Location', self.path.replace('/redirect/', '/redirect-final/'))
            payload = b''
        else:
            self.send_response(200)
            if self.path.endswith('.js'):
                payload = b'export default 1;' if 'module' in self.path else b'fetch(location.href+"?inside-worker").catch(()=>{});'
                content = 'text/javascript'
            elif self.path.endswith('.css'):
                payload, content = b'body{color:#222}', 'text/css'
            elif self.path.endswith('.svg'):
                payload, content = b'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect id="p" width="1" height="1"/></svg>', 'image/svg+xml'
            elif self.path.endswith('.png'):
                payload, content = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1xkAAAAASUVORK5CYII='), 'image/png'
            else:
                payload, content = b'<!doctype html><title>Controlled endpoint</title>ok', 'text/html'
            self.send_header('Content-Type', content)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Client-IP', self.client_address[0])
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass


class HTTP(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def get_request(self):
        connection, peer = super().get_request()
        receipt('tcp-accept', port=self.server_address[1], peer=peer[0], peerPort=peer[1])
        connection.settimeout(10)
        if getattr(self, 'tls_context', None):
            # Handshake in the per-request worker, never serially in accept().
            connection = self.tls_context.wrap_socket(connection, server_side=True, do_handshake_on_connect=False)
        return connection, peer


class H3(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.http = H3Connection(self._quic, enable_webtransport=True)

    def quic_event_received(self, event):
        receipt('quic-event', event=type(event).__name__)
        for item in self.http.handle_event(event):
            if isinstance(item, HeadersReceived):
                peer = self._quic._network_paths[0].addr
                receipt('webtransport-connect', headers=[(a.decode(), b.decode()) for a, b in item.headers], peer=peer[0], peerPort=peer[1])
                self.http.send_headers(item.stream_id, [(b':status', b'200')])
                self.transmit()


async def main():
    key, cert = root / 'key.pem', root / 'cert.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '2', '-subj', '/CN=network-gate.invalid'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    plain = HTTP(('0.0.0.0', 0), Handler)
    secure = HTTP(('0.0.0.0', 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    secure.tls_context = context
    for server in [plain, secure]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(('0.0.0.0', 0))
        quic_port = sock.getsockname()[1]
    with socket.socket() as sock:
        sock.bind(('0.0.0.0', 0))
        turn_port = sock.getsockname()[1]
    turn = root / 'root/usr/bin/turnserver'
    env = dict(os.environ, LD_LIBRARY_PATH=str(root / 'root/usr/lib/x86_64-linux-gnu'))
    password = os.urandom(16).hex()
    turn_process = None
    quic = None
    try:
        turn_process = subprocess.Popen([str(turn), '-n', '--no-cli', '--no-tls', '--no-dtls', '--fingerprint', '--lt-cred-mech', '--realm=network-gate.invalid', '--user=probe:' + password, '--listening-port=' + str(turn_port), '--listening-ip=' + address, '--relay-ip=' + address, '--min-port=57000', '--max-port=57031', '--no-multicast-peers', '--denied-peer-ip=0.0.0.0-255.255.255.255', '--allowed-peer-ip=' + address, '--log-file=' + str(root / 'turn.log'), '--pidfile=' + str(root / 'turn.pid')], env=env, stdout=(root / 'turn-stdout.log').open('w'), stderr=subprocess.STDOUT)
        (root / 'processes.json').write_text(json.dumps(dict(pid=os.getpid(), turnPid=turn_process.pid)))
        configuration = QuicConfiguration(is_client=False, alpn_protocols=['h3'], max_datagram_frame_size=65536)
        configuration.load_cert_chain(cert, key)
        quic = await serve('0.0.0.0', quic_port, configuration=configuration, create_protocol=H3)
        der = ssl.PEM_cert_to_DER_cert(cert.read_text())
        config = dict(address=address, http=plain.server_address[1], https=secure.server_address[1], webtransport=quic_port, turn=turn_port, relay=[57000, 57031], turnUsername='probe', turnPassword=password, certificateHash=list(hashlib.sha256(der).digest()), pid=os.getpid(), turnPid=turn_process.pid)
        (root / 'config.json').write_text(json.dumps(config))
        receipt('started', config={k: v for k, v in config.items() if k != 'turnPassword'})
        stop = asyncio.Event()
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
        try:
            await asyncio.wait_for(stop.wait(), 600)
        except asyncio.TimeoutError:
            pass
    finally:
        if quic:
            quic.close()
        plain.shutdown()
        secure.shutdown()
        if turn_process:
            turn_process.terminate()
            turn_process.wait(timeout=5)


asyncio.run(main())
