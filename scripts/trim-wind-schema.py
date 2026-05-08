#!/usr/bin/env python3
"""
Trim large Wind table schema files to keep only key fields (~20 per table).
Prevents LLM attention dispersion on tables with 40-192 fields.
"""
import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TABLES_DIR = PROJECT_ROOT / "docs" / "wind-tables"
INDEX_FILE = PROJECT_ROOT / "docs" / "wind-tables-schema.md"

KEY_FIELDS = {
    "ASHAREINCOME": [
        "OBJECT_ID", "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD",
        "STATEMENT_TYPE", "CRNCY_CODE", "TOT_OPER_REV", "OPER_REV",
        "NET_INT_INC", "NET_HANDLING_CHRG_COMM_INC", "PLUS_NET_INVEST_INC",
        "TOT_OPER_COST", "LESS_SELLING_DIST_EXP", "LESS_GERL_ADMIN_EXP",
        "LESS_FIN_EXP", "OPER_PROFIT", "TOT_PROFIT", "INC_TAX",
        "NET_PROFIT_INCL_MIN_INT_INC", "NET_PROFIT_EXCL_MIN_INT_INC",
        "S_FA_EPS_BASIC", "S_FA_EPS_DILUTED",
    ],
    "ASHAREBALANCESHEET": [
        "OBJECT_ID", "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD",
        "STATEMENT_TYPE", "CRNCY_CODE", "MONETARY_CAP", "TRADABLE_FIN_ASSETS",
        "ACCT_RCV", "INVENTORIES", "TOT_CUR_ASSETS", "FIX_ASSETS",
        "TOT_NON_CUR_ASSETS", "TOT_ASSETS", "TOT_CUR_LIAB",
        "TOT_NON_CUR_LIAB", "TOT_LIAB", "TOT_SHRHLDR_EQY_EXCL_MIN_INT",
        "TOT_SHRHLDR_EQY_INCL_MIN_INT", "TOT_LIAB_SHRHLDR_EQY",
    ],
    "ASHARECASHFLOW": [
        "OBJECT_ID", "S_INFO_WINDCODE", "ANN_DT", "REPORT_PERIOD",
        "STATEMENT_TYPE", "CRNCY_CODE", "CASH_RECP_SG_AND_RS",
        "STOT_CASH_INFLOWS_OPER_ACT", "CASH_PAY_GOODS_PURCH_SERV_REC",
        "CASH_PAY_BEH_EMPL", "PAY_ALL_TYP_TAX",
        "STOT_CASH_OUTFLOWS_OPER_ACT", "NET_CASH_FLOWS_OPER_ACT",
        "STOT_CASH_INFLOWS_INV_ACT", "STOT_CASH_OUTFLOWS_INV_ACT",
        "NET_CASH_FLOWS_INV_ACT", "STOT_CASH_INFLOWS_FNC_ACT",
        "STOT_CASH_OUTFLOWS_FNC_ACT", "NET_CASH_FLOWS_FNC_ACT",
        "NET_INCR_CASH_CASH_EQU",
    ],
    "ASHARECONSENSUSDATA": [
        "OBJECT_ID", "S_INFO_WINDCODE", "EST_DT", "EST_REPORT_DT",
        "NUM_EST_INST", "EPS_AVG", "EPS_MEDIAN", "NET_PROFIT_AVG",
        "NET_PROFIT_MEDIAN", "MAIN_BUS_INC_AVG", "MAIN_BUS_INC_MEDIAN",
        "EBITDA_AVG", "CONSEN_DATA_CYCLE_TYP", "NET_PROFIT_UPGRADE",
        "NET_PROFIT_DOWNGRADE", "NET_PROFIT_MAINTAIN", "S_EST_AVGROE",
        "S_EST_AVGBPS",
    ],
    "CHINAMUTUALFUNDDESCRIPTION": [
        "OBJECT_ID", "F_INFO_WINDCODE", "F_INFO_FULLNAME", "F_INFO_NAME",
        "F_INFO_CORP_FUNDMANAGEMENTCOMP", "F_INFO_CUSTODIANBANK",
        "F_INFO_FIRSTINVESTTYPE", "F_INFO_SETUPDATE", "F_INFO_MATURITYDATE",
        "F_ISSUE_TOTALUNIT", "F_INFO_MANAGEMENTFEERATIO",
        "F_INFO_CUSTODIANFEERATIO", "CRNY_CODE", "F_INFO_BENCHMARK",
        "F_INFO_STATUS", "F_INFO_TYPE", "F_INFO_ISINITIAL",
        "F_INFO_EXCHMARKET", "F_INFO_FIRSTINVESTSTYLE", "F_INFO_ISSUEDATE",
    ],
    "ASHAREEODDERIVATIVEINDICATOR": [
        "OBJECT_ID", "S_INFO_WINDCODE", "TRADE_DT", "CRNCY_CODE",
        "S_VAL_MV", "S_DQ_MV", "S_PQ_HIGH_52W_", "S_PQ_LOW_52W_",
        "S_VAL_PE", "S_VAL_PB_NEW", "S_VAL_PE_TTM", "S_VAL_PS_TTM",
        "S_DQ_TURN", "S_DQ_FREETURNOVER", "TOT_SHR_TODAY",
        "FLOAT_A_SHR_TODAY", "FREE_SHARES_TODAY",
        "NET_PROFIT_PARENT_COMP_TTM", "NET_ASSETS_TODAY", "S_DQ_CLOSE_TODAY",
    ],
    "ASHAREDIVIDEND": [
        "OBJECT_ID", "S_INFO_WINDCODE", "S_DIV_PROGRESS", "STK_DVD_PER_SH",
        "CASH_DVD_PER_SH_PRE_TAX", "CASH_DVD_PER_SH_AFTER_TAX",
        "EQY_RECORD_DT", "EX_DT", "DVD_PAYOUT_DT", "S_DIV_PRELANDATE",
        "DVD_ANN_DT", "REPORT_PERIOD", "S_DIV_BONUSRATE",
        "S_DIV_CONVERSEDRATE", "TOT_CASH_DVD", "S_DIV_BASESHARE",
        "ANN_DT", "CRNCY_CODE",
    ],
}

TRIM_NOTE = (
    "> 本文档仅列出最常用的 {count} 个字段（共 {total} 个）。"
    "如需其他字段，用 `information_schema.columns` 查询完整列表。\n"
)


def extract_field_name(row):
    """Extract field name from a markdown table row like '| 1 | FIELD_NAME | ...'"""
    cells = [c.strip() for c in row.split("|")]
    if len(cells) >= 4:
        candidate = cells[2]
        if candidate and candidate != "---" and candidate != "字段名":
            return candidate
    return None


def trim_table(table_name, keep_fields):
    md_file = TABLES_DIR / f"{table_name}.md"
    if not md_file.exists():
        print(f"  SKIP {table_name}: file not found")
        return

    text = md_file.read_text(encoding="utf-8")
    lines = text.split("\n")

    keep_set = set(keep_fields)
    header_lines: list[str] = []
    table_header: list[str] = []
    data_rows: list[str] = []
    after_table: list[str] = []
    original_total = 0

    state = "header"
    for line in lines:
        if state == "header":
            if line.startswith("| #") or line.startswith("| ---"):
                state = "table_header"
                table_header.append(line)
            else:
                header_lines.append(line)
        elif state == "table_header":
            if line.startswith("| ---"):
                table_header.append(line)
                state = "data"
            else:
                state = "data"
                fname = extract_field_name(line)
                if fname and fname in keep_set:
                    data_rows.append(line)
                if fname:
                    original_total += 1
        elif state == "data":
            fname = extract_field_name(line)
            if fname:
                original_total += 1
                if fname in keep_set:
                    data_rows.append(line)
            elif line.strip() == "" or line.startswith("---"):
                after_table.append(line)
                state = "after"
            else:
                pass
        elif state == "after":
            after_table.append(line)

    found_fields = []
    for row in data_rows:
        fname = extract_field_name(row)
        if fname:
            found_fields.append(fname)

    missing = [f for f in keep_fields if f not in set(found_fields)]
    if missing:
        print(f"  WARNING {table_name}: missing fields: {missing}")

    new_count = len(found_fields)

    new_header = []
    for line in header_lines:
        if line.startswith("**字段数：**"):
            new_header.append(f"**字段数：** {new_count}（常用字段，完整 {original_total} 个）")
        else:
            new_header.append(line)

    renumbered_rows = []
    for i, row in enumerate(data_rows, 1):
        cells = [c.strip() for c in row.split("|")]
        if len(cells) >= 4:
            cells[1] = f" {i:<3}"
            renumbered_rows.append("|".join(cells))
        else:
            renumbered_rows.append(row)

    note = TRIM_NOTE.format(count=new_count, total=original_total)

    result_lines = new_header + ["", note] + table_header + renumbered_rows + after_table
    result = "\n".join(result_lines)

    md_file.write_text(result, encoding="utf-8")
    print(f"  OK {table_name}: {original_total} -> {new_count} fields")

    return new_count


def update_index(field_counts):
    if not INDEX_FILE.exists():
        print("  SKIP: index file not found")
        return

    text = INDEX_FILE.read_text(encoding="utf-8")
    lines = text.split("\n")
    new_lines = []

    for line in lines:
        updated = False
        for table_name, count in field_counts.items():
            if table_name in line and "|" in line:
                parts = line.split("|")
                for i, part in enumerate(parts):
                    stripped = part.strip()
                    if stripped.isdigit() and int(stripped) > 20:
                        parts[i] = f" {count} "
                        updated = True
                        break
                if updated:
                    new_lines.append("|".join(parts))
                    break
        if not updated:
            new_lines.append(line)

    INDEX_FILE.write_text("\n".join(new_lines), encoding="utf-8")
    print(f"  OK: index updated for {len(field_counts)} tables")


def main():
    print("Trimming large Wind table schemas...")
    field_counts = {}
    for table_name, fields in KEY_FIELDS.items():
        count = trim_table(table_name, fields)
        if count:
            field_counts[table_name] = count

    print("\nUpdating index...")
    update_index(field_counts)
    print("\nDone!")


if __name__ == "__main__":
    main()
