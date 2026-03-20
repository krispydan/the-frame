// Explicit module registration — no filesystem scanning (per CTO review)
import { coreModule } from "./core";
import { salesModule } from "./sales";
import { catalogModule } from "./catalog";
import { ordersModule } from "./orders";
import { inventoryModule } from "./inventory";
import { financeModule } from "./finance";
import { customersModule } from "./customers";
import { marketingModule } from "./marketing";
import { intelligenceModule } from "./intelligence";
import { moduleRegistry } from "./core/lib/module-registry";
import type { ModuleDefinition } from "./shared/types";

const modules: ModuleDefinition[] = [
  coreModule,
  salesModule,
  catalogModule,
  ordersModule,
  inventoryModule,
  financeModule,
  customersModule,
  marketingModule,
  intelligenceModule,
];

// Register all modules on import
let initialized = false;
export function initializeModules(): void {
  if (initialized) return;
  for (const mod of modules) {
    moduleRegistry.register(mod);
  }
  initialized = true;
}

export { moduleRegistry } from "./core/lib/module-registry";
export { modules };
