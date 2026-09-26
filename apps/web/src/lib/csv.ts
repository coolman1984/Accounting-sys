/** Download rows as a UTF-8 CSV (with BOM so Excel opens Arabic correctly). */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]): void {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : filename + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Minor units → plain decimal string for spreadsheets. */
export function csvMoney(v: number, scale: number): string {
  const neg = v < 0;
  const abs = String(Math.abs(v)).padStart(scale + 1, '0');
  const s = scale ? `${abs.slice(0, -scale)}.${abs.slice(-scale)}` : abs;
  return neg ? '-' + s : s;
}
