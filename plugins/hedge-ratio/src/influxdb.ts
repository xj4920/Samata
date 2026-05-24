const INFLUX_HOST = process.env.INFLUX_HOST ?? '175.178.64.67';
const INFLUX_PORT = process.env.INFLUX_PORT ?? '8181';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN ?? '';
const INFLUX_TIMEOUT = Number(process.env.INFLUX_TIMEOUT ?? '60') * 1000;

const BASE_URL = `http://${INFLUX_HOST}:${INFLUX_PORT}`;

export async function queryInfluxRaw(db: string, influxQL: string): Promise<Record<string, any>[]> {
  const url = `${BASE_URL}/query?db=${encodeURIComponent(db)}&q=${encodeURIComponent(influxQL)}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      ...(INFLUX_TOKEN ? { 'Authorization': `Token ${INFLUX_TOKEN}` } : {}),
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(INFLUX_TIMEOUT),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`InfluxDB query failed (${resp.status}): ${body}`);
  }

  const json = await resp.json() as {
    results: Array<{
      series?: Array<{ columns: string[]; values: any[][] }>;
      error?: string;
    }>;
  };

  const result = json.results?.[0];
  if (result?.error) throw new Error(`InfluxDB error: ${result.error}`);

  const series = result?.series?.[0];
  if (!series) return [];

  const { columns, values } = series;
  return values.map(row => {
    const record: Record<string, any> = {};
    columns.forEach((col, i) => { record[col] = row[i]; });
    return record;
  });
}

export async function writeInfluxLineProtocol(db: string, lines: string): Promise<void> {
  const url = `${BASE_URL}/write?db=${encodeURIComponent(db)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...(INFLUX_TOKEN ? { 'Authorization': `Token ${INFLUX_TOKEN}` } : {}),
      'Content-Type': 'text/plain',
    },
    body: lines,
    signal: AbortSignal.timeout(INFLUX_TIMEOUT),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`InfluxDB write failed (${resp.status}): ${body}`);
  }
}

export function isInfluxConfigured(): boolean {
  return !!INFLUX_TOKEN;
}
