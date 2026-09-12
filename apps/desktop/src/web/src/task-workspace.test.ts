import { describe, expect, it } from 'vitest';
import type { Workspace } from '@techunter/core';
import { deviceWorkspace } from './task-workspace.js';

const workspace = (id: string, deviceId: string, status: Workspace['status'], userId = 'alice') =>
  ({ id, deviceId, status, userId, createdAt: id } as Workspace);

describe('deviceWorkspace', () => {
  it('selects the signed-in user and current device even when another device fails later', () => {
    const a = workspace('1', 'A', 'running'), b = workspace('2', 'B', 'failed');
    const task = { workspaces: [b, a], workspace: b };
    expect(deviceWorkspace(task, 'alice', 'A')).toBe(a);
    expect(deviceWorkspace(task, 'alice', 'B')).toBe(b);
    expect(deviceWorkspace(task, 'bob', 'A')).toBeNull();
    expect(deviceWorkspace(task, 'alice')).toBeNull();
  });

  it('ignores workspaces from stopped claims and does not fall back to stale state', () => {
    const old = workspace('1', 'A', 'stopped'), fresh = workspace('2', 'A', 'provisioning');
    expect(deviceWorkspace({ workspaces: [old, fresh], workspace: null }, 'alice', 'A')).toBe(fresh);
    expect(deviceWorkspace({ workspaces: [], workspace: old }, 'alice', 'A')).toBeNull();
  });
});
