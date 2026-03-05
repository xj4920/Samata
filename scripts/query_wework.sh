#!/bin/bash
# 查询 Prosper 群的企微聊天记录
curl -s -G "http://175.178.64.67:8181/query" \
  --data-urlencode "db=messages" \
  --data-urlencode "q=SELECT \"time\", \"session\", \"sender\", \"content\" FROM \"wework\" WHERE \"session\" =~ /Prosper/ ORDER BY time DESC LIMIT 200" \
  -H "Authorization: Token apiv3_DNm63XH1z6cvHKwiIYHlIvA8vHKw28PuqF7Rnr80WykNAcxafok6uSJbS2J1W5CHr9Vxf6uflvfPNVkEptRN5g" \
  -H "Accept: application/json" | python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('results', [{}])
series = results[0].get('series', [])
if not series:
    print('No data found')
    sys.exit(0)
columns = series[0]['columns']
values = series[0]['values']
# Print in chronological order
for row in reversed(values):
    record = dict(zip(columns, row))
    time_str = record.get('time', '')[:19].replace('T', ' ')
    session = record.get('session', '')
    sender = record.get('sender', '')
    content = record.get('content', '')
    print(f'[{time_str}] {sender}: {content}')
"
