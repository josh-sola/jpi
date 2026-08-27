import type { Location, Node as KdlNode } from "@bgotink/kdl";
import { getLocation } from "@bgotink/kdl";
import { z } from "zod";

import type { AnyJpiNodeSpec, ArrayAttr, FieldValue, JpiListSpec, ScalarField } from "./builder.ts";
import { isJpiListSpec, isJpiNodeSpec } from "./builder.ts";

export type Primitive = string | number | boolean;
type BaseKind = "string" | "number" | "boolean";

export interface CompiledScalarLeaf {
  readonly key: string;
  readonly kdlName: string;
  readonly kind: BaseKind | "mixed";
  readonly description: string;
  readonly default: Primitive;
}

export interface CompiledArrayLeaf {
  readonly key: string;
  readonly kdlName: string;
  readonly itemKind: BaseKind;
  readonly description: string;
  readonly default: readonly Primitive[];
}

export type CompiledField =
  | ({ readonly type: "field-scalar" } & CompiledScalarLeaf)
  | {
      readonly type: "field-node";
      readonly key: string;
      readonly kdlName: string;
      readonly node: CompiledNode;
    }
  | {
      readonly type: "field-list";
      readonly key: string;
      readonly kdlName: string;
      readonly description: string;
      readonly default: readonly unknown[];
      readonly item: CompiledListItem;
    };

export type CompiledListItem =
  | { readonly type: "item-scalar"; readonly kind: BaseKind; readonly schema: z.ZodType }
  | { readonly type: "item-node"; readonly node: CompiledNode };

export interface CompiledNode {
  readonly attrScalars: readonly CompiledScalarLeaf[];
  readonly attrArray: CompiledArrayLeaf | null;
  readonly fields: readonly CompiledField[];
  readonly zodObject: z.ZodObject<Record<string, z.ZodType>>;
  readonly defaults: Record<string, unknown>;
}

function toKebabCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function unwrapDefault(schema: z.ZodType): {
  inner: z.ZodType;
  hasDefault: boolean;
  defaultValue: unknown;
  description: string | undefined;
} {
  if (schema instanceof z.ZodDefault) {
    const inner = schema.def.innerType as z.ZodType;
    return {
      inner,
      hasDefault: true,
      defaultValue: schema.def.defaultValue,
      description: inner.description ?? schema.description,
    };
  }
  return {
    inner: schema,
    hasDefault: false,
    defaultValue: undefined,
    description: schema.description,
  };
}

function baseKindOf(schema: z.ZodType, path: string): BaseKind {
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  throw new Error(
    `${path}: unsupported schema type "${schema.def.type}" (only string, number, and boolean scalars are supported)`,
  );
}

function isPrimitiveLiteral(schema: z.ZodType): schema is z.ZodLiteral<Primitive> {
  if (!(schema instanceof z.ZodLiteral)) return false;
  return (schema.def.values as readonly unknown[]).every(
    (value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  );
}

/** Like baseKindOf, but also accepts a j.union(...) of scalars/primitive literals as "mixed". Only used for top-level field/attr scalar leaves — j.array/j.list items still go through baseKindOf and reject unions. */
function scalarLeafKindOf(schema: z.ZodType, path: string): BaseKind | "mixed" {
  if (!(schema instanceof z.ZodUnion)) return baseKindOf(schema, path);
  for (const option of schema.def.options as readonly z.ZodType[]) {
    if (
      option instanceof z.ZodString ||
      option instanceof z.ZodNumber ||
      option instanceof z.ZodBoolean ||
      isPrimitiveLiteral(option)
    ) {
      continue;
    }
    throw new Error(
      `${path}: unsupported union member "${option.def.type}" (j.union only accepts string, number, boolean, and j.literal(...) of a primitive)`,
    );
  }
  return "mixed";
}

function compileScalarLeaf(key: string, schema: ScalarField, path: string): CompiledScalarLeaf {
  const { inner, hasDefault, defaultValue, description } = unwrapDefault(schema);
  const kind = scalarLeafKindOf(inner, path);
  if (!description) {
    throw new Error(`${path}: missing .describe(...) — every field and attr needs a description`);
  }
  if (!hasDefault) {
    throw new Error(`${path}: missing .default(...) — every field and attr needs a default value`);
  }
  return { key, kdlName: toKebabCase(key), kind, description, default: defaultValue as Primitive };
}

function compileArrayAttr(key: string, schema: z.ZodType, path: string): CompiledArrayLeaf {
  const { inner, hasDefault, defaultValue, description } = unwrapDefault(schema);
  if (!(inner instanceof z.ZodArray)) {
    throw new Error(`${path}: expected an array attr built with j.array(...)`);
  }
  const itemKind = baseKindOf(inner.def.element as z.ZodType, path);
  if (!description) {
    throw new Error(`${path}: missing .describe(...) — every field and attr needs a description`);
  }
  if (!hasDefault) {
    throw new Error(`${path}: missing .default(...) — every array attr needs a default value`);
  }
  return {
    key,
    kdlName: toKebabCase(key),
    itemKind,
    description,
    default: defaultValue as readonly Primitive[],
  };
}

function compileListItem(
  item: ScalarField | AnyJpiNodeSpec,
  path: string,
): { compiled: CompiledListItem; zodSchema: z.ZodType } {
  if (isJpiNodeSpec(item)) {
    const node = compileNode(item, path);
    return { compiled: { type: "item-node", node }, zodSchema: node.zodObject };
  }
  const { inner } = unwrapDefault(item);
  const kind = baseKindOf(inner, path);
  return { compiled: { type: "item-scalar", kind, schema: item }, zodSchema: item };
}

function compileList(
  key: string,
  list: JpiListSpec,
  path: string,
): { field: CompiledField; zodSchema: z.ZodType } {
  if (!list.description) {
    throw new Error(`${path}: j.list requires a description`);
  }
  if (!Array.isArray(list.default)) {
    throw new Error(`${path}: j.list requires a default array`);
  }
  const { compiled, zodSchema } = compileListItem(list.item, `${path}[]`);
  return {
    field: {
      type: "field-list",
      key,
      kdlName: toKebabCase(key),
      description: list.description,
      default: list.default,
      item: compiled,
    },
    zodSchema: z.array(zodSchema).default(list.default as unknown[]),
  };
}

export function compileNode(spec: AnyJpiNodeSpec, path: string): CompiledNode {
  if (!isJpiNodeSpec(spec)) {
    throw new Error(`${path}: expected a node created with j.node(...)`);
  }

  const attrScalars: CompiledScalarLeaf[] = [];
  let attrArray: CompiledArrayLeaf | null = null;
  const zodShape: Record<string, z.ZodType> = {};

  for (const [key, value] of Object.entries(
    spec.attrs as Record<string, ScalarField | ArrayAttr>,
  )) {
    const attrPath = `${path}.${key}`;
    const { inner } = unwrapDefault(value);
    if (inner instanceof z.ZodArray) {
      if (attrArray) {
        throw new Error(
          `${path}: at most one array attr is allowed per node, found "${attrArray.key}" and "${key}"`,
        );
      }
      attrArray = compileArrayAttr(key, value, attrPath);
    } else {
      attrScalars.push(compileScalarLeaf(key, value as ScalarField, attrPath));
    }
    zodShape[key] = value;
  }

  const fields: CompiledField[] = [];
  for (const [key, value] of Object.entries(spec.fields as Record<string, FieldValue>)) {
    const fieldPath = `${path}.${key}`;
    if (isJpiNodeSpec(value)) {
      const node = compileNode(value, fieldPath);
      fields.push({ type: "field-node", key, kdlName: toKebabCase(key), node });
      zodShape[key] = node.zodObject.default(node.defaults);
    } else if (isJpiListSpec(value)) {
      const { field, zodSchema } = compileList(key, value, fieldPath);
      fields.push(field);
      zodShape[key] = zodSchema;
    } else {
      const leaf = compileScalarLeaf(key, value, fieldPath);
      fields.push({ type: "field-scalar", ...leaf });
      zodShape[key] = value;
    }
  }

  const zodObject = z.object(zodShape);
  const defaults = zodObject.parse({}) as Record<string, unknown>;

  return { attrScalars, attrArray, fields, zodObject, defaults };
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function formatIssue(
  sectionLabel: string,
  path: string,
  message: string,
  loc?: Location,
): string {
  const fullPath = path ? `${sectionLabel}.${path}` : sectionLabel;
  const location = loc ? ` (${loc.line}:${loc.column})` : "";
  return `${fullPath}: ${message}${location}`;
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function findLastByName(nodes: readonly KdlNode[], name: string): KdlNode | undefined {
  let found: KdlNode | undefined;
  for (const candidate of nodes) {
    if (candidate.getName() === name) found = candidate;
  }
  return found;
}

export function buildRaw(
  compiled: CompiledNode,
  kdlNode: KdlNode,
  keyPrefix: string,
  sectionLabel: string,
  issues: string[],
  locations: Map<string, Location>,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  const propertyEntries = kdlNode.getPropertyEntryMap();
  const knownProps = new Set(compiled.attrScalars.map((attr) => attr.kdlName));

  for (const attr of compiled.attrScalars) {
    const entry = propertyEntries.get(attr.kdlName);
    if (entry) {
      raw[attr.key] = entry.getValue();
      const loc = getLocation(entry);
      if (loc) locations.set(joinPath(keyPrefix, attr.key), loc.start);
    }
  }

  if (compiled.attrArray && kdlNode.hasArguments()) {
    raw[compiled.attrArray.key] = kdlNode.getArguments();
    const loc = getLocation(kdlNode);
    if (loc) locations.set(joinPath(keyPrefix, compiled.attrArray.key), loc.start);
  }

  for (const [name, entry] of propertyEntries) {
    if (!knownProps.has(name)) {
      const loc = getLocation(entry);
      issues.push(formatIssue(sectionLabel, keyPrefix, `unknown property "${name}"`, loc?.start));
    }
  }

  const children = kdlNode.children?.nodes ?? [];
  const knownChildNames = new Set(compiled.fields.map((field) => field.kdlName));

  for (const field of compiled.fields) {
    if (field.type === "field-scalar") {
      const child = findLastByName(children, field.kdlName);
      if (child) {
        const args = child.getArguments();
        if (args.length > 0) {
          raw[field.key] = args[0];
          const loc = getLocation(child);
          if (loc) locations.set(joinPath(keyPrefix, field.key), loc.start);
        }
      }
    } else if (field.type === "field-node") {
      const child = findLastByName(children, field.kdlName);
      if (child) {
        raw[field.key] = buildRaw(
          field.node,
          child,
          joinPath(keyPrefix, field.key),
          sectionLabel,
          issues,
          locations,
        );
      }
    } else {
      const matches = children.filter((child) => child.getName() === field.kdlName);
      if (matches.length > 0) {
        raw[field.key] = matches.map((child, index) => {
          const itemPath = `${joinPath(keyPrefix, field.key)}.${index}`;
          if (field.item.type === "item-scalar") {
            const args = child.getArguments();
            const loc = getLocation(child);
            if (loc) locations.set(itemPath, loc.start);
            return args.length > 0 ? args[0] : undefined;
          }
          return buildRaw(field.item.node, child, itemPath, sectionLabel, issues, locations);
        });
      }
    }
  }

  for (const child of children) {
    const name = child.getName();
    if (!knownChildNames.has(name)) {
      const loc = getLocation(child);
      issues.push(formatIssue(sectionLabel, keyPrefix, `unknown node "${name}"`, loc?.start));
    }
  }

  return raw;
}

function encodeKdlString(value: string): string {
  let out = '"';
  for (const char of value) {
    switch (char) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += char;
    }
  }
  return `${out}"`;
}

function encodeLiteral(kind: BaseKind | "mixed", value: Primitive): string {
  const effectiveKind = kind === "mixed" ? (typeof value as BaseKind) : kind;
  if (effectiveKind === "string") return encodeKdlString(String(value));
  if (effectiveKind === "boolean") return value ? "#true" : "#false";
  return String(value);
}

function renderEntries(compiled: CompiledNode, value: Record<string, unknown>): string {
  const parts: string[] = [];
  if (compiled.attrArray) {
    const items = (value[compiled.attrArray.key] as Primitive[] | undefined) ?? [];
    for (const item of items) parts.push(encodeLiteral(compiled.attrArray.itemKind, item));
  }
  for (const attr of compiled.attrScalars) {
    parts.push(`${attr.kdlName}=${encodeLiteral(attr.kind, value[attr.key] as Primitive)}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function renderNode(
  name: string,
  compiled: CompiledNode,
  value: Record<string, unknown>,
  indent: string,
): string[] {
  const entries = renderEntries(compiled, value);
  if (compiled.fields.length === 0) {
    return [`${indent}${name}${entries}`];
  }
  const childIndent = `${indent}  `;
  const lines = [`${indent}${name}${entries} {`];
  for (const field of compiled.fields) {
    lines.push(...renderField(field, value, childIndent));
  }
  lines.push(`${indent}}`);
  return lines;
}

function renderField(
  field: CompiledField,
  value: Record<string, unknown>,
  indent: string,
): string[] {
  if (field.type === "field-scalar") {
    return [
      `${indent}// ${field.description}`,
      `${indent}${field.kdlName} ${encodeLiteral(field.kind, value[field.key] as Primitive)}`,
    ];
  }
  if (field.type === "field-node") {
    const sub = (value[field.key] as Record<string, unknown> | undefined) ?? field.node.defaults;
    return renderNode(field.kdlName, field.node, sub, indent);
  }
  const items = (value[field.key] as unknown[] | undefined) ?? [];
  const lines = [`${indent}// ${field.description}`];
  for (const item of items) {
    if (field.item.type === "item-scalar") {
      lines.push(`${indent}${field.kdlName} ${encodeLiteral(field.item.kind, item as Primitive)}`);
    } else {
      lines.push(
        ...renderNode(field.kdlName, field.item.node, item as Record<string, unknown>, indent),
      );
    }
  }
  return lines;
}

export function renderStanza(sectionName: string, compiled: CompiledNode): string {
  return `${renderNode(sectionName, compiled, compiled.defaults, "").join("\n")}\n`;
}
