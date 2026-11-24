// CSV für Excel: Semikolon als Trenner (deutsches Excel) und BOM, damit Umlaute stimmen.
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): Buffer {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keine Formeln in Excel ausführen
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header, ...rows].map((r) => r.map(cell).join(';'));
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

export const profileUrl = (username: string) => `https://www.instagram.com/${username}/`;
