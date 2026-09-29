"""Command line: python -m app.cli {init,demo,serve,verify-audit}."""
from __future__ import annotations

import argparse
import getpass
import sys

from .audit import verify_chain
from .config import Settings
from .db import connect, migrate, tx


def cmd_init(args, settings: Settings) -> int:
    from .services import org

    migrate(settings.db_path)
    conn = connect(settings.db_path)
    try:
        password = args.password or getpass.getpass("관리자 비밀번호(8자 이상): ")
        with tx(conn):
            org.bootstrap(conn, settings, org_name=args.org, name=args.name, email=args.email, password=password)
    finally:
        conn.close()
    print(f"초기 설정 완료: {args.org} / 관리자 {args.email}")
    return 0


def cmd_demo(args, settings: Settings) -> int:
    from .demo import DEMO_PASSWORD, DEMO_USERS, seed_demo
    from .services.org import needs_setup

    migrate(settings.db_path)
    conn = connect(settings.db_path)
    try:
        if not needs_setup(conn):
            print("이미 데이터가 있습니다. 데모는 빈 데이터 폴더(ELEC_DATA_DIR)에서만 만듭니다.", file=sys.stderr)
            return 1
    finally:
        conn.close()
    seed_demo(settings)
    print("데모 데이터를 만들었습니다. 비밀번호는 모두", DEMO_PASSWORD)
    for name, email, roles, slot in DEMO_USERS:
        print(f"  {slot}열 {name:<4} {email:<22} {roles}")
    return 0


def cmd_serve(args, settings: Settings) -> int:
    import uvicorn

    from .main import create_app

    uvicorn.run(create_app(settings), host=args.host, port=args.port, proxy_headers=True,
                forwarded_allow_ips=args.forwarded_allow_ips)
    return 0


def cmd_verify_audit(args, settings: Settings) -> int:
    conn = connect(settings.db_path)
    try:
        ok = True
        for (org_id,) in conn.execute("SELECT id FROM organizations"):
            result = verify_chain(conn, org_id)
            print(f"org {org_id}: {result}")
            ok = ok and result["ok"]
    finally:
        conn.close()
    return 0 if ok else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("init", help="첫 관리자와 팀을 만든다")
    p.add_argument("--org", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--email", required=True)
    p.add_argument("--password")
    sub.add_parser("demo", help="빈 데이터 폴더에 데모 팀·현장·업무를 만든다")
    p = sub.add_parser("serve", help="웹 서버 실행")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8810)
    p.add_argument("--forwarded-allow-ips", default="127.0.0.1")
    sub.add_parser("verify-audit", help="감사 로그 해시 체인 검증")
    args = parser.parse_args(argv)
    settings = Settings.from_env()
    handler = {"init": cmd_init, "demo": cmd_demo, "serve": cmd_serve, "verify-audit": cmd_verify_audit}
    return handler[args.command](args, settings)


if __name__ == "__main__":
    sys.exit(main())
