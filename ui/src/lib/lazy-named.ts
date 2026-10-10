import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type LazyNamedComponent = LazyExoticComponent<
  ComponentType<Record<string, unknown>>
>;

export function lazyNamed(
  loader: () => Promise<Record<string, unknown>>,
  exportName: string,
): LazyNamedComponent {
  return lazy(async () => {
    const module = await loader();
    const component = module[exportName];

    if (!component) {
      throw new Error(`Lazy module does not export ${exportName}.`);
    }

    return {
      default: component as ComponentType<Record<string, unknown>>,
    };
  });
}
