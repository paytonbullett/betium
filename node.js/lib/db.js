'use strict';
/**
 * Tiny synchronous SQLite wrapper.
 * Uses Node's built-in `node:sqlite` (Node >= 22.13). If that is unavailable it
 * falls back to the optional `better-sqlite3` package (npm install better-sqlite3).
 * The on-disk file format is plain SQLite and is identical to the Python node's
 * betium_chain.db, so an existing chain database can be reused as-is.
 */

// Silence only the "SQLite is an experimental feature" notice.
const origEmitWarning = process.emitWarning;
process.emitWarning = function patched(warning, ...args) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/SQLite is an experimental feature/i.test(text)) return;
  return origEmitWarning.call(process, warning, ...args);
};

function loadDriver(file) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file);
  } catch (primaryErr) {
    try {
      const Better = require('better-sqlite3');
      return new Better(file);
    } catch {
      const err = new Error(
        'No SQLite driver available. Use Node.js >= 22.13 (built-in node:sqlite) ' +
        'or run: npm install better-sqlite3\n' + primaryErr.message,
      );
      err.code = 'NO_SQLITE';
      throw err;
    }
  }
}

class Db {
  constructor(file) {
    this.raw = loadDriver(file);
    this.cache = new Map();
    this.raw.exec('PRAGMA journal_mode=WAL;');
    this.raw.exec('PRAGMA busy_timeout=30000;');
  }

  _stmt(sql) {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.raw.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }

  static _args(params) {
    return params.map((p) => (p === undefined ? null : p));
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  run(sql, ...params) {
    return this._stmt(sql).run(...Db._args(params));
  }

  get(sql, ...params) {
    return this._stmt(sql).get(...Db._args(params));
  }

  all(sql, ...params) {
    return this._stmt(sql).all(...Db._args(params));
  }

  close() {
    try {
      this.raw.close();
    } catch {
      // already closed
    }
  }
}

module.exports = { Db };
