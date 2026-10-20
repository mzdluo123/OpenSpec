import { afterEach, describe, expect, it } from 'vitest';
import { defaultTreeConfig } from '../../../src/core/tree/config.js';
import { TreeContext } from '../../../src/core/tree/context.js';
import { runTreeChangeRules } from '../../../src/core/tree/change-rules.js';
import { readInflightChanges } from '../../../src/core/tree/change-index.js';
import { findOverlaps } from '../../../src/core/tree/overlap.js';
import { createTreeProject, requirement, spec, type TreeProject } from '../../fixtures/tree/builder.js';

describe('CHANGE_OVERLAP', () => {
  let project: TreeProject | undefined;
  afterEach(async () => {
    await project?.cleanup();
    project = undefined;
  });

  it('groups requirements rewritten by several in-flight changes, folding case and renames', async () => {
    project = await createTreeProject({
      specs: { drafts: spec('drafts', ['Save draft', 'Name rule', 'Untouched']) },
      changes: {
        a: { files: { 'specs/drafts/spec.md': `## MODIFIED Requirements\n\n${requirement({ name: 'Save draft' })}\n` } },
        b: { files: { 'specs/drafts/spec.md': `## REMOVED Requirements\n\n- \`### Requirement: save  DRAFT\`\n` } },
        c: {
          files: {
            'specs/drafts/spec.md': `## RENAMED Requirements\n\n- FROM: \`### Requirement: Name rule\`\n- TO: \`### Requirement: Naming rule\`\n\n## MODIFIED Requirements\n\n${requirement({ name: 'Naming rule' })}\n`,
          },
        },
        d: { files: { 'specs/drafts/spec.md': `## MODIFIED Requirements\n\n${requirement({ name: 'Name rule' })}\n` } },
        e: { files: { 'specs/drafts/spec.md': `## ADDED Requirements\n\n${requirement({ name: 'Save draft v2' })}\n` } },
      },
    });
    const overlaps = findOverlaps(await readInflightChanges(project.paths.changesDir));
    expect(overlaps).toEqual([
      { capability: 'drafts', requirement: 'Name rule', changes: [{ change: 'c', ops: ['RENAMED', 'MODIFIED'] }, { change: 'd', ops: ['MODIFIED'] }] },
      { capability: 'drafts', requirement: 'Save draft', changes: [{ change: 'a', ops: ['MODIFIED'] }, { change: 'b', ops: ['REMOVED'] }] },
    ]);

    const context = new TreeContext(project.paths, defaultTreeConfig());
    const forA = (await runTreeChangeRules(context, 'a')).filter((issue) => issue.code === 'CHANGE_OVERLAP');
    expect(forA).toEqual([expect.objectContaining({ level: 'WARNING', message: expect.stringContaining('also changed by b (REMOVED)') })]);
    expect((await runTreeChangeRules(context, 'e')).filter((issue) => issue.code === 'CHANGE_OVERLAP')).toEqual([]);
  });
});
