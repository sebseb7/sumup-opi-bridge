import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

describe('client config', () => {
  it('should call process.exit(1) and log errors if required environment variables are missing', () => {
    try {
      // Execute in a child process to prevent exiting the main test runner process.
      // We set variables to empty strings so dotenv won't override them, but our check will mark them missing.
      execSync('node -e "import(\'./src/lib/client.js\')"', {
        env: {
          ...process.env,
          SUMUP_API_KEY: '',
          SUMUP_MERCHANT_CODE: '',
          SUMUP_AFFILIATE_KEY: ''
        },
        stdio: 'pipe'
      });
      assert.fail('Should have failed to import due to missing environment variables');
    } catch (err) {
      if (err.code === 'ERR_ASSERTION') {
        throw err;
      }
      assert.equal(err.status, 1);
      const stderr = err.stderr.toString();
      assert.match(stderr, /Missing required environment variables/);
    }
  });

  it('should successfully configure and export SDK components if environment variables are set', async () => {
    // Dynamic import the real client (since env vars are guaranteed to be populated during npm test or by .env)
    const { client, merchantCode, affiliateDefaults } = await import('../src/lib/client.js');

    assert.ok(client);
    assert.ok(merchantCode);
    assert.ok(affiliateDefaults.key);
  });
});
