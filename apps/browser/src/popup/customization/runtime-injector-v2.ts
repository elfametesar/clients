type Cleanup = () => void;

export type InjectorKind = "css" | "js";
export type InjectorSourceMode = "paste" | "file" | "url";

export interface InjectorSourceConfig {
  enabled: boolean;
  code: string;
  mode: InjectorSourceMode;
  label: string;
  url: string;
}

export interface RuntimeInjectorConfig {
  version: 2;
  enabled: boolean;
  css: InjectorSourceConfig;
  js: InjectorSourceConfig & { autorun: boolean };
}

export interface RuntimeInjectorApi {
  query<T extends Element = Element>(selector: string): T | null;
  queryAll<T extends Element = Element>(selector: string): T[];
  getConfig(): RuntimeInjectorConfig;
  saveConfig(config: RuntimeInjectorConfig): void;
  setEnabled(enabled: boolean): void;
  applyCss(css?: string, persist?: boolean): void;
  clearCss(clearSavedSource?: boolean): void;
  runJs(source?: string, persist?: boolean): unknown;
  clearJs(clearSavedSource?: boolean): void;
  reset(): void;
  disableAll(reason?: string): void;
  importFromUrl(kind: InjectorKind, url: string): Promise<string>;
  openSettings(): void;
  open(): void;
  close(): void;
  toggle(): void;
}

type RuntimeInjectorWindow = Window & {
  bitwardenRuntimeInjector?: RuntimeInjectorApi;
  __bitwardenRuntimeInjectorV2Installed?: boolean;
};

function runtimeWindow(): RuntimeInjectorWindow {
  return window as RuntimeInjectorWindow;
}

export function getRuntimeInjectorApi(): RuntimeInjectorApi | undefined {
  return runtimeWindow().bitwardenRuntimeInjector;
}

const HOST_ID = "bitwarden-runtime-injector-safety";
const SETTINGS_HOST_ID = "bitwarden-runtime-injector-settings";
const SETTINGS_ENTRY_ID = "bitwarden-runtime-injector-settings-entry";
const STYLE_ID = "bitwarden-runtime-injected-css";
const CONFIG_KEY = "bitwarden-runtime-injector.config.v2";
const LEGACY_CSS_KEY = "bitwarden-runtime-injector.css";
const LEGACY_JS_KEY = "bitwarden-runtime-injector.js";
const LEGACY_AUTORUN_KEY = "bitwarden-runtime-injector.autorun";
const BOOT_GUARD_KEY = "bitwarden-runtime-injector.boot-guard";
const SAFE_REASON_KEY = "bitwarden-runtime-injector.safe-reason";
const MAX_IMPORT_BYTES = 1_000_000;
const AUTORUN_DELAY_MS = 1_200;
const ASYNC_ERROR_WINDOW_MS = 5_000;

let cleanup: Cleanup | undefined;
let asyncErrorCleanup: Cleanup | undefined;
let panelOpen = false;
let statusWriter: ((message: string, isError?: boolean) => void) | undefined;
let emergencyOpen: () => void = () => undefined;
let emergencyClose: () => void = () => undefined;
let emergencyToggle: () => void = () => undefined;
let settingsOpen: () => void = () => undefined;
let settingsRefresh: () => void = () => undefined;
let settingsEntryObserver: MutationObserver | undefined;

function defaultSource(): InjectorSourceConfig {
  return { enabled: true, code: "", mode: "paste", label: "Pasted code", url: "" };
}

export function createDefaultRuntimeInjectorConfig(): RuntimeInjectorConfig {
  return {
    version: 2,
    enabled: false,
    css: defaultSource(),
    js: { ...defaultSource(), autorun: false },
  };
}

function cloneConfig(config: RuntimeInjectorConfig): RuntimeInjectorConfig {
  return JSON.parse(JSON.stringify(config)) as RuntimeInjectorConfig;
}

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    console.warn(`[Runtime Injector] Could not save ${key}`, error);
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    console.warn(`[Runtime Injector] Could not remove ${key}`, error);
  }
}

function normalizeSource(value: unknown): InjectorSourceConfig {
  const source = typeof value === "object" && value !== null ? value : {};
  const record = source as Partial<InjectorSourceConfig>;
  const mode: InjectorSourceMode =
    record.mode === "file" || record.mode === "url" ? record.mode : "paste";

  return {
    enabled: record.enabled !== false,
    code: typeof record.code === "string" ? record.code : "",
    mode,
    label: typeof record.label === "string" && record.label.length > 0 ? record.label : "Pasted code",
    url: typeof record.url === "string" ? record.url : "",
  };
}

function normalizeConfig(value: unknown): RuntimeInjectorConfig {
  const defaults = createDefaultRuntimeInjectorConfig();
  if (typeof value !== "object" || value === null) {
    return defaults;
  }

  const record = value as Partial<RuntimeInjectorConfig>;
  const js = normalizeSource(record.js);
  const jsRecord = typeof record.js === "object" && record.js !== null ? record.js : {};

  return {
    version: 2,
    enabled: record.enabled === true,
    css: normalizeSource(record.css),
    js: {
      ...js,
      autorun: (jsRecord as Partial<RuntimeInjectorConfig["js"]>).autorun === true,
    },
  };
}

function migrateLegacyConfig(): RuntimeInjectorConfig {
  const config = createDefaultRuntimeInjectorConfig();
  const legacyCss = read(LEGACY_CSS_KEY);
  const legacyJs = read(LEGACY_JS_KEY);

  if (legacyCss.length > 0 || legacyJs.length > 0) {
    config.enabled = true;
    config.css.code = legacyCss;
    config.js.code = legacyJs;
    config.js.autorun = read(LEGACY_AUTORUN_KEY) === "true";
    saveConfig(config);
    remove(LEGACY_CSS_KEY);
    remove(LEGACY_JS_KEY);
    remove(LEGACY_AUTORUN_KEY);
  }

  return config;
}

function getConfig(): RuntimeInjectorConfig {
  const raw = read(CONFIG_KEY);
  if (raw.length === 0) {
    return migrateLegacyConfig();
  }

  try {
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    console.warn("[Runtime Injector] Invalid saved configuration; using safe defaults", error);
    return createDefaultRuntimeInjectorConfig();
  }
}

function saveConfig(config: RuntimeInjectorConfig): void {
  write(CONFIG_KEY, JSON.stringify(normalizeConfig(config)));
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element == null) {
    throw new Error(`Missing injector element: ${selector}`);
  }
  return element;
}

function styleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ID);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.dataset.runtimeInjector = "css";
  document.head.append(style);
  return style;
}

function validateCss(css: string): void {
  if (typeof CSSStyleSheet === "undefined") {
    return;
  }

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch (error) {
    throw new Error(`CSS could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function removeAppliedCss(): void {
  document.getElementById(STYLE_ID)?.remove();
}

function recoveryUiProblem(): string | undefined {
  const host = document.getElementById(HOST_ID);
  if (!(host instanceof HTMLElement)) {
    return "the protected recovery control was removed";
  }

  const surfaces = [document.documentElement, document.body, host].filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );

  try {
    for (const element of surfaces) {
      const style = window.getComputedStyle(element);
      if (style.display === "none") {
        return "a recovery surface was hidden with display: none";
      }
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        return "a recovery surface was hidden with visibility";
      }
      if (Number.parseFloat(style.opacity || "1") <= 0.01) {
        return "a recovery surface was made transparent";
      }
      if (style.contentVisibility === "hidden") {
        return "a recovery surface used content-visibility: hidden";
      }
    }

    if (document.visibilityState !== "hidden" && host.getClientRects().length === 0) {
      return "the protected recovery control has no visible layout box";
    }
  } catch (error) {
    console.warn("[Runtime Injector] Could not inspect recovery control visibility", error);
  }

  return undefined;
}

function repairDocumentForRecovery(): void {
  const surfaces = [document.documentElement, document.body].filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );

  for (const element of surfaces) {
    try {
      const style = window.getComputedStyle(element);
      if (style.display === "none") {
        element.style.setProperty("display", "block", "important");
      }
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        element.style.setProperty("visibility", "visible", "important");
      }
      if (Number.parseFloat(style.opacity || "1") <= 0.01) {
        element.style.setProperty("opacity", "1", "important");
      }
      if (style.contentVisibility === "hidden") {
        element.style.setProperty("content-visibility", "visible", "important");
      }
    } catch (error) {
      console.warn("[Runtime Injector] Could not repair a recovery surface", error);
    }
  }
}

function runCleanup(): void {
  try {
    cleanup?.();
  } catch (error) {
    console.error("[Runtime Injector] Cleanup failed", error);
  }
  cleanup = undefined;
}

function clearAsyncErrorGuard(): void {
  asyncErrorCleanup?.();
  asyncErrorCleanup = undefined;
}

function setEmergencyStatus(message: string, isError = false): void {
  statusWriter?.(message, isError);
}

function disableAll(reason = "Injection disabled by the safety system"): void {
  const config = getConfig();
  config.enabled = false;
  config.js.autorun = false;
  saveConfig(config);
  removeAppliedCss();
  repairDocumentForRecovery();
  clearAsyncErrorGuard();
  runCleanup();
  remove(BOOT_GUARD_KEY);
  write(SAFE_REASON_KEY, reason);
  setEmergencyStatus(reason, true);

  const api = runtimeWindow().bitwardenRuntimeInjector;
  if (api != null && document.documentElement != null) {
    createEmergencyUi(api);
    setEmergencyStatus(reason, true);
  }

  document.dispatchEvent(new CustomEvent("bitwarden-runtime-injector-change"));
}

function applyCss(css?: string, persist = true): void {
  const config = getConfig();
  const source = css ?? config.css.code;

  try {
    validateCss(source);
  } catch (error) {
    const message = `CSS disabled after a validation error: ${
      error instanceof Error ? error.message : String(error)
    }`;
    if (config.enabled) {
      disableAll(message);
    }
    throw new Error(message);
  }

  if (persist) {
    config.css.code = source;
    config.css.mode = "paste";
    config.css.label = "Pasted code";
    saveConfig(config);
  }

  if (!config.enabled || !config.css.enabled || source.trim().length === 0) {
    removeAppliedCss();
    return;
  }

  styleElement().textContent = source;

  const problem = recoveryUiProblem();
  if (problem != null) {
    const message = `CSS disabled because ${problem}`;
    disableAll(message);
    throw new Error(message);
  }
}

function clearCss(clearSavedSource = true): void {
  removeAppliedCss();
  if (clearSavedSource) {
    const config = getConfig();
    config.css = defaultSource();
    saveConfig(config);
  }
}

function errorMentionsInjectedSource(value: unknown): boolean {
  if (value instanceof Error) {
    return `${value.name}\n${value.message}\n${value.stack ?? ""}`.includes("bitwarden-runtime-user.js");
  }
  return String(value).includes("bitwarden-runtime-user.js");
}

function armAsyncErrorGuard(): void {
  clearAsyncErrorGuard();

  const onError = (event: ErrorEvent): void => {
    if (event.filename.includes("bitwarden-runtime-user.js") || errorMentionsInjectedSource(event.error)) {
      disableAll(`JavaScript disabled after an error: ${event.message}`);
    }
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    if (errorMentionsInjectedSource(event.reason)) {
      disableAll("JavaScript disabled after an unhandled promise rejection");
    }
  };

  const healthTimer = window.setInterval(() => {
    const problem = recoveryUiProblem();
    if (problem != null) {
      disableAll(`JavaScript disabled because ${problem}`);
      return;
    }

    const host = document.getElementById(HOST_ID);
    if (host instanceof HTMLElement) {
      protectHost(host);
    }
  }, 250);

  const onPageHide = (): void => remove(BOOT_GUARD_KEY);

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", onPageHide);
  const timer = window.setTimeout(clearAsyncErrorGuard, ASYNC_ERROR_WINDOW_MS);

  asyncErrorCleanup = () => {
    window.clearTimeout(timer);
    window.clearInterval(healthTimer);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("pagehide", onPageHide);
    remove(BOOT_GUARD_KEY);
  };
}

function runJs(source?: string, persist = true): unknown {
  const config = getConfig();
  const script = source ?? config.js.code;

  if (persist) {
    config.js.code = script;
    config.js.mode = "paste";
    config.js.label = "Pasted code";
    saveConfig(config);
  }

  if (!config.enabled || !config.js.enabled || script.trim().length === 0) {
    runCleanup();
    return undefined;
  }

  clearAsyncErrorGuard();
  runCleanup();
  write(BOOT_GUARD_KEY, JSON.stringify({ startedAt: Date.now() }));

  try {
    // eslint-disable-next-line no-new-func
    const runner = new Function(
      "window",
      "document",
      "api",
      `"use strict";\n${script}\n//# sourceURL=bitwarden-runtime-user.js`,
    ) as (
      runtimeWindow: Window,
      runtimeDocument: Document,
      runtimeApi: RuntimeInjectorApi,
    ) => unknown;

    const result = runner(window, document, runtimeWindow().bitwardenRuntimeInjector as RuntimeInjectorApi);
    if (typeof result === "function") {
      cleanup = result as Cleanup;
    }

    const recoveryProblem = recoveryUiProblem();
    if (recoveryProblem != null) {
      throw new Error(recoveryProblem);
    }

    const safetyHost = document.getElementById(HOST_ID);
    if (safetyHost instanceof HTMLElement) {
      protectHost(safetyHost);
    }

    armAsyncErrorGuard();
    return result;
  } catch (error) {
    remove(BOOT_GUARD_KEY);
    disableAll(`JavaScript disabled after an error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function clearJs(clearSavedSource = true): void {
  clearAsyncErrorGuard();
  runCleanup();
  remove(BOOT_GUARD_KEY);

  if (clearSavedSource) {
    const config = getConfig();
    config.js = { ...defaultSource(), autorun: false };
    saveConfig(config);
  }
}

function reset(): void {
  removeAppliedCss();
  clearAsyncErrorGuard();
  runCleanup();
  remove(BOOT_GUARD_KEY);
  remove(SAFE_REASON_KEY);
  saveConfig(createDefaultRuntimeInjectorConfig());
  document.dispatchEvent(new CustomEvent("bitwarden-runtime-injector-change"));
}

function setEnabled(enabled: boolean): void {
  const config = getConfig();
  config.enabled = enabled;
  if (enabled) {
    remove(SAFE_REASON_KEY);
  }
  saveConfig(config);

  if (!enabled) {
    removeAppliedCss();
    clearAsyncErrorGuard();
    runCleanup();
    remove(BOOT_GUARD_KEY);
  } else if (config.css.enabled && config.css.code.trim().length > 0) {
    applyCss(config.css.code, false);
  }

  document.dispatchEvent(new CustomEvent("bitwarden-runtime-injector-change"));
}

async function importFromUrl(kind: InjectorKind, rawUrl: string): Promise<string> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS URLs are supported");
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url.href, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Import failed with HTTP ${response.status}`);
    }

    const declaredSize = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredSize) && declaredSize > MAX_IMPORT_BYTES) {
      throw new Error("The remote file is larger than 1 MB");
    }

    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
      throw new Error("The remote file is larger than 1 MB");
    }

    if (kind === "css") {
      validateCss(text);
    } else {
      // Syntax-check without executing.
      // eslint-disable-next-line no-new-func
      new Function(`"use strict";\n${text}\n//# sourceURL=bitwarden-runtime-import-check.js`);
    }

    return text;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The URL import timed out");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}


function protectSettingsHost(host: HTMLElement): void {
  const styles: Record<string, string> = {
    all: "initial",
    display: "block",
    position: "fixed",
    inset: "0",
    width: "auto",
    height: "auto",
    opacity: "1",
    visibility: "visible",
    transform: "none",
    filter: "none",
    "pointer-events": "none",
    "z-index": "2147483646",
  };

  for (const [property, value] of Object.entries(styles)) {
    host.style.setProperty(property, value, "important");
  }
}

function createSettingsUi(api: RuntimeInjectorApi): void {
  const existing = document.getElementById(SETTINGS_HOST_ID);
  if (existing instanceof HTMLElement) {
    protectSettingsHost(existing);
    settingsRefresh();
    return;
  }

  const host = document.createElement("div");
  host.id = SETTINGS_HOST_ID;
  protectSettingsHost(host);
  (document.body ?? document.documentElement).append(host);

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      * { box-sizing: border-box; }
      #backdrop {
        position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
        padding: 18px; pointer-events: auto; background: rgb(8 15 28 / 58%); backdrop-filter: blur(5px);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #backdrop.open { display: flex; }
      #dialog {
        width: min(720px, 100%); max-height: min(760px, calc(100vh - 36px)); overflow: auto;
        color: #172033; background: #f7f9fc; border: 1px solid rgb(255 255 255 / 38%);
        border-radius: 20px; box-shadow: 0 26px 80px rgb(0 0 0 / 34%);
      }
      .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 22px 22px 16px; }
      .eyebrow { margin: 0 0 5px; color: #55729e; font-size: 10px; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
      h1, h2, p { margin-top: 0; }
      h1 { margin-bottom: 5px; font-size: 22px; line-height: 1.15; letter-spacing: -.02em; }
      .subtitle { margin-bottom: 0; color: #637087; font-size: 12px; line-height: 1.55; }
      .close { width: 34px; height: 34px; flex: 0 0 auto; border: 0; border-radius: 10px; color: #6c778a; background: transparent; font-size: 18px; cursor: pointer; }
      .close:hover { background: #e9edf4; }
      .content { display: grid; gap: 12px; padding: 0 22px 22px; }
      .card { border: 1px solid #dce2ec; border-radius: 14px; background: #fff; box-shadow: 0 4px 18px rgb(30 50 80 / 5%); }
      .master { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px; background: linear-gradient(145deg, #edf4ff, #fff); }
      .master strong, .option strong { display: block; font-size: 12px; }
      small { display: block; margin-top: 2px; color: #738096; font-size: 10px; line-height: 1.4; }
      .toggle { position: relative; display: inline-flex; align-items: center; cursor: pointer; }
      .toggle input { position: absolute; opacity: 0; pointer-events: none; }
      .track { position: relative; width: 44px; height: 25px; border-radius: 999px; background: #a3adbd; transition: .18s ease; }
      .track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 19px; height: 19px; border-radius: 50%; background: #fff; box-shadow: 0 2px 7px rgb(0 0 0 / 22%); transition: .18s ease; }
      .toggle input:checked + .track { background: #1765dc; }
      .toggle input:checked + .track::after { transform: translateX(19px); }
      .safety { display: flex; gap: 11px; padding: 13px 15px; color: #3f4d64; background: #f3f7fd; }
      .shield { display: grid; width: 27px; height: 27px; flex: 0 0 auto; place-items: center; border-radius: 9px; color: #1765dc; background: #dceaff; font-weight: 900; }
      .safety p { margin: 0; font-size: 10px; line-height: 1.55; }
      kbd, code { padding: 1px 4px; border: 1px solid #ccd5e2; border-radius: 4px; background: #fff; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; border-radius: 11px; background: #e9edf4; }
      .tabs button { height: 36px; border: 0; border-radius: 8px; color: #68758a; background: transparent; font-size: 11px; font-weight: 800; cursor: pointer; }
      .tabs button.active { color: #172033; background: #fff; box-shadow: 0 2px 8px rgb(23 32 51 / 10%); }
      .editor { overflow: hidden; }
      .editor-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 15px 16px; border-bottom: 1px solid #e1e6ee; }
      .editor-head h2 { margin-bottom: 3px; font-size: 15px; }
      .editor-head p { margin-bottom: 0; color: #758198; font-size: 10px; }
      .source-toggle { display: flex; align-items: center; gap: 7px; color: #59667a; font-size: 10px; font-weight: 800; cursor: pointer; }
      .source-toggle input, .option input { accent-color: #1765dc; }
      .source-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 12px 0; }
      .source-actions button, .source-actions label { display: inline-flex; height: 31px; align-items: center; padding: 0 11px; border: 1px solid #d8dee8; border-radius: 8px; color: #667389; background: transparent; font-size: 10px; font-weight: 800; cursor: pointer; }
      .source-actions .selected { color: #1765dc; border-color: #9bbbea; background: #eff5ff; }
      .source-actions input[type=file] { display: none; }
      #url-row { display: none; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; padding: 10px 12px 0; }
      #url-row.visible { display: grid; }
      #url { min-width: 0; height: 34px; padding: 0 10px; color: #172033; background: #f8fafc; border: 1px solid #d5dce7; border-radius: 8px; font-size: 10px; }
      #load-url { padding: 0 12px; color: #1765dc; background: transparent; border: 1px solid #a7c1e8; border-radius: 8px; font-size: 10px; font-weight: 800; cursor: pointer; }
      #code { display: block; width: calc(100% - 24px); min-height: 250px; margin: 12px; resize: vertical; padding: 13px; color: #dce5f3; background: #111827; border: 1px solid #2c3950; border-radius: 11px; outline: none; font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; tab-size: 2; }
      #code:focus { border-color: #4f8bea; box-shadow: 0 0 0 3px rgb(79 139 234 / 19%); }
      #autorun-row { display: none; padding: 0 14px 12px; }
      #autorun-row.visible { display: block; }
      .option { display: flex; align-items: flex-start; gap: 9px; padding: 10px; border-radius: 9px; background: #f3f6fa; cursor: pointer; }
      .option input { margin-top: 2px; }
      .footer { display: grid; gap: 10px; padding: 12px 14px; border-top: 1px solid #e1e6ee; }
      #status { min-height: 15px; color: #69768a; font-size: 10px; }
      #status.error { color: #bd2f2f; }
      .buttons { display: flex; justify-content: flex-end; gap: 7px; }
      .buttons button, #reset { height: 34px; padding: 0 13px; border-radius: 8px; font-size: 10px; font-weight: 800; cursor: pointer; }
      .secondary { color: #344157; background: #fff; border: 1px solid #d5dce7; }
      .primary { color: #fff; background: #1765dc; border: 1px solid #1765dc; }
      button:disabled { opacity: .55; cursor: not-allowed; }
      .danger { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 15px; }
      .danger strong { font-size: 11px; }
      .danger p { margin: 2px 0 0; color: #758198; font-size: 10px; line-height: 1.4; }
      #reset { flex: 0 0 auto; color: #b82d2d; background: #fff; border: 1px solid #e2b1b1; }
      @media (max-width: 540px) { #backdrop { padding: 8px; align-items: stretch; } #dialog { max-height: calc(100vh - 16px); border-radius: 15px; } .topbar { padding: 17px 16px 13px; } .content { padding: 0 16px 16px; } .danger { align-items: flex-start; flex-direction: column; } }
      @media (prefers-color-scheme: dark) {
        #dialog { color: #eef2f8; background: #171c25; border-color: rgb(255 255 255 / 10%); }
        .subtitle, small, .editor-head p, .danger p, #status { color: #aeb8c8; }
        .card { background: #202733; border-color: #323c4c; box-shadow: none; }
        .master { background: linear-gradient(145deg, #1d2c43, #202733); }
        .safety { color: #cad3df; background: #1c2a3e; }
        kbd, code { color: #e7edf6; background: #202733; border-color: #465267; }
        .tabs { background: #111722; }
        .tabs button { color: #aeb8c8; }
        .tabs button.active { color: #fff; background: #2a3341; }
        .editor-head, .footer { border-color: #323c4c; }
        .source-actions button, .source-actions label, .secondary, #reset { color: #d8e0ec; background: #202733; border-color: #465267; }
        .source-actions .selected { color: #8db9ff; border-color: #416da9; background: #1c304c; }
        #url { color: #eef2f8; background: #171c25; border-color: #465267; }
        .option { background: #171d27; }
        .close { color: #c3ccda; } .close:hover { background: #2a3341; }
      }
    </style>
    <div id="backdrop" role="presentation">
      <section id="dialog" role="dialog" aria-modal="true" aria-labelledby="title">
        <header class="topbar">
          <div><p class="eyebrow">Advanced customization</p><h1 id="title">Custom CSS &amp; JavaScript</h1><p class="subtitle">Paste code, import a file, or copy a remote HTTP(S) source into this popup.</p></div>
          <button id="close" class="close" type="button" aria-label="Close">✕</button>
        </header>
        <main class="content">
          <section class="card master">
            <div><strong>Enable injection</strong><small>Master kill switch for every CSS and JavaScript source.</small></div>
            <label class="toggle"><input id="master" type="checkbox"><span class="track"></span></label>
          </section>
          <section class="card safety"><div class="shield">✓</div><p><strong>Recovery remains available.</strong><br>Use the protected shield button, hold <kbd>Shift</kbd> while opening the popup, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>, or append <code>disableInjector=1</code>.</p></section>
          <nav class="tabs" aria-label="Injection type"><button id="tab-css" type="button">CSS</button><button id="tab-js" type="button">JavaScript</button></nav>
          <section class="card editor">
            <div class="editor-head"><div><p class="eyebrow" id="kind-label">Stylesheet</p><h2 id="editor-title">Custom CSS</h2><p id="source-label">Pasted code</p></div><label class="source-toggle"><input id="source-enabled" type="checkbox"> Enabled</label></div>
            <div class="source-actions"><button id="paste" type="button">Paste code</button><label id="file-label">Import file<input id="file" type="file"></label><button id="url-mode" type="button">Import URL</button></div>
            <div id="url-row"><input id="url" type="url" placeholder="https://example.com/custom.css"><button id="load-url" type="button">Load</button></div>
            <textarea id="code" spellcheck="false"></textarea>
            <div id="autorun-row"><label class="option"><input id="autorun" type="checkbox"><span><strong>Run automatically when the popup opens</strong><small>A startup guard disables injection if execution does not finish safely.</small></span></label></div>
            <footer class="footer"><div id="status" role="status" aria-live="polite">Ready</div><div class="buttons"><button id="save" class="secondary" type="button">Save</button><button id="apply" class="primary" type="button">Save &amp; apply</button></div></footer>
          </section>
          <section class="card danger"><div><strong>Reset injector</strong><p>Remove all saved code and disable all runtime changes.</p></div><button id="reset" type="button">Reset everything</button></section>
        </main>
      </section>
    </div>
  `;

  const backdrop = required<HTMLElement>(shadow, "#backdrop");
  const dialog = required<HTMLElement>(shadow, "#dialog");
  const closeButton = required<HTMLButtonElement>(shadow, "#close");
  const master = required<HTMLInputElement>(shadow, "#master");
  const tabCss = required<HTMLButtonElement>(shadow, "#tab-css");
  const tabJs = required<HTMLButtonElement>(shadow, "#tab-js");
  const kindLabel = required<HTMLElement>(shadow, "#kind-label");
  const editorTitle = required<HTMLElement>(shadow, "#editor-title");
  const sourceLabel = required<HTMLElement>(shadow, "#source-label");
  const sourceEnabled = required<HTMLInputElement>(shadow, "#source-enabled");
  const pasteButton = required<HTMLButtonElement>(shadow, "#paste");
  const fileLabel = required<HTMLElement>(shadow, "#file-label");
  const fileInput = required<HTMLInputElement>(shadow, "#file");
  const urlModeButton = required<HTMLButtonElement>(shadow, "#url-mode");
  const urlRow = required<HTMLElement>(shadow, "#url-row");
  const urlInput = required<HTMLInputElement>(shadow, "#url");
  const loadUrlButton = required<HTMLButtonElement>(shadow, "#load-url");
  const codeInput = required<HTMLTextAreaElement>(shadow, "#code");
  const autorunRow = required<HTMLElement>(shadow, "#autorun-row");
  const autorun = required<HTMLInputElement>(shadow, "#autorun");
  const status = required<HTMLElement>(shadow, "#status");
  const saveButton = required<HTMLButtonElement>(shadow, "#save");
  const applyButton = required<HTMLButtonElement>(shadow, "#apply");
  const resetButton = required<HTMLButtonElement>(shadow, "#reset");

  let activeKind: InjectorKind = "css";
  let draft = api.getConfig();
  let busy = false;

  const activeSource = (): InjectorSourceConfig => activeKind === "css" ? draft.css : draft.js;
  const setStatus = (message: string, error = false): void => {
    status.textContent = message;
    status.classList.toggle("error", error);
  };
  const setBusy = (value: boolean): void => {
    busy = value;
    loadUrlButton.disabled = value;
    saveButton.disabled = value;
    applyButton.disabled = value || !draft.enabled || !activeSource().enabled;
    loadUrlButton.textContent = value ? "Loading…" : "Load";
  };
  const render = (): void => {
    const source = activeSource();
    const css = activeKind === "css";
    master.checked = draft.enabled;
    tabCss.classList.toggle("active", css);
    tabJs.classList.toggle("active", !css);
    kindLabel.textContent = css ? "Stylesheet" : "Script";
    editorTitle.textContent = css ? "Custom CSS" : "Custom JavaScript";
    sourceLabel.textContent = source.label || "Pasted code";
    sourceEnabled.checked = source.enabled;
    pasteButton.classList.toggle("selected", source.mode === "paste");
    fileLabel.classList.toggle("selected", source.mode === "file");
    urlModeButton.classList.toggle("selected", source.mode === "url");
    urlRow.classList.toggle("visible", source.mode === "url");
    urlInput.value = source.url;
    urlInput.placeholder = `https://example.com/custom.${activeKind}`;
    codeInput.value = source.code;
    codeInput.placeholder = css ? "/* Add CSS for the Bitwarden popup */" : "// window, document and api are available";
    fileInput.accept = css ? ".css,text/css" : ".js,text/javascript,application/javascript";
    autorunRow.classList.toggle("visible", !css);
    autorun.checked = draft.js.autorun;
    applyButton.textContent = css ? "Save & apply" : "Save & run";
    setBusy(busy);
  };
  const reload = (): void => { draft = api.getConfig(); render(); };
  const save = (message = "Settings saved"): void => {
    api.saveConfig(draft);
    draft = api.getConfig();
    render();
    setStatus(message);
  };

  master.addEventListener("change", () => {
    try {
      api.setEnabled(master.checked);
      reload();
      setStatus(master.checked ? "Injection enabled" : "All injection disabled");
    } catch (error) {
      reload();
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
  tabCss.addEventListener("click", () => { activeKind = "css"; render(); });
  tabJs.addEventListener("click", () => { activeKind = "js"; render(); });
  sourceEnabled.addEventListener("change", () => {
    activeSource().enabled = sourceEnabled.checked;
    try {
      api.saveConfig(draft);
      if (activeKind === "css") {
        sourceEnabled.checked && draft.enabled ? api.applyCss(draft.css.code, false) : api.clearCss(false);
      } else if (!sourceEnabled.checked) {
        api.clearJs(false);
      }
      reload();
      setStatus(`${activeKind.toUpperCase()} ${sourceEnabled.checked ? "enabled" : "disabled"}`);
    } catch (error) {
      reload();
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
  pasteButton.addEventListener("click", () => {
    const source = activeSource();
    source.mode = "paste";
    source.label = "Pasted code";
    render();
  });
  urlModeButton.addEventListener("click", () => {
    const source = activeSource();
    source.mode = "url";
    source.label = source.url || "Remote URL";
    render();
    urlInput.focus();
  });
  urlInput.addEventListener("input", () => { activeSource().url = urlInput.value; });
  codeInput.addEventListener("input", () => { activeSource().code = codeInput.value; });
  autorun.addEventListener("change", () => { draft.js.autorun = autorun.checked; save("Autorun preference saved"); });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file == null) return;
    if (file.size > MAX_IMPORT_BYTES) { setStatus("Files larger than 1 MB are not supported", true); return; }
    try {
      const code = await file.text();
      if (activeKind === "css") validateCss(code);
      else {
        // eslint-disable-next-line no-new-func
        new Function(`"use strict";\n${code}\n//# sourceURL=bitwarden-runtime-file-check.js`);
      }
      const source = activeSource();
      source.code = code;
      source.mode = "file";
      source.label = file.name;
      save(`Imported ${file.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
  const loadUrl = async (): Promise<void> => {
    const url = urlInput.value.trim();
    if (url.length === 0) { setStatus("Enter an HTTP(S) URL first", true); return; }
    setBusy(true);
    setStatus("Loading remote source…");
    try {
      const code = await api.importFromUrl(activeKind, url);
      const source = activeSource();
      source.code = code;
      source.url = url;
      source.mode = "url";
      source.label = new URL(url).hostname;
      save(`Imported ${url}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };
  loadUrlButton.addEventListener("click", () => { void loadUrl(); });
  urlInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void loadUrl(); } });
  saveButton.addEventListener("click", () => {
    activeSource().code = codeInput.value;
    activeSource().url = urlInput.value;
    save();
  });
  applyButton.addEventListener("click", () => {
    activeSource().code = codeInput.value;
    activeSource().url = urlInput.value;
    try {
      api.saveConfig(draft);
      if (activeKind === "css") {
        api.applyCss(draft.css.code, false);
        setStatus("CSS saved and applied");
      } else {
        api.runJs(draft.js.code, false);
        setStatus("JavaScript saved and executed");
      }
      reload();
    } catch (error) {
      reload();
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
  resetButton.addEventListener("click", () => {
    if (!window.confirm("Remove all saved CSS and JavaScript and disable the injector?")) return;
    api.reset();
    reload();
    setStatus("Injector reset and disabled");
  });

  const open = (): void => {
    protectSettingsHost(host);
    reload();
    backdrop.classList.add("open");
    host.style.setProperty("pointer-events", "auto", "important");
    window.setTimeout(() => closeButton.focus(), 0);
  };
  const close = (): void => {
    backdrop.classList.remove("open");
    host.style.setProperty("pointer-events", "none", "important");
  };
  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  dialog.addEventListener("click", (event) => event.stopPropagation());
  window.addEventListener("keydown", (event) => { if (event.key === "Escape" && backdrop.classList.contains("open")) close(); });
  document.addEventListener("bitwarden-runtime-injector-change", reload);

  settingsOpen = open;
  settingsRefresh = reload;
  render();
}

function createSettingsEntry(api: RuntimeInjectorApi): void {
  const appearanceLink = document.querySelector<HTMLElement>(
    'a[routerlink="/appearance"], a[href$="/appearance"], a[href*="#/appearance"]',
  );
  if (appearanceLink == null) return;

  const container = appearanceLink.closest("bit-item") ?? appearanceLink.parentElement;
  if (container?.parentElement == null) return;

  const existing = document.getElementById(SETTINGS_ENTRY_ID);
  if (existing != null) return;

  const host = document.createElement("div");
  host.id = SETTINGS_ENTRY_ID;
  host.style.display = "block";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      button { width: 100%; min-height: 48px; display: grid; grid-template-columns: 24px minmax(0, 1fr) 18px; align-items: center; gap: 10px; padding: 8px 12px; border: 0; border-radius: 8px; color: inherit; background: transparent; text-align: left; font: 500 14px/1.3 Inter, ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
      button:hover, button:focus-visible { background: rgb(23 101 220 / 9%); outline: none; }
      .icon { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 7px; color: #1765dc; background: rgb(23 101 220 / 12%); font: 800 11px ui-monospace, monospace; }
      .text { min-width: 0; } strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; } small { display: block; margin-top: 2px; color: #738096; font-size: 9px; }
      .arrow { color: #7c8798; font-size: 20px; text-align: center; }
      @media (prefers-color-scheme: dark) { small, .arrow { color: #aab4c4; } }
    </style>
    <button type="button" aria-label="Open custom CSS and JavaScript settings"><span class="icon">&lt;/&gt;</span><span class="text"><strong>Custom CSS &amp; JavaScript</strong><small>Paste, file, or URL injection</small></span><span class="arrow">›</span></button>
  `;
  required<HTMLButtonElement>(shadow, "button").addEventListener("click", () => {
    createSettingsUi(api);
    settingsOpen();
  });
  container.insertAdjacentElement("afterend", host);
}

function startSettingsEntryObserver(api: RuntimeInjectorApi): void {
  settingsEntryObserver?.disconnect();
  createSettingsEntry(api);
  settingsEntryObserver = new MutationObserver(() => createSettingsEntry(api));
  settingsEntryObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function openSettings(): void {
  const api = runtimeWindow().bitwardenRuntimeInjector;
  if (api == null) return;
  createSettingsUi(api);
  settingsOpen();
}

function isEmergencyBypassRequested(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("disableInjector") === "1" || window.location.hash.includes("injector-safe-mode");
}

function protectHost(host: HTMLElement): void {
  const importantStyles: Record<string, string> = {
    all: "initial",
    display: "block",
    position: "fixed",
    right: "12px",
    bottom: "12px",
    width: "auto",
    height: "auto",
    opacity: "1",
    visibility: "visible",
    transform: "none",
    filter: "none",
    "pointer-events": "auto",
    "z-index": "2147483647",
  };

  for (const [property, value] of Object.entries(importantStyles)) {
    host.style.setProperty(property, value, "important");
  }
}

function createEmergencyUi(api: RuntimeInjectorApi): void {
  if (document.getElementById(HOST_ID) != null) {
    return;
  }

  panelOpen = false;

  const host = document.createElement("div");
  host.id = HOST_ID;
  protectHost(host);

  const body = document.body ?? document.documentElement.appendChild(document.createElement("body"));
  body.append(host);

  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = String.raw`
    <style>
      :host { color-scheme: light dark; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      button { font: inherit; }
      #launcher {
        display: grid; width: 38px; height: 38px; place-items: center; padding: 0; color: #fff;
        background: linear-gradient(145deg, #175ddc, #0d47b5); border: 1px solid rgb(255 255 255 / 28%);
        border-radius: 12px; box-shadow: 0 12px 32px rgb(0 0 0 / 35%), 0 1px 0 rgb(255 255 255 / 20%) inset;
        cursor: pointer;
      }
      #launcher:hover { filter: brightness(1.08); }
      #launcher svg { width: 19px; height: 19px; }
      #panel {
        position: absolute; right: 0; bottom: 48px; width: min(330px, calc(100vw - 24px)); overflow: hidden;
        color: #172033; background: rgb(255 255 255 / 98%); border: 1px solid rgb(15 23 42 / 12%);
        border-radius: 14px; box-shadow: 0 24px 70px rgb(15 23 42 / 30%); backdrop-filter: blur(18px);
      }
      #panel[hidden] { display: none; }
      .head { display: flex; align-items: center; justify-content: space-between; padding: 14px 14px 10px; }
      .eyebrow { color: #586174; font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
      h2 { margin: 3px 0 0; font-size: 15px; line-height: 1.25; }
      .close { width: 28px; height: 28px; padding: 0; color: #586174; background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
      .close:hover { background: #eef2f7; }
      .body { padding: 0 14px 14px; }
      .status { min-height: 35px; margin: 0 0 10px; padding: 9px 10px; color: #43506a; background: #f2f5fa; border-radius: 9px; font-size: 11px; line-height: 1.45; }
      .status[data-error="true"] { color: #8a1c1c; background: #fff0f0; }
      .actions { display: grid; gap: 8px; }
      .button { height: 35px; padding: 0 12px; border: 1px solid #ccd5e3; border-radius: 9px; font-size: 12px; font-weight: 700; cursor: pointer; }
      .button.primary { color: #fff; background: #175ddc; border-color: #175ddc; }
      .button.danger { color: #a51d1d; background: #fff; border-color: #f0b8b8; }
      .hint { margin: 10px 0 0; color: #69758b; font-size: 10px; line-height: 1.45; }
      @media (prefers-color-scheme: dark) {
        #panel { color: #f5f7fb; background: rgb(24 28 36 / 98%); border-color: rgb(255 255 255 / 12%); }
        .eyebrow, .close, .hint { color: #aeb7c8; }
        .close:hover { background: rgb(255 255 255 / 8%); }
        .status { color: #cbd3e0; background: rgb(255 255 255 / 7%); }
        .status[data-error="true"] { color: #ffb2b2; background: rgb(180 28 28 / 18%); }
        .button { color: #edf1f7; background: rgb(255 255 255 / 6%); border-color: rgb(255 255 255 / 15%); }
        .button.primary { color: #fff; background: #2b6fe5; border-color: #2b6fe5; }
        .button.danger { color: #ffb0b0; background: rgb(255 255 255 / 4%); border-color: rgb(255 125 125 / 35%); }
      }
    </style>
    <button id="launcher" type="button" aria-label="Injection safety controls" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
        <path d="M12 3 4.8 6v5.1c0 4.7 3 8.2 7.2 9.9 4.2-1.7 7.2-5.2 7.2-9.9V6L12 3Z"/>
        <path d="m9.1 12 1.8 1.8 4-4"/>
      </svg>
    </button>
    <section id="panel" aria-label="Injection safety controls" hidden>
      <div class="head">
        <div><div class="eyebrow">Recovery controls</div><h2>CSS & JavaScript injection</h2></div>
        <button id="close" class="close" type="button" aria-label="Close">✕</button>
      </div>
      <div class="body">
        <p id="status" class="status" role="status" aria-live="polite">${read(SAFE_REASON_KEY) || "Injection safety controls are ready."}</p>
        <div class="actions">
          <button id="settings" class="button primary" type="button">Open customization settings</button>
          <button id="reload" class="button" type="button">Reload popup safely</button>
          <button id="disable" class="button danger" type="button">Disable all injection</button>
        </div>
        <p class="hint">Emergency bypass: open the popup with <strong>Shift</strong> held, or append <code>?disableInjector=1</code>.</p>
      </div>
    </section>
  `;

  const launcher = required<HTMLButtonElement>(shadow, "#launcher");
  const panel = required<HTMLElement>(shadow, "#panel");
  const closeButton = required<HTMLButtonElement>(shadow, "#close");
  const settingsButton = required<HTMLButtonElement>(shadow, "#settings");
  const reloadButton = required<HTMLButtonElement>(shadow, "#reload");
  const disableButton = required<HTMLButtonElement>(shadow, "#disable");
  const status = required<HTMLElement>(shadow, "#status");

  statusWriter = (message: string, isError = false): void => {
    status.textContent = message;
    status.dataset.error = String(isError);
  };

  const open = (): void => {
    panel.hidden = false;
    panelOpen = true;
    launcher.setAttribute("aria-expanded", "true");
  };
  const close = (): void => {
    panel.hidden = true;
    panelOpen = false;
    launcher.setAttribute("aria-expanded", "false");
  };
  const toggle = (): void => (panelOpen ? close() : open());

  launcher.addEventListener("click", toggle);
  closeButton.addEventListener("click", close);
  settingsButton.addEventListener("click", () => {
    api.openSettings();
    close();
  });
  reloadButton.addEventListener("click", () => {
    api.disableAll("Injection disabled before a safe reload");
    window.location.reload();
  });
  disableButton.addEventListener("click", () => {
    api.disableAll("All CSS and JavaScript injection has been disabled");
  });

  emergencyOpen = open;
  emergencyClose = close;
  emergencyToggle = toggle;
}

function createApi(): RuntimeInjectorApi {
  return {
    query: <T extends Element = Element>(selector: string): T | null => document.querySelector<T>(selector),
    queryAll: <T extends Element = Element>(selector: string): T[] =>
      Array.from(document.querySelectorAll<T>(selector)),
    getConfig: () => cloneConfig(getConfig()),
    saveConfig: (config: RuntimeInjectorConfig): void => {
      saveConfig(config);
      document.dispatchEvent(new CustomEvent("bitwarden-runtime-injector-change"));
    },
    setEnabled,
    applyCss,
    clearCss,
    runJs,
    clearJs,
    reset,
    disableAll,
    importFromUrl,
    openSettings,
    open: () => emergencyOpen(),
    close: () => emergencyClose(),
    toggle: () => emergencyToggle(),
  };
}

function startRuntime(api: RuntimeInjectorApi): void {
  const previousBootWasInterrupted = read(BOOT_GUARD_KEY).length > 0;
  if (previousBootWasInterrupted) {
    disableAll("Injection was disabled because the previous JavaScript run did not finish");
  } else if (isEmergencyBypassRequested()) {
    disableAll("Injection was disabled by the emergency bypass");
  }

  createEmergencyUi(api);
  createSettingsUi(api);
  startSettingsEntryObserver(api);
  Object.freeze(api);

  const config = getConfig();
  if (config.enabled && config.css.enabled && config.css.code.trim().length > 0) {
    try {
      applyCss(config.css.code, false);
    } catch (error) {
      console.error("[Runtime Injector] Saved CSS was disabled", error);
    }
  }

  let shiftBypass = false;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Shift") {
      shiftBypass = true;
      disableAll("Injection was disabled because Shift was held during startup");
    }
    if (event.ctrlKey && event.shiftKey && event.code === "KeyI") {
      event.preventDefault();
      api.toggle();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  window.setTimeout(() => {
    const latest = getConfig();
    if (!shiftBypass && latest.enabled && latest.js.enabled && latest.js.autorun && latest.js.code.trim().length > 0) {
      try {
        runJs(latest.js.code, false);
        setEmergencyStatus("Saved JavaScript executed successfully");
      } catch (error) {
        console.error("[Runtime Injector] Autorun failed", error);
      }
    }
  }, AUTORUN_DELAY_MS);
}

export function installRuntimeInjector(): void {
  if (runtimeWindow().__bitwardenRuntimeInjectorV2Installed) {
    return;
  }
  runtimeWindow().__bitwardenRuntimeInjectorV2Installed = true;

  const api = createApi();
  Object.defineProperty(window, "bitwardenRuntimeInjector", {
    value: api,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const start = (): void => {
    try {
      startRuntime(api);
    } catch (error) {
      console.error("[Runtime Injector] Startup failed", error);
      disableAll(`Injector startup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
