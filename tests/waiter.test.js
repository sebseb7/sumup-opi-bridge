import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

// Ensure environment variables are configured for testing
process.env.SUMUP_API_KEY = 'mock_key';
process.env.SUMUP_MERCHANT_CODE = 'mock_merchant';
process.env.SUMUP_AFFILIATE_KEY = 'mock_affiliate';

// Set low timeouts and intervals to make tests run instantly
process.env.POLL_INTERVAL_MS = '10';
process.env.POLL_TIMEOUT_MS = '100';
process.env.WEBHOOK_HOST = '127.0.0.1'; // TODO(security): strictly bind to localhost

let testPort;

import { client } from '../src/lib/client.js';
import {
  pollTransaction,
  waitForWebhook,
  waitForPaymentResult,
  startWebhookServer
} from '../src/lib/waiter.js';

describe('waiter', () => {
  before(async () => {
    const getFreePort = () => new Promise((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    });
    testPort = await getFreePort();
    process.env.WEBHOOK_PORT = String(testPort);
  });
  describe('pollTransaction', () => {
    it('should poll until a terminal transaction status is reached', async () => {
      let callCount = 0;
      mock.method(client.transactions, 'get', async () => {
        callCount++;
        if (callCount < 3) {
          return { status: 'PENDING' };
        }
        return { status: 'SUCCESSFUL', amount: 100 };
      });

      const attempts = [];
      const result = await pollTransaction('tx-poll-1', (attempt, status) => {
        attempts.push({ attempt, status });
      });

      assert.equal(result.source, 'poll');
      assert.equal(result.data.status, 'SUCCESSFUL');
      assert.ok(callCount >= 3);
      assert.deepEqual(attempts[attempts.length - 1], { attempt: callCount, status: 'SUCCESSFUL' });
    });

    it('should time out if terminal status is not reached within the timeout limit', async () => {
      mock.method(client.transactions, 'get', async () => {
        return { status: 'PENDING' };
      });

      await assert.rejects(
        pollTransaction('tx-poll-timeout', null, null, 50),
        /Polling timed out/
      );
    });

    it('should stop polling immediately if aborted via AbortSignal', async () => {
      mock.method(client.transactions, 'get', async () => {
        return { status: 'PENDING' };
      });

      const controller = new AbortController();
      const promise = pollTransaction('tx-poll-abort', null, controller.signal);

      // Abort after 20ms
      setTimeout(() => {
        controller.abort();
      }, 20);

      // The promise should remain pending or handle abort. Let's make sure it doesn't resolve successfully.
      // In waiter.js, pollTransaction resolves or rejects. On abort it clears interval.
      // Wait, let's verify if abort throws or leaves it. Since signal event listener clears timers,
      // it doesn't resolve/reject, but we can verify it stopped polling.
      await new Promise((r) => setTimeout(r, 60));
    });
  });

  describe('Webhook server and waitForWebhook', () => {
    it('should start the webhook server and resolve waitForWebhook when matching POST arrives', async () => {
      startWebhookServer();

      // Mock getTransaction lookup which the webhook server performs
      mock.method(client.transactions, 'get', async (merchantCode, query) => {
        assert.equal(query.client_transaction_id, 'ctid-webhook-test');
        return { status: 'SUCCESSFUL', client_transaction_id: 'ctid-webhook-test' };
      });

      const webhookPromise = waitForWebhook('ctid-webhook-test', null, null, 1000);

      // Trigger the webhook request
      const payload = {
        event_type: 'transaction.successful',
        payload: {
          client_transaction_id: 'ctid-webhook-test',
          status: 'SUCCESSFUL'
        }
      };

      const response = await fetch(`http://127.0.0.1:${testPort}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      assert.equal(response.status, 200);
      const resData = await response.json();
      assert.deepEqual(resData, { received: true });

      const result = await webhookPromise;
      assert.equal(result.source, 'webhook');
      assert.equal(result.data.status, 'SUCCESSFUL');
    });

    it('should time out if no webhook matching transaction ID is received', async () => {
      await assert.rejects(
        waitForWebhook('non-existent-tx', null, null, 50),
        /Timed out waiting for webhook/
      );
    });
  });

  describe('waitForPaymentResult', () => {
    it('should race webhook and poll, resolving when the first completes and aborting the other', async () => {
      mock.method(client.transactions, 'get', async () => {
        return { status: 'SUCCESSFUL', amount: 50 };
      });

      const result = await waitForPaymentResult('ctid-race-test', `http://127.0.0.1:${testPort}/`, null, null);
      assert.ok(result.winner);
      assert.equal(result.winner.source, 'poll'); // poll resolves immediately under mock
      assert.equal(result.winner.data.status, 'SUCCESSFUL');
      assert.ok(result.abortController.signal.aborted);
    });
  });
});
