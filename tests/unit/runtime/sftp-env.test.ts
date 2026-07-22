import { describe, expect, it } from 'vitest';
import { applySftpCompatibilityAliases } from '../../../src/runtime/sftp-env.js';

describe('unified SFTP environment', () => {
  it('derives every packaged plugin compatibility variable from one namespace', () => {
    const env: Record<string, string | undefined> = {
      SFTP_HOST: 'sftp.internal',
      SFTP_PORT: '2222',
      SFTP_USER: 'shared-user',
      SFTP_PASSWORD: 'shared-password',
      SFTP_FAST_TRADES_REMOTE_BASE: '/fast/trades',
      SFTP_NORMAL_TRADES_REMOTE_BASE: '/normal/trades',
      SFTP_NORMAL_SUMMARY_REMOTE_BASE: '/normal/summary',
      SFTP_NORMAL_POSITION_DETAILS_REMOTE_BASE: '/normal/details',
      SFTP_FAST_SUMMARY_REMOTE_BASE: '/fast/summary',
      SFTP_CORPORATE_ACTION_REMOTE_BASE: '/corporate-action',
      SFTP_SBL_REMOTE_BASE: '/sbl',
      SFTP_HEDGE_ENABLED: 'true',
      SFTP_HEDGE_REMOTE_BASE: '/hedge',
      FAST_TRADING_SFTP_USER: 'legacy-user',
    };

    applySftpCompatibilityAliases(env);

    expect([
      env.NORMAL_TRADING_SFTP_HOST,
      env.FAST_TRADING_SFTP_HOST,
      env.CORP_ACTION_SFTP_HOST,
      env.SBL_SFTP_HOST,
      env.HEDGE_RATIO_SFTP_HOST,
    ]).toEqual(Array(5).fill(env.SFTP_HOST));
    expect([
      env.NORMAL_TRADING_SFTP_USER,
      env.FAST_TRADING_SFTP_USER,
      env.CORP_ACTION_SFTP_USER,
      env.SBL_SFTP_USER,
      env.HEDGE_RATIO_SFTP_USERNAME,
    ]).toEqual(Array(5).fill(env.SFTP_USER));
    expect([
      env.SFTP_PASSWD,
      env.NORMAL_TRADING_SFTP_PASSWORD,
      env.NORMAL_TRADING_SFTP_PASSWD,
      env.FAST_TRADING_SFTP_PASSWORD,
      env.FAST_TRADING_SFTP_PASSWD,
      env.CORP_ACTION_SFTP_PASSWORD,
      env.CORP_ACTION_SFTP_PASSWD,
      env.SBL_SFTP_PASSWD,
      env.HEDGE_RATIO_SFTP_PASSWORD,
    ]).toEqual(Array(9).fill(env.SFTP_PASSWORD));
    expect(env.SFTP_REMOTE_BASE).toBe(env.SFTP_FAST_TRADES_REMOTE_BASE);
    expect(env.NORMAL_TRADING_SFTP_TRADES_REMOTE_BASE)
      .toBe(env.SFTP_NORMAL_TRADES_REMOTE_BASE);
    expect(env.NORMAL_TRADING_SFTP_BUSINESS_SCALE_REMOTE_BASE)
      .toBe(env.SFTP_NORMAL_SUMMARY_REMOTE_BASE);
    expect(env.NORMAL_TRADING_SFTP_POSITION_DETAILS_REMOTE_BASE)
      .toBe(env.SFTP_NORMAL_POSITION_DETAILS_REMOTE_BASE);
    expect(env.NORMAL_TRADING_SFTP_REMOTE_BASE).toBe(env.SFTP_NORMAL_SUMMARY_REMOTE_BASE);
    expect(env.FAST_TRADING_SFTP_REMOTE_BASE).toBe(env.SFTP_FAST_SUMMARY_REMOTE_BASE);
    expect(env.CORP_ACTION_SFTP_REMOTE_BASE).toBe(env.SFTP_CORPORATE_ACTION_REMOTE_BASE);
    expect(env.SBL_SFTP_REMOTE_BASE).toBe(env.SFTP_SBL_REMOTE_BASE);
    expect(env.HEDGE_RATIO_SFTP_REMOTE_BASE_PATH).toBe(env.SFTP_HEDGE_REMOTE_BASE);
    expect(env.HEDGE_RATIO_SFTP_ENABLED).toBe(env.SFTP_HEDGE_ENABLED);
  });

  it('leaves legacy-only environments unchanged', () => {
    const env: Record<string, string | undefined> = { FAST_TRADING_SFTP_USER: 'legacy-user' };
    applySftpCompatibilityAliases(env);
    expect(env).toEqual({ FAST_TRADING_SFTP_USER: 'legacy-user' });
  });
});
