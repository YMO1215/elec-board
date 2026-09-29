"""Vercel entry point — PREVIEW DEMO ONLY.

Vercel functions have no persistent disk: the SQLite DB and uploaded files
live in /tmp and vanish whenever an instance is recycled (and each instance
has its own copy). Every cold start therefore seeds fresh demo data. For real
use run `python -m app.cli serve` on a server with a persistent ELEC_DATA_DIR.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("ELEC_DATA_DIR", "/tmp/elec-board")
os.environ.setdefault("ELEC_DEMO", "true")
os.environ.setdefault("ELEC_COOKIE_SECURE", "true")
# Demo data is throwaway; a fixed fallback keeps signed file links valid across
# instances. Set ELEC_SECRET_KEY in the Vercel project to override.
os.environ.setdefault("ELEC_SECRET_KEY", "elec-board-preview-demo-only")

from app.config import Settings  # noqa: E402
from app.db import connect, migrate  # noqa: E402
from app.demo import seed_demo  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.org import needs_setup  # noqa: E402

settings = Settings.from_env()
migrate(settings.db_path)
_conn = connect(settings.db_path)
try:
    _empty = needs_setup(_conn)
finally:
    _conn.close()
if _empty:
    seed_demo(settings)

app = create_app(settings)
