#!/usr/bin/env node
/**
 * @file cli.js
 * Interactive CLI for testing the SumUp Cloud API in sandbox mode.
 *
 * Usage:
 *   node src/cli.js
 *   npm start
 */
import { select, input, confirm, number } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import http from 'node:http';
import readline from 'node:readline';
import {
  listReaders,
  getReader,
  getReaderStatus,
  createCheckout,
  terminateCheckout,
  merchantCode,
  getTransaction,
} from './lib/index.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const READER_STATUS_COLOR = {
  paired:      chalk.green,
  processing:  chalk.yellow,
  expired:     chalk.red,
  unknown:     chalk.gray,
};

const DEVICE_STATUS_COLOR = {
  ONLINE:  chalk.green,
  OFFLINE: chalk.red,
};

const TX_STATUS_COLOR = {
  // TX API (uppercase)
  SUCCESSFUL: chalk.bold.green,
  FAILED:     chalk.bold.red,
  CANCELLED:  chalk.bold.yellow,
  PENDING:    chalk.bold.blue,
  REFUNDED:   chalk.bold.magenta,
  // webhook payload (lowercase)
  successful: chalk.bold.green,
  failed:     chalk.bold.red,
  cancelled:  chalk.bold.yellow,
  pending:    chalk.bold.blue,
};

/**
 * Normalise a result from either source into a flat display object.
 * Webhook envelope: { event_type, payload: { status, client_transaction_id, ... }, timestamp }
 * TX API:           { id, status, amount, currency, transaction_code, ... }
 * @param {{ source: string, data: Record<string, unknown> }} result
 */
function printResult({ source, data }) {
  // Unwrap webhook envelope if needed
  const isWebhook = !!data.event_type;
  const inner     = isWebhook ? /** @type {any} */ (data.payload) : data;
  const status    = inner?.status ?? data.status ?? '—';
  const statusFn  = TX_STATUS_COLOR[status] ?? chalk.white;

  console.log('');
  console.log(chalk.bold('  ─────────────────────────────────────'));
  console.log(`${chalk.bold('  💳 Payment Result')}  ${chalk.gray(`[via ${source}]`)}`);
  console.log(chalk.bold('  ─────────────────────────────────────'));
  console.log(`  Status          : ${statusFn(status)}`);

  if (!isWebhook) {
    // Full TX API response
    const tx = /** @type {any} */ (data);
    if (tx.id)                    console.log(`  TX ID           : ${chalk.cyan(tx.id)}`);
    if (tx.transaction_code)      console.log(`  TX Code         : ${chalk.cyan(tx.transaction_code)}`);
    if (tx.client_transaction_id) console.log(`  Client TX ID    : ${chalk.cyan(tx.client_transaction_id)}`);
    if (tx.amount != null)        console.log(`  Amount          : ${chalk.green(`${tx.currency} ${tx.amount}`)}`);
    if (tx.tip_amount)            console.log(`  Tip             : ${chalk.green(`${tx.currency} ${tx.tip_amount}`)}`);
    if (tx.payment_type)          console.log(`  Payment Type    : ${tx.payment_type}`);
    if (tx.entry_mode)            console.log(`  Entry Mode      : ${tx.entry_mode}`);
    if (tx.card?.last_4_digits)   console.log(`  Card            : **** **** **** ${tx.card.last_4_digits}`);
    if (tx.card?.type)            console.log(`  Card Type       : ${tx.card.type}`);
    if (tx.auth_code)             console.log(`  Auth Code       : ${tx.auth_code}`);
    if (tx.timestamp)             console.log(`  Time            : ${tx.timestamp}`);
    if (tx.simple_status)         console.log(`  Simple Status   : ${tx.simple_status}`);
  } else {
    // Webhook envelope — less detail, but fast
    const p = /** @type {any} */ (inner);
    if (p?.client_transaction_id) console.log(`  Client TX ID    : ${chalk.cyan(p.client_transaction_id)}`);
    if (p?.transaction_id)        console.log(`  TX ID           : ${chalk.cyan(p.transaction_id)}`);
    if (data.timestamp)           console.log(`  Time            : ${data.timestamp}`);
    console.log(chalk.gray('  (Full details available via TX API poll)'));
  }

  console.log(chalk.bold('  ─────────────────────────────────────'));
  console.log('');
}

const pendingWebhooks = new Map();
let globalWebhookServer = null;

function startWebhookServer() {
  if (globalWebhookServer) return;
  const port = parseInt(process.env.WEBHOOK_PORT ?? '58180', 10);
  globalWebhookServer = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
      let data;
      try { data = JSON.parse(body); } catch { data = { raw: body }; }
      
      const ctid = data?.payload?.client_transaction_id;
      if (ctid && pendingWebhooks.has(ctid)) {
        const resolve = pendingWebhooks.get(ctid);
        resolve({ source: 'webhook', data });
      }
    });
  });
  globalWebhookServer.listen(port, '127.0.0.1', () => {});
  // Unref the server so it doesn't keep the Node event loop alive if everything else exits
  globalWebhookServer.unref();
}

/**
 * Wait for the global webhook server to receive a POST for this clientTransactionId.
 * Resolves with { source: 'webhook', data: <parsed body> }
 *
 * @param {string} clientTxId
 * @param {() => string} elapsed  Returns current elapsed time string for logging
 * @param {AbortSignal} [signal]  Signal to abort listening if the race is won elsewhere
 * @param {number} timeoutMs
 * @returns {Promise<{ source: string, data: Record<string, unknown> }>}
 */
function waitForWebhook(clientTxId, elapsed, signal, timeoutMs = 5 * 60 * 1000) {
  startWebhookServer();

  return new Promise((resolve, reject) => {
    pendingWebhooks.set(clientTxId, (result) => {
      pendingWebhooks.delete(clientTxId);
      clearTimeout(timer);
      console.log(`  ${chalk.gray(elapsed())}  ${chalk.magenta('webhook')}  →  ${chalk.bold('received')}`);
      resolve(result);
    });

    const timer = setTimeout(() => {
      pendingWebhooks.delete(clientTxId);
      reject(new Error('Timed out waiting for webhook'));
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        pendingWebhooks.delete(clientTxId);
        clearTimeout(timer);
      });
    }
  });
}

/**
 * Poll the Transactions API every 10 seconds until a terminal status is reached.
 * Resolves with { source: 'poll', data: <tx object> }
 *
 * @param {string} clientTransactionId
 * @param {(attempt: number, status: string) => void} onAttempt  Called on every poll with attempt number and status
 * @param {AbortSignal} [signal]  Signal to abort polling if the race is won elsewhere
 * @param {number} timeoutMs
 * @returns {Promise<{ source: string, data: Record<string, unknown> }>}
 */
function pollTransaction(clientTransactionId, onAttempt, signal, timeoutMs = 5 * 60 * 1000) {
  const TERMINAL = new Set(['SUCCESSFUL', 'FAILED', 'CANCELLED', 'REFUNDED']);
  let forcePoll;
  const promise = new Promise((resolve, reject) => {
    let interval;
    let attempt = 0;
    const attemptFetch = async () => {
      attempt++;
      try {
        const tx = await getTransaction({ clientTransactionId });
        if (aborted) return; // Prevent logging if aborted while the request was in-flight
        
        const status = String(tx?.status ?? 'unknown');
        onAttempt(attempt, status);
        if (TERMINAL.has(status.toUpperCase())) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve({ source: 'poll', data: tx });
        }
      } catch (err) {
        if (aborted) return; // Prevent error logging if aborted in-flight
        onAttempt(attempt, `error: ${err.message}`);
      }
    };

    let aborted = false;

    interval = setInterval(attemptFetch, 10_000);
    forcePoll = () => {
      if (aborted) return;
      clearInterval(interval);
      attemptFetch();
      interval = setInterval(attemptFetch, 10_000);
    };

    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('Polling timed out'));
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        aborted = true;
        clearInterval(interval);
        clearTimeout(timer);
      });
    }
  });

  // Attach the manual trigger to the promise
  // @ts-ignore
  promise.force = forcePoll;
  return promise;
}

/** Pretty-print a reader object */
function printReader(reader) {
  const statusFn = READER_STATUS_COLOR[reader.status] ?? chalk.white;
  console.log('');
  console.log(chalk.bold(`  📟 ${reader.name}`));
  console.log(`     ID      : ${chalk.cyan(reader.id)}`);
  console.log(`     Status  : ${statusFn(reader.status)}`);
  console.log(`     Model   : ${reader.device?.model ?? '—'}`);
  console.log(`     Device  : ${reader.device?.identifier ?? '—'}`);
  console.log(`     Created : ${reader.created_at}`);
}

/** Pretty-print reader status */
function printStatus(readerId, status) {
  const deviceFn = DEVICE_STATUS_COLOR[status.status] ?? chalk.white;
  console.log('');
  console.log(chalk.bold(`  📡 Reader Status — ${chalk.cyan(readerId)}`));
  console.log(`     Online      : ${deviceFn(status.status)}`);
  if (status.state)               console.log(`     State       : ${chalk.yellow(status.state)}`);
  if (status.battery_level != null) console.log(`     Battery     : ${status.battery_level}% (${status.battery_temperature ?? '?'}°C)`);
  if (status.connection_type)     console.log(`     Connection  : ${status.connection_type}`);
  if (status.firmware_version)    console.log(`     Firmware    : ${status.firmware_version}`);
  if (status.last_activity)       console.log(`     Last Active : ${status.last_activity}`);
}

// ---------------------------------------------------------------------------
// Sub-menus
// ---------------------------------------------------------------------------

/** Pick a paired reader interactively, returns reader object */
async function pickReader(label = 'Select a reader') {
  const spinner = ora('Fetching readers…').start();
  let readers;
  try {
    readers = await listReaders();
    spinner.succeed(`${readers.length} reader(s) found`);
  } catch (err) {
    spinner.fail(err.message);
    return null;
  }

  if (readers.length === 0) {
    console.log(chalk.yellow('\n  No readers paired to this account yet.'));
    console.log(chalk.gray('  Use the Virtual Solo at https://virtual-solo.sumup.com to pair one.\n'));
    return null;
  }

  const readerId = await select({
    message: label,
    choices: readers.map((r) => ({
      name: `${r.name}  ${chalk.gray(`(${r.status})`)}  ${chalk.cyan(r.id)}`,
      value: r.id,
    })),
  });

  return readers.find((r) => r.id === readerId) ?? null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function actionListReaders() {
  const spinner = ora('Fetching readers…').start();
  try {
    const readers = await listReaders();
    spinner.succeed(`${readers.length} reader(s) on merchant ${chalk.cyan(merchantCode)}`);
    if (readers.length === 0) {
      console.log(chalk.yellow('\n  No readers paired yet.'));
      console.log(chalk.gray('  Pair one at https://virtual-solo.sumup.com\n'));
    } else {
      readers.forEach(printReader);
      console.log('');
    }
  } catch (err) {
    spinner.fail(chalk.red(err.message));
  }
}

async function actionGetReader() {
  const reader = await pickReader('Which reader would you like to inspect?');
  if (!reader) return;

  const spinner = ora('Fetching reader details…').start();
  try {
    const detail = await getReader(reader.id);
    spinner.succeed('Reader details');
    printReader(detail);
    if (detail.metadata && Object.keys(detail.metadata).length > 0) {
      console.log(`     Metadata : ${JSON.stringify(detail.metadata)}`);
    }
    console.log('');
  } catch (err) {
    spinner.fail(chalk.red(err.message));
  }
}

async function actionGetStatus() {
  const reader = await pickReader('Which reader status would you like to check?');
  if (!reader) return;

  const spinner = ora('Fetching reader status…').start();
  try {
    const status = await getReaderStatus(reader.id);
    spinner.succeed('Reader status');
    printStatus(reader.id, status);
    console.log('');
  } catch (err) {
    spinner.fail(chalk.red(err.message));
  }
}

async function actionCreateCheckout() {
  const reader = await pickReader('Which reader should process the payment?');
  if (!reader) return;

  if (reader.status !== 'paired') {
    console.log(chalk.red(`\n  Reader is not paired (status: ${reader.status})\n`));
    return;
  }

  const webhookUrl = process.env.WEBHOOK_URL ?? '';

  // Collect checkout parameters
  const amountInput = parseFloat(await input({
    message: 'Amount (e.g. 10.50 for €10.50):',
    default: '1.00',
    validate: (v) => {
      const n = parseFloat(v);
      if (isNaN(n) || n <= 0) return 'Enter a positive number (e.g. 4.20)';
      return true;
    },
  }));

  const currency = await input({
    message: 'Currency (ISO 4217):',
    default: 'EUR',
    validate: (v) => (/^[A-Z]{3}$/.test(v) ? true : 'Enter a valid 3-letter currency code'),
  });

  const description = await input({
    message: 'Description (optional, press Enter to skip):',
  });

  const useTips = await confirm({ message: 'Enable tipping?', default: false });
  let tipRates;
  let tipTimeout;
  if (useTips) {
    const ratesRaw = await input({
      message: 'Tip rates as whole-number percentages (e.g. 10,15,20 for 10%, 15%, 20%):',
      default: '10,15,20',
      validate: (v) => {
        const rates = v.split(',').map((r) => parseFloat(r.trim()));
        if (rates.some(isNaN)) return 'All values must be numbers';
        if (rates.some((r) => r < 1 || r > 99)) return 'Each rate must be between 1 and 99 (percent)';
        return true;
      },
    });
    tipRates = ratesRaw.split(',').map((r) => parseFloat(r.trim()) / 100);
    tipTimeout = await number({ message: 'Tip selection timeout (30–120s):', default: 30 });
  }

  const minorUnit = 2;
  const value = Math.round(amountInput * Math.pow(10, minorUnit));

  console.log('');
  console.log(chalk.bold('  Checkout summary:'));
  console.log(`    Reader      : ${chalk.cyan(reader.name)} (${reader.id})`);
  console.log(`    Amount      : ${chalk.green(`${currency} ${amountInput.toFixed(minorUnit)}`)}`);
  if (description) console.log(`    Description : ${description}`);
  if (webhookUrl)  console.log(`    Webhook     : ${chalk.gray(webhookUrl)}`);
  console.log('');

  const confirmed = await confirm({ message: 'Send checkout to reader?', default: true });
  if (!confirmed) {
    console.log(chalk.gray('\n  Checkout cancelled.\n'));
    return;
  }

  const spinner = ora(`Sending checkout to ${chalk.cyan(reader.name)}…`).start();
  let clientTxId;
  try {
    const result = await createCheckout(reader.id, {
      value,
      currency,
      minorUnit,
      ...(description  && { description }),
      ...(webhookUrl   && { returnUrl: webhookUrl }),
      ...(tipRates     && { tipRates, tipTimeout }),
    });
    clientTxId = result.client_transaction_id;
    spinner.succeed(chalk.green('Checkout accepted — waiting for customer…'));
    console.log(`  Transaction ID : ${chalk.cyan(clientTxId)}`);
  } catch (err) {
    spinner.fail(chalk.red(err.message));
    return;
  }
  if (!webhookUrl && !clientTxId) {
    console.log(chalk.gray('  (No WEBHOOK_URL set and no TX ID — result unavailable)\n'));
    return;
  }

  // Capture start time for relative timestamps
  const startedAt = Date.now();
  const elapsed = () => {
    const s = Math.round((Date.now() - startedAt) / 1000);
    return `+${String(s).padStart(3, ' ')}s`;
  };

  // Start webhook listener BEFORE the race block so we don't miss a fast response
  const abortController = new AbortController();
  const webhookPromise = webhookUrl ? waitForWebhook(clientTxId, elapsed, abortController.signal) : null;

  // Race: webhook vs TX API polling every 10s
  // Each source prints a new line on every event — no spinner, full history visible
  const pollPromise = pollTransaction(clientTxId, (attempt, status) => {
    const statusFn = TX_STATUS_COLOR[status.toUpperCase()] ?? chalk.gray;
    console.log(`  ${chalk.gray(elapsed())}  ${chalk.blue(`poll #${attempt}`)}  →  ${statusFn(status)}`);
  }, abortController.signal);

  const raceable = [pollPromise];
  if (webhookPromise) raceable.push(webhookPromise);

  console.log(chalk.gray(`  ${''.padStart(5)}  Sources: TX API poll (every 10s)${webhookUrl ? ' + webhook' : ''}`));
  console.log(chalk.gray(`  ${''.padStart(5)}  Press ${chalk.white('t')} to terminate the checkout early.`));

  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const onKeypress = async (str, key) => {
    if (key.ctrl && key.name === 'c') {
      process.exit(0);
    }
    if (key.name === 't') {
      console.log(`  ${chalk.gray(elapsed())}  ${chalk.yellow('terminating checkout…')}`);
      try {
        await terminateCheckout(reader.id);
        console.log(`  ${chalk.gray(elapsed())}  ${chalk.green('termination signal sent')}`);
        // @ts-ignore
        setTimeout(() => pollPromise.force(), 1000);
      } catch (err) {
        console.log(`  ${chalk.gray(elapsed())}  ${chalk.red(`termination failed: ${err.message}`)}`);
      }
    }
  };
  process.stdin.on('keypress', onKeypress);

  const cleanupKeypress = () => {
    process.stdin.off('keypress', onKeypress);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  try {
    let winner = await Promise.race(raceable);
    cleanupKeypress();
    abortController.abort(); // Cancel the loser

    // Webhook arrived first — enrich with full TX details from the API
    if (winner.source === 'webhook') {
      const webhookPayload = /** @type {any} */ (winner.data);
      const ctid = webhookPayload?.payload?.client_transaction_id ?? clientTxId;
      try {
        const tx = await getTransaction({ clientTransactionId: ctid });
        winner = { source: 'webhook', data: tx }; // preserve original source for the UI
      } catch {
        // TX lookup failed — fall back to webhook envelope display
      }
    }

    printResult(winner);
  } catch (err) {
    cleanupKeypress();
    abortController.abort();
    process.stdout.write('\r\x1b[K');
    console.log(chalk.yellow(`\n  ⚠  ${err.message}\n`));
  }
}

async function actionTerminate() {
  const reader = await pickReader('Which reader checkout should be terminated?');
  if (!reader) return;

  console.log('');
  console.log(chalk.yellow('  ⚠️  This will cancel the current transaction on the reader.'));
  console.log(chalk.gray('     Only works if the reader is waiting for cardholder action.\n'));

  const confirmed = await confirm({ message: 'Terminate checkout?', default: false });
  if (!confirmed) {
    console.log(chalk.gray('\n  Termination cancelled.\n'));
    return;
  }

  const spinner = ora(`Terminating checkout on ${chalk.cyan(reader.name)}…`).start();
  try {
    await terminateCheckout(reader.id);
    spinner.succeed(chalk.green('Termination request sent.'));
    console.log(chalk.gray('  The checkout will stop shortly (asynchronous).\n'));
  } catch (err) {
    spinner.fail(chalk.red(err.message));
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log(chalk.bold.blue('  ╔══════════════════════════════════╗'));
  console.log(chalk.bold.blue('  ║   SumUp Cloud API Test CLI 🚀    ║'));
  console.log(chalk.bold.blue('  ╚══════════════════════════════════╝'));
  console.log(chalk.gray(`  Merchant : ${merchantCode}`));
  console.log('');

  while (true) {
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: '📋  List Readers',        value: 'list' },
        { name: '🔍  Get Reader Details',  value: 'get' },
        { name: '📡  Get Reader Status',   value: 'status' },
        { name: '💳  Create Checkout',     value: 'checkout' },
        { name: '✋  Terminate Checkout',  value: 'terminate' },
        { name: '🚪  Exit',               value: 'exit' },
      ],
    });

    console.log('');

    switch (action) {
      case 'list':      await actionListReaders();   break;
      case 'get':       await actionGetReader();     break;
      case 'status':    await actionGetStatus();     break;
      case 'checkout':  await actionCreateCheckout(); break;
      case 'terminate': await actionTerminate();     break;
      case 'exit':
        console.log(chalk.bold.blue('\n  Goodbye! 👋\n'));
        process.exit(0);
    }
  }
}

main().catch((err) => {
  console.error(chalk.red(`\n  Fatal error: ${err.message}\n`));
  process.exit(1);
});
