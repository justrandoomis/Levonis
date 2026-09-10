import qrcode from 'qrcode-generator';

export interface QrMatrix {
  size: number;
  get: (x: number, y: number) => boolean;
  isDark: (row: number, col: number) => boolean;
}

export function qrEncode(text: string): QrMatrix {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text || 'https://levonis-iq.com');
    qr.make();
    const size = qr.getModuleCount();
    return {
      size,
      get: (x: number, y: number) => qr.isDark(y, x),
      isDark: (row: number, col: number) => qr.isDark(row, col),
    };
  } catch {
    const qr = qrcode(4, 'L');
    qr.addData(text || 'https://levonis-iq.com');
    qr.make();
    const size = qr.getModuleCount();
    return {
      size,
      get: (x: number, y: number) => qr.isDark(y, x),
      isDark: (row: number, col: number) => qr.isDark(row, col),
    };
  }
}

export function qrToSvgPath(matrix: any, margin = 4): string {
  const size = matrix?.size || 21;
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dark =
        typeof matrix?.get === 'function'
          ? matrix.get(x, y)
          : typeof matrix?.isDark === 'function'
          ? matrix.isDark(y, x)
          : false;
      if (dark) {
        d += `M${x + margin},${y + margin}h1v1h-1z `;
      }
    }
  }
  return d.trim();
}
