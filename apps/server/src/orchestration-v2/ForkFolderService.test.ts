import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadFolderId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ForkFolderService from "./ForkFolderService.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:fork-folders");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in fork folder tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** `crashFiling` fails the first move of that thread, as a crash between commits would. */
function makeHarness(options: { readonly crashFiling?: ThreadId } = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "fork-folders" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({});
  const layerStores = Layer.mergeAll(
    ProjectStore.layer,
    ProjectionStore.layer,
    EffectOutbox.layer,
    CommandReceiptStore.layer,
  ).pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(Layer.mergeAll(layerOrchestrator, layerServerSettings, layerStores)),
  );
  const layerProjects = ProjectService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerOrchestrator,
        layerStores,
        layerServerSettings,
        IdAllocator.layer,
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({}),
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: true,
            }),
          invalidate: () => Effect.void,
        }),
        Layer.succeed(WorkspacePaths.WorkspacePaths, {
          normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
          resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
            Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
        }),
      ),
    ),
  );
  const crashFiling = options.crashFiling;
  const layerFilingThreads =
    crashFiling === undefined
      ? layerThreadManagement
      : Layer.effect(
          ThreadManagement.ThreadManagementService,
          Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            const crashed = yield* Ref.make(false);
            return ThreadManagement.ThreadManagementService.of({
              ...threads,
              dispatch: (command) =>
                Effect.gen(function* () {
                  if (
                    command.type === "thread.folder.set" &&
                    command.threadId === crashFiling &&
                    !(yield* Ref.getAndSet(crashed, true))
                  ) {
                    return yield* Effect.die("simulated crash before filing");
                  }
                  return yield* threads.dispatch(command);
                }),
            });
          }),
        ).pipe(Layer.provide(layerThreadManagement));
  const layerForkFolders = ForkFolderService.layer.pipe(
    Layer.provide(Layer.mergeAll(layerFilingThreads, layerProjects, layerStores)),
  );
  return Layer.mergeAll(
    layerOrchestrator,
    layerThreadManagement,
    layerProjects,
    layerForkFolders,
    layerStores,
    layerDatabase,
  );
}

const createProject = Effect.fn("ForkFolderTest.createProject")(function* () {
  const projects = yield* ProjectService.ProjectService;
  yield* projects.create({
    commandId: CommandId.make("command:fork-folders:project"),
    projectId,
    title: "Fork folders",
    workspaceRoot: "/work/fork-folders",
  });
});

/** Gives a thread a settled run, so it can be forked from. */
const recordRun = Effect.fn("ForkFolderTest.recordRun")(function* (threadId: ThreadId) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const runId = RunId.make(`${threadId}:run`);
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`${threadId}:run`),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`${threadId}:message`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ],
  });
});

const createThread = Effect.fn("ForkFolderTest.createThread")(function* (
  name: string,
  title: string,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`command:create:${name}`),
    threadId,
    projectId,
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* recordRun(threadId);
  return threadId;
});

const fork = Effect.fn("ForkFolderTest.fork")(function* (sourceThreadId: ThreadId, name: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* threads.dispatch({
    type: "thread.fork",
    commandId: CommandId.make(`command:fork:${name}`),
    sourceThreadId,
    targetThreadId: threadId,
    sourcePoint: { type: "run", runId: RunId.make(`${sourceThreadId}:run`) },
    createdBy: "user",
    creationSource: "web",
  });
  yield* recordRun(threadId);
  return threadId;
});

const place = Effect.fn("ForkFolderTest.place")(function* (
  sourceThreadId: ThreadId,
  threadId: ThreadId,
) {
  const forkFolders = yield* ForkFolderService.ForkFolderService;
  yield* forkFolders.place({ sourceThreadId, threadId });
});

const foldersOf = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  return Option.getOrThrow(yield* projects.getById(projectId)).threadFolders ?? [];
});

const folderOf = Effect.fn("ForkFolderTest.folderOf")(function* (threadId: ThreadId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return (yield* threads.getThreadShell(threadId))?.threadFolderId;
});

const fileThread = Effect.fn("ForkFolderTest.fileThread")(function* (
  threadId: ThreadId,
  threadFolderId: ThreadFolderId,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.folder.set",
    commandId: CommandId.make(`command:file:${threadId}:${threadFolderId}`),
    threadId,
    threadFolderId,
  });
});

const createFolder = Effect.fn("ForkFolderTest.createFolder")(function* (
  name: string,
  parentFolderId: ThreadFolderId | null,
) {
  const projects = yield* ProjectService.ProjectService;
  const folderId = ThreadFolderId.make(`folder:${name}`);
  yield* projects.createThreadFolder({
    commandId: CommandId.make(`command:folder:${name}`),
    projectId,
    folderId,
    parentFolderId,
    name,
  });
  return folderId;
});

describe("ForkFolderService", () => {
  it.effect("files a forked chat and its source into a subfolder named after the source", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* createProject();
      const source = yield* createThread("source", "Increase revenue");
      const sourceBefore = yield* threads.getThreadShell(source);
      const copy = yield* fork(source, "copy");
      assert.deepEqual(
        (yield* outbox.listByCommandId(CommandId.make("command:fork:copy"))).map((effect) => [
          effect.threadId,
          effect.request,
        ]),
        [[source, { type: "fork-folder.place", sourceThreadId: source, threadId: copy }]],
      );

      yield* place(source, copy);
      const [family, ...others] = yield* foldersOf;
      assert.deepEqual(others, []);
      assert.deepInclude(family, {
        name: "Increase revenue",
        parentFolderId: null,
        forkRootThreadId: source,
        deletedAt: null,
      });
      assert.equal(yield* folderOf(source), family!.id);
      assert.equal(yield* folderOf(copy), family!.id);
      const sourceAfter = yield* threads.getThreadShell(source);
      assert.deepEqual(sourceAfter?.updatedAt, sourceBefore?.updatedAt);
    }).pipe(Effect.provide(makeHarness())),
  );

  it.effect("puts later copies of the source, and copies of a copy, in the same subfolder", () =>
    Effect.gen(function* () {
      yield* createProject();
      const source = yield* createThread("source", "Increase revenue");
      const copy = yield* fork(source, "copy");
      yield* place(source, copy);
      const [family] = yield* foldersOf;

      const second = yield* fork(source, "second-copy");
      yield* place(source, second);
      const copyOfCopy = yield* fork(copy, "copy-of-copy");
      yield* place(copy, copyOfCopy);

      assert.deepEqual(yield* foldersOf, [family!]);
      for (const threadId of [source, copy, second, copyOfCopy]) {
        assert.equal(yield* folderOf(threadId), family!.id);
      }
    }).pipe(Effect.provide(makeHarness())),
  );

  it.effect("nests the subfolder inside the folder the source is already in", () =>
    Effect.gen(function* () {
      yield* createProject();
      const revenue = yield* createFolder("Revenue", null);
      const source = yield* createThread("source", "Pricing page");
      yield* fileThread(source, revenue);
      const copy = yield* fork(source, "copy");
      assert.equal(yield* folderOf(copy), revenue);

      yield* place(source, copy);
      const family = (yield* foldersOf).find((folder) => folder.forkRootThreadId === source);
      assert.deepInclude(family, { name: "Pricing page", parentFolderId: revenue });
      assert.equal(yield* folderOf(source), family!.id);
      assert.equal(yield* folderOf(copy), family!.id);
    }).pipe(Effect.provide(makeHarness())),
  );

  it.effect("makes a new subfolder where the source now is instead of pulling it back", () =>
    Effect.gen(function* () {
      yield* createProject();
      const source = yield* createThread("source", "Increase revenue");
      const copy = yield* fork(source, "copy");
      yield* place(source, copy);
      const [family] = yield* foldersOf;
      const revenue = yield* createFolder("Revenue", null);
      yield* fileThread(source, revenue);

      const second = yield* fork(source, "second-copy");
      yield* place(source, second);
      const secondFamily = (yield* foldersOf).find(
        (folder) => folder.forkRootThreadId === source && folder.id !== family!.id,
      );
      assert.deepInclude(secondFamily, { name: "Increase revenue", parentFolderId: revenue });
      assert.equal(yield* folderOf(source), secondFamily!.id);
      assert.equal(yield* folderOf(second), secondFamily!.id);
      assert.equal(yield* folderOf(copy), family!.id);
    }).pipe(Effect.provide(makeHarness())),
  );

  it.effect("places one family's forks one at a time, so they never make two folders", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* createProject();
      const source = yield* createThread("source", "Increase revenue");
      const copy = yield* fork(source, "copy");
      const second = yield* fork(source, "second-copy");
      const copyOfCopy = yield* fork(copy, "copy-of-copy");
      const claim = outbox.claimNext({ workerId: "worker" });

      for (const expected of [copy, second, copyOfCopy]) {
        const effect = Option.getOrThrow(yield* claim);
        assert.isTrue(Option.isNone(yield* claim));
        assert.equal(effect.request.type, "fork-folder.place");
        if (effect.request.type !== "fork-folder.place") return;
        assert.equal(effect.request.threadId, expected);
        yield* place(effect.request.sourceThreadId, effect.request.threadId);
        yield* outbox.succeed({ effectId: effect.id, workerId: "worker" });
      }
      const [family, ...others] = yield* foldersOf;
      assert.deepEqual(others, []);
      for (const threadId of [source, copy, second, copyOfCopy]) {
        assert.equal(yield* folderOf(threadId), family!.id);
      }
    }).pipe(Effect.provide(makeHarness())),
  );

  it.effect("replays without new events and finishes after a crash between commits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createProject();
      const source = yield* createThread("source", "Increase revenue");
      const copy = yield* fork(source, "copy");

      assert.equal((yield* Effect.exit(place(source, copy)))._tag, "Failure");
      const [family] = yield* foldersOf;
      assert.equal(family?.forkRootThreadId, source);
      assert.notEqual(yield* folderOf(source), family!.id);

      yield* place(source, copy);
      assert.deepEqual(yield* foldersOf, [family!]);
      assert.equal(yield* folderOf(source), family!.id);
      assert.equal(yield* folderOf(copy), family!.id);

      const sequences = Effect.all([
        orchestrator.getThreadEventSequence(source),
        orchestrator.getThreadEventSequence(copy),
        sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${projectId}
        `,
      ]);
      const before = yield* sequences;
      yield* place(source, copy);
      assert.deepEqual(yield* sequences, before);
      assert.deepEqual(yield* foldersOf, [family!]);
    }).pipe(Effect.provide(makeHarness({ crashFiling: ThreadId.make("thread:source") }))),
  );

  it.effect("leaves the fork where it started when the source is archived or nested too deep", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* createProject();
      const archived = yield* createThread("archived", "Archived");
      const archivedCopy = yield* fork(archived, "archived-copy");
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:archive"),
        threadId: archived,
      });
      yield* place(archived, archivedCopy);
      assert.deepEqual(yield* foldersOf, []);
      assert.isUndefined(yield* folderOf(archivedCopy));

      let deepest: ThreadFolderId | null = null;
      for (let level = 1; level <= 6; level++) {
        deepest = yield* createFolder(`level-${level}`, deepest);
      }
      const nested = yield* createThread("nested", "Nested");
      yield* fileThread(nested, deepest!);
      const nestedCopy = yield* fork(nested, "nested-copy");
      yield* place(nested, nestedCopy);
      assert.lengthOf(yield* foldersOf, 6);
      assert.equal(yield* folderOf(nested), deepest);
      assert.equal(yield* folderOf(nestedCopy), deepest);
    }).pipe(Effect.provide(makeHarness())),
  );
});
