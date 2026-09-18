/**
 * Collection engine: discover sources → skip unchanged (fingerprint) →
 * parse → dedup-insert (dedupe_key PK) → record fingerprint.
 *
 * Correctness note: re-parsing is always safe (INSERT OR IGNORE on stable
 * dedup keys); fingerprints are a pure performance optimization.
 */

import type Database from 'better-sqlite3';

import { claudeCollector } from './collectors/claude.js';
import { codexCollector } from './collectors/codex.js';
import { grokCollector } from './collectors/grok.js';
import { hermesCollector } from './collectors/hermes.js';
import { opencodeCollector } from './collectors/opencode.js';
import { piCollector } from './collectors/pi.js';
import {
  getCollectorFingerprint,
  insertRecords,
  setCollectorFingerprint,
} from './store.js';
import type { CollectorEnv, UsageCollector, UsageRecord } from './types.js';
import { fingerprint, sameFingerprint } from './collectors/shared.js';

export const builtinCollectors: UsageCollector[] = [
  claudeCollector,
  codexCollector,
  grokCollector,
  opencodeCollector,
  hermesCollector,
  piCollector,
];

export interface SourceReport {
  agent: string;
  sourcePath: string;
  status: 'collected' | 'unchanged' | 'failed';
  parsed: number;
  inserted: number;
  duplicates: number;
  error?: string;
}

export interface CollectionReport {
  startedAt: string;
  finishedAt: string;
  sources: SourceReport[];
  totals: { parsed: number; inserted: number; duplicates: number; failed: number };
}

export interface RunOptions {
  env?: CollectorEnv;
  collectors?: UsageCollector[];
  /** Force re-parse even when fingerprints match. */
  force?: boolean;
}

export async function runCollection(db: Database.Database, options: RunOptions = {}): Promise<CollectionReport> {
  const collectors = options.collectors ?? builtinCollectors;
  const report: CollectionReport = {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    sources: [],
    totals: { parsed: 0, inserted: 0, duplicates: 0, failed: 0 },
  };

  for (const collector of collectors) {
    let sources;
    try {
      sources = await collector.discover(options.env ?? {});
    } catch (err) {
      report.sources.push({
        agent: collector.agent,
        sourcePath: '(discover)',
        status: 'failed',
        parsed: 0,
        inserted: 0,
        duplicates: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      report.totals.failed++;
      continue;
    }

    for (const source of sources) {
      const fp = await fingerprint(source.path, source.kind === 'sqlite');
      if (!options.force && fp && sameFingerprint(fp, getCollectorFingerprint(db, source.path))) {
        report.sources.push({
          agent: collector.agent,
          sourcePath: source.path,
          status: 'unchanged',
          parsed: 0,
          inserted: 0,
          duplicates: 0,
        });
        continue;
      }

      try {
        const batch: UsageRecord[] = [];
        for await (const record of collector.parse(source)) {
          batch.push(record);
        }
        const { inserted, duplicates } = insertRecords(db, batch, source.path, true);
        // Never pin a fingerprint on a zero-yield parse: a transient bug or
        // unsupported format variant would otherwise mark the file "done"
        // forever. Zero-yield sources are retried on the next run instead.
        if (fp && batch.length > 0) setCollectorFingerprint(db, source.path, collector.agent, fp, batch.length);
        report.sources.push({
          agent: collector.agent,
          sourcePath: source.path,
          status: 'collected',
          parsed: batch.length,
          inserted,
          duplicates,
        });
        report.totals.parsed += batch.length;
        report.totals.inserted += inserted;
        report.totals.duplicates += duplicates;
      } catch (err) {
        report.sources.push({
          agent: collector.agent,
          sourcePath: source.path,
          status: 'failed',
          parsed: 0,
          inserted: 0,
          duplicates: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        report.totals.failed++;
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
