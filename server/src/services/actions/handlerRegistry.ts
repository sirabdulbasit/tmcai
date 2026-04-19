import type { ActionHandler, HandlerCategory } from './handlerBase';

const registry = new Map<string, ActionHandler>();

export function register(handler: ActionHandler): void {
  const name = handler.metadata().name;
  if (registry.has(name)) {
    throw new Error(`handler "${name}" already registered`);
  }
  registry.set(name, handler);
}

export function get(name: string): ActionHandler | undefined {
  return registry.get(name);
}

export function requireHandler(name: string): ActionHandler {
  const h = registry.get(name);
  if (!h) throw new Error(`no handler registered for action "${name}"`);
  return h;
}

export function listAll(): ActionHandler[] {
  return Array.from(registry.values());
}

export function listByCategory(category: HandlerCategory): ActionHandler[] {
  return listAll().filter((h) => h.metadata().category === category);
}

export function has(name: string): boolean {
  return registry.has(name);
}

export function reset(): void {
  registry.clear();
}
