

  curl -s -G 'http://175.178.64.67:8181/query' \
  --data-urlencode 'db=messages' \
  --data-urlencode 'q=SHOW TAG VALUES FROM "wework" WITH KEY = "session"' \
  -H "Authorization: Token apiv3_DNm63XH1z6cvHKwiIYHlIvA8vHKw28PuqF7Rnr80WykNAcxafok6uSJbS2J1W5CHr9Vxf6uflvfPNVkEptRN5g" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2, ensure_ascii=False))"



  curl -s -G 'http://175.178.64.67:8181/query' \
  --data-urlencode 'db=messages' \
  --data-urlencode 'q=SHOW TAG KEYS FROM "wework"' \
  -H "Authorization: Token apiv3_DNm63XH1z6cvHKwiIYHlIvA8vHKw28PuqF7Rnr80WykNAcxafok6uSJbS2J1W5CHr9Vxf6uflvfPNVkEptRN5g" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2, ensure_ascii=False))"

  curl -s -G 'http://175.178.64.67:8181/query' \
  --data-urlencode 'db=messages' \
  --data-urlencode 'q=SHOW TAG VALUES FROM "wework" WITH KEY = "sender"' \
  -H "Authorization: Token apiv3_DNm63XH1z6cvHKwiIYHlIvA8vHKw28PuqF7Rnr80WykNAcxafok6uSJbS2J1W5CHr9Vxf6uflvfPNVkEptRN5g" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2, ensure_ascii=False))"


"q=SELECT * FROM \"wework\" WHERE time > '2026-03-04T12:00:00Z' AND (\"sender\" = '肖诗泉' OR \"sender\" = '栾宜男' OR \"sender\" = '栾宜男(休假)' OR \"sender\" = '郁泱' OR \"sender\" = '郁泱(休假)' OR \"sender\" = '蠕蠕（郁泱）' OR \"sender\" = '符航睿' OR \"sender\" = '尹成功' OR \"sender\" = 'YIN CHENGGONG' OR \"sender\" = '一米阳光' OR \"sender\" = '赵晴宇' OR \"sender\" = '赵晴宇swag~' OR \"sender\" = '闫亚会') ORDER BY time DESC LIMIT 20" 