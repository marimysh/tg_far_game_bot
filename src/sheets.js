const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export class SheetsClient {
  constructor({ clientId, clientSecret, refreshToken }, spreadsheetId) {
    this.auth = { clientId, clientSecret, refreshToken };
    this.spreadsheetId = spreadsheetId;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.auth.clientId,
        client_secret: this.auth.clientSecret,
        refresh_token: this.auth.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Google token refresh failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    }
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async api(path, { method = 'GET', query = {}, body } = {}) {
    const qs = new URLSearchParams(query).toString();
    const url = `${SHEETS_API}/${this.spreadsheetId}${path}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Sheets API ${method} ${path} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data;
  }

  async values(range, query = {}) {
    const path = `/values/${encodeURIComponent(range)}`;
    const data = await this.api(path, { query });
    return data.values ?? [];
  }

  async updateValues(range, values) {
    const path = `/values/${encodeURIComponent(range)}`;
    return this.api(path, {
      method: 'PUT',
      query: { valueInputOption: 'USER_ENTERED' },
      body: { range, majorDimension: 'ROWS', values },
    });
  }

  async appendValues(range, values) {
    const path = `/values/${encodeURIComponent(range)}:append`;
    return this.api(path, {
      method: 'POST',
      query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
      body: { range, majorDimension: 'ROWS', values },
    });
  }
}
