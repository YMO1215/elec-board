"""SQLite access: one connection per request, explicit write transactions."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
SCHEMA_VERSION = 1


def connect(db_path: Path) -> sqlite3.Connection:
    # isolation_level=None: autocommit; writes open BEGIN IMMEDIATE via tx().
    conn = sqlite3.connect(db_path, isolation_level=None, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def migrate(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version == 0:
            conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        elif version > SCHEMA_VERSION:
            raise RuntimeError(
                f"database schema v{version} is newer than this code (v{SCHEMA_VERSION})"
            )
    finally:
        conn.close()


@contextmanager
def tx(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Serialize writers: BEGIN IMMEDIATE takes the write lock up front, so
    read-then-write sequences (audit hash chain, version checks) cannot race."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def local_today(tz) -> date:
    return datetime.now(tz).date()


def local_date_of(iso_ts: str, tz) -> date:
    return datetime.fromisoformat(iso_ts).astimezone(tz).date()


def row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(r) if r is not None else None


def rows(rs: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rs]


def one(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
    return row(conn.execute(sql, tuple(params)).fetchone())


def many(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
    return rows(conn.execute(sql, tuple(params)).fetchall())


def scalar(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> Any:
    r = conn.execute(sql, tuple(params)).fetchone()
    return r[0] if r is not None else None


def bump_rev(conn: sqlite3.Connection, org_id: int) -> None:
    """Every write bumps the org revision; clients poll it to refresh views."""
    conn.execute("UPDATE organizations SET rev = rev + 1 WHERE id = ?", (org_id,))
