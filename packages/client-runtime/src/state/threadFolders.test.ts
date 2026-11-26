import {
  EnvironmentId,
  ProjectId,
  THREAD_FOLDER_MAX_DEPTH,
  THREAD_FOLDER_MAX_LIVE,
  THREAD_FOLDER_MAX_TOTAL,
  ThreadFolderId,
  ThreadId,
  type ThreadFolder,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canCreateThreadFolder,
  layoutThreadFolders,
  resolveThreadFolder,
  threadFolderKey,
  threadFolderTree,
  type ThreadFolderLayout,
  type ThreadFolderNode,
} from "./threadFolders.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const DELETED_AT = "2026-10-27T11:00:00.000Z";

function folder(
  id: string,
  name: string,
  parentFolderId: string | null = null,
  deletedAt: string | null = null,
): ThreadFolder {
  return {
    id: ThreadFolderId.make(id),
    parentFolderId: parentFolderId === null ? null : ThreadFolderId.make(parentFolderId),
    name,
    createdAt: "2026-10-27T10:00:00.000Z",
    deletedAt,
  };
}

function thread(id: string, threadFolderId: string | null = null, projectId = PROJECT_ID) {
  return {
    environmentId: ENVIRONMENT_ID,
    id: ThreadId.make(id),
    projectId,
    threadFolderId: threadFolderId === null ? null : ThreadFolderId.make(threadFolderId),
  };
}

type TestThread = ReturnType<typeof thread>;

function project(threadFolders: ReadonlyArray<ThreadFolder>, id = PROJECT_ID) {
  return { environmentId: ENVIRONMENT_ID, id, threadFolders };
}

function layout(input: {
  readonly projects: ReadonlyArray<ReturnType<typeof project>>;
  readonly threads: ReadonlyArray<TestThread>;
  readonly collapsed?: ReadonlyArray<string>;
  readonly openThreadId?: string;
  readonly labelProjects?: boolean;
  readonly needsAttention?: (thread: TestThread) => boolean;
}) {
  return layoutThreadFolders({
    projects: input.projects,
    threads: input.threads,
    collapsedFolderKeys: new Set(
      (input.collapsed ?? []).map((id) => threadFolderKey(ENVIRONMENT_ID, ThreadFolderId.make(id))),
    ),
    openThreadKey:
      input.openThreadId === undefined ? null : `${ENVIRONMENT_ID}:${input.openThreadId}`,
    labelProjects: input.labelProjects ?? false,
    ...(input.needsAttention === undefined ? {} : { needsAttention: input.needsAttention }),
  });
}

function outline(result: ThreadFolderLayout<ReturnType<typeof project>, TestThread>) {
  return result.rows.map((row) => {
    if (row.kind === "project") return `# ${row.project.id}`;
    const indent = "  ".repeat(row.depth);
    return row.kind === "folder" ? `${indent}[${row.folder.name}]` : `${indent}${row.thread.id}`;
  });
}

describe("layoutThreadFolders", () => {
  it("lists folders by name above loose threads, with subfolders before a folder's threads", () => {
    const result = layout({
      projects: [
        project([
          folder("ten", "Folder 10"),
          folder("two", "Folder 2"),
          folder("pricing", "pricing", "two"),
          { ...folder("fork", "Increase revenue"), forkRootThreadId: ThreadId.make("source") },
          folder("empty", "zeta"),
        ]),
      ],
      threads: [
        thread("loose"),
        thread("b", "two"),
        thread("c", "pricing"),
        thread("d", "ten"),
        thread("e", "two"),
        thread("source", "fork"),
        thread("copy", "fork"),
      ],
    });

    expect(outline(result)).toEqual([
      "[Folder 2]",
      "  [pricing]",
      "    c",
      "  b",
      "  e",
      "[Folder 10]",
      "  d",
      "[Increase revenue]",
      "  source",
      "  copy",
      "[zeta]",
    ]);
    expect(result.looseThreads.map((row) => row.id)).toEqual(["loose"]);
    expect(result.rows.flatMap((row) => (row.kind === "folder" ? [row.threadCount] : []))).toEqual([
      3, 1, 1, 2, 0,
    ]);
  });

  it("shows a deleted folder's contents one level up, and unknown or looping folder ids at the root", () => {
    const result = layout({
      projects: [
        project([
          folder("revenue", "Revenue"),
          folder("q3", "Q3", "revenue", DELETED_AT),
          folder("pricing", "Pricing", "q3"),
          folder("loop-a", "Loop A", "loop-b", DELETED_AT),
          folder("loop-b", "Loop B", "loop-a", DELETED_AT),
        ]),
      ],
      threads: [
        thread("in-q3", "q3"),
        thread("in-pricing", "pricing"),
        thread("unknown", "missing"),
        thread("in-loop", "loop-a"),
        thread("elsewhere", "revenue", ProjectId.make("project-2")),
      ],
    });

    expect(outline(result)).toEqual(["[Revenue]", "  [Pricing]", "    in-pricing", "  in-q3"]);
    expect(result.looseThreads.map((row) => row.id)).toEqual(["unknown", "in-loop", "elsewhere"]);
  });

  it("hides a collapsed folder's contents but keeps the open thread and still counts them", () => {
    const projects = [
      project([folder("revenue", "Revenue"), folder("pricing", "Pricing", "revenue")]),
    ];
    const threads = [thread("a", "revenue"), thread("b", "pricing"), thread("c", "pricing")];
    const needsAttention = (row: TestThread) => row.id === "c";

    const collapsed = layout({
      projects,
      threads,
      collapsed: ["revenue"],
      openThreadId: "b",
      needsAttention,
    });
    expect(outline(collapsed)).toEqual(["[Revenue]", "  b"]);
    expect(collapsed.rows[0]).toMatchObject({
      collapsed: true,
      threadCount: 3,
      needsAttention: true,
    });
    expect(outline(layout({ projects, threads, collapsed: ["revenue"] }))).toEqual(["[Revenue]"]);

    const inner = layout({ projects, threads, collapsed: ["pricing"], openThreadId: "b" });
    expect(outline(inner)).toEqual(["[Revenue]", "  [Pricing]", "    b", "  a"]);
    expect(inner.rows[0]).toMatchObject({ collapsed: false, needsAttention: false });
  });

  it("labels projects when asked or when several have folders, and adds nothing for projects without folders", () => {
    const projects = [
      project([folder("one", "One")], ProjectId.make("project-1")),
      project([folder("gone", "Gone", null, DELETED_AT)], ProjectId.make("project-2")),
      project([folder("three", "Three")], ProjectId.make("project-3")),
    ];
    const threads = [
      thread("a", "one", ProjectId.make("project-1")),
      thread("b", "gone", ProjectId.make("project-2")),
      thread("c", "three", ProjectId.make("project-3")),
    ];

    expect(outline(layout({ projects, threads, labelProjects: true }))).toEqual([
      "# project-1",
      "[One]",
      "  a",
      "# project-3",
      "[Three]",
      "  c",
    ]);
    // One project group can hold several projects, and their folders may share names.
    expect(outline(layout({ projects, threads }))).toEqual([
      "# project-1",
      "[One]",
      "  a",
      "# project-3",
      "[Three]",
      "  c",
    ]);
    const unlabelled = layout({ projects: projects.slice(0, 2), threads });
    expect(outline(unlabelled)).toEqual(["[One]", "  a"]);
    expect(unlabelled.looseThreads.map((row) => row.id)).toEqual(["b", "c"]);
  });
});

describe("threadFolderTree", () => {
  it("lists every live folder once, even folders whose parents loop", () => {
    const names = (nodes: ReadonlyArray<ThreadFolderNode>): unknown =>
      nodes.map((node) => [node.folder.name, node.depth, names(node.children)]);

    expect(
      names(
        threadFolderTree([
          folder("revenue", "Revenue"),
          folder("cycle-1", "Cycle 1", "cycle-2"),
          folder("cycle-2", "Cycle 2", "cycle-1"),
          folder("self", "Self", "self-tombstone"),
          folder("self-tombstone", "Self tombstone", "self", DELETED_AT),
        ]),
      ),
    ).toEqual([
      ["Cycle 1", 0, [["Cycle 2", 1, []]]],
      ["Revenue", 0, []],
      ["Self", 0, []],
    ]);
  });
});

describe("resolveThreadFolder", () => {
  it("names the live folder a shelved thread belongs to", () => {
    const folders = [folder("revenue", "Revenue"), folder("q3", "Q3", "revenue", DELETED_AT)];

    expect(resolveThreadFolder(folders, ThreadFolderId.make("q3"))?.name).toBe("Revenue");
    expect(resolveThreadFolder(folders, ThreadFolderId.make("missing"))).toBeNull();
    expect(resolveThreadFolder(undefined, ThreadFolderId.make("revenue"))).toBeNull();
  });
});

describe("canCreateThreadFolder", () => {
  it("allows a new folder only where the server would accept one", () => {
    const chain = Array.from({ length: THREAD_FOLDER_MAX_DEPTH }, (_, index) =>
      folder(`level-${index + 1}`, `Level ${index + 1}`, index === 0 ? null : `level-${index}`),
    );
    const deep = ThreadFolderId.make(`level-${THREAD_FOLDER_MAX_DEPTH}`);
    const shallower = ThreadFolderId.make(`level-${THREAD_FOLDER_MAX_DEPTH - 1}`);

    expect(canCreateThreadFolder(undefined, null)).toBe(true);
    expect(canCreateThreadFolder(chain, shallower)).toBe(true);
    expect(canCreateThreadFolder(chain, deep)).toBe(false);
    // Only live folders count toward depth.
    const withDeletedLevel = chain.map((row) =>
      row.id === "level-2" ? { ...row, deletedAt: DELETED_AT } : row,
    );
    expect(canCreateThreadFolder(withDeletedLevel, deep)).toBe(true);
    expect(canCreateThreadFolder(withDeletedLevel, ThreadFolderId.make("level-2"))).toBe(false);
    expect(canCreateThreadFolder(chain, ThreadFolderId.make("missing"))).toBe(false);

    const many = (count: number, deletedAt: string | null) =>
      Array.from({ length: count }, (_, index) =>
        folder(`f-${index}`, `F ${index}`, null, deletedAt),
      );
    expect(canCreateThreadFolder(many(THREAD_FOLDER_MAX_LIVE - 1, null), null)).toBe(true);
    expect(canCreateThreadFolder(many(THREAD_FOLDER_MAX_LIVE, null), null)).toBe(false);
    // The server forgets the oldest deleted folders to make room.
    expect(canCreateThreadFolder(many(THREAD_FOLDER_MAX_TOTAL, DELETED_AT), null)).toBe(true);
  });
});
