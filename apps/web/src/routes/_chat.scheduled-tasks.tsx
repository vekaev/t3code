import { createFileRoute } from "@tanstack/react-router";

import { AppRouteModal, AppRouteModalClose } from "../components/AppRouteModal";
import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";
import { validateSettingsRouteSearch } from "../components/settings/settingsScopeNavigation";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";

function ScheduledTasksRoute() {
  const { project, machine, checkout, ...target } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <AppRouteModal label="Scheduled tasks">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2">
          <WorkspaceBreadcrumb ariaLabel="Scheduled tasks breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Scheduled tasks</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ms-auto flex shrink-0 items-center gap-1">
            <AppRouteModalClose />
          </div>
        </header>
        <SettingsScopeProvider
          search={{ project, machine, checkout }}
          onChange={(next) => {
            // Replace every key, so a new filter also drops the task link and its environment.
            void navigate({
              search: () => ({
                project: next.project,
                machine: next.machine,
                checkout: next.checkout,
              }),
              resetScroll: false,
            });
          }}
        >
          <ScheduledTasksSettings {...target} />
        </SettingsScopeProvider>
      </div>
    </AppRouteModal>
  );
}

export const Route = createFileRoute("/_chat/scheduled-tasks")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...validateSettingsRouteSearch(raw),
    ...validateScheduledTasksSearch(raw),
  }),
  component: ScheduledTasksRoute,
});
