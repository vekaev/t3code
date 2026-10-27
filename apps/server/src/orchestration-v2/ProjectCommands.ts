import {
  type CommandId,
  type EventId,
  MAX_SCRIPT_ID_LENGTH,
  type ModelSelection,
  type ProjectIconOverride,
  ProjectId,
  type ProjectScript,
  SCRIPT_RUN_COMMAND_PATTERN,
  type StoredThreadFolder,
  type ThreadEnvMode,
  THREAD_FOLDER_MAX_DEPTH,
  THREAD_FOLDER_MAX_LIVE,
  THREAD_FOLDER_MAX_TOTAL,
  THREAD_FOLDER_NAME_MAX_LENGTH,
  resolveLiveThreadFolderId,
  threadFolderAncestorIds,
  threadFolderDepth,
  type ThreadFolderId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import type { ProjectRow } from "./ProjectStore.ts";

export interface ProjectCreateCommand {
  readonly type: "project.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectMetaUpdateCommand {
  readonly type: "project.meta.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly autoPull?: boolean;
  readonly faviconPath?: string | null;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export interface ProjectThreadFolderCreateCommand {
  readonly type: "project.thread-folder.create";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly folderId: ThreadFolderId;
  readonly parentFolderId: ThreadFolderId | null;
  readonly name: string;
  readonly icon?: ProjectIconOverride | null;
  readonly forkRootThreadId?: ThreadId;
}

export interface ProjectThreadFolderUpdateCommand {
  readonly type: "project.thread-folder.update";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly folderId: ThreadFolderId;
  readonly name?: string;
  readonly icon?: ProjectIconOverride | null;
  readonly parentFolderId?: ThreadFolderId | null;
}

export interface ProjectThreadFolderTargetCommand {
  readonly type: "project.thread-folder.delete" | "project.thread-folder.restore";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly folderId: ThreadFolderId;
}

export type ProjectCommand =
  | ProjectCreateCommand
  | ProjectMetaUpdateCommand
  | ProjectDeleteCommand
  | ProjectThreadFolderCreateCommand
  | ProjectThreadFolderUpdateCommand
  | ProjectThreadFolderTargetCommand;

export class ProjectCommandInvariantError extends Schema.TaggedError<ProjectCommandInvariantError>()(
  "ProjectCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class ProjectCommandMissingProjectError extends Schema.TaggedError<ProjectCommandMissingProjectError>()(
  "ProjectCommandMissingProjectError",
  {
    commandType: Schema.String,
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist for command '${this.commandType}'.`;
  }
}

export class ProjectWorkspaceConflictError extends Schema.TaggedError<ProjectWorkspaceConflictError>()(
  "ProjectWorkspaceConflictError",
  {
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Active project '${this.conflictingProjectId}' already exists for workspace root '${this.workspaceRoot}'.`;
  }
}

export const ProjectCommandRejection = Schema.Union([
  ProjectCommandInvariantError,
  ProjectCommandMissingProjectError,
  ProjectWorkspaceConflictError,
]);
export type ProjectCommandRejection = typeof ProjectCommandRejection.Type;

const ProjectCommandRejectionJson = Schema.fromJsonString(ProjectCommandRejection);
export const encodeProjectCommandRejection = Schema.encodeSync(ProjectCommandRejectionJson);
export const decodeProjectCommandRejection = Schema.decodeUnknownOption(
  ProjectCommandRejectionJson,
);

export interface ProjectCommandState {
  readonly project: ProjectRow | undefined;
  readonly workspaceOwner: ProjectRow | undefined;
}

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

const isLongMonogram = (icon: ProjectIconOverride | null | undefined) =>
  icon?.kind === "monogram" && Array.from(monogramSegmenter.segment(icon.text)).length > 2;

/** Whether `folderId` or a live folder below it sits deeper than the limit. */
function hasTooDeepFolder(folders: ReadonlyArray<StoredThreadFolder>, folderId: ThreadFolderId) {
  return folders.some(
    (folder) =>
      folder.deletedAt === null &&
      (folder.id === folderId || threadFolderAncestorIds(folders, folder.id).includes(folderId)) &&
      threadFolderDepth(folders, folder.id) > THREAD_FOLDER_MAX_DEPTH,
  );
}

/**
 * Keeps the list within the cap by forgetting the oldest deleted folders, first those that show
 * at the root anyway. Threads in a forgotten folder below a live one move up to the root.
 */
function forgetDeletedFolders(
  folders: ReadonlyArray<StoredThreadFolder>,
): ReadonlyArray<StoredThreadFolder> {
  const excess = folders.length - THREAD_FOLDER_MAX_TOTAL;
  if (excess <= 0) return folders;
  const forgotten = new Map(
    folders
      .flatMap((folder) =>
        folder.deletedAt === null
          ? []
          : [
              {
                folder,
                deletedAt: folder.deletedAt,
                nested: resolveLiveThreadFolderId(folders, folder.id) !== null,
              },
            ],
      )
      .toSorted(
        (left, right) =>
          Number(left.nested) - Number(right.nested) ||
          left.deletedAt.localeCompare(right.deletedAt),
      )
      .slice(0, excess)
      .map(({ folder }) => [folder.id, folder.parentFolderId] as const),
  );
  // A subfolder of a forgotten folder hangs from its parent instead, so it shows where it did.
  const keptParentOf = (parentFolderId: ThreadFolderId | null) => {
    const seen = new Set<ThreadFolderId>();
    let parent = parentFolderId;
    while (parent !== null && forgotten.has(parent)) {
      if (seen.has(parent)) return null;
      seen.add(parent);
      parent = forgotten.get(parent) ?? null;
    }
    return parent;
  };
  return folders.flatMap((folder) => {
    if (forgotten.has(folder.id)) return [];
    const parentFolderId = keptParentOf(folder.parentFolderId);
    return [parentFolderId === folder.parentFolderId ? folder : { ...folder, parentFolderId }];
  });
}

/** The next folder list, or why the change is not allowed. */
function planThreadFolders(
  command:
    | ProjectThreadFolderCreateCommand
    | ProjectThreadFolderUpdateCommand
    | ProjectThreadFolderTargetCommand,
  folders: ReadonlyArray<StoredThreadFolder>,
  occurredAt: string,
): Result.Result<ReadonlyArray<StoredThreadFolder>, string> {
  const existing = folders.find((folder) => folder.id === command.folderId);
  const liveCount = folders.filter((folder) => folder.deletedAt === null).length;
  const isLiveFolder = (id: ThreadFolderId | null) =>
    id === null || folders.some((folder) => folder.id === id && folder.deletedAt === null);
  const nameOf = (name: string) => {
    const trimmed = name.trim();
    return trimmed.length > 0 && trimmed.length <= THREAD_FOLDER_NAME_MAX_LENGTH
      ? trimmed
      : undefined;
  };
  const replace = (folder: StoredThreadFolder) =>
    folders.map((candidate) => (candidate.id === folder.id ? folder : candidate));

  if (command.type === "project.thread-folder.create") {
    const name = nameOf(command.name);
    if (existing !== undefined) return Result.fail(`Folder '${command.folderId}' already exists.`);
    if (name === undefined) {
      return Result.fail(`Folder names must be 1-${THREAD_FOLDER_NAME_MAX_LENGTH} characters.`);
    }
    if (isLongMonogram(command.icon)) {
      return Result.fail("Folder monograms must contain at most two characters.");
    }
    if (!isLiveFolder(command.parentFolderId)) {
      return Result.fail(`Parent folder '${command.parentFolderId}' does not exist.`);
    }
    if (liveCount >= THREAD_FOLDER_MAX_LIVE) {
      return Result.fail(`Projects can hold at most ${THREAD_FOLDER_MAX_LIVE} folders.`);
    }
    const next = forgetDeletedFolders([
      ...folders,
      {
        id: command.folderId,
        parentFolderId: command.parentFolderId,
        name,
        ...(command.icon == null ? {} : { icon: command.icon }),
        ...(command.forkRootThreadId === undefined
          ? {}
          : { forkRootThreadId: command.forkRootThreadId }),
        createdAt: occurredAt,
        deletedAt: null,
      },
    ]);
    return hasTooDeepFolder(next, command.folderId)
      ? Result.fail(`Folders nest at most ${THREAD_FOLDER_MAX_DEPTH} levels deep.`)
      : Result.succeed(next);
  }

  if (existing === undefined) return Result.fail(`Folder '${command.folderId}' does not exist.`);
  switch (command.type) {
    case "project.thread-folder.update": {
      if (existing.deletedAt !== null) {
        return Result.fail(`Folder '${command.folderId}' is deleted.`);
      }
      const name = command.name === undefined ? existing.name : nameOf(command.name);
      if (name === undefined) {
        return Result.fail(`Folder names must be 1-${THREAD_FOLDER_NAME_MAX_LENGTH} characters.`);
      }
      if (isLongMonogram(command.icon)) {
        return Result.fail("Folder monograms must contain at most two characters.");
      }
      const parentFolderId =
        command.parentFolderId === undefined ? existing.parentFolderId : command.parentFolderId;
      if (parentFolderId !== existing.parentFolderId) {
        if (!isLiveFolder(parentFolderId)) {
          return Result.fail(`Parent folder '${parentFolderId}' does not exist.`);
        }
        // Deleted folders still link their subfolders, so the walk includes them.
        if (
          parentFolderId === command.folderId ||
          (parentFolderId !== null &&
            threadFolderAncestorIds(folders, parentFolderId).includes(command.folderId))
        ) {
          return Result.fail(`Folder '${command.folderId}' cannot move inside itself.`);
        }
      }
      const { icon: _icon, ...withoutIcon } = existing;
      const icon = command.icon === undefined ? existing.icon : command.icon;
      const next = replace({
        ...withoutIcon,
        name,
        parentFolderId,
        ...(icon == null ? {} : { icon }),
      });
      return parentFolderId !== existing.parentFolderId && hasTooDeepFolder(next, command.folderId)
        ? Result.fail(`Folders nest at most ${THREAD_FOLDER_MAX_DEPTH} levels deep.`)
        : Result.succeed(next);
    }
    case "project.thread-folder.delete":
      return existing.deletedAt !== null
        ? Result.fail(`Folder '${command.folderId}' is already deleted.`)
        : Result.succeed(replace({ ...existing, deletedAt: occurredAt }));
    case "project.thread-folder.restore": {
      if (existing.deletedAt === null) {
        return Result.fail(`Folder '${command.folderId}' is not deleted.`);
      }
      if (liveCount >= THREAD_FOLDER_MAX_LIVE) {
        return Result.fail(`Projects can hold at most ${THREAD_FOLDER_MAX_LIVE} folders.`);
      }
      // Folders made below it while it was deleted count only the live levels above them.
      const next = replace({ ...existing, deletedAt: null });
      return hasTooDeepFolder(next, command.folderId)
        ? Result.fail(`Folders nest at most ${THREAD_FOLDER_MAX_DEPTH} levels deep.`)
        : Result.succeed(next);
    }
  }
}

/** Read state and commit the planned event under the project lock. */
export function planProjectCommand(input: {
  readonly command: ProjectCommand;
  readonly state: ProjectCommandState;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedProjectEvent, ProjectCommandRejection> {
  const { command, state } = input;
  const invariant = (detail: string) =>
    Result.fail(new ProjectCommandInvariantError({ commandType: command.type, detail }));
  const missingProject = () =>
    Result.fail(
      new ProjectCommandMissingProjectError({
        commandType: command.type,
        projectId: command.projectId,
      }),
    );
  const activeProject = state.project?.deletedAt === null ? state.project : undefined;
  const requireWorkspaceAvailable = (workspaceRoot: string) =>
    state.workspaceOwner === undefined || state.workspaceOwner.projectId === command.projectId
      ? undefined
      : new ProjectWorkspaceConflictError({
          workspaceRoot,
          conflictingProjectId: state.workspaceOwner.projectId,
        });
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "project" as const,
    aggregateId: command.projectId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  switch (command.type) {
    case "project.create": {
      if (state.project !== undefined) {
        return invariant(
          `Project '${command.projectId}' already exists and cannot be created twice.`,
        );
      }
      const conflict = requireWorkspaceAvailable(command.workspaceRoot);
      if (conflict !== undefined) return Result.fail(conflict);
      return Result.succeed({
        ...base,
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: command.scripts ?? [],
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    }

    case "project.meta.update": {
      const project = activeProject;
      if (project === undefined) return missingProject();
      if (isLongMonogram(command.projectIcon)) {
        return invariant("Project monograms must contain at most two characters.");
      }
      if (command.scripts !== undefined) {
        // Allow editing or removing persisted invalid script ids, while rejecting new invalid ids.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            return invariant(
              `Script IDs must be 1-${MAX_SCRIPT_ID_LENGTH} lowercase letters, digits or hyphens, starting with a letter or digit (got ${script.id.length} characters).`,
            );
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        const conflict = requireWorkspaceAvailable(command.workspaceRoot);
        if (conflict !== undefined) return Result.fail(conflict);
      }
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.workspaceRoot === undefined ? {} : { workspaceRoot: command.workspaceRoot }),
          ...(command.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: command.defaultModelSelection }),
          ...(command.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: command.defaultThreadEnvMode }),
          ...(command.autoPull === undefined ? {} : { autoPull: command.autoPull }),
          ...(command.faviconPath === undefined ? {} : { faviconPath: command.faviconPath }),
          ...(command.projectIcon === undefined ? {} : { projectIcon: command.projectIcon }),
          ...(command.scripts === undefined ? {} : { scripts: command.scripts }),
          updatedAt: occurredAt,
        },
      });
    }

    case "project.delete": {
      if (activeProject === undefined) return missingProject();
      // Thread children are deleted by ProjectService before this event commits.
      return Result.succeed({
        ...base,
        type: "project.deleted",
        payload: { projectId: command.projectId, deletedAt: occurredAt },
      });
    }

    case "project.thread-folder.create":
    case "project.thread-folder.update":
    case "project.thread-folder.delete":
    case "project.thread-folder.restore": {
      if (activeProject === undefined) return missingProject();
      const threadFolders = planThreadFolders(command, activeProject.threadFolders, occurredAt);
      if (Result.isFailure(threadFolders)) return invariant(threadFolders.failure);
      // Arranging folders is not project activity, so recency sorting ignores it.
      return Result.succeed({
        ...base,
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          threadFolders: threadFolders.success,
          updatedAt: activeProject.updatedAt,
        },
      });
    }
  }
}
