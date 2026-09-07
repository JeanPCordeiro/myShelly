#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

class ShellySimulator {
  constructor(options = {}) {
    this.now = new Date(options.startTime || Date.now()).getTime();
    this.kvs = new Map(Object.entries(options.kvs || {}));
    this.kvsFile = options.kvsFile ? path.resolve(options.kvsFile) : null;
    this.virtualsFile = options.virtualsFile ? path.resolve(options.virtualsFile) : null;
    this.switches = new Map();
    this.virtuals = new Map(Object.entries(options.virtuals || {
      "number:200": { value: 0 },
      "text:200": { value: "auto" },
      "text:201": { value: "" },
      "boolean:200": { value: false },
    }));
    this.statusHandlers = [];
    this.endpoints = new Map();
    this.timers = new Map();
    this.nextTimerId = 1;
    this.httpRequests = [];
    this.weather = options.weather;
    this.logs = [];
    this.pending = [];
    this.context = this.createContext();
  }

  createContext() {
    const simulator = this;
    class SimulatedDate extends Date {
      constructor(...args) {
        super(...(args.length === 0 ? [simulator.now] : args));
      }

      static now() {
        return simulator.now;
      }
    }

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

    const Shelly = {
      call: (method, params, callback) => {
        this.pending.push(async () => {
          const normalized = method.toUpperCase();
          let result = null;
          let error = null;

          if (normalized === "KVS.GET") {
            result = this.kvs.has(params.key) ? { value: this.kvs.get(params.key) } : null;
          } else if (normalized === "KVS.SET") {
            this.kvs.set(params.key, params.value);
            await this.saveKvs();
            result = { was_set: true };
          } else if (normalized === "KVS.DELETE") {
            this.kvs.delete(params.key);
            await this.saveKvs();
            result = { deleted: true };
          } else if (normalized === "SWITCH.SET") {
            this.switches.set(Number(params.id), Boolean(params.on));
            result = { was_on: Boolean(params.on) };
          } else if (normalized === "HTTP.REQUEST" || normalized === "HTTP.GET") {
            this.httpRequests.push({ method: params.method || "GET", url: params.url, body: params.body });
            if (this.weather) {
              result = { code: 200, body: JSON.stringify({ current: this.weather }) };
            } else {
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
            }
          } else {
            error = `Unsupported Shelly.call method: ${method}`;
          }

          if (callback) callback(result, error);
        });
      },
      addStatusHandler: (handler) => this.statusHandlers.push(handler),
      getDeviceInfo: () => ({ name: "Simulated Shelly" }),
    };

    const Timer = {
      set: (milliseconds, repeat, callback) => {
        const id = this.nextTimerId++;
        this.timers.set(id, { milliseconds, repeat, callback, due: this.now + milliseconds });
        return id;
      },
      clear: (id) => this.timers.delete(id),
    };

    const HTTPServer = {
      registerEndpoint: (name, handler) => this.endpoints.set(name, handler),
    };

    const Virtual = {
      getHandle: (id) => {
        const virtual = this.virtuals.get(id);
        if (!virtual) return null;
        return {
          getValue: () => virtual.value,
          setValue: (value) => {
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
    await this.loadKvs();
    await this.loadVirtuals();
    const source = await fs.readFile(scriptPath, "utf8");
    const script = new vm.Script(source, { filename: scriptPath });
    script.runInNewContext(this.context);
    await this.drain();
  }

  async loadKvs() {
    if (!this.kvsFile) return;
    try {
      const storedKvs = JSON.parse(await fs.readFile(this.kvsFile, "utf8"));
      this.kvs = new Map([...Object.entries(storedKvs), ...this.kvs]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async saveKvs() {
    if (!this.kvsFile) return;
    await fs.mkdir(path.dirname(this.kvsFile), { recursive: true });
    await fs.writeFile(this.kvsFile, `${JSON.stringify(Object.fromEntries(this.kvs), null, 2)}\n`);
  }

  async loadVirtuals() {
    if (!this.virtualsFile) return;
    try {
      const storedVirtuals = JSON.parse(await fs.readFile(this.virtualsFile, "utf8"));
      for (const [id, value] of Object.entries(storedVirtuals)) {
        const nextValue = value && typeof value === "object" && "value" in value ? value.value : value;
        const virtual = this.virtuals.get(id);
        if (!virtual) {
          this.virtuals.set(id, { value: nextValue });
        } else if (virtual.value !== nextValue) {
          virtual.value = nextValue;
          if (virtual.handlers) virtual.handlers.forEach((handler) => handler({ value: nextValue }));
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async saveVirtuals() {
    if (!this.virtualsFile) return;
    await fs.mkdir(path.dirname(this.virtualsFile), { recursive: true });
    const values = Object.fromEntries(
      [...this.virtuals].map(([id, virtual]) => [id, virtual.value])
    );
    await fs.writeFile(this.virtualsFile, `${JSON.stringify(values, null, 2)}\n`);
  }

  async flushPersistence() {
    if (this.virtualSavePromise) await this.virtualSavePromise;
  }

  async drain() {
    while (this.pending.length > 0) {
      const callbacks = this.pending.splice(0);
      for (const callback of callbacks) await callback();
      await this.flushPersistence();
    }
  }

  async advance(seconds) {
    const target = this.now + seconds * 1000;
    while (true) {
      const dueTimers = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([, a], [, b]) => a.due - b.due);
      if (dueTimers.length === 0) break;

      const [id, timer] = dueTimers[0];
      this.now = timer.due;
      await this.loadVirtuals();
      timer.callback();
      await this.drain();
      if (timer.repeat && this.timers.has(id)) timer.due += timer.milliseconds;
      else this.timers.delete(id);
    }
    this.now = target;
    await this.drain();
  }

  async runRealtime(seconds) {
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
    const status = { name: "switch", id, delta: { apower: watts } };
    this.statusHandlers.forEach((handler) => handler(status));
    await this.drain();
  }

  async setVirtual(id, value) {
    const virtual = this.virtuals.get(id);
    if (!virtual) throw new Error(`Unknown Virtual Component: ${id}`);
    virtual.value = value;
    if (virtual.handlers) virtual.handlers.forEach((handler) => handler({ value }));
    await this.flushPersistence();
  }

  async request(method, endpoint, body = "") {
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
  const argumentsList = process.argv.slice(2);
  const scriptArgument = argumentsList[0];
  const scenarioArgument = argumentsList[1] && !argumentsList[1].startsWith("--")
    ? argumentsList[1]
    : null;
  const kvsFileIndex = argumentsList.indexOf("--kvs-file");
  const commandKvsFile = kvsFileIndex >= 0 ? argumentsList[kvsFileIndex + 1] : null;
  const runSecondsIndex = argumentsList.indexOf("--run-seconds");
  const commandRunSeconds = runSecondsIndex >= 0 ? Number(argumentsList[runSecondsIndex + 1]) : null;
  if (!scriptArgument) {
    console.error("Usage: node shelly-simulator.mjs <script.js> [scenario.json]");
    process.exitCode = 1;
    return;
  }

  const scriptPath = path.resolve(scriptArgument);
  const scriptRoot = path.basename(scriptPath, path.extname(scriptPath));
  const defaultKvsFile = path.join(path.dirname(scriptPath), `${scriptRoot}.kvs.json`);
  const defaultVirtualsFile = path.join(path.dirname(scriptPath), `${scriptRoot}.virtuals.json`);
  const scenario = scenarioArgument
    ? JSON.parse(await fs.readFile(path.resolve(scenarioArgument), "utf8"))
    : {};
  const simulator = new ShellySimulator({
    ...scenario,
    kvsFile: commandKvsFile || scenario.kvsFile || defaultKvsFile,
    virtualsFile: scenario.virtualsFile || defaultVirtualsFile,
  });

  await simulator.loadScript(scriptPath);
  for (const event of scenario.events || []) {
    await simulator.runRealtime(event.afterSeconds || 0);
    if (event.power !== undefined) await simulator.emitPower(event.power, event.id || 0);
    if (event.virtual) await simulator.setVirtual(event.virtual.id, event.virtual.value);
    if (event.request) await simulator.request(event.request.method || "GET", event.request.path, event.request.body || "");
  }
  const defaultRunSeconds = 120;
  const runSeconds = scenario.finishAfterSeconds ?? commandRunSeconds ?? defaultRunSeconds;
  await simulator.runRealtime(runSeconds);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { ShellySimulator };