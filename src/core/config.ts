import {
  Document,
  format as formatKdl,
  InvalidKdlError,
  Node,
  parse as parseKdl,
  type Location,
} from "@bgotink/kdl";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getAgentDirectory } from "../pi/index.ts";
import type { AnyJpiNodeSpec, InferNode } from "./builder.ts";
import { errorMessage } from "./errors.ts";
import {
  buildRaw,
  cloneJson,
  compileNode,
  formatIssue,
  renderStanza,
  type CompiledNode,
  type CompiledScalarLeaf,
  type Primitive,
} from "./codec.ts";

export interface ConfigLoadResult<Value> {
  readonly value: Value;
  readonly issues: string[];
}

export interface ConfigSaveResult {
  readonly issues: string[];
}

/** Where a scalar field lives on the section node: a child node, or a property on the section line itself. */
type ScalarTarget = { readonly location: "field" | "attr"; readonly leaf: CompiledScalarLeaf };

const HEADER =
  "// jpi.kdl — config for all jpi plugins.\n// Sections are added by each plugin on first load.\n";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatParseError(error: unknown): string {
  if (error instanceof InvalidKdlError) {
    return Array.from(error.flat())
      .map((sub) => sub.message)
      .join("; ");
  }
  return errorMessage(error);
}

async function appendStanza(path: string, currentText: string, stanza: string): Promise<void> {
  const trimmed = currentText.replace(/\s+$/, "");
  await writeFile(path, `${trimmed}\n\n${stanza}`, "utf8");
}

/**
 * Reads and writes one plugin's section of the shared `jpi.kdl` config file.
 * The schema is validated at construction so a bad field fails fast, not
 * buried inside a later decode failure.
 */
export class Config<Schema extends AnyJpiNodeSpec> {
  readonly #section: string;
  readonly #path: string;
  readonly #compiled: CompiledNode;
  readonly #stanza: string;

  constructor(
    section: string,
    schema: Schema,
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
  ) {
    this.#section = section;
    this.#path = join(getAgentDirectory(env, homeDirectory), "jpi.kdl");
    this.#compiled = compileNode(schema, section);
    this.#stanza = renderStanza(section, this.#compiled);
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<ConfigLoadResult<InferNode<Schema>>> {
    let text: string;
    try {
      text = await this.#ensureFile();
    } catch (error) {
      return {
        value: cloneJson(this.#compiled.defaults) as InferNode<Schema>,
        issues: [`could not read jpi.kdl: ${errorMessage(error)}`],
      };
    }

    let document;
    try {
      document = parseKdl(text, { storeLocations: true });
    } catch (error) {
      return {
        value: cloneJson(this.#compiled.defaults) as InferNode<Schema>,
        issues: [`could not parse jpi.kdl: ${formatParseError(error)}`],
      };
    }

    const sectionNode = document.findNodeByName(this.#section);
    if (!sectionNode) {
      const appendIssues: string[] = [];
      try {
        await appendStanza(this.#path, text, this.#stanza);
      } catch (error) {
        appendIssues.push(`could not write jpi.kdl: ${errorMessage(error)}`);
      }
      return {
        value: cloneJson(this.#compiled.defaults) as InferNode<Schema>,
        issues: appendIssues,
      };
    }

    const issues: string[] = [];
    const locations: Map<string, Location> = new Map();
    const raw = buildRaw(this.#compiled, sectionNode, "", this.#section, issues, locations);

    const parsed = this.#compiled.zodObject.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path.map(String).join(".");
        issues.push(formatIssue(this.#section, key, issue.message, locations.get(key)));
      }
      return { value: cloneJson(this.#compiled.defaults) as InferNode<Schema>, issues };
    }

    return { value: parsed.data as InferNode<Schema>, issues };
  }

  /**
   * Writes scalar top-level values back into the section, mutating only the
   * affected child nodes so everything else the user wrote survives
   * untouched. Validates every change first: any unsupported key or invalid
   * value aborts the whole call without writing anything.
   */
  async save(changes: Partial<InferNode<Schema>>): Promise<ConfigSaveResult> {
    const entries = Object.entries(changes as Record<string, unknown>);
    if (entries.length === 0) return { issues: [] };

    const issues: string[] = [];
    const plan: Array<{ target: ScalarTarget; value: Primitive }> = [];

    for (const [key, value] of entries) {
      const target = this.#findScalarTarget(key);
      if (!target) {
        issues.push(
          formatIssue(
            this.#section,
            key,
            "not a top-level scalar field (nested nodes, lists, and array attrs can't be saved)",
          ),
        );
        continue;
      }
      const shape = this.#compiled.zodObject.shape[key];
      if (!shape) throw new Error(`schema has no shape entry for scalar field "${key}"`);
      const parsed = shape.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          issues.push(formatIssue(this.#section, key, issue.message));
        }
        continue;
      }
      plan.push({ target, value: parsed.data as Primitive });
    }

    if (issues.length > 0) return { issues };

    let text: string;
    try {
      text = await this.#ensureFile();
    } catch (error) {
      return { issues: [`could not read jpi.kdl: ${errorMessage(error)}`] };
    }

    let document;
    try {
      document = parseKdl(text, { storeLocations: true });
    } catch (error) {
      return { issues: [`could not parse jpi.kdl: ${formatParseError(error)}`] };
    }

    let sectionNode = document.findNodeByName(this.#section);
    if (!sectionNode) {
      try {
        await appendStanza(this.#path, text, this.#stanza);
      } catch (error) {
        return { issues: [`could not write jpi.kdl: ${errorMessage(error)}`] };
      }
      try {
        text = await readFile(this.#path, "utf8");
        document = parseKdl(text, { storeLocations: true });
      } catch (error) {
        return { issues: [`could not parse jpi.kdl: ${formatParseError(error)}`] };
      }
      sectionNode = document.findNodeByName(this.#section);
      if (!sectionNode) {
        return { issues: [`could not find "${this.#section}" section after creating it`] };
      }
    }

    for (const { target, value } of plan) {
      if (target.location === "attr") {
        sectionNode.setProperty(target.leaf.kdlName, value);
        continue;
      }
      if (!sectionNode.children) {
        sectionNode.children = new Document();
      }
      const child = sectionNode.findNodeByName(target.leaf.kdlName);
      if (child) {
        const entry = child.getArgumentEntry(0);
        if (entry) {
          entry.setValue(value);
        } else {
          child.addArgument(value);
        }
      } else {
        const newNode = Node.create(target.leaf.kdlName);
        newNode.addArgument(value);
        newNode.leading = "  ";
        sectionNode.children.appendNode(newNode);
      }
    }

    try {
      await writeFile(this.#path, formatKdl(document), "utf8");
    } catch (error) {
      return { issues: [`could not write jpi.kdl: ${errorMessage(error)}`] };
    }

    return { issues: [] };
  }

  /** A scalar field's spec, whether it's a child node (fields) or a property on the section line (attrs); undefined for anything else. */
  #findScalarTarget(key: string): ScalarTarget | undefined {
    const field = this.#compiled.fields.find((candidate) => candidate.key === key);
    if (field) {
      return field.type === "field-scalar" ? { location: "field", leaf: field } : undefined;
    }
    const attr = this.#compiled.attrScalars.find((candidate) => candidate.key === key);
    return attr ? { location: "attr", leaf: attr } : undefined;
  }

  async #ensureFile(): Promise<string> {
    await mkdir(dirname(this.#path), { recursive: true });
    try {
      const handle = await open(this.#path, "wx");
      try {
        await handle.writeFile(HEADER, "utf8");
      } finally {
        await handle.close();
      }
      return HEADER;
    } catch (error) {
      if (isErrnoException(error) && error.code === "EEXIST") {
        return readFile(this.#path, "utf8");
      }
      throw error;
    }
  }
}
