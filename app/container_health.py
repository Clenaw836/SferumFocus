"""Loopback liveness probe; bypass environment HTTP proxies, disclose no secrets."""
import json
import os
import urllib.request


def main() -> int:
    port = int(os.getenv('PORT', '8000'))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f'http://127.0.0.1:{port}/health', timeout=3) as response:
            return 0 if response.status == 200 and json.load(response).get('status') == 'ok' else 1
    except (OSError, ValueError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
