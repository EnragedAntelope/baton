import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

describe('README.md sync with CLI', () => {
  const commands = ['init', 'status', 'claim', 'pass', 'pickup', 'steal', 'undo', 'log', 'doctor', 'scan', 'compact', 'task'];

  it('mentions every CLI command', async () => {
    const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');
    for (const cmd of commands) {
      expect(readme, `README.md should mention command: ${cmd}`).toContain(cmd);
    }
  });
});
