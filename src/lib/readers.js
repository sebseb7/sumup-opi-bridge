/**
 * @file readers.js
 * Reusable helpers wrapping client.readers.* SDK methods.
 * All functions surface structured errors from the API problem+json format.
 */
import crypto from 'node:crypto';
import { client, merchantCode, affiliateDefaults } from './client.js';
import { logEvent } from './event-log.js';

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Extracts a readable message from a SumUp API error response.
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  if (err && typeof err === 'object') {
    const e = /** @type {any} */ (err);
    // SDK wraps API problem+json inside err.body or err.message
    const body = e.body ?? e.response?.body ?? e;
    if (body.detail) return `${body.title ?? 'API Error'}: ${body.detail}`;
    if (body.title) return body.title;
    if (e.message) return e.message;
  }
  return String(err);
}

/**
 * Wraps an async SDK call, re-throwing with a clean error message.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    throw new Error(formatError(err));
  }
}

// ---------------------------------------------------------------------------
// Reader CRUD
// ---------------------------------------------------------------------------

/**
 * List all readers paired to the merchant account.
 * @returns {Promise<import('@sumup/sdk').Reader[]>}
 */
export async function listReaders() {
  const result = await call(() => client.readers.list(merchantCode));
  return result.items ?? [];
}

/**
 * Retrieve a single reader by ID.
 * @param {string} readerId
 * @returns {Promise<import('@sumup/sdk').Reader>}
 */
export async function getReader(readerId) {
  return call(() => client.readers.get(merchantCode, readerId));
}

/**
 * Get the last known status of a reader (battery, state, connectivity).
 * @param {string} readerId
 * @returns {Promise<{
 *   status: 'ONLINE' | 'OFFLINE';
 *   state?: 'IDLE' | 'SELECTING_TIP' | 'WAITING_FOR_CARD' | 'WAITING_FOR_PIN' | 'WAITING_FOR_SIGNATURE' | 'UPDATING_FIRMWARE';
 *   battery_level?: number;
 *   battery_temperature?: number;
 *   connection_type?: string;
 *   firmware_version?: string;
 *   last_activity?: string;
 * }>}
 */
export async function getReaderStatus(readerId) {
  const result = await call(() => client.readers.getStatus(merchantCode, readerId));
  return result.data ?? result;
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CheckoutOptions
 * @property {number}  value       - Amount in minor units (e.g. 1000 = €10.00)
 * @property {string}  [currency]  - ISO 4217 currency code (default: 'EUR')
 * @property {number}  [minorUnit] - Decimal places for the currency (default: 2)
 * @property {string}  [description]
 * @property {string}  [returnUrl] - HTTPS webhook URL for payment result
 * @property {string}  [foreignTransactionId] - Your own unique TX id
 * @property {number[]} [tipRates] - Tipping rates (0.01–0.99), sorted ascending
 * @property {number}  [tipTimeout] - Seconds for tip selection (30–120)
 */

/**
 * Start a checkout on a paired reader.
 * Automatically injects affiliate metadata from env vars.
 *
 * @param {string} readerId
 * @param {CheckoutOptions} opts
 * @returns {Promise<{ client_transaction_id: string }>}
 */
export async function createCheckout(readerId, opts) {
  const {
    value,
    currency = 'EUR',
    minorUnit = 2,
    description,
    returnUrl,
    foreignTransactionId = crypto.randomUUID(),
    tipRates,
    tipTimeout,
  } = opts;

  const body = {
    total_amount: { currency, minor_unit: minorUnit, value },
    affiliate: {
      key: affiliateDefaults.key,
      app_id: affiliateDefaults.app_id,
      foreign_transaction_id: foreignTransactionId,
    },
    ...(description && { description }),
    ...(returnUrl && { return_url: returnUrl }),
    ...(tipRates && { tip_rates: tipRates }),
    ...(tipTimeout && { tip_timeout: tipTimeout }),
  };

  const result = await call(() =>
    client.readers.createCheckout(merchantCode, readerId, body),
  );
  const data = result.data ?? result;
  logEvent('payment', {
    readerId,
    value,
    currency,
    minorUnit,
    description,
    foreignTransactionId,
    clientTransactionId: data?.client_transaction_id,
    data,
  });
  return data;
}

/**
 * Terminate (cancel) the active checkout on a reader.
 * Only works when the device is waiting for cardholder action.
 *
 * @param {string} readerId
 * @returns {Promise<void>}
 */
export async function terminateCheckout(readerId) {
  return call(() => client.readers.terminateCheckout(merchantCode, readerId));
}
