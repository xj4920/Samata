"""检查 WIND Oracle 库两张表的最新数据日期"""
import oracledb
import sys

oracledb.init_oracle_client()

conn = oracledb.connect(
    user="windquery",
    password="wind2010query",
    dsn="10.2.89.132:1521/winddb"
)

tables = [
    ("WIND.ASHAREEODDERIVATIVEINDICATOR", "TRADE_DT"),
    ("WIND.ASHAREINCOME", "ANN_DT"),
]

for table, date_col in tables:
    try:
        cur = conn.cursor()
        cur.execute(f"SELECT MAX({date_col}) FROM {table}")
        row = cur.fetchone()
        cur.close()
        latest = row[0] if row else "NULL"
        print(f"{table}: MAX({date_col}) = {latest}")
    except Exception as e:
        print(f"{table}: ERROR - {e}", file=sys.stderr)

conn.close()
