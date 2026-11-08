"""Versioned AES-256-GCM records. Keys stay server-side; context/version are AAD."""
from __future__ import annotations
import base64,re,secrets
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

class SessionCipher:
    def __init__(self, keys: dict[str,bytes], active_version: str='v1'):
        if not keys or active_version not in keys:
            raise ValueError('Active encryption key is not configured')
        if any(not re.fullmatch(r'v[1-9][0-9]{0,5}',v) or not isinstance(k,bytes) or len(k)!=32 for v,k in keys.items()):
            raise ValueError('AES keyring must contain versioned 32-byte keys')
        self._keys={v:AESGCM(k) for v,k in keys.items()};self.active_version=active_version
    def encrypt(self, plaintext: str, context: bytes=b'') -> str:
        version=self.active_version;nonce=secrets.token_bytes(12)
        raw=nonce+self._keys[version].encrypt(nonce,plaintext.encode('utf-8'),version.encode()+b'\0'+context)
        return version+':'+base64.urlsafe_b64encode(raw).decode('ascii')
    def decrypt(self, token: str, context: bytes=b'') -> str:
        try:
            version,payload=token.split(':',1)
            if version not in self._keys or len(payload)>32*1024*1024:raise ValueError()
            raw=base64.b64decode(payload,altchars=b'-_',validate=True)
            if len(raw)<28:raise ValueError()
        except (ValueError,TypeError,AttributeError):
            raise ValueError('Encrypted record version/encoding invalid') from None
        return self._keys[version].decrypt(raw[:12],raw[12:],version.encode()+b'\0'+context).decode('utf-8')
