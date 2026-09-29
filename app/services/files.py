"""Private file storage. Files live outside the web root and are served only
through short-lived HMAC-signed URLs issued to members of the owning org."""
from __future__ import annotations

import hashlib
import mimetypes
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import Settings
from ..db import now_iso, one
from ..errors import bad_request, conflict
from ..security import signed_file_url

INLINE_PREFIXES = ("image/", "video/", "audio/", "application/pdf")


def _safe_name(filename: str) -> str:
    name = Path(filename or "file").name.strip() or "file"
    return name[:120]


def store(
    conn: sqlite3.Connection,
    settings: Settings,
    *,
    org_id: int,
    owner_type: str,
    owner_id: int,
    item_key: str | None,
    filename: str,
    mime: str,
    data: bytes,
    uploaded_by: int,
    client_id: str | None = None,
) -> dict[str, Any]:
    if client_id:
        existing = one(conn, "SELECT * FROM attachments WHERE client_id = ?", (client_id,))
        if existing is not None:
            same_owner = (existing["org_id"], existing["owner_type"], existing["owner_id"]) == (
                org_id, owner_type, owner_id)
            if not same_owner:
                raise conflict("같은 업로드 키가 다른 대상에 이미 쓰였습니다.", "client_id_reused")
            return existing
    if len(data) == 0:
        raise bad_request("빈 파일은 올릴 수 없습니다.", "empty_file")
    if len(data) > settings.max_upload_bytes:
        raise bad_request("파일이 너무 큽니다.", "file_too_large",
                          {"max_bytes": settings.max_upload_bytes})
    now = datetime.now(timezone.utc)
    rel = Path(str(org_id)) / f"{now:%Y}" / f"{now:%m}" / secrets.token_hex(16)
    path = settings.files_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    cur = conn.execute(
        "INSERT INTO attachments (org_id, owner_type, owner_id, item_key, client_id, filename, mime, size,"
        " sha256, storage_path, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (org_id, owner_type, owner_id, item_key, client_id, _safe_name(filename), mime, len(data),
         hashlib.sha256(data).hexdigest(), rel.as_posix(), uploaded_by, now_iso()),
    )
    return one(conn, "SELECT * FROM attachments WHERE id = ?", (cur.lastrowid,))


def guess_mime(filename: str, declared: str | None) -> str:
    if declared and declared != "application/octet-stream":
        return declared.split(";")[0].strip().lower()
    return (mimetypes.guess_type(filename)[0] or "application/octet-stream").lower()


def public_view(settings: Settings, att: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": att["id"],
        "owner_type": att["owner_type"],
        "owner_id": att["owner_id"],
        "item_key": att["item_key"],
        "filename": att["filename"],
        "mime": att["mime"],
        "size": att["size"],
        "sha256": att["sha256"],
        "created_at": att["created_at"],
        "url": signed_file_url(settings.secret_key, att["id"], settings.file_url_ttl_seconds),
    }


def absolute_path(settings: Settings, att: dict[str, Any]) -> Path:
    path = (settings.files_dir / att["storage_path"]).resolve()
    if settings.files_dir.resolve() not in path.parents:
        raise bad_request("잘못된 파일 경로입니다.", "bad_path")
    return path
