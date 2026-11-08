"""Do not emit sensitive request targets or HTTP wire debug data.

Reverse-proxy logs must be configured separately (deploy/nginx.conf.example).
This filter cannot retroactively scrub logs written by an external proxy.
"""
import logging
import re
import traceback
from urllib.parse import unquote, urlsplit


class NoApiQuery(logging.Filter):
    def filter(self, record):
        if isinstance(record.args, tuple) and len(record.args) == 5:
            args = list(record.args)
            if isinstance(args[2], str):
                value = args[2]
                # Strip encoded delimiters too: only a path belongs in an access log.
                for _ in range(3):
                    decoded = unquote(value)
                    if decoded == value:
                        break
                    value = decoded
                try:
                    u = urlsplit(value)
                    args[2] = u.path if u.scheme else value.split('?', 1)[0].split('#', 1)[0]
                except ValueError:
                    args[2] = '[invalid-target]'
                args[2] = ''.join(c for c in args[2] if ord(c) >= 32 and ord(c) != 127)
            record.args = tuple(args)
        return True


class NoWireLogs(logging.Filter):
    def filter(self, record):
        # httpcore DEBUG can include cookies, auth headers, request body, TLS URLs.
        # Raising the logger level alone is not sufficient: logging can be reset.
        return False


_SENSITIVE = re.compile(r"(?i)(?<![a-z0-9_])(?:password|pw2|pw|at|token|secret|access_token|refresh_token|authorization|cookie|set-cookie|set_cookie|snils|init_data|client_secret|x-max-init-data|x-telegram-init-data|x-csrf-token)[\"']?\s*[:=]")
_SECRET_KEYS = {'password','pw','pw2','at','access_token','refresh_token','authorization','cookie','set-cookie','snils','init_data','client_secret','token','secret','set_cookie','x-max-init-data','x-telegram-init-data','x-csrf-token'}

_STANDARD_FIELDS=frozenset(logging.LogRecord('',0,'',0,'',(),None).__dict__)
def _safe_extra(value,depth=0):
    if depth>=8:return '[REDACTED nested log data]'
    if isinstance(value,dict):
        return {k:'[REDACTED]' if isinstance(k,str) and k.lower() in _SECRET_KEYS else _safe_extra(v,depth+1) for k,v in value.items()}
    if isinstance(value,(tuple,list)):
        return [_safe_extra(v,depth+1) for v in value]
    if isinstance(value,str) and _SENSITIVE.search(value):return '[REDACTED sensitive log content]'
    return value

class RedactingFilter(logging.Filter):
    """Fail closed on credential-bearing text; preserve normal operational messages."""
    def filter(self, record):
        try:
            message=record.getMessage()
            if _SENSITIVE.search(message):
                record.msg='[REDACTED sensitive log content]';record.args=()
            for key in list(record.__dict__):
                if key.lower() in _SECRET_KEYS:record.__dict__[key]='[REDACTED]'
                elif key not in _STANDARD_FIELDS:record.__dict__[key]=_safe_extra(record.__dict__[key])
            if record.exc_info and _SENSITIVE.search(''.join(traceback.format_exception(*record.exc_info))):
                record.exc_info=None;record.exc_text=None
                record.msg='[REDACTED sensitive exception]';record.args=()
        except Exception:
            record.msg='[REDACTED invalid log content]';record.args=();record.exc_info=None;record.exc_text=None
        return True


def install():
    previous=logging.getLogRecordFactory()
    if not getattr(previous,'_sf_redaction',False):
        redactor=RedactingFilter()
        def factory(*args,**kwargs):
            record=previous(*args,**kwargs)
            if record.name=='uvicorn.access':NoApiQuery().filter(record)
            redactor.filter(record)
            return record
        factory._sf_redaction=True
        logging.setLogRecordFactory(factory)
    # Logger adds `extra` AFTER the record factory. Scrub that boundary too.
    make_record=logging.Logger.makeRecord
    if not getattr(make_record,'_sf_redaction',False):
        def safe_make_record(self,*args,**kwargs):
            record=make_record(self,*args,**kwargs)
            RedactingFilter().filter(record)
            return record
        safe_make_record._sf_redaction=True
        logging.Logger.makeRecord=safe_make_record
    logger = logging.getLogger('uvicorn.access')
    if not any(isinstance(f, NoApiQuery) for f in logger.filters):
        logger.addFilter(NoApiQuery())
    for name in ('httpx', 'httpcore', 'httpcore.connection', 'httpcore.http11', 'httpcore.http2', 'httpcore.proxy', 'httpcore.socks'):
        logger = logging.getLogger(name)
        if not any(isinstance(f, NoWireLogs) for f in logger.filters):
            logger.addFilter(NoWireLogs())
        logger.setLevel(logging.CRITICAL + 1)
