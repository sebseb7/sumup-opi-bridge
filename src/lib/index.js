/**
 * @file index.js
 * Public surface of the sumup-cloudapi library.
 * Import from here when using the library in other scripts.
 *
 * @example
 * import { listReaders, createCheckout } from './lib/index.js';
 */
export { client, merchantCode, affiliateDefaults } from './client.js';
export {
  listReaders,
  getReader,
  getReaderStatus,
  createCheckout,
  terminateCheckout,
} from './readers.js';
export { getTransaction } from './transactions.js';
