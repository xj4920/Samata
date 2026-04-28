#!/usr/bin/env python
"""
Dump column-level schema for all WIND.* tables used by dataSync into
docs/wind-schema.json.

Why: OTCClaw agent kept burning its 30-round tool budget guessing column
names (see 2026-04-28 incident). Persisting column metadata into the repo
lets the agent read it via read_file before writing SQL.

Source of truth:
  - Table list: ~/work/source/dataSync/config/config.json TABLES[]
  - Column metadata: ALL_TAB_COLUMNS in Oracle WIND schema

Idempotent: rerun whenever dataSync's TABLES change or Wind schema evolves.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import sys
from pathlib import Path

import oracledb


REPO_ROOT = Path(__file__).resolve().parent.parent
DATASYNC_CONFIG = Path(
    os.environ.get(
        "DATASYNC_CONFIG",
        Path.home() / "work" / "source" / "dataSync" / "config" / "config.json",
    )
).expanduser()
OUTPUT_PATH = REPO_ROOT / "docs" / "wind-schema.json"


def load_dataset_config() -> dict:
    if not DATASYNC_CONFIG.exists():
        raise SystemExit(
            f"dataSync config not found at {DATASYNC_CONFIG}. "
            "Set DATASYNC_CONFIG env var to override."
        )
    with DATASYNC_CONFIG.open("r", encoding="utf-8") as f:
        return json.load(f)


def fetch_columns(conn, owner: str, table: str) -> list[dict]:
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT column_name, data_type, data_length, nullable, column_id
            FROM all_tab_columns
            WHERE owner = :owner_name AND table_name = :tab_name
            ORDER BY column_id
            """,
            owner_name=owner,
            tab_name=table,
        )
        rows = cur.fetchall()
    finally:
        cur.close()

    return [
        {
            "name": name,
            "type": data_type,
            "length": int(data_length) if data_length is not None else None,
            "nullable": nullable,
        }
        for (name, data_type, data_length, nullable, _column_id) in rows
    ]


def main() -> int:
    cfg = load_dataset_config()
    tables_cfg = cfg.get("TABLES", [])
    if not tables_cfg:
        raise SystemExit("dataSync config has no TABLES entries")

    host = cfg["ORACLE_HOST"]
    port = cfg["ORACLE_PORT"]
    service = cfg["ORACLE_DATABASE_NAME"]
    user = cfg["ORACLE_USER"]
    pwd = cfg["ORACLE_PWD"]

    try:
        oracledb.init_oracle_client()
    except Exception:
        pass

    print(f"Connecting to {host}:{port}/{service} as {user}...", file=sys.stderr)
    conn = oracledb.connect(user=user, password=pwd, dsn=f"{host}:{port}/{service}")

    out: dict = {
        "generated_at": _dt.datetime.now(_dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "source": f"{host}:{port}/{service} ({user})",
        "note": (
            "Column metadata dumped from Oracle ALL_TAB_COLUMNS for tables tracked "
            "by ~/work/source/dataSync/config/config.json. Regenerate via "
            "scripts/dump-wind-schema.py."
        ),
        "tables": {},
    }

    failures: list[str] = []
    for entry in tables_cfg:
        full = entry["name"]
        date_col = entry.get("date_col")
        if "." in full:
            owner, table = full.split(".", 1)
        else:
            owner, table = "WIND", full
        owner = owner.upper()
        table = table.upper()

        try:
            cols = fetch_columns(conn, owner, table)
        except oracledb.DatabaseError as e:
            print(f"  ! {full}: {e}", file=sys.stderr)
            failures.append(full)
            continue

        if not cols:
            print(f"  ! {full}: no columns found", file=sys.stderr)
            failures.append(full)
            continue

        out["tables"][table] = {
            "owner": owner,
            "date_col": date_col,
            "columns": cols,
        }
        print(f"  + {full}: {len(cols)} columns", file=sys.stderr)

    conn.close()

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(
        f"\nWrote {len(out['tables'])} tables to {OUTPUT_PATH.relative_to(REPO_ROOT)}"
        + (f" (failures: {failures})" if failures else ""),
        file=sys.stderr,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
