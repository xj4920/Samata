#!/usr/bin/env python3
"""
One-time script: split docs/wind-tables-schema.md into per-table files
under docs/wind-tables/ and replace the original with a compact index.
"""
import re
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_FILE = PROJECT_ROOT / "docs" / "wind-tables-schema.md"
OUTPUT_DIR = PROJECT_ROOT / "docs" / "wind-tables"


def parse_sections(text):
    """Split the schema doc into per-table sections.
    Returns list of (table_name, description, field_count, section_body)."""
    sections = []
    # Split on ## TABLE_NAME headings (only uppercase table names)
    parts = re.split(r'^(## [A-Z][A-Z0-9_]+)', text, flags=re.MULTILINE)

    # parts[0] = preamble (title, TOC), then alternating heading/body
    for i in range(1, len(parts), 2):
        heading = parts[i]            # "## TABLENAME"
        body = parts[i + 1] if i + 1 < len(parts) else ""
        table_name = heading.replace("## ", "").strip()

        desc_match = re.search(r'\*\*说明[：:]\*\*\s*(.+)', body)
        desc = desc_match.group(1).strip() if desc_match else table_name

        count_match = re.search(r'\*\*字段数[：:]\*\*\s*(\d+)', body)
        field_count = int(count_match.group(1)) if count_match else 0

        full_section = heading + body.rstrip() + "\n"
        sections.append((table_name, desc, field_count, full_section))

    return sections


def write_table_files(sections):
    """Write each table to docs/wind-tables/<TABLE_NAME>.md."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for table_name, desc, field_count, body in sections:
        out_path = OUTPUT_DIR / f"{table_name}.md"
        out_path.write_text(body, encoding="utf-8")
        print(f"  {table_name}.md ({field_count} fields, {len(body)} bytes)")


def write_index(sections):
    """Replace wind-tables-schema.md with a compact index."""
    lines = [
        "# Wind 数据库表结构索引",
        "",
        "本文档是 24 张 Wind 表的索引。查询某张表前，先在下表找到目标表，",
        "然后用 `read_file` 读取对应文件获取完整字段列表。",
        "",
        "| # | 表名 | 字段数 | 说明 | 文件路径 |",
        "|---|------|-------|------|---------|",
    ]
    for i, (table_name, desc, field_count, _) in enumerate(sections, 1):
        rel_path = f"docs/wind-tables/{table_name}.md"
        lines.append(f"| {i} | {table_name} | {field_count} | {desc} | `{rel_path}` |")

    lines.append("")
    SCHEMA_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nIndex written to {SCHEMA_FILE} ({len(lines)} lines)")


def main():
    if not SCHEMA_FILE.exists():
        print(f"ERROR: {SCHEMA_FILE} not found")
        return

    text = SCHEMA_FILE.read_text(encoding="utf-8")
    sections = parse_sections(text)
    print(f"Parsed {len(sections)} table sections\n")

    print("Writing per-table files:")
    write_table_files(sections)
    write_index(sections)
    print("\nDone!")


if __name__ == "__main__":
    main()
