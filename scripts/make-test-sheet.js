import { SheetsClient } from '../src/sheets.js';

const [,, sourceSpreadsheetId, title = 'FAR Помощь (тест far-bot)'] = process.argv;

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
if (!sourceSpreadsheetId || !clientId || !clientSecret || !refreshToken) {
  console.error('usage: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... node scripts/make-test-sheet.js <sourceSpreadsheetId> [title]');
  process.exit(1);
}

const sheets = new SheetsClient({ clientId, clientSecret, refreshToken }, sourceSpreadsheetId);
const SHEET = 'Полный список';

const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
  method: 'POST',
  headers: { authorization: `Bearer ${await sheets.token()}`, 'content-type': 'application/json' },
  body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: SHEET } }] }),
});
const created = await res.json();
if (!res.ok) throw new Error(`create spreadsheet failed: HTTP ${res.status} ${JSON.stringify(created).slice(0, 300)}`);
const targetId = created.spreadsheetId;

const values = await sheets.values(`'${SHEET}'!A1:J1000`);
await fetch(
  `https://sheets.googleapis.com/v4/spreadsheets/${targetId}/values/${encodeURIComponent(`'${SHEET}'!A1`)}?valueInputOption=RAW`,
  {
    method: 'PUT',
    headers: { authorization: `Bearer ${await sheets.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ range: `'${SHEET}'!A1`, majorDimension: 'ROWS', values }),
  },
).then((r) => {
  if (!r.ok) throw new Error(`copy values failed: HTTP ${r.status}`);
});

console.log(JSON.stringify({ spreadsheetId: targetId, url: created.spreadsheetUrl, rowsCopied: values.length - 1 }));
