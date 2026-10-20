import { createRequire } from 'node:module';

/** The package whose maintainers own the analytics endpoint. */
export const UPSTREAM_PACKAGE_NAME = '@fission-ai/openspec';

const { name } = createRequire(import.meta.url)('../../package.json') as { name: string };

/**
 * True only for the upstream build. A redistributed fork (for example
 * `@rainchan/openspec`) must not report usage to the upstream project's
 * analytics, so telemetry stays off for it regardless of user settings.
 */
export function isUpstreamDistribution(): boolean {
  return name === UPSTREAM_PACKAGE_NAME;
}
