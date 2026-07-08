import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Ensure required environment variables are set so importing client doesn't exit the process
process.env.SUMUP_API_KEY = 'mock_key';
process.env.SUMUP_MERCHANT_CODE = 'mock_merchant';
process.env.SUMUP_AFFILIATE_KEY = 'mock_affiliate';

import { client, merchantCode as expectedMerchantCode } from '../src/lib/client.js';
import { getTransaction } from '../src/lib/transactions.js';

describe('transactions', () => {
  describe('getTransaction', () => {
    it('should validate query arguments and require at least one identifier', async () => {
      await assert.rejects(
        getTransaction({}),
        /getTransaction: at least one query identifier is required/
      );
    });

    it('should query the API with correct keys and camelCase to snake_case mappings', async () => {
      mock.method(client.transactions, 'get', async (merchantCode, params) => {
        assert.equal(merchantCode, expectedMerchantCode);
        assert.deepEqual(params, {
          transaction_code: 'TX_123',
          client_transaction_id: 'client_tx_456'
        });
        return { status: 'SUCCESSFUL', amount: 10 };
      });

      const result = await getTransaction({
        transactionCode: 'TX_123',
        clientTransactionId: 'client_tx_456'
      });

      assert.equal(result.status, 'SUCCESSFUL');
      assert.equal(result.amount, 10);
    });

    it('should support individual identifiers like id and foreignTransactionId', async () => {
      mock.method(client.transactions, 'get', async (merchantCode, params) => {
        assert.equal(merchantCode, expectedMerchantCode);
        assert.deepEqual(params, {
          id: 'tx_id_999',
          foreign_transaction_id: 'foreign_tx_888'
        });
        return { status: 'FAILED' };
      });

      const result = await getTransaction({
        id: 'tx_id_999',
        foreignTransactionId: 'foreign_tx_888'
      });

      assert.equal(result.status, 'FAILED');
    });

    it('should bubble up formatted errors if the client request fails', async () => {
      const error = new Error('HTTP 401');
      error.body = {
        title: 'Unauthorized',
        detail: 'The provided API key is invalid'
      };

      mock.method(client.transactions, 'get', () => {
        return Promise.reject(error);
      });

      await assert.rejects(
        getTransaction({ id: 'tx_id' }),
        /Unauthorized: The provided API key is invalid/
      );
    });
  });
});
