/**
 * Structured logging. One JSON line per event in production, pretty-printed
 * key/value output in development. `requestId` is attached by the HTTP
 * middleware and forwarded to the AI service so a single user action can be
 * traced across both processes.
 */

import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

let root: Logger | null = null;

export function initLogger(level: string, production: boolean): Logger {
  root = pino({
    level,
    base: { service: 'orchestrator' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    ...(production ? {} : { transport: { target: 'pino/file', options: { destination: 1 } } }),
  });
  return root;
}

export function logger(): Logger {
  // Lazy fallback for code paths that run before main() (tests, scripts).
  if (!root) root = initLogger(process.env.LOG_LEVEL ?? 'info', false);
  return root;
}
