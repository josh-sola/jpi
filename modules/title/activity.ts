import {
  ACTIVE_FRAMES,
  IDLE_INDICATOR,
  INPUT_INDICATOR,
  SPINNER_INTERVAL_MS,
  WAITING_INDICATOR,
  type Scheduler,
} from "./helpers.ts";

type State = "input" | "working" | "waiting" | "idle";

export class ActivityTitle {
  private main = false;
  private backgroundProviders = new Set<string>();
  private subagents = new Set<string>();
  private scheduleActive = false;
  private prompts = 0;
  private frame = 0;
  private timer?: unknown;
  private disposed = false;
  private scheduler: Scheduler;
  private getName: () => string;
  private setTitle: (title: string) => void;

  constructor(scheduler: Scheduler, getName: () => string, setTitle: (title: string) => void) {
    this.scheduler = scheduler;
    this.getName = getName;
    this.setTitle = setTitle;
  }

  setMain(active: boolean): void {
    this.change(() => {
      this.main = active;
    });
  }

  /** provider namespaces the flag so two background integrations can't clobber each other. */
  setBackgroundProvider(provider: string, active: boolean): void {
    this.change(() => {
      if (active) this.backgroundProviders.add(provider);
      else this.backgroundProviders.delete(provider);
    });
  }

  startSubagent(id: string): void {
    this.change(() => {
      this.subagents.add(id);
    });
  }

  finishSubagent(id: string): void {
    this.change(() => {
      this.subagents.delete(id);
    });
  }

  setScheduleActive(active: boolean): void {
    this.change(() => {
      this.scheduleActive = active;
    });
  }

  /** Prompts can nest, so track a count rather than a flag. */
  startPrompt(): void {
    this.change(() => {
      this.prompts += 1;
    });
  }

  endPrompt(): void {
    this.change(() => {
      if (this.prompts > 0) this.prompts -= 1;
    });
  }

  refresh(): void {
    if (!this.disposed) this.render();
  }

  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
    this.main = false;
    this.backgroundProviders.clear();
    this.subagents.clear();
    this.scheduleActive = false;
    this.prompts = 0;
    this.setTitle(`${IDLE_INDICATOR} ${this.getName()}`);
  }

  private change(update: () => void): void {
    if (this.disposed) return;
    const before = this.state();
    update();
    const after = this.state();
    if (before === after) return;
    if (after === "working") this.start();
    else if (before === "working") this.stop();
    else this.render();
  }

  private start(): void {
    this.frame = 0;
    this.render();
    this.timer = this.scheduler.setInterval(() => {
      if (this.disposed) return;
      this.frame = (this.frame + 1) % ACTIVE_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL_MS);
  }

  private stop(): void {
    if (this.timer !== undefined) this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
    this.frame = 0;
    this.render();
  }

  private render(): void {
    this.setTitle(this.text());
  }

  private text(): string {
    const state = this.state();
    if (state === "input") return `${INPUT_INDICATOR} ${this.getName()}`;
    if (state === "working") return `${ACTIVE_FRAMES[this.frame]} ${this.getName()}`;
    if (state === "waiting") return `${WAITING_INDICATOR} ${this.getName()}`;
    return `${IDLE_INDICATOR} ${this.getName()}`;
  }

  private state(): State {
    if (this.prompts > 0) return "input";
    if (this.main) return "working";
    if (this.backgroundProviders.size > 0 || this.subagents.size > 0 || this.scheduleActive) {
      return "waiting";
    }
    return "idle";
  }
}
