/** Normalize supported synthetic tender date formats to YYYY-MM-DD. */
export function normalizeTenderDate(value: string): string | undefined {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const uk = /^(\d{2})([/-])(\d{2})\2(\d{4})$/.exec(trimmed);

  let year: number;
  let month: number;
  let day: number;

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (uk) {
    day = Number(uk[1]);
    month = Number(uk[3]);
    year = Number(uk[4]);
  } else {
    return undefined;
  }

  if (year < 1 || year > 9999) return undefined;

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Normalize harmless display spacing and hyphens while preserving identifier characters. */
export function normalizeMeterIdentifier(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}
