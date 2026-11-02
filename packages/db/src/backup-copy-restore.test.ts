import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const database = await startEmbeddedPostgresTestDatabase("sps-db-copy-restore-");
  cleanups.push(database.cleanup);
  return database.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

async function writePlainBackup(directory: string, name: string, lines: string[]): Promise<string> {
  const backupFile = path.join(directory, name);
  await fs.promises.writeFile(backupFile, `${lines.join("\n")}\n`, "utf8");
  return backupFile;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres COPY restore test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("database COPY backup restore", () => {
  it(
    "round trips COPY data through the JavaScript restore fallback without interpreting row text as SQL boundaries",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "sps_copy_restore_target",
      );
      const backupDir = createTempDir("sps-db-copy-restore-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const previousPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      const previousPsqlPath = process.env.PAPERCLIP_PSQL_PATH;
      const unavailableBinary = path.join(backupDir, "owned-missing-postgres-tool");

      try {
        await sourceSql.unsafe(`
          CREATE TABLE public.backup_copy_restore_edge_values (
            id integer PRIMARY KEY,
            text_value text NOT NULL,
            byte_value bytea NOT NULL,
            json_value jsonb NOT NULL,
            array_value text[] NOT NULL,
            boolean_value boolean NOT NULL,
            numeric_value numeric(40, 9) NOT NULL,
            timestamp_value timestamptz NOT NULL,
            date_value date NOT NULL,
            nullable_value text,
            empty_value text NOT NULL
          );
          CREATE TABLE public.backup_copy_restore_single_value (value text NOT NULL);
        `);

        const statementBreakpoint = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";
        const literalNullToken = "\\N";
        const textCases = [
          "",
          "tab\tseparated",
          "first line\nsecond line",
          "first line\rsecond line",
          literalNullToken,
          "trailing\\",
          "literal\\.",
          "form-feed\fbackspace\bvertical-tab\v",
          statementBreakpoint,
          "Robert'); DROP TABLE companies; --",
          "unicode: 東京 🛰️ café",
        ];
        for (let id = 0; id < 128; id += 1) {
          const textValue = textCases[id % textCases.length]!;
          const byteValue = Buffer.from([0x00, id, 0x5c, 0xff, 0x0a]);
          const jsonValue = { id, value: textValue, marker: statementBreakpoint };
          const arrayValue = [textValue, literalNullToken, "", "line\nbreak"];
          const numericValue = `12345678901234567890.${String((id * 17) % 1_000_000_000).padStart(9, "0")}`;
          await sourceSql`
            INSERT INTO public.backup_copy_restore_edge_values
              (id, text_value, byte_value, json_value, array_value, boolean_value, numeric_value,
                timestamp_value, date_value, nullable_value, empty_value)
            VALUES (
              ${id}, ${textValue}, ${byteValue}, ${sourceSql.json(jsonValue)}::jsonb, ${arrayValue},
              ${id % 2 === 0}, ${numericValue}::numeric,
              CASE WHEN ${id} = 0 THEN 'infinity'::timestamptz ELSE '2026-10-30 12:34:56.789+00'::timestamptz END,
              CASE WHEN ${id} = 0 THEN 'infinity'::date ELSE '2026-10-30'::date END,
              ${id === 0 ? null : textValue}, ${""}
            )
          `;
        }
        await sourceSql`INSERT INTO public.backup_copy_restore_single_value (value) VALUES (${statementBreakpoint})`;

        const sourceRows = await sourceSql.unsafe<{
          id: number;
          text_value: string;
          byte_value: string;
          json_value: string;
          array_value: string[];
          boolean_value: boolean;
          numeric_value: string;
          timestamp_value: string;
          date_value: string;
          nullable_value: string | null;
          empty_value: string;
        }[]>(`
          SELECT id, text_value, encode(byte_value, 'hex') AS byte_value, json_value::text AS json_value,
            array_value, boolean_value, numeric_value::text AS numeric_value,
            timestamp_value::text AS timestamp_value, date_value::text AS date_value, nullable_value, empty_value
          FROM public.backup_copy_restore_edge_values
          ORDER BY id
        `);
        const sourceMigrationHistory = await sourceSql.unsafe<{ hash: string; created_at: string }[]>(`
          SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY hash
        `);
        expect(sourceRows).toHaveLength(128);

        process.env.PAPERCLIP_PG_DUMP_PATH = unavailableBinary;
        process.env.PAPERCLIP_PSQL_PATH = unavailableBinary;
        expect(fs.existsSync(unavailableBinary)).toBe(false);

        const backup = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "sps-copy-fallback-test",
        });
        const archiveSql = gunzipSync(await fs.promises.readFile(backup.backupFile)).toString("utf8");
        expect(archiveSql).toContain('COPY "public"."backup_copy_restore_edge_values"');
        expect(archiveSql).toContain('COPY "public"."backup_copy_restore_single_value"');

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: backup.backupFile,
        });

        const restoredRows = await restoreSql.unsafe(`
          SELECT id, text_value, encode(byte_value, 'hex') AS byte_value, json_value::text AS json_value,
            array_value, boolean_value, numeric_value::text AS numeric_value,
            timestamp_value::text AS timestamp_value, date_value::text AS date_value, nullable_value, empty_value
          FROM public.backup_copy_restore_edge_values
          ORDER BY id
        `);
        expect(restoredRows).toEqual(sourceRows);
        const markerRows = await restoreSql<{ value: string }[]>`
          SELECT value FROM public.backup_copy_restore_single_value
        `;
        expect(markerRows).toEqual([{ value: statementBreakpoint }]);
        const restoredMigrationHistory = await restoreSql.unsafe<{ hash: string; created_at: string }[]>(`
          SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY hash
        `);
        expect(restoredMigrationHistory).toEqual(sourceMigrationHistory);

        const assertTableAbsent = async (tableName: string) => {
          const rows = await restoreSql<{ absent: boolean }[]>`
            SELECT to_regclass(${`public.${tableName}`}) IS NULL AS absent
          `;
          expect(rows).toEqual([{ absent: true }]);
        };
        const marker = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";
        const truncatedTable = "copy_reject_truncated";
        const truncatedBackup = await writePlainBackup(backupDir, "copy-truncated.sql", [
          "BEGIN;",
          marker,
          `CREATE TABLE public.${truncatedTable} (value text NOT NULL);`,
          marker,
          `COPY public.${truncatedTable} (value) FROM stdin;`,
          ...Array.from({ length: 110 }, (_, index) => `row-${index}`),
        ]);
        await expect(runDatabaseRestore({ connectionString: restoreConnectionString, backupFile: truncatedBackup }))
          .rejects.toThrow(/unterminated COPY/i);
        await assertTableAbsent(truncatedTable);

        const invalidValueTable = "copy_reject_invalid_value";
        const invalidValueBackup = await writePlainBackup(backupDir, "copy-invalid-value.sql", [
          "BEGIN;",
          marker,
          `CREATE TABLE public.${invalidValueTable} (value integer NOT NULL);`,
          marker,
          `COPY public.${invalidValueTable} (value) FROM stdin;`,
          "1",
          "2",
          "not-an-integer",
          "\\.",
          marker,
          "COMMIT;",
          marker,
        ]);
        await expect(runDatabaseRestore({ connectionString: restoreConnectionString, backupFile: invalidValueBackup }))
          .rejects.toThrow(/invalid input syntax for type integer/i);
        await assertTableAbsent(invalidValueTable);

        const inconsistentTable = "copy_reject_inconsistent_fields";
        const inconsistentBackup = await writePlainBackup(backupDir, "copy-inconsistent-fields.sql", [
          "BEGIN;",
          marker,
          `CREATE TABLE public.${inconsistentTable} (first_value text NOT NULL, second_value text NOT NULL);`,
          marker,
          `COPY public.${inconsistentTable} (first_value, second_value) FROM stdin;`,
          "first\tsecond",
          "only-one-field",
          "\\.",
          marker,
          "COMMIT;",
          marker,
        ]);
        await expect(runDatabaseRestore({ connectionString: restoreConnectionString, backupFile: inconsistentBackup }))
          .rejects.toThrow(/inconsistent COPY field counts/i);
        await assertTableAbsent(inconsistentTable);

        const escapedTextTable = "copy_valid_escaped_text";
        const escapedTextBackup = await writePlainBackup(backupDir, "copy-valid-escaped-text.sql", [
          "BEGIN;",
          marker,
          `CREATE TABLE public.${escapedTextTable} (value text NOT NULL);`,
          marker,
          `COPY public.${escapedTextTable} (value) FROM stdin;`,
          "H\\x65llo\\040\\342\\202\\254",
          "\\.",
          marker,
          "COMMIT;",
          marker,
        ]);
        await runDatabaseRestore({ connectionString: restoreConnectionString, backupFile: escapedTextBackup });
        const escapedTextRows = await restoreSql.unsafe<{ value: string }[]>(`
          SELECT value FROM public.${escapedTextTable}
        `);
        expect(escapedTextRows).toEqual([{ value: "Hello €" }]);
      } finally {
        if (previousPgDumpPath === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = previousPgDumpPath;
        if (previousPsqlPath === undefined) delete process.env.PAPERCLIP_PSQL_PATH;
        else process.env.PAPERCLIP_PSQL_PATH = previousPsqlPath;
        await Promise.all([sourceSql.end(), restoreSql.end()]);
      }
    },
    60_000,
  );
});
