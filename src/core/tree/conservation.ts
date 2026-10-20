import {
  diffScenarioNames,
  extractRequirementsSection,
  normalizeRequirementName,
  type RequirementBlock,
} from '../parsers/requirement-blocks.js';
import { isWithinSubtree, type TreeIssue } from './config.js';
import type { RestructureManifest } from './manifest.js';
import { treeSpecs, type SpecsTree } from './simulate.js';

/**
 * Conservation: an independent re-derivation of where every requirement block
 * must end up under the manifest, checked against the simulated tree. Moves
 * must be byte-identical (after newline normalization and trimming), renames
 * may only change the header line, merges must map every dropped scenario, and
 * nothing outside the manifest may change.
 */

const NO_BLOCK: RequirementBlock = { headerLine: '', name: '', raw: '' };

export function scenarioNames(raw: string): string[] {
  return diffScenarioNames({ headerLine: '', name: '', raw }, NO_BLOCK).missing;
}

function normalize(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

function bodyWithoutHeader(raw: string): string {
  return normalize(raw).split('\n').slice(1).join('\n').trim();
}

interface TrackedBlock {
  original: { capability: string; name: string; raw: string };
  location: { capability: string; name: string };
  dropped?: { keepId: number; scenarios: Record<string, string> };
}

function locationKey(capability: string, name: string): string {
  return `${capability}\u0000${normalizeRequirementName(name)}`;
}

export function checkConservation(
  before: SpecsTree,
  after: SpecsTree,
  manifest: RestructureManifest,
  modifiedByDeltas: ReadonlyArray<{ capability: string; name: string }>
): TreeIssue[] {
  const issues: TreeIssue[] = [];
  const tracked: TrackedBlock[] = [];
  for (const [capability, content] of treeSpecs(before)) {
    for (const block of extractRequirementsSection(content).bodyBlocks) {
      tracked.push({
        original: { capability, name: block.name, raw: block.raw },
        location: { capability, name: normalizeRequirementName(block.name) },
      });
    }
  }
  const live = () => tracked.filter((block) => !block.dropped);
  const at = (capability: string, name: string) =>
    live().findIndex((block) => locationKey(block.location.capability, block.location.name) === locationKey(capability, name));

  for (const operation of manifest.operations) {
    switch (operation.op) {
      case 'move-capability':
        for (const block of live()) {
          if (isWithinSubtree(block.location.capability, operation.from)) {
            block.location.capability = `${operation.to}${block.location.capability.slice(operation.from.length)}`;
          }
        }
        break;
      case 'move-requirement': {
        const index = at(operation.from, operation.requirement);
        if (index !== -1) {
          const block = live()[index];
          block.location = {
            capability: operation.to,
            name: normalizeRequirementName(operation.renameTo ?? block.location.name),
          };
        }
        break;
      }
      case 'merge-requirement': {
        const keepIndex = at(operation.keep.capability, operation.keep.requirement);
        const dropIndex = at(operation.drop.capability, operation.drop.requirement);
        if (keepIndex !== -1 && dropIndex !== -1) {
          const keep = live()[keepIndex];
          live()[dropIndex].dropped = { keepId: tracked.indexOf(keep), scenarios: operation.scenarios };
        }
        break;
      }
      default:
        break;
    }
  }

  const afterBlocks = new Map<string, RequirementBlock>();
  for (const [capability, content] of treeSpecs(after)) {
    for (const block of extractRequirementsSection(content).bodyBlocks) {
      afterBlocks.set(locationKey(capability, block.name), block);
    }
  }
  const keepIds = new Set(tracked.filter((block) => block.dropped).map((block) => block.dropped!.keepId));
  const modifiedKeys = new Set(modifiedByDeltas.map((entry) => locationKey(entry.capability, entry.name)));
  const accounted = new Set<string>();

  for (const [id, block] of tracked.entries()) {
    if (block.dropped) continue;
    const key = locationKey(block.location.capability, block.location.name);
    const label = `${block.original.capability}#${block.original.name}`;
    const found = afterBlocks.get(key);
    if (!found) {
      issues.push({
        level: 'ERROR',
        code: 'CONSERVATION_UNDECLARED_CHANGE',
        path: `${block.original.capability}/spec.md`,
        message: `Requirement ${label} is missing after the restructure (expected at ${block.location.capability}#${block.location.name}).`,
      });
      continue;
    }
    accounted.add(key);
    const declaredRewrite = keepIds.has(id) && modifiedKeys.has(key);
    if (declaredRewrite) continue;
    const renamed = normalizeRequirementName(block.original.name) !== block.location.name;
    const same = renamed
      ? bodyWithoutHeader(block.original.raw) === bodyWithoutHeader(found.raw)
      : normalize(block.original.raw) === normalize(found.raw);
    if (!same) {
      issues.push({
        level: 'ERROR',
        code: 'CONSERVATION_UNDECLARED_CHANGE',
        path: `${block.location.capability}/spec.md`,
        message: modifiedKeys.has(key)
          ? `Requirement ${block.location.capability}#${block.location.name} is MODIFIED, but a restructure change may only rewrite a requirement it keeps in merge-requirement.`
          : `Requirement ${label} changed text during the restructure; moves must be byte-identical${renamed ? ' apart from the renamed header' : ''}.`,
      });
    }
  }

  for (const [key, block] of afterBlocks) {
    if (accounted.has(key)) continue;
    const [capability] = key.split('\u0000');
    issues.push({
      level: 'ERROR',
      code: 'CONSERVATION_UNDECLARED_CHANGE',
      path: `${capability}/spec.md`,
      message: `Requirement ${capability}#${block.name} appears after the restructure but is not accounted for by any manifest operation.`,
    });
  }

  for (const block of tracked) {
    if (!block.dropped) continue;
    const keep = tracked[block.dropped.keepId];
    const keepAfter = afterBlocks.get(locationKey(keep.location.capability, keep.location.name));
    const keepScenarios = new Set(keepAfter ? scenarioNames(keepAfter.raw) : []);
    const dropScenarios = scenarioNames(block.original.raw);
    const label = `${block.original.capability}#${block.original.name}`;
    for (const scenario of dropScenarios) {
      const mapped = block.dropped.scenarios[scenario];
      if (mapped === undefined) {
        issues.push({
          level: 'ERROR',
          code: 'CONSERVATION_UNMAPPED_SCENARIO',
          path: 'restructure.yaml',
          message: `Scenario "${scenario}" of dropped requirement ${label} has no mapping in merge-requirement.scenarios.`,
        });
      } else if (!keepScenarios.has(mapped)) {
        issues.push({
          level: 'ERROR',
          code: 'CONSERVATION_UNMAPPED_SCENARIO',
          path: 'restructure.yaml',
          message: `Scenario "${scenario}" of ${label} maps to "${mapped}", which ${keep.location.capability}#${keep.location.name} does not have after this change's MODIFIED delta.`,
        });
      }
    }
    for (const key of Object.keys(block.dropped.scenarios)) {
      if (!dropScenarios.includes(key)) {
        issues.push({
          level: 'ERROR',
          code: 'CONSERVATION_UNMAPPED_SCENARIO',
          path: 'restructure.yaml',
          message: `merge-requirement.scenarios maps "${key}", which is not a scenario of ${label}.`,
        });
      }
    }
  }

  return issues;
}
