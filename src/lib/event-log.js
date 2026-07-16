import fs from 'node:fs';
import path from 'node:path';

const logPath = process.env.EVENT_LOG
  ?? path.join(process.cwd(), 'sumup-bridge.log');

/**
 * Append a structured event line to the bridge logfile.
 * Types used: webhook, payment, poll
 *
 * @param {'webhook'|'payment'|'poll'} type
 * @param {Record<string, unknown>} data
 */
export function logEvent(type, data) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type,
    ...data,
  }) + '\n';

  try {
    fs.appendFileSync(logPath, line);
  } catch (err) {
    console.error(`[event-log] Failed to write ${logPath}: ${err.message}`);
  }
}

export function getEventLogPath() {
  return logPath;
}
