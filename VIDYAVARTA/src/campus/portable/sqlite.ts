// Native-module-free SQLite adapter for the ready-to-run Node 24 distribution.
// The developer source still uses the better-sqlite3 binding; the ready package uses Node's built-in SQLite.
import { DatabaseSync } from 'node:sqlite';
export default class PortableDatabase {
  private readonly connection: DatabaseSync;
  constructor(path:string) { this.connection=new DatabaseSync(path); }
  pragma(sql:string) { this.connection.exec(`PRAGMA ${sql}`); }
  exec(sql:string) { this.connection.exec(sql); }
  prepare(sql:string) { return this.connection.prepare(sql); }
  transaction<T extends (...args:any[])=>any>(fn:T):T {
    return ((...args:Parameters<T>)=>{
      this.connection.exec('BEGIN IMMEDIATE');
      try { const result=fn(...args);this.connection.exec('COMMIT');return result; }
      catch(e) { this.connection.exec('ROLLBACK');throw e; }
    }) as T;
  }
  close() { this.connection.close(); }
}
