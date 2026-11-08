"""Public cache metadata derived from the user's decrypted snapshot, never a queue claim."""
from __future__ import annotations
from datetime import datetime,timezone
import time

CACHE_FRESH_SECONDS=900

def cache_metadata(connection: dict | None, *, now: float | None=None) -> dict:
    now=time.time() if now is None else now
    connection=connection or {};snapshot=connection.get('snapshot') or {}
    stamp=snapshot.get('synced_at');epoch=None
    if isinstance(stamp,str):
        try:
            parsed=datetime.fromisoformat(stamp.replace('Z','+00:00'))
            if parsed.tzinfo is not None:
                candidate=parsed.timestamp()
                if 0<candidate<=now+5:epoch=candidate
        except (ValueError,OverflowError,OSError):pass
    available=epoch is not None or any(bool(snapshot.get(k)) for k in ('tasks','lessons','days','grades','school_name','grade'))
    stale=bool(available and connection.get('provider')=='netschool' and
               (connection.get('status')!='connected' or epoch is None or now-epoch>CACHE_FRESH_SECONDS))
    return {'snapshot_available':available,'is_stale':stale,
            'last_synced_at':stamp if epoch is not None else None}
