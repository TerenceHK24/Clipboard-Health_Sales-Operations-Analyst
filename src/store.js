import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const decode = row => row ? { ...JSON.parse(row.data), status: row.status, error: row.error,
  firstSeen: row.first_seen, lastSeen: row.last_seen } : null;

/** Durable local journal. Never keep this database inside npm's disposable cache. */
export class Store {
  constructor(directory, scope) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'review.sqlite');
    this.db = new DatabaseSync(this.path);
    try { chmodSync(directory, 0o700); chmodSync(this.path, 0o600); } catch { /* Windows ACLs are managed by the OS. */ }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, case_key TEXT NOT NULL, data TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY, proposal_id TEXT NOT NULL,
        decision TEXT NOT NULL, reviewer TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, step INTEGER NOT NULL,
        state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manual_matches(site_url TEXT PRIMARY KEY, account_id TEXT NOT NULL, reviewer TEXT NOT NULL, created_at TEXT NOT NULL);`);
    const existing = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('scope');
    if (existing && existing.value !== scope) { this.db.close(); throw new Error('This state directory belongs to a different API/site/token scope. Use a separate directory.'); }
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('scope', scope);
  }
  manualLinks() { return Object.fromEntries(this.db.prepare('SELECT site_url,account_id FROM manual_matches').all().map(row => [row.site_url, row.account_id])); }
  link(siteUrl, accountId, reviewer) {
    this.db.prepare('INSERT INTO manual_matches VALUES(?,?,?,?) ON CONFLICT(site_url) DO UPDATE SET account_id=excluded.account_id, reviewer=excluded.reviewer, created_at=excluded.created_at')
      .run(siteUrl, accountId, reviewer, now());
    this.recordRun('manual_match', { siteUrl, accountId, reviewer });
  }
  unlink(siteUrl, reviewer) {
    this.db.prepare('DELETE FROM manual_matches WHERE site_url=?').run(siteUrl);
    this.recordRun('manual_unmatch', { siteUrl, reviewer });
  }
  get(id) { return decode(this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id)); }
  list() { return this.db.prepare('SELECT * FROM proposals ORDER BY first_seen DESC, id').all().map(decode); }
  setStatus(id, status, error = null) { this.db.prepare('UPDATE proposals SET status=?,error=? WHERE id=?').run(status, error, id); }
  decision(id, decision, reviewer, note = '') {
    this.db.prepare('INSERT INTO decisions(proposal_id,decision,reviewer,note,at) VALUES(?,?,?,?,?)').run(id, decision, reviewer, note, now());
  }
  audit() { return this.db.prepare('SELECT * FROM decisions ORDER BY id DESC').all(); }
  operation(id) {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    return row ? { ...JSON.parse(row.data), state: row.state } : null;
  }
  saveOperation(id, proposalId, step, state, data) {
    this.db.prepare(`INSERT INTO operations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      state=excluded.state,data=excluded.data,updated_at=excluded.updated_at`)
      .run(id, proposalId, step, state, JSON.stringify(data), now());
  }
  operations(id) { return this.db.prepare('SELECT step,state,data,updated_at FROM operations WHERE proposal_id=? ORDER BY step').all(id)
    .map(row => ({ ...row, data: JSON.parse(row.data) })); }
  latest() {
    const row = this.db.prepare("SELECT * FROM runs WHERE status='complete' ORDER BY at DESC, rowid DESC LIMIT 1").get();
    return row ? { id: row.id, at: row.at, ...JSON.parse(row.data) } : null;
  }
  recordRun(status, data) { this.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run(randomUUID(), now(), status, JSON.stringify(data)); }
  publish(snapshot, result) {
    let added = 0, remembered = 0;
    const at = now(), active = new Set(result.proposals.map(p => p.id));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const old of this.list()) if (old.status === 'pending' && !active.has(old.id)) this.setStatus(old.id, 'superseded');
      for (const item of result.proposals) {
        const existing = this.get(item.id);
        if (existing) {
          this.db.prepare('UPDATE proposals SET last_seen=? WHERE id=?').run(at, item.id);
          if (existing.status === 'superseded') this.setStatus(item.id, 'pending');
          else if (existing.status !== 'pending') remembered++;
        } else {
          this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)')
            .run(item.id, item.key, JSON.stringify(item), 'pending', null, at, at);
          added++;
        }
      }
      this.recordRun('complete', { snapshot, result: { ...result, proposals: result.proposals.map(p => p.id) }, summary: {
        facilities: snapshot.website.locations.length, accounts: snapshot.accounts.length,
        added, remembered, pending: this.list().filter(p => p.status === 'pending').length } });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { added, remembered, pending: this.list().filter(p => p.status === 'pending').length };
  }
  async withLock(callback) {
    const owner = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lock = this.db.prepare('SELECT * FROM locks WHERE id=1').get();
      if (lock) {
        let alive = true;
        if (lock.host === hostname()) {
          try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        }
        if (alive) throw new Error('Another scan or review operation holds the local journal lock. Retry when it finishes.');
        this.db.prepare('DELETE FROM locks WHERE id=1').run();
      }
      this.db.prepare('INSERT INTO locks VALUES(1,?,?,?)').run(owner, process.pid, hostname());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try { return await callback(); }
    finally { this.db.prepare('DELETE FROM locks WHERE id=1 AND owner=?').run(owner); }
  }
  close() { this.db.close(); }
}
