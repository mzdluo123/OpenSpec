import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/telemetry/distribution.js', () => ({
  UPSTREAM_PACKAGE_NAME: '@fission-ai/openspec',
  isUpstreamDistribution: () => false,
}));

import { isTelemetryEnabled, maybeShowTelemetryNotice, shutdown, trackCommand } from '../../src/telemetry/index.js';

describe('telemetry in a redistributed fork', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-fork-telemetry-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tempDir;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.APPDATA = path.join(tempDir, 'appdata');
    delete process.env.OPENSPEC_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    fs.mkdirSync(path.join(tempDir, 'openspec'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'openspec', 'config.json'), JSON.stringify({ telemetry: { enabled: true } }));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await shutdown();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stays off even when the user enabled it, and sends nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(isTelemetryEnabled()).toBe(false);
    await maybeShowTelemetryNotice();
    await trackCommand('list', '1.0.0');
    await shutdown();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
