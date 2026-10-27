import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ProjectIconOverride,
  ProjectId,
  type ProjectScript,
  type StoredThreadFolder,
  ThreadFolderId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  planProjectCommand,
  type ProjectCommand,
  type ProjectCommandState,
} from "./ProjectCommands.ts";
import type { ProjectRow } from "./ProjectStore.ts";

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const projectId = ProjectId.make("project-scripts");

const row = (overrides: Partial<ProjectRow> = {}): ProjectRow => ({
  projectId,
  title: "Scripts",
  workspaceRoot: "/tmp/scripts",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  threadFolders: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const script = (id: string): ProjectScript => ({
  id,
  name: "Install dependencies",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: false,
});

const plan = (command: ProjectCommand, state: Partial<ProjectCommandState> = {}) =>
  planProjectCommand({
    command,
    state: { project: undefined, workspaceOwner: undefined, ...state },
    eventId: EventId.make("event:planned"),
    now,
  });

const payloadOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isSuccess(result));
  return Result.getOrThrow(result).payload as Record<string, unknown>;
};

const failureOf = (result: ReturnType<typeof plan>) => {
  assert.isTrue(Result.isFailure(result));
  return Result.isFailure(result) ? result.failure : assert.fail("expected a rejection");
};

describe("planProjectCommand", () => {
  it("keeps legacy scripts editable and removable while rejecting new invalid ones", () => {
    const legacy = script("install-javascript-dependencies");
    const withLegacy = (scripts: ReadonlyArray<ProjectScript>) =>
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-repair-script"),
          projectId,
          scripts,
        },
        { project: row({ scripts: [legacy] }) },
      );
    for (const scripts of [[{ ...legacy, command: "vp install" }, script("lint")], []]) {
      assert.deepEqual(payloadOf(withLegacy(scripts)).scripts, scripts);
    }
    assert.equal(
      failureOf(withLegacy([legacy, script("another.invalid.id")]))._tag,
      "ProjectCommandInvariantError",
    );
  });

  it("rejects a workspace root held by another active project", () => {
    const owner = row({
      projectId: ProjectId.make("project-existing"),
      workspaceRoot: "/tmp/project",
    });
    const create = failureOf(
      plan(
        {
          type: "project.create",
          commandId: CommandId.make("cmd-duplicate-root"),
          projectId: ProjectId.make("project-duplicate-root"),
          title: "Duplicate",
          workspaceRoot: "/tmp/project",
        },
        { workspaceOwner: owner },
      ),
    );
    assert.equal(create._tag, "ProjectWorkspaceConflictError");
    assert.equal(
      create.message,
      "Active project 'project-existing' already exists for workspace root '/tmp/project'.",
    );
    const move = failureOf(
      plan(
        {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-move-root"),
          projectId,
          workspaceRoot: "/tmp/project",
        },
        { project: row(), workspaceOwner: owner },
      ),
    );
    assert.equal(move._tag, "ProjectWorkspaceConflictError");
  });

  it("requires the project to exist, and to be absent on create", () => {
    const create: ProjectCommand = {
      type: "project.create",
      commandId: CommandId.make("cmd-create-twice"),
      projectId,
      title: "Twice",
      workspaceRoot: "/tmp/twice",
    };
    assert.include(failureOf(plan(create, { project: row() })).message, "cannot be created twice");
    const deleted = row({ deletedAt: "2026-01-01T00:00:00.000Z" });
    assert.include(
      failureOf(plan(create, { project: deleted })).message,
      "cannot be created twice",
    );
    for (const command of [
      { type: "project.meta.update", commandId: CommandId.make("cmd-missing"), projectId },
      { type: "project.delete", commandId: CommandId.make("cmd-missing"), projectId },
    ] as const) {
      for (const project of [undefined, deleted]) {
        assert.equal(
          failureOf(plan(command, { project }))._tag,
          "ProjectCommandMissingProjectError",
        );
      }
    }
  });
});

describe("planProjectCommand thread folders", () => {
  const projectUpdatedAt = "2025-12-01T00:00:00.000Z";
  const deletedAt = "2025-12-15T00:00:00.000Z";
  const folderId = ThreadFolderId.make;
  const folder = (
    id: string,
    parentFolderId: string | null,
    overrides: Partial<StoredThreadFolder> = {},
  ): StoredThreadFolder => ({
    id: folderId(id),
    parentFolderId: parentFolderId === null ? null : folderId(parentFolderId),
    name: id,
    createdAt: "2025-11-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  });
  const inProject = (...threadFolders: ReadonlyArray<StoredThreadFolder>) => ({
    project: row({ threadFolders, updatedAt: projectUpdatedAt }),
  });
  const create = (
    id: string,
    parentFolderId: string | null,
    overrides: { readonly name?: string; readonly forkRootThreadId?: ThreadId } = {},
  ): ProjectCommand => ({
    type: "project.thread-folder.create",
    commandId: CommandId.make(`cmd-create-${id}`),
    projectId,
    folderId: folderId(id),
    parentFolderId: parentFolderId === null ? null : folderId(parentFolderId),
    name: overrides.name ?? id,
    ...(overrides.forkRootThreadId === undefined
      ? {}
      : { forkRootThreadId: overrides.forkRootThreadId }),
  });
  const move = (id: string, parentFolderId: string | null): ProjectCommand => ({
    type: "project.thread-folder.update",
    commandId: CommandId.make(`cmd-move-${id}`),
    projectId,
    folderId: folderId(id),
    parentFolderId: parentFolderId === null ? null : folderId(parentFolderId),
  });
  const target = (
    type: "project.thread-folder.delete" | "project.thread-folder.restore",
    id: string,
  ): ProjectCommand => ({
    type,
    commandId: CommandId.make(`cmd-${type}-${id}`),
    projectId,
    folderId: folderId(id),
  });
  const foldersOf = (result: ReturnType<typeof plan>) =>
    payloadOf(result).threadFolders as ReadonlyArray<StoredThreadFolder>;
  const rejected = (result: ReturnType<typeof plan>) =>
    assert.equal(failureOf(result)._tag, "ProjectCommandInvariantError");
  // `work` > `revenue` > `pricing`, with `revenue` deleted.
  const nested = [
    folder("work", null),
    folder("revenue", "work", { deletedAt }),
    folder("pricing", "revenue"),
  ];

  it("creates folders at the root and nested without changing the project's activity time", () => {
    const rootFolder = plan(create("work", null), inProject());
    assert.deepEqual(foldersOf(rootFolder), [
      { ...folder("work", null), createdAt: DateTime.formatIso(now) },
    ]);
    assert.equal(payloadOf(rootFolder).updatedAt, projectUpdatedAt);
    const forkRootThreadId = ThreadId.make("thread-source");
    const child = plan(
      create("revenue", "work", { name: "  increase revenue ", forkRootThreadId }),
      inProject(folder("work", null)),
    );
    assert.deepEqual(foldersOf(child), [
      folder("work", null),
      {
        ...folder("revenue", "work"),
        name: "increase revenue",
        forkRootThreadId,
        createdAt: DateTime.formatIso(now),
      },
    ]);
    assert.deepEqual(Object.keys(payloadOf(child)).toSorted(), [
      "projectId",
      "threadFolders",
      "updatedAt",
    ]);
  });

  it("rejects a missing, deleted or duplicate folder", () => {
    rejected(plan(create("pricing", "missing"), inProject()));
    rejected(plan(create("pricing", "revenue"), inProject(...nested)));
    rejected(plan(create("work", null), inProject(...nested)));
    rejected(plan(create("revenue", null), inProject(...nested)));
    rejected(plan(move("revenue", null), inProject(...nested)));
    rejected(
      plan(
        {
          type: "project.thread-folder.update",
          commandId: CommandId.make("cmd-rename-deleted"),
          projectId,
          folderId: folderId("revenue"),
          name: "Growth",
        },
        inProject(...nested),
      ),
    );
    rejected(plan(move("ideas", "revenue"), inProject(...nested, folder("ideas", null))));
    rejected(plan(target("project.thread-folder.delete", "revenue"), inProject(...nested)));
    rejected(plan(target("project.thread-folder.restore", "work"), inProject(...nested)));
    for (const command of [create("work", null), move("work", null)]) {
      assert.equal(
        failureOf(plan(command, { project: undefined }))._tag,
        "ProjectCommandMissingProjectError",
      );
    }
  });

  it("rejects a move into the folder itself or below it, even through a deleted folder", () => {
    rejected(plan(move("work", "work"), inProject(...nested)));
    rejected(plan(move("work", "pricing"), inProject(...nested)));
    assert.deepEqual(foldersOf(plan(move("pricing", null), inProject(...nested))), [
      ...nested.slice(0, 2),
      folder("pricing", null),
    ]);
  });

  it("caps live nesting depth and the number of folders", () => {
    const chain = Array.from({ length: 6 }, (_, index) =>
      folder(`level-${index + 1}`, index === 0 ? null : `level-${index}`),
    );
    rejected(plan(create("too-deep", "level-6"), inProject(...chain)));
    assert.lengthOf(foldersOf(plan(create("deepest", "level-5"), inProject(...chain))), 7);
    const withDeleted = chain.map((entry) =>
      entry.id === "level-3" ? { ...entry, deletedAt } : entry,
    );
    assert.lengthOf(foldersOf(plan(create("deepest", "level-6"), inProject(...withDeleted))), 7);
    const subtree = [folder("branch", null), folder("leaf", "branch")];
    rejected(plan(move("branch", "level-5"), inProject(...chain, ...subtree)));
    assert.lengthOf(foldersOf(plan(move("branch", "level-4"), inProject(...chain, ...subtree))), 8);

    const live = Array.from({ length: 200 }, (_, index) => folder(`live-${index}`, null));
    const deleted = Array.from({ length: 301 }, (_, index) =>
      folder(`deleted-${index}`, null, { deletedAt }),
    );
    rejected(plan(create("one-more", null), inProject(...live)));
    rejected(
      plan(target("project.thread-folder.restore", "deleted-0"), inProject(...live, ...deleted)),
    );
    assert.lengthOf(foldersOf(plan(create("one-more", null), inProject(...live.slice(1)))), 200);
  });

  it("rejects a restore that would nest a live folder past the depth limit", () => {
    const chain = Array.from({ length: 6 }, (_, index) =>
      folder(`level-${index + 1}`, index === 0 ? null : `level-${index}`, {
        deletedAt: index === 0 ? deletedAt : null,
      }),
    );
    const deeper = [...chain, folder("deeper", "level-6")];
    rejected(plan(target("project.thread-folder.restore", "level-1"), inProject(...deeper)));
    assert.lengthOf(
      foldersOf(plan(target("project.thread-folder.restore", "level-1"), inProject(...chain))),
      6,
    );
  });

  it("forgets the oldest deleted folders past the cap, those already at the root first", () => {
    const live = Array.from({ length: 198 }, (_, index) => folder(`live-${index}`, null));
    const deleted = Array.from({ length: 299 }, (_, index) =>
      folder(`deleted-${index}`, null, { deletedAt }),
    );
    const folders = foldersOf(
      plan(
        create("one-more", null),
        inProject(
          ...live,
          folder("nested-old", "live-0", { deletedAt: "2025-12-01T00:00:00.000Z" }),
          folder("root-old", null, { deletedAt: "2025-12-02T00:00:00.000Z" }),
          folder("child", "root-old"),
          ...deleted,
        ),
      ),
    );
    assert.lengthOf(folders, 500);
    const ids = folders.map((entry) => entry.id);
    assert.notInclude(ids, folderId("root-old"));
    assert.includeMembers(ids, [folderId("nested-old"), folderId("one-more")]);
    assert.deepInclude(folders, folder("child", null));
  });

  it("deletes to a tombstone that keeps its place, and restores it exactly", () => {
    const deleteRevenue = plan(
      target("project.thread-folder.delete", "work"),
      inProject(folder("work", null), folder("pricing", "work")),
    );
    const [tombstone] = foldersOf(deleteRevenue);
    assert.deepEqual(tombstone, { ...folder("work", null), deletedAt: DateTime.formatIso(now) });
    assert.equal(payloadOf(deleteRevenue).updatedAt, projectUpdatedAt);
    assert.deepEqual(
      foldersOf(
        plan(
          target("project.thread-folder.restore", "work"),
          inProject(tombstone!, folder("pricing", "work")),
        ),
      ),
      [folder("work", null), folder("pricing", "work")],
    );
  });

  it("renames a folder and sets or clears its icon, checking names and monograms", () => {
    const update = (fields: {
      readonly name?: string;
      readonly icon?: ProjectIconOverride | null;
    }): ProjectCommand => ({
      type: "project.thread-folder.update",
      commandId: CommandId.make("cmd-update-work"),
      projectId,
      folderId: folderId("work"),
      ...fields,
    });
    const icon = { kind: "emoji", emoji: "💰" } as const;
    const withIcon = foldersOf(
      plan(update({ name: "Revenue", icon }), inProject(folder("work", null))),
    );
    assert.deepEqual(withIcon, [{ ...folder("work", null), name: "Revenue", icon }]);
    assert.deepEqual(foldersOf(plan(update({ icon: null }), inProject(withIcon[0]!))), [
      { ...folder("work", null), name: "Revenue" },
    ]);
    rejected(plan(update({ name: "   " }), inProject(folder("work", null))));
    rejected(plan(update({ name: "x".repeat(65) }), inProject(folder("work", null))));
    rejected(
      plan(
        update({ icon: { kind: "monogram", text: "ABC", color: "blue" } }),
        inProject(folder("work", null)),
      ),
    );
  });
});
