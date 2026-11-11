#!/usr/bin/env python3
"""Verify local module MIME delivery and the single bundled soundtrack."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import json

MUSIC_PATH = '/assets/music/FEARLESS-PT-II.mp3'
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
    assert music_source.count('.mp3') == 1, 'music registry must contain exactly one configured MP3'
    assert MUSIC_PATH in music_source, 'the bundled track path must be registered'
    audio_files = sorted(p.name for p in (ROOT / 'assets' / 'music').glob('*.mp3'))
    assert audio_files == ['FEARLESS-PT-II.mp3'], f'unexpected audio assets: {audio_files}'
    sw_source = (ROOT / 'sw.js').read_text(encoding='utf-8')
    assert sw_source.count(MUSIC_PATH.removeprefix('/')) == 1, 'service worker should precache the one track exactly once'

    files = sorted({p for base in JS_DIRS for p in base.rglob('*.js') if p.is_file()})
    assert files, 'no JavaScript modules found'
    server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f'http://127.0.0.1:{server.server_port}'
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
                raise AssertionError(f'missing module unexpectedly returned HTTP {response.status}')
        except HTTPError as error:
            assert error.code == 404, f'missing module returned HTTP {error.code}'
        # HEAD only the configured local soundtrack; no removed or remote path is probed.
        local_path = ROOT / MUSIC_PATH.lstrip('/')
        with urlopen(Request(base_url + MUSIC_PATH, method='HEAD')) as response:
            content_type = (response.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
            assert local_path.is_file(), f'{MUSIC_PATH}: not physically present'
            assert response.status == 200 and content_type == 'audio/mpeg', f'{MUSIC_PATH}: {response.status} {content_type}'
        print(f'PASS local delivery: {len(files)} JavaScript modules have JavaScript MIME; missing-module fallback is disabled.')
        print('PASS soundtrack audit: exactly one local MP3 is registered, present, served as audio/mpeg, and in the worker precache.')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == '__main__':
    main()
