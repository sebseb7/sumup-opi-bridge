import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

// Ensure required environment variables are set so importing client doesn't exit the process
process.env.SUMUP_API_KEY = 'mock_key';
process.env.SUMUP_MERCHANT_CODE = 'mock_merchant';
process.env.SUMUP_AFFILIATE_KEY = 'mock_affiliate';

import { client, merchantCode as expectedMerchantCode, affiliateDefaults } from '../src/lib/client.js';
import {
  listReaders,
  getReader,
  getReaderStatus,
  createCheckout,
  terminateCheckout
} from '../src/lib/readers.js';

describe('readers', () => {
  describe('listReaders', () => {
    it('should retrieve lists of readers and return items or empty array', async () => {
      const mockReaders = [{ id: 'rdr_1', status: 'PAIRED' }];
      
      mock.method(client.readers, 'list', async (merchantCode) => {
        assert.equal(merchantCode, expectedMerchantCode);
        return { items: mockReaders };
      });

      const list = await listReaders();
      assert.deepEqual(list, mockReaders);
    });

    it('should return empty array if items is not defined', async () => {
      mock.method(client.readers, 'list', async () => {
        return {};
      });

      const list = await listReaders();
      assert.deepEqual(list, []);
    });
  });

  describe('getReader', () => {
    it('should call SDK get method with correct arguments', async () => {
      mock.method(client.readers, 'get', async (merchantCode, readerId) => {
        assert.equal(merchantCode, expectedMerchantCode);
        assert.equal(readerId, 'rdr_2');
        return { id: 'rdr_2', status: 'ONLINE' };
      });

      const reader = await getReader('rdr_2');
      assert.equal(reader.id, 'rdr_2');
    });
  });

  describe('getReaderStatus', () => {
    it('should retrieve reader status and return result data', async () => {
      const mockStatus = { status: 'ONLINE', battery_level: 80 };
      
      mock.method(client.readers, 'getStatus', async (merchantCode, readerId) => {
        assert.equal(merchantCode, expectedMerchantCode);
        assert.equal(readerId, 'rdr_3');
        return { data: mockStatus };
      });

      const status = await getReaderStatus('rdr_3');
      assert.deepEqual(status, mockStatus);
    });

    it('should fallback to direct response if data key is missing', async () => {
      const mockDirectStatus = { status: 'OFFLINE' };
      mock.method(client.readers, 'getStatus', async () => {
        return mockDirectStatus;
      });

      const status = await getReaderStatus('rdr_3');
      assert.deepEqual(status, mockDirectStatus);
    });
  });

  describe('createCheckout', () => {
    it('should construct the checkout body properly and call SDK createCheckout', async () => {
      mock.method(client.readers, 'createCheckout', async (merchantCode, readerId, body) => {
        assert.equal(merchantCode, expectedMerchantCode);
        assert.equal(readerId, 'rdr_4');
        assert.deepEqual(body.total_amount, { currency: 'EUR', minor_unit: 2, value: 1000 });
        assert.equal(body.description, 'Test description');
        assert.equal(body.affiliate.key, affiliateDefaults.key);
        assert.ok(body.affiliate.foreign_transaction_id);
        return { data: { client_transaction_id: 'tx-123' } };
      });

      const res = await createCheckout('rdr_4', {
        value: 1000,
        currency: 'EUR',
        description: 'Test description'
      });
      assert.equal(res.client_transaction_id, 'tx-123');
    });
  });

  describe('terminateCheckout', () => {
    it('should invoke SDK terminateCheckout with correct parameters', async () => {
      let called = false;
      mock.method(client.readers, 'terminateCheckout', async (merchantCode, readerId) => {
        assert.equal(merchantCode, expectedMerchantCode);
        assert.equal(readerId, 'rdr_5');
        called = true;
      });

      await terminateCheckout('rdr_5');
      assert.ok(called);
    });
  });

  describe('Error formatting and handling', () => {
    it('should correctly format and surface nested API error details', async () => {
      const apiError = new Error('API request failed');
      // SDK wraps API errors in body property
      apiError.body = {
        title: 'Bad Request',
        detail: 'Reader must be in WAITING_FOR_CARD state'
      };

      mock.method(client.readers, 'list', () => {
        return Promise.reject(apiError);
      });

      await assert.rejects(
        listReaders(),
        /Bad Request: Reader must be in WAITING_FOR_CARD state/
      );
    });

    it('should fallback to error message if detailed details are missing', async () => {
      const basicError = new Error('Network failure');
      mock.method(client.readers, 'list', () => {
        return Promise.reject(basicError);
      });

      await assert.rejects(
        listReaders(),
        /Network failure/
      );
    });
  });
});
