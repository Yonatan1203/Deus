import pino from 'pino';
import { createLogRing } from './log-ring.js';
import { isInteractiveTerminal } from './platform.js';

/** Newest info+ lines, served by the control UI's Logs tab. */
export const logRing = createLogRing(1000);

// Pretty, colorized output only for an interactive terminal. Under launchd
// (or any piped/redirected stdout) emit plain NDJSON so ANSI escape codes
// don't corrupt persisted log files (LIA-272).
const primary = isInteractiveTerminal()
  ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
  : pino.destination(1);

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.multistream([
    { level: 'trace', stream: primary },
    { level: 'trace', stream: logRing.stream },
  ]),
);

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
