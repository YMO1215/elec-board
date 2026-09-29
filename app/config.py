"""Runtime settings, read from environment variables (see .env.example)."""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from datetime import timedelta, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT_DIR / "web"

# Candidate TrueType fonts with Hangul glyphs, used for PDF reports when
# ELEC_PDF_FONT is not set. Falls back to a non-embedded CID font.
PDF_FONT_CANDIDATES = (
    r"C:\Windows\Fonts\malgun.ttf",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/Library/Fonts/NanumGothic.ttf",
)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _load_secret(data_dir: Path) -> str:
    explicit = os.environ.get("ELEC_SECRET_KEY")
    if explicit:
        return explicit
    # Development convenience: persist a random key next to the database so
    # sessions and signed file URLs survive restarts.
    path = data_dir / "secret.key"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    data_dir.mkdir(parents=True, exist_ok=True)
    key = secrets.token_urlsafe(48)
    path.write_text(key, encoding="utf-8")
    return key


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    secret_key: str
    cookie_secure: bool = False
    session_days: int = 14
    invite_days: int = 7
    file_url_ttl_seconds: int = 600
    max_upload_bytes: int = 50 * 1024 * 1024
    tz_offset_hours: int = 9                 # Korea (no DST)
    knowledge_review_days: int = 180
    pdf_font_path: str | None = None
    setup_token: str | None = None           # if set, first-run setup requires it
    login_max_failures: int = 5
    login_lock_seconds: int = 300
    allowed_upload_prefixes: tuple[str, ...] = field(default=("image/", "video/", "audio/"))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "elec-board.sqlite3"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def tz(self) -> timezone:
        return timezone(timedelta(hours=self.tz_offset_hours))

    @classmethod
    def from_env(cls) -> "Settings":
        data_dir = Path(os.environ.get("ELEC_DATA_DIR", ROOT_DIR / "data")).resolve()
        return cls(
            data_dir=data_dir,
            secret_key=_load_secret(data_dir),
            cookie_secure=_env_bool("ELEC_COOKIE_SECURE", False),
            session_days=int(os.environ.get("ELEC_SESSION_DAYS", "14")),
            file_url_ttl_seconds=int(os.environ.get("ELEC_FILE_URL_TTL", "600")),
            max_upload_bytes=int(os.environ.get("ELEC_MAX_UPLOAD_MB", "50")) * 1024 * 1024,
            tz_offset_hours=int(os.environ.get("ELEC_TZ_OFFSET_HOURS", "9")),
            knowledge_review_days=int(os.environ.get("ELEC_KNOWLEDGE_REVIEW_DAYS", "180")),
            pdf_font_path=os.environ.get("ELEC_PDF_FONT") or None,
            setup_token=os.environ.get("ELEC_SETUP_TOKEN") or None,
        )
