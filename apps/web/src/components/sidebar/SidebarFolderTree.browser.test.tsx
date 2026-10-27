import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { layoutThreadFolders } from "@t3tools/client-runtime/state/thread-folders";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadFolderId,
  ThreadId,
  type ThreadFolder,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { sidebarListItemId } from "../Sidebar.logic";
import { SidebarFolderRow, useCollapsedThreadFolders } from "./SidebarFolderRow";

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
  threadFolders: [folder("revenue", "Increase revenue"), folder("pricing", "Pricing", "revenue")],
};

interface HarnessThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly threadFolderId: ThreadFolderId | null;
  readonly title: string;
}
const thread = (id: string, title: string, threadFolderId: string | null): HarnessThread => ({
  environmentId,
  id: ThreadId.make(id),
  projectId,
  threadFolderId: threadFolderId === null ? null : ThreadFolderId.make(threadFolderId),
  title,
});
const noop = () => {};

// The sidebar's folder block, built from the same layout, rows and collapse state.
function FolderTree(props: {
  readonly threads: ReadonlyArray<HarnessThread>;
  readonly openThreadId: string | null;
}) {
  const { collapsedFolderKeys, setFolderCollapsed } = useCollapsedThreadFolders();
  const { rows } = layoutThreadFolders({
    projects: [project],
    threads: props.threads,
    collapsedFolderKeys,
    openThreadKey:
      props.openThreadId === null
        ? null
        : scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(props.openThreadId))),
    labelProjects: false,
  });
  return (
    <DndContext>
      <SortableContext
        items={rows.map((row) =>
          row.kind === "thread" ? row.key : sidebarListItemId({ kind: "folder", key: row.key }),
        )}
      >
        <ul role="presentation">
          {rows.map((row) =>
            row.kind === "folder" ? (
              <SidebarFolderRow
                key={row.key}
                rowKey={row.key}
                folder={row.folder}
                depth={row.depth}
                collapsed={row.collapsed}
                threadCount={row.threadCount}
                needsAttention={row.needsAttention}
                isRenaming={false}
                onSetCollapsed={setFolderCollapsed}
                onContextMenu={noop}
                onStartRename={noop}
                onCommitRename={noop}
                onCancelRename={noop}
              />
            ) : row.kind === "thread" ? (
              <li key={row.key}>{row.thread.title}</li>
            ) : null,
          )}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

const threads = [
  thread("spec", "Write the spec", "revenue"),
  thread("quote", "Quote the tiers", "revenue"),
];

describe("sidebar folder tree", () => {
  it("collapses a folder around the open thread and keeps it collapsed after a remount", async () => {
    window.localStorage.clear();
    using _storage = { [Symbol.dispose]: () => window.localStorage.clear() };
    {
      await using screen = await render(
        <FolderTree threads={threads} openThreadId="spec" />,
        // The harness has no routes; the open thread arrives as a prop.
        { router: false },
      );
      const revenue = screen.getByRole("treeitem", { name: /^Increase revenue folder/ });
      await expect.element(revenue).toHaveAttribute("aria-expanded", "true");
      await expect.element(screen.getByText("Quote the tiers")).toBeInTheDocument();

      await userEvent.click(revenue);

      await expect.element(revenue).toHaveAttribute("aria-expanded", "false");
      await expect.element(screen.getByText("Quote the tiers")).not.toBeInTheDocument();
      await expect.element(screen.getByText("Write the spec")).toBeInTheDocument();
      await expect.element(screen.getByText("Pricing")).not.toBeInTheDocument();
    }

    await using screen = await render(
      <FolderTree threads={threads} openThreadId={null} />,
      // The harness has no routes; the open thread arrives as a prop.
      { router: false },
    );
    await expect
      .element(screen.getByRole("treeitem", { name: /^Increase revenue folder/ }))
      .toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByText("Write the spec")).not.toBeInTheDocument();
  });
});
