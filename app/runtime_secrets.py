"""Local-only random secrets, persistent under mode 0600. Never derived from bot tokens."""
import json,os,secrets,stat
from pathlib import Path
from cryptography.fernet import Fernet

def configure():
    for source,target in [('BOT_TOKEN','TELEGRAM_BOT_TOKEN'),('PUBLIC_WEBAPP_URL','TELEGRAM_MINIAPP_URL'),('SESSION_SECRET','SESSION_SIGNING_KEY')]:
        if not os.getenv(target) and os.getenv(source):os.environ[target]=os.environ[source]
    if not os.getenv('SFERUM_PUBLIC_ORIGIN') and os.getenv('TELEGRAM_MINIAPP_URL'):
        from urllib.parse import urlsplit
        p=urlsplit(os.environ['TELEGRAM_MINIAPP_URL'])
        if p.scheme=='https' and p.hostname and not p.username and not p.password:os.environ['SFERUM_PUBLIC_ORIGIN']=f'https://{p.netloc}'
    if os.getenv('SFERUM_ENV','production') not in {'demo','test'} or os.getenv('SFERUM_LOCAL_SECRETS')!='1':return
    # Explicit local development only; never infer trust from request Host/Origin.
    if not os.getenv('SFERUM_PUBLIC_ORIGIN'):
        port = int(os.getenv('PORT', '8000'))
        if not 1 <= port <= 65535:raise ValueError('Invalid local port')
        os.environ['SFERUM_PUBLIC_ORIGIN'] = f'http://127.0.0.1:{port}'
    if os.getenv('SESSION_SIGNING_KEY') and os.getenv('DIARY_ENCRYPTION_KEY'):return
    from app.json_storage import ensure_private_dir
    directory=Path(os.getenv('SFERUM_DATA_DIR','data'));ensure_private_dir(directory)
    path=directory/'.runtime_secrets.json'
    # flock + exclusive create avoids simultaneous workers observing partial keys.
    import fcntl
    lock=os.open(directory/'.runtime_secrets.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if not path.exists():
            data={'SESSION_SIGNING_KEY':secrets.token_urlsafe(48),'DIARY_ENCRYPTION_KEY':Fernet.generate_key().decode()}
            fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w') as f:json.dump(data,f);f.flush();os.fsync(f.fileno())
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd) as f:
            info=os.fstat(f.fileno())
            if stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=os.getuid():raise ValueError('Local secret file must be owned by process user and mode 0600')
            data=json.load(f)
        Fernet(data['DIARY_ENCRYPTION_KEY'].encode())
        if len(data['SESSION_SIGNING_KEY'])<32:raise ValueError('Invalid local signing key')
        for name in ('SESSION_SIGNING_KEY','DIARY_ENCRYPTION_KEY'):
            if not os.getenv(name):os.environ[name]=data[name]
    finally:os.close(lock)
