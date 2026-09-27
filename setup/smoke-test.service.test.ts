import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./platform.js', () => ({
  getServiceManager: vi.fn(() => 'systemd'),
  getSystemdServiceStatus: vi.fn(),
}));

import { checkServiceRunning } from './smoke-test.js';
import { getSystemdServiceStatus } from './platform.js';

const status = vi.mocked(getSystemdServiceStatus);

describe('smoke-test service check on systemd', () => {
  beforeEach(() => status.mockReset());

  it('asks for the status of the unit serving this checkout', () => {
    status.mockReturnValue('running');
    expect(checkServiceRunning()).toBe('running');
    expect(status).toHaveBeenCalledWith(process.cwd());
  });

  it('reports stopped for an inactive or missing unit', () => {
    status.mockReturnValue('stopped');
    expect(checkServiceRunning()).toBe('stopped');
    status.mockReturnValue('not_found');
    expect(checkServiceRunning()).toBe('stopped');
  });
});
