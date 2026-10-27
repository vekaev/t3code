import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadFolderKey } from "@t3tools/client-runtime/state/thread-folders";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadFolderId,
  ThreadId,
  type ThreadFolder,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarFolderSegment, threadNeedsAttention } from "./Sidebar.folders";
import { resolveSidebarDropTarget, sidebarListItemId, type SidebarListItem } from "./Sidebar.logic";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");

const folder = (id: string, name: string, parentFolderId: string | null = null): ThreadFolder => ({
  id: ThreadFolderId.make(id),
  parentFolderId: parentFolderId === null ? null : ThreadFolderId.make(parentFolderId),
  name,
  createdAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});
const project = {
  environmentId,
  id: projectId,
  threadFolders: [
    folder("plans", "Plans"),
    folder("drafts", "Drafts", "plans"),
    folder("bugs", "Bugs"),
  ],
};
const thread = (id: string, threadFolderId: string | null = null) => ({
  environmentId,
  id: ThreadId.make(id),
  projectId,
  threadFolderId: threadFolderId === null ? null : ThreadFolderId.make(threadFolderId),
});
const threadKey = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
const folderKey = (id: string) => threadFolderKey(environmentId, ThreadFolderId.make(id));
const folderItem = (id: string): SidebarListItem => ({ kind: "folder", key: folderKey(id) });
const threadItem = (id: string, depth: number): SidebarListItem => ({
  kind: "thread",
  key: threadKey(id),
  section: "active",
  depth,
});

function segment(options: { collapsed?: ReadonlyArray<string>; open?: string } = {}) {
  return buildSidebarFolderSegment({
    projects: [project],
    // Active order, as the partition sorted it.
    threads: [
      thread("loose-1"),
      thread("in-drafts", "drafts"),
      thread("in-plans", "plans"),
      thread("loose-2"),
      thread("in-bugs", "bugs"),
    ],
    collapsedFolderKeys: new Set((options.collapsed ?? []).map(folderKey)),
    openThreadKey: options.open === undefined ? null : threadKey(options.open),
    labelProjects: false,
  });
}

describe("sidebar folder segment", () => {
  it("lists folders by name above the loose threads, each thread at its depth", () => {
    const { items, looseThreads } = segment();
    expect(items).toEqual([
      folderItem("bugs"),
      threadItem("in-bugs", 1),
      folderItem("plans"),
      folderItem("drafts"),
      threadItem("in-drafts", 2),
      threadItem("in-plans", 1),
    ]);
    expect(looseThreads.map((entry) => entry.id)).toEqual(["loose-1", "loose-2"]);
  });

  it("orders keyboard navigation as the rows appear", () => {
    const { items, shownThreads } = segment();
    const rowKeys = items.flatMap((item) => (item.kind === "thread" ? [item.key] : []));
    expect(shownThreads.map((entry) => threadKey(entry.id))).toEqual([
      ...rowKeys,
      threadKey("loose-1"),
      threadKey("loose-2"),
    ]);
  });

  it("leaves a collapsed folder's threads out but keeps the open one under it", () => {
    const { items, shownThreads } = segment({ collapsed: ["plans"], open: "in-drafts" });
    expect(items).toEqual([
      folderItem("bugs"),
      threadItem("in-bugs", 1),
      folderItem("plans"),
      threadItem("in-drafts", 1),
    ]);
    expect(shownThreads.map((entry) => entry.id)).toEqual([
      "in-bugs",
      "in-drafts",
      "loose-1",
      "loose-2",
    ]);
  });
});

describe("collapsed folder attention", () => {
  const now = "2026-03-09T09:01:00.000Z";
  const quiet = {
    ...thread("quiet", "bugs"),
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: null,
    runtime: null as {
      readonly status: "failed" | "running";
      readonly activeRunId: null;
      readonly providerInstanceId: ProviderInstanceId;
      readonly providerName: string;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null,
    lastVisitedAt: "2026-03-09T08:00:00.000Z",
    settledOverride: null,
    snoozedAt: null as string | null,
    snoozedUntil: null as string | null,
  };
  const runtime = (status: "failed" | "running") => ({
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: status === "failed" ? "Exited" : null,
    updatedAt: "2026-03-09T08:30:00.000Z",
  });
  const collapsedDot = (hidden: typeof quiet) =>
    buildSidebarFolderSegment({
      projects: [project],
      threads: [quiet, { ...hidden, ...thread("hidden", "bugs") }],
      collapsedFolderKeys: new Set([folderKey("bugs")]),
      openThreadKey: null,
      labelProjects: false,
      needsAttention: (entry) => threadNeedsAttention(entry, now),
    }).rowByKey.get(folderKey("bugs"));

  it("marks a collapsed folder for a thread that woke or failed inside it", () => {
    const woke = {
      ...quiet,
      snoozedAt: "2026-03-09T07:00:00.000Z",
      snoozedUntil: "2026-03-09T09:00:00.000Z",
    };
    expect(collapsedDot(woke)).toMatchObject({ collapsed: true, needsAttention: true });
    expect(collapsedDot({ ...quiet, runtime: runtime("failed") })).toMatchObject({
      needsAttention: true,
    });
    expect(collapsedDot({ ...woke, lastVisitedAt: "2026-03-09T09:00:30.000Z" })).toMatchObject({
      needsAttention: false,
    });
    expect(collapsedDot({ ...quiet, runtime: runtime("running") })).toMatchObject({
      needsAttention: false,
    });
  });
});

describe("sidebar drops around the folder block", () => {
  const items: SidebarListItem[] = [
    { kind: "marker", marker: "pinned-header" },
    { kind: "thread", key: "pinned", section: "pinned" },
    { kind: "marker", marker: "pinned-divider" },
    ...segment().items,
    { kind: "marker", marker: "active-placeholder" },
    { kind: "thread", key: threadKey("loose-1"), section: "active" },
    { kind: "thread", key: threadKey("loose-2"), section: "active" },
    { kind: "marker", marker: "settled-header" },
    { kind: "marker", marker: "settled-placeholder" },
  ];

  it.each([
    ["a folder row", sidebarListItemId(folderItem("plans"))],
    ["a thread in a folder", threadKey("in-drafts")],
  ])("lands a loose thread dropped on %s in the first loose slot", (_, overId) => {
    expect(resolveSidebarDropTarget(items, threadKey("loose-2"), overId)).toEqual({
      section: "active",
      pinnedOrder: ["pinned"],
      activeOrder: [threadKey("loose-2"), threadKey("loose-1")],
    });
  });

  it("unpins a thread dropped on the folder block into the first loose slot", () => {
    expect(
      resolveSidebarDropTarget(items, "pinned", sidebarListItemId(folderItem("bugs"))),
    ).toEqual({
      section: "active",
      pinnedOrder: [],
      activeOrder: ["pinned", threadKey("loose-1"), threadKey("loose-2")],
    });
  });

  it("lets a thread in a folder leave Active but not reorder into it", () => {
    expect(resolveSidebarDropTarget(items, threadKey("in-plans"), threadKey("loose-1"))).toBeNull();
    expect(resolveSidebarDropTarget(items, threadKey("in-plans"), "pinned")).toMatchObject({
      section: "pinned",
      pinnedOrder: [threadKey("in-plans"), "pinned"],
    });
  });
});
