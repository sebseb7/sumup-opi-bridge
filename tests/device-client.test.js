import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { normalizeHost, sendDeviceOutput, sendPaymentDeviceRequests } from '../src/lib/device-client.js';
import { encodeMessage } from '../src/lib/opi-protocol.js';

describe('device-client', () => {
  describe('normalizeHost', () => {
    it('should return null for empty or invalid values', () => {
      assert.equal(normalizeHost(null), null);
      assert.equal(normalizeHost(''), null);
      assert.equal(normalizeHost('   '), null);
      assert.equal(normalizeHost('#CASHBOXNAME#'), null);
    });

    it('should extract host from brackets', () => {
      assert.equal(normalizeHost('[192.168.1.100]'), '192.168.1.100');
      assert.equal(normalizeHost('[192.168.1.100]:4102'), '192.168.1.100');
    });

    it('should split port from host', () => {
      assert.equal(normalizeHost('localhost:8080'), 'localhost');
      assert.equal(normalizeHost('127.0.0.1'), '127.0.0.1');
    });
  });

  describe('TCP Client Operations', () => {
    let mockServer;
    let serverPort;
    const serverHost = '127.0.0.1'; // TODO(security): strictly bind to localhost

    before(async () => {
      mockServer = net.createServer((socket) => {
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length >= 4) {
            const len = buffer.readUInt32BE(0);
            if (buffer.length >= 4 + len) {
              const body = buffer.subarray(4, 4 + len).toString('utf8');
              
              // Respond with a dummy OPI response frame
              const dummyResponse = `<DeviceResponse RequestID="${body.match(/RequestID="([^"]+)"/)?.[1] || 'unknown'}"/>`;
              socket.write(encodeMessage(dummyResponse));
            }
          }
        });
      });

      // Bind to port 0 on 127.0.0.1 to let OS assign any free port
      await new Promise((resolve) => {
        mockServer.listen(0, serverHost, () => {
          serverPort = mockServer.address().port;
          resolve();
        });
      });
    });

    after((done) => {
      mockServer.close(done);
    });

    it('should successfully send device output and resolve', async () => {
      await assert.doesNotReject(
        sendDeviceOutput({
          posHost: serverHost,
          posPort: serverPort,
          applicationSender: 'TEST-SENDER',
          workstationId: '1',
          text: 'Hello POS',
          target: 'CashierDisplay',
          requestId: 'test-req-123',
          sequenceId: '0'
        })
      );
    });

    it('should reject if connection fails', async () => {
      // Connect to a port that is highly likely to be inactive
      await assert.rejects(
        sendDeviceOutput({
          posHost: serverHost,
          posPort: 12345, // invalid port
          applicationSender: 'TEST-SENDER',
          workstationId: '1',
          text: 'Hello POS',
          target: 'CashierDisplay',
          requestId: 'test-req-123',
          sequenceId: '0'
        }),
        /ECONNREFUSED/
      );
    });

    it('should send payment device requests and return structured results', async () => {
      const payment = {
        requestId: 'pay-req-1',
        stan: '654321',
        approvalCode: '123456',
        amount: '20.00',
        currency: 'EUR',
        cardCircuit: 'MASTERCARD',
        cardPan: '************5555'
      };

      const result = await sendPaymentDeviceRequests({
        posHost: serverHost,
        posPort: serverPort,
        workstationId: '2',
        payment
      });

      assert.equal(result.stan, '654321');
      assert.equal(result.approvalCode, '123456');
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].target, 'PrinterReceipt');
      assert.equal(result.results[0].ok, true);
    });
  });
});
