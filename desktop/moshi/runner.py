"""Pinned moshi_mlx 0.3.0 concurrent runner, with authenticated PCM transport.

Inference and threaded Mimi processing remain upstream. Its two small Opus
stream adapters are replaced with PCM so Deck needs no downloaded browser codec.
This module is imported in both multiprocessing children, before local_web runs.
"""
import hmac
import os
import sys
import signal
import threading
import time
import numpy as np


class PCMReader:
    def __init__(self, sample_rate):
        if sample_rate != 24000:
            raise ValueError('Expected 24 kHz audio')

    def append_bytes(self, data):
        if len(data) % 4 or len(data) > 1920 * 4 * 4:
            raise ValueError('Invalid PCM frame size')
        pcm = np.frombuffer(data, dtype='<f4').copy()
        if not np.isfinite(pcm).all():
            raise ValueError('Non-finite PCM sample')
        return np.clip(pcm, -1, 1)


class PCMWriter:
    def __init__(self, sample_rate):
        if sample_rate != 24000:
            raise ValueError('Expected 24 kHz audio')

    def append_pcm(self, pcm):
        return np.asarray(pcm, dtype='<f4').tobytes()


def authorized(headers, token, host):
    return bool(token) and hmac.compare_digest(headers.get('X-Apex-Voice-Token', ''), token) and headers.get('Origin', f'http://{host}') == f'http://{host}'


def install_transport():
    import sphn
    from aiohttp import web
    sphn.OpusStreamReader = PCMReader
    sphn.OpusStreamWriter = PCMWriter

    @web.middleware
    async def guard(request, handler):
        if not authorized(request.headers, os.environ.get('APEX_VOICE_TOKEN', ''), request.host):
            raise web.HTTPForbidden()
        response = await handler(request)
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'"
        response.headers['Cache-Control'] = 'no-store'
        return response

    application = web.Application

    def guarded_application(*args, **kwargs):
        kwargs['middlewares'] = [guard, *kwargs.get('middlewares', [])]
        return application(*args, **kwargs)

    web.Application = guarded_application


def download():
    from huggingface_hub import hf_hub_download
    # The original q4 release has no config.json; upstream uses config_v0_1.
    for filename in ['model.q4.safetensors', 'tokenizer_spm_32k_3.model', 'tokenizer-e351c8d8-checkpoint125.safetensors']:
        print(f'Downloading {filename}', flush=True)
        hf_hub_download('kyutai/moshiko-mlx-q4', filename)


def signal_parent():
    os.kill(os.getppid(), signal.SIGTERM)


def run_worker(target, args, on_exit=signal_parent):
    # Upstream joins the surviving worker forever if its partner dies. Let
    # Electron observe parent exit and terminate the remaining process group.
    try:
        return target(*args)
    finally:
        on_exit()


def model_worker(*args):
    from moshi_mlx.local_web import model_server
    return run_worker(model_server, args)


def web_worker(*args):
    from moshi_mlx.local_web import web_server
    return run_worker(web_server, args)


def worker_exited(workers):
    return any(worker.pid is not None and worker.exitcode is not None for worker in workers)


def watch_workers(workers):
    # Native MLX/codec crashes do not execute a Python finally block.
    while True:
        if worker_exited(workers):
            print('A Moshi worker stopped; ending this call.', flush=True)
            os.kill(os.getpid(), signal.SIGTERM)
            return
        time.sleep(.1)


# Spawned child processes import __mp_main__, so they receive the adapters too.
if '--download-only' not in sys.argv:
    install_transport()

if __name__ == '__main__':
    if '--download-only' in sys.argv:
        download()
    else:
        from moshi_mlx import local_web
        # Spawn imports this module without executing this main block, so
        # these wrappers call the original targets in each child.
        local_web.model_server = model_worker
        local_web.web_server = web_worker
        process_type = local_web.multiprocessing.Process
        workers = []

        def tracked_process(*args, **kwargs):
            process = process_type(*args, **kwargs)
            workers.append(process)
            return process

        local_web.multiprocessing.Process = tracked_process
        threading.Thread(target=watch_workers, args=(workers,), daemon=True).start()
        local_web.main()
