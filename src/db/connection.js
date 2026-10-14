import mysql from 'mysql2/promise';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../config/env.js';

let pool = null;
let sqliteDb = null;

class Database {
  constructor() {
    this.client = env.DB_CLIENT;
  }

  async init(customConfig = {}) {
    if (customConfig.client) this.client = customConfig.client;

    if (this.client === 'mysql') {
      if (!pool) {
        pool = mysql.createPool({
          host: customConfig.host || env.DB_HOST,
          port: customConfig.port || env.DB_PORT,
          user: customConfig.user || env.DB_USER,
          password: customConfig.password || env.DB_PASSWORD,
          database: customConfig.database || env.DB_NAME,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
          timezone: '+05:30'
        });
      }
    } else {
      if (!sqliteDb) {
        const dbPath = customConfig.sqlitePath || env.SQLITE_PATH || ':memory:';
        sqliteDb = new DatabaseSync(dbPath);
        // Enable foreign keys
        sqliteDb.exec('PRAGMA foreign_keys = ON;');
      }
    }
    return this;
  }

  async query(sql, params = []) {
    if (this.client === 'mysql') {
      const [rows] = await pool.query(sql, params);
      return rows;
    } else {
      const stmt = sqliteDb.prepare(sql);
      return stmt.all(...params);
    }
  }

  async queryOne(sql, params = []) {
    if (this.client === 'mysql') {
      const [rows] = await pool.query(sql, params);
      return rows.length > 0 ? rows[0] : null;
    } else {
      const stmt = sqliteDb.prepare(sql);
      const row = stmt.get(...params);
      return row || null;
    }
  }

  async execute(sql, params = []) {
    if (this.client === 'mysql') {
      const [result] = await pool.execute(sql, params);
      return {
        affectedRows: result.affectedRows,
        insertId: result.insertId
      };
    } else {
      const stmt = sqliteDb.prepare(sql);
      const result = stmt.run(...params);
      return {
        affectedRows: result.changes,
        insertId: result.lastInsertRowid
      };
    }
  }

  async execRaw(sql) {
    if (this.client === 'mysql') {
      const conn = await pool.getConnection();
      try {
        const statements = sql
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const statement of statements) {
          await conn.query(statement);
        }
      } finally {
        conn.release();
      }
    } else {
      sqliteDb.exec(sql);
    }
  }

  async transaction(callback) {
    if (this.client === 'mysql') {
      const conn = await pool.getConnection();
      await conn.beginTransaction();
      try {
        const trx = {
          query: async (sql, params = []) => {
            const [rows] = await conn.query(sql, params);
            return rows;
          },
          queryOne: async (sql, params = []) => {
            const [rows] = await conn.query(sql, params);
            return rows.length > 0 ? rows[0] : null;
          },
          execute: async (sql, params = []) => {
            const [result] = await conn.execute(sql, params);
            return {
              affectedRows: result.affectedRows,
              insertId: result.insertId
            };
          }
        };
        const result = await callback(trx);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } else {
      sqliteDb.exec('BEGIN TRANSACTION;');
      try {
        const trx = {
          query: async (sql, params = []) => {
            const stmt = sqliteDb.prepare(sql);
            return stmt.all(...params);
          },
          queryOne: async (sql, params = []) => {
            const stmt = sqliteDb.prepare(sql);
            const row = stmt.get(...params);
            return row || null;
          },
          execute: async (sql, params = []) => {
            const stmt = sqliteDb.prepare(sql);
            const res = stmt.run(...params);
            return {
              affectedRows: res.changes,
              insertId: res.lastInsertRowid
            };
          }
        };
        const result = await callback(trx);
        sqliteDb.exec('COMMIT;');
        return result;
      } catch (err) {
        sqliteDb.exec('ROLLBACK;');
        throw err;
      }
    }
  }

  async close() {
    if (this.client === 'mysql' && pool) {
      await pool.end();
      pool = null;
    } else if (sqliteDb) {
      sqliteDb.close();
      sqliteDb = null;
    }
  }
}

export const db = new Database();
