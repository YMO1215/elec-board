"""Password hashing, opaque tokens and signed (expiring) file URLs."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
MIN_PASSWORD_LENGTH = 8


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_DKLEN
    )
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, n, r, p, salt, digest = encoded.split("$")
    except ValueError:
        return False
    if algo != "scrypt":
        return False
    expected = _unb64(digest)
    actual = hashlib.scrypt(
        password.encode("utf-8"), salt=_unb64(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected)
    )
    return hmac.compare_digest(actual, expected)


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_hash(token: str) -> str:
    """Session / invitation tokens are stored hashed; a DB leak does not grant access."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_public_id() -> str:
    """Unguessable id for QR labels (never the sequential asset id)."""
    return secrets.token_urlsafe(12)


def sign_file(secret: str, file_id: int, expires_at: int) -> str:
    msg = f"file:{file_id}:{expires_at}".encode("ascii")
    return _b64(hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).digest())


def signed_file_url(secret: str, file_id: int, ttl_seconds: int, now: float | None = None) -> str:
    expires_at = int((now if now is not None else time.time()) + ttl_seconds)
    return f"files/{file_id}?exp={expires_at}&sig={sign_file(secret, file_id, expires_at)}"


def verify_file_signature(secret: str, file_id: int, expires_at: int, sig: str, now: float | None = None) -> bool:
    if expires_at < int(now if now is not None else time.time()):
        return False
    return hmac.compare_digest(sign_file(secret, file_id, expires_at), sig)
