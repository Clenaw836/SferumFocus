"""Allowlisted auth diagnostics. Never accept credentials or provider payloads."""
from __future__ import annotations
import logging,secrets,time
logger=logging.getLogger('sferumfocus.sgo.auth')
_STAGES=frozenset({'start','warmup','capabilities','challenge','authenticate','initialize','snapshot','complete'})
_RESULTS=frozenset({'begin','ok','disabled','rejected','unavailable','unsupported','error','retry_encoding','retry_variant'})
class AuthDiagnostics:
    def __init__(self):
        self.trace=secrets.token_hex(6);self.started=time.monotonic()
    def record(self,stage:str,result:str):
        if stage not in _STAGES or result not in _RESULTS:raise ValueError('Invalid diagnostic event')
        logger.info('sgo_auth trace=%s stage=%s result=%s elapsed_ms=%d',self.trace,stage,result,int((time.monotonic()-self.started)*1000))
