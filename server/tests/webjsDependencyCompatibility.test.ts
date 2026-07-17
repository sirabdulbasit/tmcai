import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('whatsapp-web.js production compatibility', () => {
  it('pins the upstream release containing the frozen-start/auth-timeout fix', () => {
    const packageJson = require('whatsapp-web.js/package.json');
    expect(packageJson.version).toBe('1.34.7');
  });

  it('retains the LID and inbound-media APIs used by chats 11/12', () => {
    const webjs = require('whatsapp-web.js');
    expect(typeof webjs.Client?.prototype?.getContactLidAndPhone).toBe('function');
    expect(typeof webjs.Message?.prototype?.downloadMedia).toBe('function');
  });
});
