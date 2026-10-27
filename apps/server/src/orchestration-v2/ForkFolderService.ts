import {
  CommandId,
  type OrchestrationV2ThreadShell,
  resolveLiveThreadFolderId,
  type StoredThreadFolder,
  THREAD_FOLDER_MAX_DEPTH,
  THREAD_FOLDER_MAX_LIVE,
  THREAD_FOLDER_NAME_MAX_LENGTH,
  threadFolderDepth,
  ThreadFolderId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ForkFolderService extends Context.Service<
  ForkFolderService,
  {
    /**
     * Files a fork with its source in the source's family subfolder, or makes one where the
     * source sits. Ids derive from the fork, so a retry finishes the same work.
     */
    readonly place: (input: {
      readonly sourceThreadId: ThreadId;
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ProjectService.ProjectServiceError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ForkFolderService") {}

type ThreadShell = OrchestrationV2ThreadShell;

const isOpen = (thread: ThreadShell | null): thread is ThreadShell =>
  thread !== null && thread.archivedAt === null && thread.deletedAt === null;

// Cut between code points; `slice` can split an emoji and leave an invalid name.
function folderNameOf(title: string): string {
  let name = "";
  for (const character of title) {
    if (name.length + character.length > THREAD_FOLDER_NAME_MAX_LENGTH) break;
    name += character;
  }
  return name.trim();
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const projectRows = yield* ProjectStore.ProjectStoreV2;

  /** The folder collecting the source's family: its own, or that of a fork it descends from. */
  const familyFolderOf = Effect.fn("ForkFolderService.familyFolderOf")(function* (
    folders: ReadonlyArray<StoredThreadFolder>,
    source: ThreadShell,
  ) {
    const folderId = resolveLiveThreadFolderId(folders, source.threadFolderId);
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (folder?.forkRootThreadId == null) return undefined;
    const seen = new Set<ThreadId>();
    for (let thread = source; ;) {
      if (thread.id === folder.forkRootThreadId) return folder;
      if (thread.forkedFrom?.type !== "run" || seen.has(thread.id)) return undefined;
      seen.add(thread.id);
      const parent = yield* threads.getThreadShell(thread.forkedFrom.threadId);
      if (
        parent === null ||
        resolveLiveThreadFolderId(folders, parent.threadFolderId) !== folderId
      ) {
        return undefined;
      }
      thread = parent;
    }
  });

  const createFamilyFolder = Effect.fn("ForkFolderService.createFamilyFolder")(function* (
    folders: ReadonlyArray<StoredThreadFolder>,
    source: ThreadShell,
    forkThreadId: ThreadId,
  ) {
    // Only this fork makes this folder, so a retry finds the one an interrupted attempt made.
    const folderId = ThreadFolderId.make(`fork:${source.id}:${forkThreadId}`);
    const made = folders.find((folder) => folder.id === folderId);
    if (made !== undefined) return made.deletedAt === null ? folderId : undefined;
    const parentFolderId = resolveLiveThreadFolderId(folders, source.threadFolderId);
    if (
      threadFolderDepth(folders, parentFolderId) >= THREAD_FOLDER_MAX_DEPTH ||
      folders.filter((folder) => folder.deletedAt === null).length >= THREAD_FOLDER_MAX_LIVE
    ) {
      return undefined;
    }
    yield* projects.createThreadFolder({
      commandId: CommandId.make(`server:fork-folder:${forkThreadId}:create:${folderId}`),
      projectId: source.projectId,
      folderId,
      parentFolderId,
      name: folderNameOf(source.title),
      forkRootThreadId: source.id,
    });
    return folderId;
  });

  const file = Effect.fn("ForkFolderService.file")(function* (
    thread: ThreadShell,
    threadFolderId: ThreadFolderId,
    forkThreadId: ThreadId,
  ) {
    if (thread.threadFolderId === threadFolderId) return;
    yield* threads.dispatch({
      type: "thread.folder.set",
      commandId: CommandId.make(
        `server:fork-folder:${forkThreadId}:file:${thread.id}:${threadFolderId}`,
      ),
      threadId: thread.id,
      threadFolderId,
    });
  });

  const place: ForkFolderService["Service"]["place"] = Effect.fn("ForkFolderService.place")(
    function* (input) {
      const source = yield* threads.getThreadShell(input.sourceThreadId);
      const fork = yield* threads.getThreadShell(input.threadId);
      if (!isOpen(source) || !isOpen(fork) || fork.projectId !== source.projectId) return;
      const project = yield* projectRows.get(source.projectId);
      if (Option.isNone(project)) return;
      const folders = project.value.threadFolders;

      const family = yield* familyFolderOf(folders, source);
      if (family !== undefined) return yield* file(fork, family.id, fork.id);
      // An older family folder the source has left stays as the user arranged it.
      const folderId = yield* createFamilyFolder(folders, source, fork.id);
      if (folderId === undefined) return;
      yield* file(source, folderId, fork.id);
      yield* file(fork, folderId, fork.id);
    },
  );

  return ForkFolderService.of({ place });
});

export const layer = Layer.effect(ForkFolderService, make);
