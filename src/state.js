import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export class StateStore {
  constructor(file, { ttlMs = 24 * 3600 * 1000 } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.states = new Map();
    this.dirty = false;
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        for (const [k, v] of Object.entries(raw)) this.states.set(k, v);
      } catch {
        this.states = new Map();
      }
    }
    this.timer = setInterval(() => this.flush(), 2000);
    this.timer.unref?.();
  }

  key(chatId, threadId) {
    return `${chatId}_${threadId ?? 'none'}`;
  }

  get(chatId, threadId) {
    const k = this.key(chatId, threadId);
    const rec = this.states.get(k);
    if (!rec) return { state: 'expect_command', data: {} };
    if (Date.now() - rec.updatedAt > this.ttlMs) {
      this.states.delete(k);
      return { state: 'expect_command', data: {} };
    }
    return { state: rec.state, data: rec.data ?? {} };
  }

  set(chatId, threadId, state, data = {}) {
    this.states.set(this.key(chatId, threadId), { state, data, updatedAt: Date.now() });
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.states), null, 2));
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  close() {
    clearInterval(this.timer);
    this.flush();
  }
}
