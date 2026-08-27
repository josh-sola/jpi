import { z } from "zod";

const NODE_KIND = "jpi-node";
const LIST_KIND = "jpi-list";

type Primitive = string | number | boolean;

type ScalarZod = z.ZodString | z.ZodNumber | z.ZodBoolean;

/** A union member: a scalar zod or a `j.literal(...)` of a primitive. */
type UnionMember = ScalarZod | z.ZodLiteral<Primitive>;

/** A `j.union(...)` of scalars and/or primitive literals. */
type ScalarUnion = z.ZodUnion<readonly UnionMember[]>;

/** A scalar schema (or union of scalars), optionally wrapped in `.default(...)`. */
export type ScalarField =
  | ScalarZod
  | z.ZodDefault<ScalarZod>
  | ScalarUnion
  | z.ZodDefault<ScalarUnion>;

/** An array-of-scalars schema, optionally wrapped in `.default(...)`. */
export type ArrayAttr = z.ZodArray<ScalarZod> | z.ZodDefault<z.ZodArray<ScalarZod>>;

export interface JpiNodeSpec<
  Attrs extends Record<string, ScalarField | ArrayAttr> = Record<string, ScalarField | ArrayAttr>,
  Fields extends Record<string, FieldValue> = Record<string, FieldValue>,
> {
  readonly kind: typeof NODE_KIND;
  readonly attrs: Attrs;
  readonly fields: Fields;
}

export type AnyJpiNodeSpec = JpiNodeSpec<any, any>;

export interface JpiListSpec<
  Item extends ScalarField | AnyJpiNodeSpec = ScalarField | AnyJpiNodeSpec,
> {
  readonly kind: typeof LIST_KIND;
  readonly item: Item;
  readonly description: string;
  readonly default: readonly InferListItem<Item>[];
}

export type FieldValue = ScalarField | AnyJpiNodeSpec | JpiListSpec;

type InferListItem<Item> = Item extends AnyJpiNodeSpec
  ? InferNode<Item>
  : Item extends z.ZodType
    ? z.output<Item>
    : never;

type InferField<Field> = Field extends AnyJpiNodeSpec
  ? InferNode<Field>
  : Field extends JpiListSpec<infer Item>
    ? InferListItem<Item>[]
    : Field extends z.ZodType
      ? z.output<Field>
      : never;

type InferAttrs<Attrs> = {
  [K in keyof Attrs]: Attrs[K] extends z.ZodType ? z.output<Attrs[K]> : never;
};

type InferFields<Fields> = {
  [K in keyof Fields]: InferField<Fields[K]>;
};

export type InferNode<Spec extends AnyJpiNodeSpec> = InferAttrs<Spec["attrs"]> &
  InferFields<Spec["fields"]>;

export function isJpiNodeSpec(value: unknown): value is AnyJpiNodeSpec {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === NODE_KIND
  );
}

export function isJpiListSpec(value: unknown): value is JpiListSpec {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === LIST_KIND
  );
}

function isArraySchema(schema: z.ZodType): boolean {
  const unwrapped = schema instanceof z.ZodDefault ? schema.def.innerType : schema;
  return unwrapped instanceof z.ZodArray;
}

function node<
  Attrs extends Record<string, ScalarField | ArrayAttr> = Record<never, never>,
  Fields extends Record<string, FieldValue> = Record<never, never>,
>(spec: { attrs?: Attrs; fields?: Fields } = {}): JpiNodeSpec<Attrs, Fields> {
  const attrs = spec.attrs ?? ({} as Attrs);
  const fields = spec.fields ?? ({} as Fields);

  const arrayAttrKeys = Object.keys(attrs).filter((key) =>
    isArraySchema(attrs[key as keyof Attrs] as z.ZodType),
  );
  if (arrayAttrKeys.length > 1) {
    throw new Error(
      `j.node: at most one array attr is allowed per node, got ${arrayAttrKeys.length} (${arrayAttrKeys.join(", ")})`,
    );
  }

  return { kind: NODE_KIND, attrs, fields };
}

function list<Item extends ScalarField | AnyJpiNodeSpec>(
  item: Item,
  options: { description: string; default: readonly InferListItem<Item>[] },
): JpiListSpec<Item> {
  return {
    kind: LIST_KIND,
    item,
    description: options.description,
    default: options.default,
  };
}

function literal<T extends Primitive>(value: T): z.ZodLiteral<T> {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`j.literal: expected a string, number, or boolean, got ${typeof value}`);
  }
  return z.literal(value);
}

function union<const T extends readonly UnionMember[]>(...members: T): z.ZodUnion<T> {
  if (members.length < 2) {
    throw new Error(`j.union: requires at least two members, got ${members.length}`);
  }
  return z.union(members);
}

export const j = {
  string: (): z.ZodString => z.string(),
  number: (): z.ZodNumber => z.number(),
  boolean: (): z.ZodBoolean => z.boolean(),
  literal,
  union,
  array: <T extends ScalarZod>(item: T): z.ZodArray<T> => z.array(item),
  node,
  list,
};

export namespace j {
  export type infer<Spec extends AnyJpiNodeSpec> = InferNode<Spec>;
}
