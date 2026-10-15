// Views that only appear after the person opens them, loaded on first use so
// they stay out of the desktop's startup chunk.
import { lazy, Suspense, type ComponentProps } from "react";

const LazySettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })));
const LazyLibraryView = lazy(() => import("./LibraryView").then((m) => ({ default: m.LibraryView })));
const LazyApexAgentTasks = lazy(() => import("./ApexAgentTasks").then((m) => ({ default: m.ApexAgentTasks })));

export type { SettingsSection } from "./SettingsPage";

export function SettingsPage(props: ComponentProps<typeof LazySettingsPage>) {
  return <Suspense fallback={null}><LazySettingsPage {...props} /></Suspense>;
}

export function LibraryView(props: ComponentProps<typeof LazyLibraryView>) {
  return <Suspense fallback={null}><LazyLibraryView {...props} /></Suspense>;
}

export function ApexAgentTasks(props: ComponentProps<typeof LazyApexAgentTasks>) {
  return <Suspense fallback={null}><LazyApexAgentTasks {...props} /></Suspense>;
}
