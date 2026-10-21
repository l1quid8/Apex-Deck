#!/usr/bin/env python3
"""Resolve and verify a Linux CPU runtime, on Linux x86-64 only."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request

PYTHON_URL = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261020/cpython-3.11.17%2B20261020-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'
REV = '3d3d5dee26484f91867d81cb899cfcf72b96be6c'
IMPORT_CHECK = 'import ctranslate2, faster_whisper, kokoro_onnx, onnxruntime, websockets; from transformers import WhisperFeatureExtractor; import importlib.util; assert importlib.util.find_spec("silero_vad"); print("ok")'


def download(url, cache, expected=None):
    dest = cache / hashlib.sha256(url.encode()).hexdigest()
    if not dest.exists():
        partial = dest.with_suffix('.partial')
        print('Downloading', url.rsplit('/', 1)[-1], flush=True)
        with urllib.request.urlopen(url, timeout=120) as source, partial.open('wb') as out:
            shutil.copyfileobj(source, out, 1024 * 1024)
        partial.replace(dest)
    with dest.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if expected and digest != expected:
        dest.unlink()
        raise ValueError('Download hash mismatch: ' + url)
    return dest, dict(url=url, sha256=digest, size=dest.stat().st_size)


def extract(archive, destination):
    with tarfile.open(archive) as tar:
        tar.extractall(destination, filter='data')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sidecar', type=pathlib.Path, required=True)
    parser.add_argument('--work', type=pathlib.Path, required=True)
    parser.add_argument('--install-to', type=pathlib.Path)
    args = parser.parse_args()
    side, work = args.sidecar.resolve(), args.work.resolve()
    cache = work / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    archive, python = download(PYTHON_URL, cache)
    if not (work / 'python/bin/python3').exists():
        extract(archive, work)
    interpreter = work / 'python/bin/python3'
    subprocess.run([str(interpreter), '-I', '-m', 'pip', 'install', '--dry-run', '--ignore-installed', '--only-binary=:all:', '--report', str(work / 'report.json'), '-r', str(side / 'requirements-linux.in')], check=True)
    report = json.loads((work / 'report.json').read_text())
    wheels, wheel_files = [], []
    entries = report['install']
    with urllib.request.urlopen('https://pypi.org/pypi/silero-vad/6.2.3/json') as response:
        silero = next(x for x in json.load(response)['urls'] if x['filename'].endswith('py3-none-any.whl'))
    entries.append({'metadata': {'name': 'silero-vad', 'version': '6.2.3'}, 'download_info': {'url': silero['url'], 'archive_info': {'hashes': {'sha256': silero['digests']['sha256']}}}})
    for entry in entries:
        meta, info = entry['metadata'], entry['download_info']
        name = meta['name'].lower().replace('_', '-')
        if name in ('torch', 'torchaudio', 'triton') or name.startswith(('nvidia-', 'mlx')):
            raise ValueError('Forbidden CPU runtime dependency: ' + name)
        source, item = download(info['url'], cache, info['archive_info']['hashes']['sha256'])
        filename = info['url'].rsplit('/', 1)[-1]
        wheel_file = work / 'wheels' / filename
        wheel_file.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, wheel_file)
        wheel_files.append(wheel_file)
        wheels.append(dict(name=name, version=meta['version'], filename=filename, license=str(meta.get('license_expression') or meta.get('license') or 'See wheel dist-info')[:80], **item))
    models, model_files = [], []
    for file in ('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'):
        source, item = download(f'https://huggingface.co/Systran/faster-whisper-base.en/resolve/{REV}/{file}', cache)
        models.append(dict(path='models/whisper-base-en/' + file, **item)); model_files.append(source)
    for file in ('kokoro-v1.0.onnx', 'voices-v1.0.bin'):
        source, item = download('https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/' + file, cache)
        models.append(dict(path='models/kokoro/' + file, **item)); model_files.append(source)
    smart = next(x for x in json.loads((side / 'runtime-manifest.json').read_text())['models'] if x['path'] == 'models/smart-turn/smart-turn-v3.2-cpu.onnx')
    source, item = download(smart['url'], cache, smart['sha256'])
    if item['size'] != smart['size']:
        raise ValueError('Smart Turn size mismatch')
    models.append(smart); model_files.append(source)
    total = sum(x['size'] for x in [python, *wheels, *models])
    manifest = dict(version='1', platform='linux', arch='x86_64', python=python, wheels=sorted(wheels, key=lambda x: x['name']), models=models, downloadBytes=total, requiredDiskBytes=total * 3)
    (side / 'runtime-manifest-linux-x86_64.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (side / 'requirements-linux.lock').write_text(''.join(f"{w['name']}=={w['version']}\n" for w in manifest['wheels']))
    if args.install_to:
        target = args.install_to.resolve(); target.mkdir(parents=True, exist_ok=True)
        extract(archive, target)
        subprocess.run([str(target / 'python/bin/python3'), '-I', '-m', 'pip', 'install', '--no-index', '--no-deps', '--disable-pip-version-check', *map(str, wheel_files)], check=True, env={**os.environ, 'PYTHONNOUSERSITE': '1'})
        for model, source in zip(models, model_files):
            dest = target / model['path']; dest.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, dest)
        subprocess.run([str(target / 'python/bin/python3'), '-I', '-c', IMPORT_CHECK], check=True)
    print('downloadBytes', total, flush=True)


if __name__ == '__main__':
    main()
