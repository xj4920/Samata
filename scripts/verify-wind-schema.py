#!/usr/bin/env /usr/local/python-3.10.4/bin/python
"""
Verify wind-tables-schema.md against actual PostgreSQL information_schema.columns.
Connects to 127.0.0.1/wind_sync (the synced PG) and compares column names per table.
"""
import re
import sys
from pathlib import Path
from typing import Dict, List

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
    sys.exit(1)

SCHEMA_DOC = Path(__file__).resolve().parent.parent / "docs" / "wind-tables-schema.md"

def parse_schema_doc(path: Path) -> Dict[str, List[str]]:
    """Parse wind-tables-schema.md, return {TABLE_NAME: [col1, col2, ...]}."""
    tables: Dict[str, List[str]] = {}
    current_table = None

    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^## ([A-Z][A-Z0-9_]+)", line)
        if m:
            current_table = m.group(1)
            tables[current_table] = []
            continue

        if current_table is None:
            continue

        if re.match(r"^\|\s*\d+\s*\|", line):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 3:
                col_name = parts[2]
                if col_name and col_name != "字段名" and not col_name.startswith("---"):
                    tables[current_table].append(col_name)

    return tables


def query_pg_schema(conn) -> Dict[str, List[str]]:
    """Query information_schema.columns for all uppercase tables in wind_sync."""
    cur = conn.cursor()
    cur.execute("""
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name ~ '^[A-Z]'
        ORDER BY table_name, ordinal_position
    """)
    result: Dict[str, List[str]] = {}
    for table_name, column_name in cur.fetchall():
        result.setdefault(table_name, []).append(column_name)
    cur.close()
    return result


def main():
    print(f"Reading schema doc: {SCHEMA_DOC}")
    if not SCHEMA_DOC.exists():
        print(f"ERROR: {SCHEMA_DOC} not found")
        sys.exit(1)

    doc_tables = parse_schema_doc(SCHEMA_DOC)
    print(f"Doc tables: {len(doc_tables)}")

    print("\nConnecting to PostgreSQL 127.0.0.1:5432/wind_sync ...")
    try:
        conn = psycopg2.connect(
            host="127.0.0.1", port=5432,
            dbname="wind_sync", user="wind_sync", password="wind_sync"
        )
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    pg_tables = query_pg_schema(conn)
    conn.close()
    print(f"PG tables (uppercase): {len(pg_tables)}")

    # Compare
    all_tables = sorted(set(doc_tables.keys()) | set(pg_tables.keys()))

    mismatch_count = 0
    for table in all_tables:
        doc_cols = set(doc_tables.get(table, []))
        pg_cols = set(pg_tables.get(table, []))

        only_doc = doc_cols - pg_cols
        only_pg = pg_cols - doc_cols

        if table not in doc_tables:
            print(f"\n[EXTRA IN PG] {table} — {len(pg_cols)} cols in PG, missing from doc")
            mismatch_count += 1
        elif table not in pg_tables:
            print(f"\n[MISSING IN PG] {table} — documented but not in PG")
            mismatch_count += 1
        elif only_doc or only_pg:
            print(f"\n[MISMATCH] {table}")
            if only_doc:
                print(f"  Doc only ({len(only_doc)}): {sorted(only_doc)}")
            if only_pg:
                print(f"  PG only  ({len(only_pg)}): {sorted(only_pg)}")
            mismatch_count += 1
        else:
            print(f"  [OK] {table} — {len(doc_cols)} cols match")

    print(f"\n{'='*60}")
    print(f"Total tables: {len(all_tables)}, Mismatches: {mismatch_count}")
    if mismatch_count == 0:
        print("All column names consistent!")
    else:
        print(f"{mismatch_count} table(s) have discrepancies.")


if __name__ == "__main__":
    main()
