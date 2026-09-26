import { resolve } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  backupDir: string;
  /** Directory with the built web app (served as static files). */
  webDir: string | null;
  /** Session lifetime in hours. */
  sessionHours: number;
  logLevel: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = resolve(process.env.MIZAN_DATA_DIR ?? overrides.dataDir ?? resolve(process.cwd(), 'data'));
  return {
    host: process.env.MIZAN_HOST ?? '0.0.0.0',
    port: Number(process.env.MIZAN_PORT ?? 4800),
    dataDir,
    dbFile: process.env.MIZAN_DB ?? resolve(dataDir, 'mizan.db'),
    backupDir: resolve(dataDir, 'backups'),
    webDir: process.env.MIZAN_WEB_DIR ?? null,
    sessionHours: Number(process.env.MIZAN_SESSION_HOURS ?? 12),
    logLevel: process.env.MIZAN_LOG_LEVEL ?? 'info',
    ...overrides,
  };
}
