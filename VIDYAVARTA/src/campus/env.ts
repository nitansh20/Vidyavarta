import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Loads ./.env once at startup (KEY=VALUE lines) using Node's built-in parser
 * when available, with a small fallback parser otherwise.
 * Real environment variables always win - the file never overrides them.
 */
let loaded = false;
export interface EnvLoadReport { loaded: boolean; path: string; keys: string[] }
export function envReport(): EnvLoadReport { return envLoadReportValue; }
let envLoadReportValue: EnvLoadReport = { loaded: false, path: '', keys: [] };
export function loadLocalEnv(directory: string = process.cwd()): EnvLoadReport {
  if (loaded) return envLoadReportValue;
  loaded = true;
  const path = join(directory, '.env');
  if (!existsSync(path)) { envLoadReportValue = { loaded: false, path, keys: [] }; return envLoadReportValue; }
  const names: string[] = [];
  try {
    if (typeof (process as { loadEnvFile?: (p?: string) => void }).loadEnvFile === 'function') {
      try {
        (process as { loadEnvFile: (p?: string) => void }).loadEnvFile(path);
        const names: string[] = [];
        for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
          const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
          if (m) names.push(m[1]);
        }
        envLoadReportValue = { loaded: true, path, keys: names };
        return envLoadReportValue;
      } catch { /* malformed line: fall through to the forgiving parser */ }
    }
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1);
      if (!(match[1] in process.env)) process.env[match[1]] = value;
      names.push(match[1]);
    }
    envLoadReportValue = { loaded: true, path, keys: names };
  } catch (e) { console.warn('[campus] Could not read .env:', (e as Error).message); }
  return envLoadReportValue;
}
