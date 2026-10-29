import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateThreadFolders from "./074_ProjectionProjectThreadFolders.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "074_ProjectionProjectThreadFolders",
  (it) => {
    it.effect("adds folders to existing projects without touching them, and reruns safely", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 73 });
        const now = "2026-01-01T00:00:00.000Z";
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES ('project-1', 'Existing', '/work/project-1', NULL, '[]', ${now}, ${now}, NULL)
        `;
        yield* runMigrations({ toMigrationInclusive: 74 });
        const selectProject = sql<{
          readonly threadFolders: string | null;
          readonly updatedAt: string;
        }>`
          SELECT thread_folders_json AS "threadFolders", updated_at AS "updatedAt"
          FROM projection_projects WHERE project_id = 'project-1'
        `;
        assert.deepEqual(yield* selectProject, [{ threadFolders: null, updatedAt: now }]);
        yield* sql`UPDATE projection_projects SET thread_folders_json = '[]'`;
        yield* migrateThreadFolders;
        assert.deepEqual(yield* selectProject, [{ threadFolders: "[]", updatedAt: now }]);
      }),
    );
  },
);
