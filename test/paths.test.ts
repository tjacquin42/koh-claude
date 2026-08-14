import { describe, expect, it } from 'vitest';
import { groupsFile, kohClaudeHome, spoolDirs } from '../src/paths';

describe('paths', () => {
  it('utilise KOH_CLAUDE_HOME quand il est posé', () => {
    expect(kohClaudeHome({ KOH_CLAUDE_HOME: '/tmp/koh' })).toBe('/tmp/koh');
  });

  it('retombe sur ~/.koh-claude', () => {
    expect(kohClaudeHome({ HOME: '/Users/x' })).toBe('/Users/x/.koh-claude');
  });

  it('dérive les cinq sous-dossiers', () => {
    expect(spoolDirs('/tmp/koh').events).toBe('/tmp/koh/events');
    expect(spoolDirs('/tmp/koh').sessions).toBe('/tmp/koh/sessions');
    expect(spoolDirs('/tmp/koh').requests).toBe('/tmp/koh/requests');
    expect(spoolDirs('/tmp/koh').rejected).toBe('/tmp/koh/events/rejected');
    expect(spoolDirs('/tmp/koh').backups).toBe('/tmp/koh/backups');
  });

  it('place le classement en dossiers à la racine de l état', () => {
    expect(groupsFile('/tmp/koh')).toBe('/tmp/koh/groups.json');
  });
});
