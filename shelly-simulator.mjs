#!/usr/bin/env node

/*
 * Shelly Simulator Architecture
 * ==============================
 *
 * Purpose
 * -------
 * This program runs a Shelly JavaScript script on a normal Node.js machine.
 * It is a lightweight device runtime, not a replacement implementation of
 * the script being tested. The script remains unchanged and is executed inside
 * a controlled VM context that provides the Shelly services it expects.
 *
 * Process overview
 * ----------------
 * 1. The CLI receives the script filename and an optional run duration.
 * 2. A ShellySimulator instance is created with a simulated clock and device
 *    state containers.
 * 3. Persistent KVS and Virtual Component files are loaded before startup.
 * 4. The script is evaluated in a VM context containing simulated Shelly APIs.
 * 5. Startup calls are queued and drained, just like asynchronous device RPCs.
 * 6. The real-time loop waits for timer deadlines and executes callbacks.
 * 7. State changes are persisted so the next process behaves like a reboot.
 *
 * VM context and API interception
 * -------------------------------
 * The script never calls Node.js APIs directly. It sees objects such as
 * Shelly, Timer, Virtual, HTTPServer, Date and print returned by createContext.
 *
 * Shelly.call() is the main interception point. The simulator receives the
 * method name and parameters, translates supported methods into local actions,
 * and eventually invokes the script callback with a Shelly-like result:
 *
 *   Shelly.call("KVS.GET", params, callback)
 *                |
 *                +-- queued in pending
 *                +-- executed by drain()
 *                +-- callback(result, error)
 *
 * Calls are queued instead of executed inline because real Shelly RPC calls are
 * asynchronous. This also preserves nested callback ordering and makes it
 * possible to wait for real HTTP requests without blocking the script VM.
 *
 * KVS state
 * ---------
 * KVS is private key/value storage owned by the script. KVS.GET reads from the
 * in-memory Map, KVS.SET updates it and writes the complete snapshot to the
 * script-named .kvs.json file, and KVS.DELETE removes a key and persists the
 * result. Values are kept exactly as supplied by the script; a JSON.stringify
 * value therefore remains a string, matching the Shelly behavior used here.
 *
 * Virtual Component state
 * -----------------------
 * Virtual Components are device/UI state visible to Shelly Control. The
 * simulator creates no components by default. Components must be declared in
 * the script-named .virtuals.json file. Virtual.getHandle(id) returns a small
 * handle exposing getValue(), setValue() and addEventHandler().
 *
 * setValue() updates the in-memory value immediately, persists the plain value
 * to the virtuals file, and notifies registered handlers. Before each due timer
 * the simulator reloads that file, so an external edit is treated like a value
 * change arriving from Shelly Control. Missing IDs return null, allowing the
 * same script to run on devices with different Virtual Component layouts.
 *
 * Timers and time
 * ---------------
 * Timer.set() registers a deadline in the simulated clock. Timer.clear() removes
 * it. runRealtime() waits on the host clock with no acceleration, then calls
 * advance(), which executes every due timer in chronological order. This keeps
 * minute and hourly schedules aligned with real device time.
 *
 * HTTP boundary
 * -------------
 * HTTP.GET and HTTP.REQUEST are intercepted in Shelly.call(), then forwarded
 * to the URL supplied by the script through Node's fetch(). The simulator does
 * not interpret the target service or the response payload.
 *
 * Persistence boundary
 * --------------------
 * KVS and Virtual Components intentionally use separate files because they are
 * different kinds of Shelly state. The filenames are derived from the script:
 *
 *   ExampleScript.mjs         -> ExampleScript.kvs.json
 *   ExampleScript.mjs         -> ExampleScript.virtuals.json
 *
 * The files are loaded before script startup and updated after state changes.
 * The simulator therefore models a device reboot without inventing state that
 * was not declared by the script or persisted by a previous run.
 */

import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

class ShellySimulator {
  constructor(options = {}) {
    // Keep the simulated clock independent from the host clock so scripts can
    // use Date normally while the simulator controls when time advances.
    this.now = new Date(options.startTime || Date.now()).getTime();

    // KVS is private script storage. Scripts access it only through
    // Shelly.call("KVS.GET"), Shelly.call("KVS.SET") and KVS.DELETE.
    // Keep this Map as the authoritative runtime state; the JSON file is only
    // the durable snapshot used when the simulated device starts again.
    this.kvs = new Map(Object.entries(options.kvs || {}));
    this.kvsFile = options.kvsFile ? path.resolve(options.kvsFile) : null;

    // Virtual Components are device/UI state. They are exposed through
    // Virtual.getHandle(id), so the script and Shelly Control share the same
    // value instead of communicating through KVS. The simulator deliberately
    // starts with no Virtual Components: components must be declared by the
    // persisted virtuals JSON file. A missing handle is intentional: it models
    // a real device where that component has not been created.
    this.virtualsFile = options.virtualsFile ? path.resolve(options.virtualsFile) : null;
    this.switches = new Map();
    this.virtuals = new Map(
      Object.entries(options.virtuals || {}).map(([id, value]) => [
        id,
        value && typeof value === "object" && "value" in value ? value : { value },
      ])
    );
    // Each collection below represents one device subsystem. When adding a
    // new Shelly API, store its runtime state here and expose only its public
    // script-facing handle from createContext().
    this.statusHandlers = [];
    this.endpoints = new Map();
    this.timers = new Map();
    this.nextTimerId = 1;
    this.httpRequests = [];
    this.logs = [];
    this.pending = [];
    this.context = this.createContext();
  }

  /*
   * Create the JavaScript global objects exposed to the script.
   *
   * A script is executed inside a VM context so it can use familiar Shelly
   * globals such as Shelly, Timer, Virtual, HTTPServer, Date and print. The
   * context deliberately exposes only the simulator API; this keeps missing
   * device dependencies visible instead of silently using Node internals.
   */
  createContext() {
    const simulator = this;

    // Expose a Date implementation that follows the simulator clock.
    class SimulatedDate extends Date {
      constructor(...args) {
        super(...(args.length === 0 ? [simulator.now] : args));
      }

      static now() {
        return simulator.now;
      }
    }

    // Prefix simulator output with the simulated local timestamp.
    const pad = (value) => String(value).padStart(2, "0");
    const timestamp = () => {
      const date = new SimulatedDate();
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    const print = (...args) => {
      const line = `[${timestamp()}] ${args.map(String).join(" ")}`;
      this.logs.push(line);
      console.log(line);
    };

    /*
     * Shelly API extension point
     * ---------------------------
     * To support another Shelly.call method, add one normalized branch below.
     * The branch must produce a Shelly-shaped result, set an error when the
     * operation fails, and leave callback invocation at the end of the queued
     * operation. Do not call the callback synchronously from the public API:
     * scripts rely on Shelly RPC calls being asynchronous.
     */
    const Shelly = {
      call: (method, params, callback) => {
        /*
         * Shelly.call is asynchronous on the device. Queueing the operation
         * preserves that contract and makes nested calls such as KVS.GET ->
         * HTTP.GET -> KVS.SET run in the same callback-driven order.
         */
        this.pending.push(async () => {
          const normalized = method.toUpperCase();
          let result = null;
          let error = null;

          // Keep method matching case-insensitive because existing scripts use
          // both KVS.GET and KVS.Get spellings.
          if (normalized === "KVS.GET") {
            // Missing keys return null, matching the script's first-start check.
            result = this.kvs.has(params.key) ? { value: this.kvs.get(params.key) } : null;
          } else if (normalized === "KVS.SET") {
            // KVS values are kept as supplied by the script. In particular,
            // JSON.stringify() values remain strings, just as on the device.
            this.kvs.set(params.key, params.value);
            await this.saveKvs();
            result = { was_set: true };
          } else if (normalized === "KVS.DELETE") {
            // Deleting a key lets a script return to its first-run path.
            this.kvs.delete(params.key);
            await this.saveKvs();
            result = { deleted: true };
          } else if (normalized === "SWITCH.SET") {
            this.switches.set(Number(params.id), Boolean(params.on));
            result = { was_on: Boolean(params.on) };
          } else if (normalized === "HTTP.REQUEST" || normalized === "HTTP.GET") {
            // Forward any HTTP request generically. The simulator does not
            // interpret the URL, method, or response payload.
            this.httpRequests.push({ method: params.method || "GET", url: params.url, body: params.body });
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), (params.timeout || 30) * 1000);
            try {
              const response = await fetch(params.url, {
                method: params.method || "GET",
                body: params.body,
                signal: controller.signal,
              });
              result = { code: response.status, body: await response.text() };
            } catch (requestError) {
              error = requestError.message;
            } finally {
              clearTimeout(timeout);
            }
          } else {
            // Unsupported calls are reported to the script callback instead of
            // being silently ignored. This makes missing simulator APIs visible.
            error = `Unsupported Shelly.call method: ${method}`;
          }

          if (callback) callback(result, error);
        });
      },
      addStatusHandler: (handler) => this.statusHandlers.push(handler),
      getDeviceInfo: () => ({ name: "Simulated Shelly" }),
    };

    /*
     * Timer contract
     * --------------
     * Timer.set() returns an opaque numeric ID. Repeating timers remain in the
     * registry and are rescheduled from their previous deadline; one-shot
     * timers are removed after their callback. Timer.clear() must therefore
     * only remove the ID and must not invoke the callback.
     */
    const Timer = {
      /*
       * Device timers are registered here, not with Node's setTimeout. The
       * scheduler later decides when a timer is due, which is essential for
       * deterministic virtual-time execution.
       */
      set: (milliseconds, repeat, callback) => {
        const id = this.nextTimerId++;
        this.timers.set(id, { milliseconds, repeat, callback, due: this.now + milliseconds });
        return id;
      },
      clear: (id) => this.timers.delete(id),
    };

    // HTTPServer stores endpoint handlers for programmatic callers. It does
    // not open a TCP listener; request() below invokes these handlers directly.
    const HTTPServer = {
      // Keep script endpoints available for direct simulator requests.
      registerEndpoint: (name, handler) => this.endpoints.set(name, handler),
    };

    const Virtual = {
      getHandle: (id) => {
        /*
         * Virtual Components represent user-visible device state. Handles are
         * intentionally lightweight, but support the operations used by the
         * script under test: reading, writing and reacting to value changes.
         */
        const virtual = this.virtuals.get(id);
        if (!virtual) return null;
        return {
          getValue: () => virtual.value,
          setValue: (value) => {
            // A Virtual Component write is visible immediately to subsequent
            // getValue() calls, persisted asynchronously, and broadcast to
            // handlers so scripts can react without polling.
            virtual.value = value;
            this.virtualSavePromise = this.saveVirtuals();
            if (virtual.handlers) {
              virtual.handlers.forEach((handler) => handler({ value }));
            }
          },
          addEventHandler: (handler) => {
            if (!virtual.handlers) virtual.handlers = [];
            virtual.handlers.push(handler);
          },
        };
      },
    };

    return { Date: SimulatedDate, Shelly, Timer, HTTPServer, Virtual, print, console };
  }

  async loadScript(scriptPath) {
    /*
     * Restore state before evaluating the source. This mirrors a Shelly
     * reboot: the script sees persisted KVS and Virtual Component values
     * during its startup code, not after startup has already run.
     */
    await this.loadKvs();
    await this.loadVirtuals();
    // vm.Script compiles first, then runInNewContext executes top-level startup
    // code. A script that throws here has not completed device startup.
    const source = await fs.readFile(scriptPath, "utf8");
    const script = new vm.Script(source, { filename: scriptPath });
    script.runInNewContext(this.context);
    await this.drain();
  }

  async loadKvs() {
    // KVS is the script's private persistent key/value storage.
    if (!this.kvsFile) return;
    try {
      const storedKvs = JSON.parse(await fs.readFile(this.kvsFile, "utf8"));

      this.kvs = new Map([...Object.entries(storedKvs), ...this.kvs]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async saveKvs() {
    // Write the complete KVS snapshot so a later process starts like a rebooted device.
    // A KVS write is therefore durable before its Shelly callback completes.
    if (!this.kvsFile) return;
    await fs.mkdir(path.dirname(this.kvsFile), { recursive: true });
    await fs.writeFile(this.kvsFile, `${JSON.stringify(Object.fromEntries(this.kvs), null, 2)}\n`);
  }

  async loadVirtuals() {
    // Reload external changes so editing the virtuals file behaves like a
    // control change received by a running device.
    if (!this.virtualsFile) return;
    try {
      const storedVirtuals = JSON.parse(await fs.readFile(this.virtualsFile, "utf8"));
      for (const [id, value] of Object.entries(storedVirtuals)) {
        // Accept both the compact persisted form ({ "text:201": "..." }) and
        // the richer persisted form ({ "text:201": { "value": "..." } }).
        const nextValue = value && typeof value === "object" && "value" in value ? value.value : value;
        const virtual = this.virtuals.get(id);
        if (!virtual) {
          // Unknown IDs are loaded as well, allowing a device configuration to
          // add a component without changing simulator source code.
          this.virtuals.set(id, { value: nextValue });
        } else if (virtual.value !== nextValue) {
          // A changed file value is treated like a Shelly Control change and
          // therefore notifies registered handlers.
          virtual.value = nextValue;
          if (virtual.handlers) virtual.handlers.forEach((handler) => handler({ value: nextValue }));
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async saveVirtuals() {
    // Virtual Component state is persisted separately because it is device/UI state,
    // not private script storage.
    // The file stores plain values; internal event-handler arrays never leak
    // into the persisted JSON.
    if (!this.virtualsFile) return;
    await fs.mkdir(path.dirname(this.virtualsFile), { recursive: true });
    const values = Object.fromEntries(
      [...this.virtuals].map(([id, virtual]) => [id, virtual.value])
    );
    await fs.writeFile(this.virtualsFile, `${JSON.stringify(values, null, 2)}\n`);
  }

  async flushPersistence() {
    // setValue() starts an asynchronous write; wait for it before continuing.
    if (this.virtualSavePromise) await this.virtualSavePromise;
  }

  async drain() {
    /*
     * Drain the device-operation queue until it is empty. A callback may
     * enqueue another Shelly.call, so this must be a loop rather than a single
     * batch. Persistence is flushed between batches to keep files consistent.
     */
    while (this.pending.length > 0) {
      const callbacks = this.pending.splice(0);
      for (const callback of callbacks) await callback();
      await this.flushPersistence();
    }
  }

  async advance(seconds) {
    /*
     * Advance the simulated clock without waiting on the host clock. Every
     * timer due in the interval is executed in chronological order. This is
     * useful for deterministic unit-style checks, while runRealtime below is
     * the normal device-like execution path.
     */
    const target = this.now + seconds * 1000;
    while (true) {
      const dueTimers = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([, a], [, b]) => a.due - b.due);
      if (dueTimers.length === 0) break;

      const [id, timer] = dueTimers[0];
      this.now = timer.due;
      await this.loadVirtuals();
      // Timer callbacks may register, clear or reschedule timers. Apply those
      // mutations before deciding whether the current timer repeats.
      timer.callback();
      await this.drain();
      if (timer.repeat && this.timers.has(id)) timer.due += timer.milliseconds;
      else this.timers.delete(id);
    }
    this.now = target;
    await this.drain();
  }

  async runRealtime(seconds) {
    /*
     * Run against wall-clock time. The process sleeps until the next simulated
     * timer deadline, then advances the device clock and executes callbacks.
     * No acceleration factor is applied: one simulated second is one real
     * second, just as it would be on a Shelly device.
     */
    const target = this.now + seconds * 1000;
    while (this.now < target) {
      const nextDue = [...this.timers.values()]
        .map((timer) => timer.due)
        .filter((due) => due > this.now)
        .sort((a, b) => a - b)[0] || target;
      const nextTime = Math.min(nextDue, target);
      const simulatedWait = nextTime - this.now;
      await new Promise((resolve) => setTimeout(resolve, simulatedWait));
      await this.advance(simulatedWait / 1000);
    }
  }

  async emitPower(watts, id = 0) {
    // Inject a switch power-status event into registered script handlers.
    const status = { name: "switch", id, delta: { apower: watts } };
    this.statusHandlers.forEach((handler) => handler(status));
    await this.drain();
  }

  async setVirtual(id, value) {
    // Inject a Virtual Component change, as if it came from Shelly Control.
    // This is the programmatic equivalent of changing a component from the
    // cloud UI.
    const virtual = this.virtuals.get(id);
    if (!virtual) throw new Error(`Unknown Virtual Component: ${id}`);
    virtual.value = value;
    if (virtual.handlers) virtual.handlers.forEach((handler) => handler({ value }));
    await this.flushPersistence();
  }

  async request(method, endpoint, body = "") {
    // Invoke a script endpoint without starting an HTTP server. This helper is
    // intentionally separate from Shelly.call: it models an external client
    // reaching an endpoint registered by the script.
    const handler = this.endpoints.get(endpoint.replace(/^\//, ""));
    if (!handler) throw new Error(`Unknown endpoint: ${endpoint}`);
    const response = {
      body: "",
      code: 200,
      headers: [],
      send() { this.sent = true; },
    };
    handler({ method, body }, response);
    await this.drain();
    return response;
  }

  summary() {
    // Keep this inspection helper available to API users, even though the CLI
    // intentionally does not print a summary after the observation window.
    return {
      time: new Date(this.now).toISOString(),
      kvs: Object.fromEntries(this.kvs),
      switches: Object.fromEntries(this.switches),
      virtuals: Object.fromEntries(this.virtuals),
      httpRequests: this.httpRequests,
    };
  }
}

async function main() {
  /*
  * The CLI is intentionally thin. It constructs one device, loads one
  * script, and keeps the device alive for the requested observation window.
  * This mirrors how a script is normally installed once and then reacts to
  * timers or external device state.
   */
  const argumentsList = process.argv.slice(2);
  const scriptArgument = argumentsList[0];
  const kvsFileIndex = argumentsList.indexOf("--kvs-file");
  const commandKvsFile = kvsFileIndex >= 0 ? argumentsList[kvsFileIndex + 1] : null;
  const runSecondsIndex = argumentsList.indexOf("--run-seconds");
  const commandRunSeconds = runSecondsIndex >= 0 ? Number(argumentsList[runSecondsIndex + 1]) : null;
  if (!scriptArgument) {
    console.error("Usage: node shelly-simulator.mjs <script.js> [--run-seconds seconds]");
    process.exitCode = 1;
    return;
  }

  const scriptPath = path.resolve(scriptArgument);
  const scriptRoot = path.basename(scriptPath, path.extname(scriptPath));
  const defaultKvsFile = path.join(path.dirname(scriptPath), `${scriptRoot}.kvs.json`);
  const defaultVirtualsFile = path.join(path.dirname(scriptPath), `${scriptRoot}.virtuals.json`);
  // Persistence filenames follow the script name so multiple scripts can run
  // in the same directory without sharing private state accidentally.
  const simulator = new ShellySimulator({
    kvsFile: commandKvsFile || defaultKvsFile,
    virtualsFile: defaultVirtualsFile,
  });

  await simulator.loadScript(scriptPath);
  const defaultRunSeconds = 120;
  const runSeconds = commandRunSeconds ?? defaultRunSeconds;
  await simulator.runRealtime(runSeconds);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { ShellySimulator };