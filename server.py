#!/usr/bin/env python3
"""Run: python3 server.py. No pip / npm install required."""
import argparse
import json
import mimetypes
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfoNotFoundError
from analytics import Index

BASE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser(description='Local Codex usage analytics')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--sessions', default=str(Path.home()/'.codex/sessions'))
    ap.add_argument('--cache', default=str(BASE/'.cache/usage.sqlite3'))
    args = ap.parse_args()
    index = Index(args.sessions, args.cache)
    lock = threading.Lock()
    last_scan = 0

    class Handler(BaseHTTPRequestHandler):
        def send(self, status, body, kind='application/json; charset=utf-8'):
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            nonlocal last_scan
            host = self.headers.get('Host', '')
            if host not in (f'127.0.0.1:{args.port}', f'localhost:{args.port}'):
                return self.send(403, b'{"error":"Local host only"}')
            url = urlparse(self.path)
            if url.path in ('/api/usage', '/api/logs'):
                params = parse_qs(url.query)
                try:
                    with lock:
                        if time.monotonic()-last_scan > 5 or params.get('refresh') == ['1']:
                            index.scan()
                            last_scan = time.monotonic()
                        pricing = json.loads((BASE/'pricing.json').read_text())
                        period, tz = params.get('range', ['mtd'])[0], params.get('tz', ['Asia/Singapore'])[0]
                        if url.path == '/api/logs':
                            report = index.logs(period, tz, pricing, int(params.get('page', ['1'])[0]),
                                                int(params.get('limit', ['50'])[0]), params.get('model', [''])[0],
                                                date_filter=params.get('date', [''])[0])
                        else:
                            report = index.report(period, tz, pricing)
                    return self.send(200, json.dumps(report).encode())
                except (ValueError, ZoneInfoNotFoundError) as exc:
                    return self.send(400, json.dumps({'error': str(exc)}).encode())
                except OSError as exc:
                    return self.send(500, json.dumps({'error': str(exc)}).encode())
            routes = {'/':'index.html', '/summary':'index.html', '/activity':'index.html', '/logs':'index.html',
                      '/app.js':'app.js', '/style.css':'style.css', '/favicon.svg':'favicon.svg'}
            if url.path not in routes:
                return self.send(404, b'Not found', 'text/plain')
            p = BASE/'dist'/routes[url.path]
            self.send(200, p.read_bytes(), (mimetypes.guess_type(p)[0] or 'text/plain')+'; charset=utf-8')

        def log_message(self, fmt, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'Codex Usage ready: http://127.0.0.1:{args.port}', flush=True)
    print('Logs stay local. Press Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == '__main__':
    main()
