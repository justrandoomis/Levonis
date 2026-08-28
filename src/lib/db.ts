export const initDb = async () => {
  const res = await fetch('/api/d1/init', { method: 'POST' });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
};

export const queryDb = async <T = any>(sql: string, params: any[] = []): Promise<T[]> => {
  const res = await fetch('/api/d1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.result as T[];
};
