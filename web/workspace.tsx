import { createContext, useContext, type ReactNode } from "react";
import type { Meta, Model, Operation, Page, Site, Source } from "./data";
export type Workspace = {
  sites: Site[];
  models: Model[];
  sources: Source[];
  operations: Operation[];
  meta: Meta | null;
  query: string;
  navigate: (page: Page) => void;
  inspectSite: (id: string) => void;
  inspectModel: (id: string) => void;
  configureSource: (source?: Source) => void;
  sourceAction: (
    source: Source,
    action: "check" | "preview" | "sync",
  ) => Promise<Operation>;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
};
const Context = createContext<Workspace | null>(null);
export function WorkspaceProvider({
  value,
  children,
}: {
  value: Workspace;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useWorkspace = () => useContext(Context)!;
