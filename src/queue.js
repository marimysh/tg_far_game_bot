export const COLUMNS = [
  'id',
  'Дата',
  'Ник',
  'Тип',
  'Осталось дней',
  'Изначально',
  'Порог в днях',
  'Статус',
  'Время добавления',
  'Время обновления',
];

const NUMERIC = ['id', 'Изначально', 'Порог в днях', 'Осталось дней'];

function toNum(v) {
  // Google с USER_ENTERED форматирует >=1000 по локали листа ("4 444" с NBSP) —
  // вырезаем все пробелы (включая неразрывный) до парсинга.
  const n = Number(String(v ?? '').replace(/[\s ]/g, '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : 0;
}

export function formatDateDDMMYYYY(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function localISO(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const ao = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${p(Math.floor(ao / 60))}:${p(ao % 60)}`
  );
}

export function createQueue({ sheets, sheetName, typeThresholds }) {
  const rangeAll = `'${sheetName}'!A:J`;
  let colIndex = null;

  async function headerIndex() {
    if (colIndex) return colIndex;
    const header = (await sheets.values(`'${sheetName}'!A1:J1`))[0] ?? [];
    colIndex = {};
    header.forEach((name, i) => {
      if (name && colIndex[name] === undefined) colIndex[name] = i;
    });
    const missing = COLUMNS.filter((c) => colIndex[c] === undefined);
    if (missing.length) throw new Error(`Sheet header is missing columns: ${missing.join(', ')}`);
    return colIndex;
  }

  function rowToObject(cells, idx, rowNumber) {
    const row = { _row: rowNumber };
    for (const c of COLUMNS) row[c] = cells[idx[c]] ?? '';
    for (const k of NUMERIC) row[k] = toNum(row[k]);
    return row;
  }

  async function readQueue() {
    const idx = await headerIndex();
    const values = await sheets.values(rangeAll);
    return values
      .slice(1)
      .map((cells, i) => rowToObject(cells, idx, i + 2))
      .filter((r) => String(r['Ник']).trim() !== '' || String(r['id']).trim() !== '');
  }

  function actualRows(queue) {
    return queue
      .filter(
        (r) =>
          String(r['Ник']).trim() !== '' &&
          String(r['Дата']).trim() !== '' &&
          r['Статус'] === 'В очереди' &&
          Number(r['Осталось дней']) >= Number(r['Порог в днях']),
      )
      .sort((a, b) => Number(a['id']) - Number(b['id']));
  }

  function findByNickType(rows, nick, type) {
    return rows.find((r) => String(r['Ник']) === nick && String(r['Тип']) === type);
  }

  async function appendRequest({ nick, type, days, thresholds }) {
    const idx = await headerIndex();
    const now = new Date();
    const thr = thresholds ?? typeThresholds;
    const data = {
      id: '=ROW()',
      Дата: formatDateDDMMYYYY(now),
      Ник: nick,
      Тип: type,
      Статус: 'В очереди',
      Изначально: days,
      'Порог в днях': thr[type] ?? 1,
      'Осталось дней': days,
      'Время добавления': localISO(now),
      'Время обновления': localISO(now),
    };
    const width = Math.max(...Object.values(idx)) + 1;
    const row = Array(width).fill('');
    for (const [name, value] of Object.entries(data)) row[idx[name]] = value;
    await sheets.appendValues(rangeAll, [row]);
  }

  async function updateRow(row, patch) {
    const idx = await headerIndex();
    const range = `'${sheetName}'!A${row._row}:J${row._row}`;
    const current = (await sheets.values(range))[0] ?? [];
    const width = Math.max(...Object.values(idx)) + 1;
    const cells = Array.from({ length: width }, (_, i) => current[i] ?? '');
    for (const [name, value] of Object.entries(patch)) cells[idx[name]] = value;
    await sheets.updateValues(range, [cells]);
  }

  return { readQueue, actualRows, findByNickType, appendRequest, updateRow };
}
