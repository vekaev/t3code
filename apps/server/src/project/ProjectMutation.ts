import { type ProjectMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type ProjectService } from "./ProjectService.ts";

type ProjectMutations = Pick<
  ProjectService["Service"],
  | "create"
  | "delete"
  | "update"
  | "createThreadFolder"
  | "updateThreadFolder"
  | "deleteThreadFolder"
  | "restoreThreadFolder"
>;

export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
) {
  switch (mutation.type) {
    case "project.create":
      return yield* projects.create({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        title: mutation.title,
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.update":
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.autoPull === undefined ? {} : { autoPull: mutation.autoPull }),
        ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(mutation.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.delete":
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });

    case "project.thread-folder.create":
      return yield* projects.createThreadFolder({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        folderId: mutation.folderId,
        parentFolderId: mutation.parentFolderId,
        name: mutation.name,
        ...(mutation.icon === undefined ? {} : { icon: mutation.icon }),
      });

    case "project.thread-folder.update":
      return yield* projects.updateThreadFolder({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        folderId: mutation.folderId,
        ...(mutation.name === undefined ? {} : { name: mutation.name }),
        ...(mutation.icon === undefined ? {} : { icon: mutation.icon }),
        ...(mutation.parentFolderId === undefined
          ? {}
          : { parentFolderId: mutation.parentFolderId }),
      });

    case "project.thread-folder.delete":
      return yield* projects.deleteThreadFolder({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        folderId: mutation.folderId,
      });

    case "project.thread-folder.restore":
      return yield* projects.restoreThreadFolder({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        folderId: mutation.folderId,
      });
  }
});
