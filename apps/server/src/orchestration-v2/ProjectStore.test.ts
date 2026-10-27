import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadFolderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );

    it.effect("keeps thread folders through a project update and reads a NULL column as none", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-thread-folders");
        const event = {
          sequence: 1,
          eventId: EventId.make("event-thread-folders-created"),
          aggregateKind: "project" as const,
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        };
        yield* projects.apply({
          ...event,
          type: "project.created",
          payload: {
            projectId,
            title: "Folders",
            workspaceRoot: "/tmp/project-thread-folders",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });
        assert.deepStrictEqual(Option.getOrThrow(yield* projects.get(projectId)).threadFolders, []);
        const threadFolders = [
          {
            id: ThreadFolderId.make("folder-revenue"),
            parentFolderId: null,
            name: "Increase revenue",
            icon: { kind: "emoji" as const, emoji: "💰" },
            createdAt: "2026-03-25T00:00:00.000Z",
            deletedAt: null,
          },
        ];
        yield* projects.apply({
          ...event,
          sequence: 2,
          eventId: EventId.make("event-thread-folders-updated"),
          type: "project.meta-updated",
          payload: { projectId, threadFolders, updatedAt: "2026-03-24T00:00:00.000Z" },
        });
        yield* projects.apply({
          ...event,
          sequence: 3,
          eventId: EventId.make("event-thread-folders-renamed"),
          type: "project.meta-updated",
          payload: { projectId, title: "Renamed", updatedAt: "2026-03-26T00:00:00.000Z" },
        });
        const updated = Option.getOrThrow(yield* projects.get(projectId));
        assert.deepStrictEqual(updated.threadFolders, threadFolders);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* projects.getShell(projectId)).threadFolders,
          threadFolders,
        );

        yield* sql`UPDATE projection_projects SET thread_folders_json = NULL`;
        assert.deepStrictEqual(Option.getOrThrow(yield* projects.get(projectId)).threadFolders, []);
        assert.notProperty(Option.getOrThrow(yield* projects.getShell(projectId)), "threadFolders");
      }),
    );
  },
);
