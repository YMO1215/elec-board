"""Hash-chained audit log. Each row's hash covers the previous row's hash, so
any edit to history (outside the DB triggers) breaks verify_chain()."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any

from .db import many, now_iso, scalar

GENESIS = "0" * 64


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _row_hash(prev_hash: str, fields: dict[str, Any]) -> str:
    return hashlib.sha256((prev_hash + canonical_json(fields)).encode("utf-8")).hexdigest()


def record(
    conn: sqlite3.Connection,
    org_id: int,
    actor_id: int | None,
    action: str,
    entity_type: str,
    entity_id: int | None,
    detail: dict[str, Any] | None = None,
) -> None:
    """Must run inside db.tx() so the chain head cannot move underneath us."""
    prev = scalar(conn, "SELECT hash FROM audit_logs WHERE org_id = ? ORDER BY id DESC LIMIT 1", (org_id,))
    prev = prev or GENESIS
    created_at = now_iso()
    detail_json = canonical_json(detail or {})
    fields = {
        "org_id": org_id,
        "actor_id": actor_id,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "detail_json": detail_json,
        "created_at": created_at,
    }
    conn.execute(
        "INSERT INTO audit_logs (org_id, actor_id, action, entity_type, entity_id, detail_json,"
        " created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (org_id, actor_id, action, entity_type, entity_id, detail_json, created_at, prev,
         _row_hash(prev, fields)),
    )


def verify_chain(conn: sqlite3.Connection, org_id: int) -> dict[str, Any]:
    prev = GENESIS
    entries = many(conn, "SELECT * FROM audit_logs WHERE org_id = ? ORDER BY id", (org_id,))
    for e in entries:
        fields = {k: e[k] for k in ("org_id", "actor_id", "action", "entity_type", "entity_id",
                                    "detail_json", "created_at")}
        if e["prev_hash"] != prev or e["hash"] != _row_hash(prev, fields):
            return {"ok": False, "checked": len(entries), "broken_at": e["id"]}
        prev = e["hash"]
    return {"ok": True, "checked": len(entries), "broken_at": None}
