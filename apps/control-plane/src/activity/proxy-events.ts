// 22-02 (A1, H3): the proxy lifecycle events (`server.proxy_installed | proxy_failed |
// proxy_removed`). Only these three actions on a server pass through here; their metadata is the
// closed allowlist of activity-event.ts (ids, codes, durations, step, trigger, port, listener).
import { writeActivityEvent, type ActivityWriteHandle, type WriteActivityEventInput } from './write-activity-event.js';

export type ProxyActivityAction = 'server.proxy_installed' | 'server.proxy_failed' | 'server.proxy_removed';

export type ProxyActivityEventInput = WriteActivityEventInput & {
  readonly entityType: 'server';
  readonly action: ProxyActivityAction;
};

export function writeProxyActivityEvent(handle: ActivityWriteHandle, input: ProxyActivityEventInput, at: Date): Promise<string> {
  return writeActivityEvent(handle, input, at);
}
