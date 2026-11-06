#!/usr/bin/env python3
"""Check module delivery and exact soundtrack paths in the local project tree."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import json

MUSIC_PATHS = (
    '/assets/music/MORTALS.mp3',
    '/assets/music/FEARLESS-PT-II.mp3',
    '/assets/music/KREZUS-SKINS.mp3',
)
ROOT = Path(__file__).resolve().parents[1]
JS_DIRS = (ROOT / 'js', ROOT / 'assets' / 'vendor')


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_args):
        pass


def main():
    config = json.loads((ROOT / 'vercel.json').read_text(encoding='utf-8'))
    assert not config.get('rewrites'), 'vercel.json must not rewrite module URLs to index.html'
    assert not config.get('routes'), 'vercel.json must not add SPA fallbacks for module paths'
    assert not (ROOT / '_redirects').exists(), 'Netlify _redirects must not create an HTML fallback'

    music_source = (ROOT / 'js' / 'music.js').read_text(encoding='utf-8')
    for path in MUSIC_PATHS:
        assert path in music_source, f'music registry is missing exact path {path}'

    files = sorted({p for base in JS_DIRS for p in base.rglob('*.js') if p.is_file()})
    assert files, 'no JavaScript modules found'
    server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f'http://127.0.0.1:{server.server_port}'
    present, missing = [], []
    try:
        for path in files:
            rel = path.relative_to(ROOT).as_posix()
            with urlopen(base_url + '/' + rel) as response:
                content_type = (response.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
                assert response.status == 200, f'{rel}: HTTP {response.status}'
                assert content_type in {'text/javascript', 'application/javascript'}, f'{rel}: bad Content-Type {content_type!r}'
                body_head = response.read().lstrip()[:128].lower()
                assert not body_head.startswith((b'<!doctype html', b'<html')), f'{rel}: received HTML instead of module source'
        try:
            with urlopen(base_url + '/assets/vendor/not-a-real-module.js') as response:
                assert response.status != 200, 'missing module unexpectedly returned HTTP 200'
        except HTTPError as err:
            assert err.code == 404, f'missing module returned unexpected HTTP {err.code}'

        for path in MUSIC_PATHS:
            local_path = ROOT / path.lstrip('/')
            try:
                with urlopen(Request(base_url + path, method='HEAD')) as response:
                    content_type = (response.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
                    assert local_path.is_file(), f'{path}: served but not physically present in source'
                    assert response.status == 200, f'{path}: HTTP {response.status}'
                    assert content_type == 'audio/mpeg', f'{path}: expected audio/mpeg, received {content_type!r}'
                    present.append(path)
            except HTTPError as err:
                assert err.code == 404, f'{path}: unexpected HTTP {err.code}'
                assert not local_path.is_file(), f'{path}: file exists but local server returned 404'
                missing.append(path)
        print(f'PASS local delivery: {len(files)} JavaScript modules have JavaScript MIME; missing-module fallback is disabled; registry contains all three exact soundtrack paths.')
        if present:
            print('LOCAL AUDIO PRESENT AND SERVED AS audio/mpeg: ' + ', '.join(present))
        if missing:
            print('BLOCKED — these original audio files are absent from the source/deployment output and return HTTP 404:')
            for path in missing:
                print(f'  MISSING: {path}')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == '__main__':
    main()
