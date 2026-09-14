export class MemoryMedia {
  objects = new Map<string, Uint8Array>();
  fail = false;
  async head(key: string) { const data = this.objects.get(key); return data ? { key, size: data.length } : null; }
  async get(key: string) {
    const data = this.objects.get(key);
    return data ? { key, size: data.length, httpMetadata: { contentType: 'image/webp' }, arrayBuffer: async () => data.slice().buffer } : null;
  }
  async put(key: string, data: Uint8Array) { this.objects.set(key, new Uint8Array(data)); }
  async delete(key: string) { if (this.fail) throw new Error('R2 temporarily unavailable'); this.objects.delete(key); }
  async list({ prefix = '', cursor = '0', limit = 1000 } = {}) {
    const all = [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key,data]) => ({ key, size: data.length }));
    const start = Number(cursor);
    return { objects: all.slice(start, start + limit), truncated: start + limit < all.length, cursor: String(start + limit) };
  }
}

export function parityMediaEnv() {
  const media = new MemoryMedia();
  for (const key of ['products/front.jpg', 'products/a1-front.jpg', 'products/one.jpg', 'products/two.jpg', 'products/a.jpg', 'products/x.jpg']) media.objects.set(key, new Uint8Array([1, 2, 3, 4]));
  return { BUCKET: media };
}
