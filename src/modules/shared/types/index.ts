// Shared types across modules — types only, no runtime code

export type ModuleRoute = {
  path: string;
  label: string;
  icon?: string;
};

export type ModuleDefinition = {
  name: string;
  label: string;
  description: string;
  routes: ModuleRoute[];
  schema?: unknown[];
  mcpTools?: unknown[];
  eventHooks?: Record<string, (...args: unknown[]) => void | Promise<void>>;
};
