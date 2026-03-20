import type { ModuleDefinition, ModuleRoute } from "@/modules/shared/types";

class ModuleRegistry {
  private modules: Map<string, ModuleDefinition> = new Map();

  register(module: ModuleDefinition): void {
    if (this.modules.has(module.name)) {
      throw new Error(`Module "${module.name}" is already registered`);
    }
    this.modules.set(module.name, module);
  }

  getModule(name: string): ModuleDefinition | undefined {
    return this.modules.get(name);
  }

  getAllModules(): ModuleDefinition[] {
    return Array.from(this.modules.values());
  }

  getModuleRoutes(name: string): ModuleRoute[] {
    return this.modules.get(name)?.routes ?? [];
  }

  getAllRoutes(): { module: string; routes: ModuleRoute[] }[] {
    return this.getAllModules().map((m) => ({
      module: m.name,
      routes: m.routes,
    }));
  }
}

// Singleton
export const moduleRegistry = new ModuleRegistry();
