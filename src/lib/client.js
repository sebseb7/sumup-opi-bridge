/**
 * @file client.js
 * Loads env vars and exports a configured SumUp client singleton.
 * Import this instead of constructing SumUp directly.
 */
import 'dotenv/config';
import SumUp from '@sumup/sdk';

const required = ['SUMUP_API_KEY', 'SUMUP_MERCHANT_CODE', 'SUMUP_AFFILIATE_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  // Use basic ANSI codes — chalk may not be available at this point
  const red    = (s) => `\x1b[31m${s}\x1b[0m`;
  const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
  const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

  console.error('');
  console.error(bold(red('  ✖  Missing required environment variables:')));
  console.error('');
  for (const k of missing) {
    console.error(`     ${yellow(k)}`);
  }
  console.error('');
  console.error(`  Copy ${cyan('.env.example')} to ${cyan('.env')} and fill in your values:`);
  console.error('');
  console.error(`     ${cyan('cp .env.example .env')}`);
  console.error('');
  console.error('  Get your credentials at:');
  console.error(`     ${cyan('https://developer.sumup.com')}`);
  console.error('');
  process.exit(1);
}

/** Configured SumUp SDK client */
export const client = new SumUp({ apiKey: process.env.SUMUP_API_KEY });

/** Merchant code from env */
export const merchantCode = process.env.SUMUP_MERCHANT_CODE;

/** Affiliate metadata injected into every checkout */
export const affiliateDefaults = {
  key: process.env.SUMUP_AFFILIATE_KEY,
  app_id: process.env.SUMUP_APP_ID ?? 'com.example.sumup-cloudapi-test',
};
