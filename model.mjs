export const periods = ['早上', '白天', '晚上'];
export const slots = ['am', 'pm'];
export const legacyKey = 'pet-shuttle.records.v1';
const dateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' });
export const today = () => dateFormatter.format(new Date());

export function nextWeek(date = today()) {
  const start = new Date(date + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() + 7 - ((start.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, offset) =>
    new Date(+start + offset * 86400000).toISOString().slice(0, 10));
}

export function validate(row) {
  const { id, date, period, fee, dogs, note } = row ?? {};
  const raw = typeof row?.time === 'string' ? row.time.trim() : '';
  const time = /^\d{4}$/.test(raw) ? raw.slice(0, 2) + ':' + raw.slice(2) : raw;
  const parsed = new Date(date);
  if (typeof id !== 'string' || !id || !/^[\w.-]{1,120}$/.test(id) ||
      id === '.' || id === '..' || /^__.*__$/.test(id) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+parsed) ||
      parsed.toISOString().slice(0, 10) !== date ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || !periods.includes(period) ||
      !Number.isSafeInteger(fee) || fee < 0 ||
      (dogs !== undefined && (!Number.isSafeInteger(dogs) || dogs < 1)) || typeof note !== 'string' ||
      new TextEncoder().encode(note).length > 500000) {
    throw new Error('備份或表單含有無效的紀錄。請檢查日期、時間、金額、狗狗數及備註。');
  }
  return { id, date, time, period, fee, ...(dogs === undefined ? {} : { dogs }), note };
}

export function readBackup(text) {
  const backup = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (backup?.version !== 1 || !Array.isArray(backup.records)) {
    throw new Error('請選擇毛孩接送 JSON 備份。');
  }
  return deduplicate(backup.records);
}

export function deduplicate(records) {
  const unique = new Map();
  for (const input of records) {
    const row = validate(input);
    const previous = unique.get(row.id);
    if (previous && !sameRecord(previous, row)) throw new Error('同一 ID 有不同內容：' + row.id);
    unique.set(row.id, row);
  }
  return [...unique.values()];
}

export function sameRecord(a, b) {
  return JSON.stringify(validate(a)) === JSON.stringify(validate(b));
}

export function totals(rows) {
  return rows.reduce((sum, row) => ({
    trips: sum.trips + 1, dogs: sum.dogs + (row.dogs ?? 0), fee: sum.fee + row.fee
  }), { trips: 0, dogs: 0, fee: 0 });
}

export function csvCell(value) {
  let text = String(value);
  if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
