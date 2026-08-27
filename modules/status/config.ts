import { j, type InferNode } from "../../src/core/index.ts";

import { CUSTOM_COMPONENT_PREFIX, isCustomComponentId } from "./custom.ts";
import { DEFAULT_STATUS_LINE_FORMAT, isJpiComponentId, type StatusLineFormat } from "./layout.ts";

const row = j.node({
  attrs: {
    components: j.array(j.string()).describe("component ids, left to right").default([]),
  },
});

export const statusSchema = j.node({
  fields: {
    format: j.node({
      fields: {
        row: j.list(row, {
          description: "status line rows, top to bottom",
          default: DEFAULT_STATUS_LINE_FORMAT.map((line) => ({ components: [...line] })),
        }),
      },
    }),
    disabledStatuses: j.list(j.string(), {
      description: "built-in statuses to hide",
      default: [],
    }),
  },
});

export type StatusConfigValue = InferNode<typeof statusSchema>;

/**
 * What `loadStatusLineConfig` needs from a config source. The loader's config
 * value carries an extra `enabled` field, but that's still structurally
 * assignable here, so this covers both it and a bare test-built `Config`.
 */
export type StatusConfigLike = {
  readonly path: string;
  load(): Promise<{ value: StatusConfigValue; issues: string[] }>;
};

export type StatusLineConfig = {
  format: StatusLineFormat;
  disabledStatuses: ReadonlySet<string>;
};

export type StatusLineConfigResult = {
  config: StatusLineConfig;
  path: string;
  issues: string[];
  problem?: string;
};

export function createDefaultStatusLineConfig(): StatusLineConfig {
  return {
    format: DEFAULT_STATUS_LINE_FORMAT,
    disabledStatuses: new Set(),
  };
}

function checkComponentIds(rows: readonly { components: readonly string[] }[]): string | undefined {
  for (let lineIndex = 0; lineIndex < rows.length; lineIndex += 1) {
    const components = rows[lineIndex]!.components;
    for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
      const componentId = components[componentIndex]!;
      if (componentId.startsWith("@jpi/") && !isJpiComponentId(componentId)) {
        return `format.row[${lineIndex}].components[${componentIndex}] has unknown reserved ID ${componentId}`;
      }
      if (componentId.startsWith(CUSTOM_COMPONENT_PREFIX) && !isCustomComponentId(componentId)) {
        return `format.row[${lineIndex}].components[${componentIndex}] has a blank @custom: path`;
      }
    }
  }
  return undefined;
}

/** Turns a decoded config value into the runtime shape, falling back to defaults on a semantic (not just schema) problem. */
export function toStatusLineConfig(value: StatusConfigValue): {
  config: StatusLineConfig;
  problem?: string;
} {
  const problem = checkComponentIds(value.format.row);
  if (problem) return { config: createDefaultStatusLineConfig(), problem };

  return {
    config: {
      format: value.format.row.map((entry) => entry.components) as StatusLineFormat,
      disabledStatuses: new Set(value.disabledStatuses),
    },
  };
}

export async function loadStatusLineConfig(
  config: StatusConfigLike,
): Promise<StatusLineConfigResult> {
  const { value, issues } = await config.load();
  const { config: statusLineConfig, problem } = toStatusLineConfig(value);

  return {
    config: statusLineConfig,
    path: config.path,
    issues: problem ? [...issues, problem] : issues,
    problem,
  };
}
