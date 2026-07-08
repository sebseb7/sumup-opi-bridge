import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeMessage,
  createFrameReader,
  detectRequest,
  serviceResponse,
  cardServiceResponse,
  escapeXml,
  deviceRequest,
  buildReceiptText
} from '../src/lib/opi-protocol.js';

describe('opi-protocol', () => {
  describe('encodeMessage', () => {
    it('should prefix the XML payload with its length in a 4-byte big-endian integer', () => {
      const xml = '<Test />';
      const result = encodeMessage(xml);
      assert.ok(result instanceof Buffer);
      assert.equal(result.length, 12); // 4 bytes header + 8 bytes body
      assert.equal(result.readUInt32BE(0), 8);
      assert.equal(result.subarray(4).toString('utf8'), xml);
    });
  });

  describe('createFrameReader', () => {
    it('should invoke onMessage when a complete frame is received', () => {
      let messageReceived = null;
      const reader = createFrameReader((msg) => {
        messageReceived = msg;
      });

      const body = '<Message>Hello</Message>';
      const frame = encodeMessage(body);
      reader(frame);

      assert.equal(messageReceived, body);
    });

    it('should buffer and process fragmented frames', () => {
      const messages = [];
      const reader = createFrameReader((msg) => {
        messages.push(msg);
      });

      const body = '<Frag>Test</Frag>';
      const frame = encodeMessage(body);

      // Send first 6 bytes (4 bytes header + 2 bytes body)
      reader(frame.subarray(0, 6));
      assert.equal(messages.length, 0);

      // Send the rest of the frame
      reader(frame.subarray(6));
      assert.equal(messages.length, 1);
      assert.equal(messages[0], body);
    });

    it('should invoke onError when message callback throws', () => {
      let errorThrown = null;
      const reader = createFrameReader(
        () => {
          throw new Error('Callback failure');
        },
        (err) => {
          errorThrown = err;
        }
      );

      const frame = encodeMessage('<Msg/>');
      reader(frame);

      assert.ok(errorThrown);
      assert.equal(errorThrown.message, 'Callback failure');
    });
  });

  describe('detectRequest', () => {
    it('should extract correct metadata from service request XML', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ServiceRequest RequestID="42" RequestType="Login" WorkstationID="WS9" ApplicationSender="JTL">
</ServiceRequest>`;
      const req = detectRequest(xml);
      assert.equal(req.root, 'ServiceRequest');
      assert.equal(req.requestId, '42');
      assert.equal(req.requestType, 'Login');
      assert.equal(req.workstationId, 'WS9');
      assert.equal(req.applicationSender, 'JTL');
    });

    it('should extract correct metadata from card payment request XML', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CardServiceRequest RequestID="101" RequestType="CardPayment" WorkstationID="2" ApplicationSender="POS-1">
  <TotalAmount Currency="EUR">12.50</TotalAmount>
  <ReceiptNumber>REC-999</ReceiptNumber>
  <TransactionID>TX-12345</TransactionID>
  <CashierID>CASH-1</CashierID>
</CardServiceRequest>`;
      const req = detectRequest(xml);
      assert.equal(req.root, 'CardServiceRequest');
      assert.equal(req.requestId, '101');
      assert.equal(req.requestType, 'CardPayment');
      assert.equal(req.workstationId, '2');
      assert.equal(req.amount, '12.50');
      assert.equal(req.currency, 'EUR');
      assert.equal(req.receiptNumber, 'REC-999');
      assert.equal(req.transactionId, 'TX-12345');
      assert.equal(req.cashierId, 'CASH-1');
    });

    it('should default missing values gracefully', () => {
      const xml = '<EmptyRequest />';
      const req = detectRequest(xml);
      assert.equal(req.root, 'EmptyRequest');
      assert.equal(req.requestId, '');
      assert.equal(req.workstationId, '1');
      assert.equal(req.popId, '001');
      assert.equal(req.currency, 'EUR');
    });
  });

  describe('serviceResponse', () => {
    it('should generate valid ServiceResponse XML matching inputs', () => {
      const res = serviceResponse({
        requestId: 'req-1',
        requestType: 'Login',
        workstationId: 'ws-5',
        overallResult: 'Success'
      });
      assert.match(res, /<ServiceResponse/);
      assert.match(res, /RequestID="req-1"/);
      assert.match(res, /RequestType="Login"/);
      assert.match(res, /WorkstationID="ws-5"/);
      assert.match(res, /OverallResult="Success"/);
      assert.match(res, /Terminal TerminalID="12345678"/);
    });
  });

  describe('cardServiceResponse', () => {
    it('should generate successful CardServiceResponse XML', () => {
      const res = cardServiceResponse({
        requestId: 'req-2',
        requestType: 'CardPayment',
        workstationId: 'ws-5',
        overallResult: 'Success',
        amount: '15.00',
        currency: 'EUR',
        stan: '111111',
        approvalCode: '999999',
        cardPan: '************4444',
        cardCircuit: 'VISA'
      });
      assert.match(res, /OverallResult="Success"/);
      assert.match(res, /STAN="111111"/);
      assert.match(res, /Currency="EUR">15.00<\/TotalAmount>/);
      assert.match(res, /ApprovalCode="999999"/);
      assert.match(res, /CardPAN="\*\*\*\*\*\*\*\*\*\*\*\*4444"/);
      assert.match(res, /CardCircuit="VISA"/);
    });

    it('should generate failed CardServiceResponse XML with error message if provided', () => {
      const res = cardServiceResponse({
        requestId: 'req-3',
        requestType: 'CardPayment',
        workstationId: 'ws-5',
        overallResult: 'Failed',
        message: 'Karte abgelehnt',
        amount: '15.00'
      });
      assert.match(res, /OverallResult="Failed"/);
      assert.match(res, /<PrivateData>answer-txt=Karte abgelehnt<\/PrivateData>/);
      assert.doesNotMatch(res, /<Tender>/);
    });
  });

  describe('escapeXml', () => {
    it('should escape xml entities', () => {
      assert.equal(escapeXml('a & b < c > d " e'), 'a &amp; b &lt; c &gt; d &quot; e');
    });
  });

  describe('deviceRequest', () => {
    it('should construct DeviceRequest XML with correct lines of text', () => {
      const res = deviceRequest({
        applicationSender: 'SUMUP-BRIDGE',
        requestId: 'd-1',
        workstationId: 'w-1',
        text: 'Line 1\nLine 2',
        target: 'CashierDisplay',
        sequenceId: '3'
      });
      assert.match(res, /<DeviceRequest/);
      assert.match(res, /RequestID="d-1"/);
      assert.match(res, /SequenceID="3"/);
      assert.match(res, /OutDeviceTarget="CashierDisplay"/);
      assert.match(res, /<TextLine>Line 1<\/TextLine>/);
      assert.match(res, /<TextLine>Line 2<\/TextLine>/);
    });
  });

  describe('buildReceiptText', () => {
    it('should build formatted receipt text', () => {
      const receipt = buildReceiptText({
        stan: '123456',
        approvalCode: '987654',
        amount: '10.00',
        currency: 'EUR',
        cardCircuit: 'MASTERCARD',
        cardPan: '************1111',
        requestId: 'req-9'
      });
      assert.match(receipt, /Transaktionsnummer: 123456-req-9/);
      assert.match(receipt, /Karte: MASTERCARD/);
      assert.match(receipt, /PAN: \*\*\*\*\*\*\*\*\*\*\*\*1111/);
    });
  });
});
