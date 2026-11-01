import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/**
 * Prompt once per interactive CRM process. The terminal input is not echoed,
 * forwarded to logs, accepted via CLI flags, or written to a credential file.
 * The returned string is held only in the running process for authenticated API requests.
 */
export async function promptForCrmToken({ input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('A real interactive terminal (TTY) is required to enter the CRM token. Unattended CRM scans cannot run without a person present.');
  }

  // readline owns the terminal's raw-mode lifecycle; its normal echo writes to
  // this discarded stream instead of the visible terminal.
  const silentOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input, output: silentOutput, terminal: true, historySize: 0 });
  try {
    output.write('Enter CRM bearer token (input hidden): ');
    const token = (await reader.question('')).trim();
    output.write('\n');
    if (!token || /\s/.test(token)) {
      throw new Error('CRM bearer token must be nonempty and contain no whitespace.');
    }
    return token;
  } finally {
    reader.close();
  }
}
