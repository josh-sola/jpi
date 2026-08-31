/**
 * real-session.ts — the minimal REAL pi session tests/pi's canaries need: a
 * real `ExtensionAPI`, a real `ExtensionRunner`, and a real `AgentSession`, on
 * a faux model backend (no network, no auth).
 *
 * This is a stripped-down `runPrintMode` (tests/subagents/helpers/print-mode-runner.ts):
 * same faux-provider plumbing, same env isolation, but no turn is driven —
 * these canaries assert against Pi's own objects at rest, not against a
 * scripted conversation. Reuses `fauxModelBackend`/`registerFauxProvider`
 * rather than reinventing the model/auth plumbing every Pi version has moved
 * at least once (see faux-model-backend.ts's header).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxModelBackend } from "../../subagents/helpers/faux-model-backend.ts";
import { registerFauxProvider } from "../../subagents/helpers/pi-ai.ts";
import { CAPTURED_PI } from "../fixtures/capture-extension.ts";

const CAPTURE_EXTENSION_PATH = fileURLToPath(
  new URL("../fixtures/capture-extension.ts", import.meta.url),
);

export interface RealSessionHandle {
  /** The real, live `AgentSession` (faux model, no auth, no network). */
  session: AgentSession;
  /** The real `ExtensionAPI` handle `capture-extension.ts`'s factory received. */
  pi: ExtensionAPI;
  /** The resource loader backing `session` — `getExtensions()` for tool-listing canaries. */
  loader: DefaultResourceLoader;
  /** Emit `session_shutdown`, dispose the session, unregister faux, restore env, rm temp dirs. */
  dispose: () => Promise<void>;
}

/**
 * Boots a real `AgentSession` with `capture-extension.ts` loaded as an
 * `additionalExtensionPaths` entry, so `pi` is the exact object real pi
 * modules receive. Isolates `PI_CODING_AGENT_DIR`/`HOME` so the dev's own
 * config/extensions can't bleed in.
 */
export async function bootRealSession(): Promise<RealSessionHandle> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-canary-"));
  const hermeticDir = mkdtempSync(join(tmpdir(), "pi-canary-home-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = hermeticDir;
  process.env.HOME = hermeticDir;

  const faux = registerFauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: 200_000 }],
  });
  const model = faux.getModel();
  const { modelRegistry, modelRuntime } = fauxModelBackend(model);

  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [CAPTURE_EXTENSION_PATH],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    ...({ modelRegistry, modelRuntime } as Record<string, unknown>),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  } as any);

  // Binding fires session_start and wires the extension runner's UI context —
  // the same call print-mode-runner makes before driving a turn.
  await session.bindExtensions({});

  const pi = (globalThis as Record<symbol, unknown>)[CAPTURED_PI] as ExtensionAPI;

  const dispose = async () => {
    try {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      /* ignore */
    }
    try {
      session.dispose?.();
    } catch {
      /* ignore */
    }
    faux.unregister();
    delete (globalThis as Record<symbol, unknown>)[CAPTURED_PI];
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(hermeticDir, { recursive: true, force: true });
  };

  return { session, pi, loader, dispose };
}
