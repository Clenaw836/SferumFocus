"""Container probe. Never prints account, tokens, cookies or grade payloads."""
import time

def main():
    from app import config
    from app.platform_auth import store
    with store().tx() as db:online=bool(db.execute('SELECT 1 FROM connector_workers WHERE heartbeat>? LIMIT 1',(time.time()-45,)).fetchone())
    print('connector_online' if online else 'connector_offline')
    return 0 if online else 1
if __name__=='__main__':raise SystemExit(main())
