/**
 * @file transactions.js
 * Reusable helpers for the SumUp Transactions API.
 * Endpoint: GET /v2.1/merchants/{merchant_code}/transactions
 */
import { client, merchantCode } from './client.js';

// ---------------------------------------------------------------------------
// Error handling (same pattern as readers.js)
// ---------------------------------------------------------------------------

function formatError(err) {
  if (err && typeof err === 'object') {
    const e = /** @type {any} */ (err);
    const body = e.body ?? e.response?.body ?? e;
    if (body.detail) return `${body.title ?? 'API Error'}: ${body.detail}`;
    if (body.title)  return body.title;
    if (e.message)   return e.message;
  }
  return String(err);
}

async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    throw new Error(formatError(err));
  }
}

// ---------------------------------------------------------------------------
// Transaction lookup
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TransactionQuery
 * @property {string} [id]                   - Transaction ID
 * @property {string} [transactionCode]       - Transaction code from acquirer
 * @property {string} [foreignTransactionId]  - Your own foreign TX id
 * @property {string} [clientTransactionId]   - Client TX id (returned by checkout)
 */

/**
 * Retrieve a transaction by any of its identifiers.
 * At least one query param is required.
 *
 * @param {TransactionQuery} query
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getTransaction(query) {
  const params = {
    ...(query.id                  && { id: query.id }),
    ...(query.transactionCode     && { transaction_code: query.transactionCode }),
    ...(query.foreignTransactionId && { foreign_transaction_id: query.foreignTransactionId }),
    ...(query.clientTransactionId  && { client_transaction_id: query.clientTransactionId }),
  };

  if (Object.keys(params).length === 0) {
    throw new Error('getTransaction: at least one query identifier is required');
  }

  return call(() => client.transactions.get(merchantCode, params));
}
