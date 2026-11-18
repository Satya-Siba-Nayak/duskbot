import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { Keyboard } from "@capacitor/keyboard";
import { Preferences } from "@capacitor/preferences";
import { PushNotifications } from "@capacitor/push-notifications";
import { Share } from "@capacitor/share";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";

/** The Keychain/Keystore plugin's own native methods. Its JS conveniences (setKeyPrefix, get, set) go through a lazily
 * loaded wrapper that never answers on Android with Capacitor 8.6, so the phone keeps tokens through these directly. */
const keystore = SecureStorage as unknown as {
  internalGetItem(options: { prefixedKey: string; sync: boolean }): Promise<{ data: string | null }>;
  internalSetItem(options: { prefixedKey: string; data: string; sync: boolean }): Promise<void>;
  internalRemoveItem(options: { prefixedKey: string; sync: boolean }): Promise<{ success: boolean }>;
};
const SECRET_PREFIX = "dusk.";
import { BarcodeScanner, BarcodeFormat, GoogleBarcodeScannerModuleInstallState } from "@capacitor-mlkit/barcode-scanning";
import type { AppleCredential, CameraPermission, CameraScanner, DeliveredNotification, MobilePlatform, OrientationBridge, ScanOverlay, TurnActivityBridge } from "@/mobile/platform";
import type { NativeAction } from "@/mobile/phone-actions";
import type { TurnActivityAttributes, TurnActivityState } from "../../../shared/phone-activity";
import type { GlassBridge, GlassEvent, GlassGlyphs, GlassState } from "@/mobile/native-glass";
import type { SlidePath } from "@/mobile/NavStack";
import type { MenuBridge, NativeMenuArm, NativeMenuContent, NativeMenuEvent } from "@/mobile/native-menu";
import { createVoiceEvents, type VoiceBridge, type VoiceEnd } from "@/lib/voice-input/bridge";
import { registerPhoneVoice } from "@/lib/voice-input/device";
import { appLinkFromUniversal, type MobileOpenTarget } from "../../../shared/mobile-link";

/** The app's own scanner on ios (ios/App/App/QrScannerPlugin.swift): the ML Kit plugin ships for CocoaPods only, and this
 * project links its plugins as Swift packages. */
interface QrScannerPlugin {
  checkPermissions(): Promise<{ camera: string }>;
  requestPermissions(): Promise<{ camera: string }>;
  openSettings(): Promise<void>;
  startScan(options?: { overlay?: ScanOverlay }): Promise<{ fullScreen?: boolean } | undefined>;
  stopScan(): Promise<void>;
  isTorchAvailable(): Promise<{ available: boolean }>;
  setTorch(options: { on: boolean }): Promise<void>;
  setBusy(options: { busy: boolean; label?: string }): Promise<void>;
  addListener(event: "codeScanned", listener: (event: { text?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "scannerAction", listener: (event: { key?: string }) => void): Promise<PluginListenerHandle>;
}
const QrScanner = registerPlugin<QrScannerPlugin>("QrScanner");
/** The app's own Sign in with Apple (ios/App/App/AppleSignInPlugin.swift): AuthenticationServices, no SDK. */
const AppleSignIn = registerPlugin<{ signIn(options: { nonce: string }): Promise<AppleCredential> }>("AppleSignIn");

/** The app's own dictation (ios/App/App/SpeechRecognizerPlugin.swift, android .../SpeechRecognizerPlugin.java): the
 * phone's recognizer, offline where it can be. Events carry the session number `start` was given. */
export interface SpeechPermissions { microphone: string; speech?: string }
export interface SpeechPlugin {
  checkPermissions(): Promise<SpeechPermissions>;
  requestPermissions(): Promise<SpeechPermissions>;
  openSettings(): Promise<void>;
  start(options: { locale?: string; session: number }): Promise<void>;
  finish(): Promise<void>;
  stop(): Promise<void>;
  addListener(event: "transcript", listener: (event: { text?: string; partial?: boolean; session?: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "level", listener: (event: { level?: number; session?: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "end", listener: (event: { code?: number; reason?: string; session?: number }) => void): Promise<PluginListenerHandle>;
}
const DuskSpeech = registerPlugin<SpeechPlugin>("DuskSpeech");

/** The app's own Liquid Glass chat chrome (ios/App/App/GlassChromePlugin.swift), iOS 26 and later. */
interface GlassPlugin {
  supported(): Promise<{ supported: boolean }>;
  update(state: GlassState): Promise<void>;
  setText(options: { text: string; seq: number }): Promise<void>;
  setAvatar(options: { data: string | null }): Promise<void>;
  focus(): Promise<void>;
  blur(): Promise<void>;
  clear(): Promise<void>;
  slide(options: { path: SlidePath | null }): Promise<void>;
  glyphs(): Promise<GlassGlyphs>;
  addListener(event: "glass", listener: (event: GlassEvent) => void): Promise<PluginListenerHandle>;
}
const DuskGlass = registerPlugin<GlassPlugin>("DuskGlass");

export function glassBridge(plugin: GlassPlugin): GlassBridge {
  const quiet = (work: Promise<unknown>) => { void work.catch(() => {}); };
  return {
    update: (state) => quiet(plugin.update(state)),
    setText: (text, seq) => quiet(plugin.setText({ text, seq })),
    setAvatar: (data) => quiet(plugin.setAvatar({ data })),
    focus: () => quiet(plugin.focus()),
    blur: () => quiet(plugin.blur()),
    clear: () => quiet(plugin.clear()),
    slide: (path) => quiet(plugin.slide({ path })),
    glyphs: () => plugin.glyphs().catch(() => ({})),
    onEvent: (listener) => unsubscribe([plugin.addListener("glass", listener)]),
  };
}

/** The app's own context menu over page items (ios/App/App/NativeMenuPlugin.swift), iOS 26 and later. */
interface MenuPlugin {
  supported(): Promise<{ supported: boolean }>;
  arm(options: NativeMenuArm): Promise<void>;
  disarm(options: { id?: string }): Promise<void>;
  resolve(options: { id: string; content: NativeMenuContent }): Promise<void>;
  addListener(event: "menu", listener: (event: NativeMenuEvent) => void): Promise<PluginListenerHandle>;
}
const DuskMenu = registerPlugin<MenuPlugin>("DuskMenu");

export function menuBridge(plugin: MenuPlugin): MenuBridge {
  const quiet = (work: Promise<unknown>) => { void work.catch(() => {}); };
  return {
    arm: (options) => quiet(plugin.arm(options)),
    disarm: (id) => quiet(plugin.disarm({ id })),
    resolve: (id, content) => quiet(plugin.resolve({ id, content })),
    onEvent: (listener) => unsubscribe([plugin.addListener("menu", listener)]),
  };
}

/** Which way the app may turn (ios/App/App/AppViewController.swift). */
interface OrientationPlugin {
  allowLandscape(options: { on: boolean }): Promise<void>;
  rotate(options: { to: "portrait" | "landscape" }): Promise<void>;
}
const DuskOrientation = registerPlugin<OrientationPlugin>("DuskOrientation");

/** ActivityKit and the Live Activity's buttons (ios/App/App/TurnActivityPlugin.swift). */
interface TurnActivityPlugin {
  start(options: { attributes: TurnActivityAttributes; state: TurnActivityState }): Promise<{ id?: string }>;
  update(options: { id: string; state: TurnActivityState }): Promise<void>;
  end(options: { id: string; state: TurnActivityState; now?: boolean }): Promise<void>;
  list(): Promise<{ activities: Array<{ id: string; botId: string; threadId: string; startedAt: number }> }>;
  lineKey(): Promise<{ key?: string }>;
  addListener(event: "token", listener: (event: { id: string; threadId: string; token: string; startedAt: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "startToken", listener: (event: { token: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "action", listener: (event: NativeAction) => void): Promise<PluginListenerHandle>;
}
const DuskTurnActivity = registerPlugin<TurnActivityPlugin>("DuskTurnActivity");

interface NotificationsPlugin {
  setViewing(options: { threadId: string | null }): Promise<void>;
  delivered(): Promise<{ notifications: DeliveredNotification[] }>;
  remove(options: { ids: string[] }): Promise<void>;
}
const DuskNotifications = registerPlugin<NotificationsPlugin>("DuskNotifications");

/** Android's delivered pushes: FCM's data block is flat (server/mobile/push.ts messageData). */
async function androidDelivered(): Promise<DeliveredNotification[]> {
  const { notifications } = await PushNotifications.getDeliveredNotifications();
  return notifications.map((one) => {
    const data = (one.data ?? {}) as Record<string, unknown>;
    return {
      id: one.id,
      ...(typeof data.threadId === "string" ? { threadId: data.threadId } : {}),
      ...(typeof data.id === "string" ? { notificationId: data.id } : {}),
    };
  });
}

function turnActivityBridge(): TurnActivityBridge {
  return {
    async start(attributes, state) { return (await DuskTurnActivity.start({ attributes, state })).id ?? null; },
    update: (id, state) => DuskTurnActivity.update({ id, state }),
    end: (id, state, now) => DuskTurnActivity.end({ id, state, ...(now ? { now } : {}) }),
    list: async () => (await DuskTurnActivity.list()).activities,
    onToken: (listener) => unsubscribe([DuskTurnActivity.addListener("token", listener)]),
    onStartToken: (listener) => unsubscribe([DuskTurnActivity.addListener("startToken", ({ token }) => listener(token))]),
    lineKey: async () => (await DuskTurnActivity.lineKey()).key ?? null,
  };
}

/** a push the bot host sent, as opposed to one from an older link that put its ids at the top level */
const fromBotHost = (data: Record<string, unknown>) => ["dusk", "omb"].some((key) => data[key] && typeof data[key] === "object");

export function orientationBridge(plugin: OrientationPlugin): OrientationBridge {
  return {
    allowLandscape: (on) => { void plugin.allowLandscape({ on }).catch(() => {}); },
    rotate: (to) => { void plugin.rotate({ to }).catch(() => {}); },
  };
}

const UNSUPPORTED = new Set(["recognizer-unavailable", "unsupported-locale"]);
// android has no separate speech permission, so `speech` is absent there
const speechAllowed = (state: SpeechPermissions) => state.microphone === "granted" && (state.speech === undefined || state.speech === "granted");

/** The VoiceBridge over the native recognizer. Permissions are asked on the first start; a refusal ends the session. */
export function phoneSpeech(plugin: SpeechPlugin): VoiceBridge {
  const events = createVoiceEvents();
  let session = 0;
  let live = false;
  let listening: Promise<unknown> | undefined;
  const ours = (event: { session?: number }) => live && event.session === session;
  const ended = (info: VoiceEnd) => {
    live = false;
    events.end(info);
  };
  const listen = () => listening ??= Promise.all([
    plugin.addListener("transcript", (event) => {
      if (ours(event) && typeof event.text === "string") events.transcript({ partial: event.partial !== false, text: event.text });
    }),
    plugin.addListener("level", (event) => {
      if (ours(event) && typeof event.level === "number") events.level(Math.min(1, Math.max(0, event.level)));
    }),
    plugin.addListener("end", (event) => {
      if (ours(event)) ended({ code: typeof event.code === "number" ? event.code : 1, reason: event.reason });
    }),
  ]).catch((error) => {
    listening = undefined;
    throw error;
  });

  return {
    async speechStart(options) {
      session += 1;
      live = false;
      const mine = session;
      try {
        await listen();
        let state = await plugin.checkPermissions();
        if (!speechAllowed(state)) state = await plugin.requestPermissions();
        if (mine !== session) return;
        if (!speechAllowed(state)) return ended({ code: 1, reason: "microphone-blocked" });
      } catch {
        if (mine === session) ended({ code: 1, reason: "recognition-error" });
        return;
      }
      live = true;
      try {
        await plugin.start({ locale: options?.locale, session: mine });
      } catch (error) {
        if (mine !== session || !live) return;
        const code = (error as { code?: unknown } | null)?.code;
        const reason = typeof code === "string" && code ? code : "recognition-error";
        ended({ code: UNSUPPORTED.has(reason) ? 2 : 1, reason });
      }
    },
    async speechStop() {
      session += 1;
      live = false;
      await plugin.stop().catch(() => {});
    },
    async speechFinish() {
      if (!live) return;
      try {
        await plugin.finish();
      } catch {
        if (live) ended({ code: 0, reason: "completed" });
      }
    },
    onSpeechTranscript: events.onSpeechTranscript,
    onSpeechEnd: events.onSpeechEnd,
    onSpeechLevel: events.onSpeechLevel,
  };
}

/** What a live scan needs of whichever scanner the platform has. */
export interface ScanDriver {
  permission(): Promise<string>;
  request(): Promise<string>;
  openSettings(): Promise<void>;
  listen(onCode: (text: string | undefined) => void, onError: (message: string) => void, onAction?: (key: string) => void): Promise<PluginListenerHandle[]>;
  /** with an overlay a scanner may draw the whole screen itself, and says so */
  start(overlay?: ScanOverlay): Promise<{ fullScreen?: boolean } | void>;
  busy?(on: boolean, label?: string): Promise<void>;
  stop(): Promise<void>;
  torchAvailable(): Promise<boolean>;
  torch(on: boolean): Promise<void>;
}

const iosScanner: ScanDriver = {
  permission: async () => (await QrScanner.checkPermissions()).camera,
  request: async () => (await QrScanner.requestPermissions()).camera,
  openSettings: () => QrScanner.openSettings(),
  listen: async (onCode, _onError, onAction) => [
    await QrScanner.addListener("codeScanned", ({ text }) => onCode(text)),
    await QrScanner.addListener("scannerAction", ({ key }) => { if (typeof key === "string") onAction?.(key); }),
  ],
  start: async (overlay) => (await QrScanner.startScan(overlay ? { overlay } : undefined)) ?? undefined,
  busy: (busy, label) => QrScanner.setBusy({ busy, label }),
  stop: () => QrScanner.stopScan(),
  torchAvailable: async () => (await QrScanner.isTorchAvailable()).available,
  torch: (on) => QrScanner.setTorch({ on }),
};

const androidScanner: ScanDriver = {
  permission: async () => (await BarcodeScanner.checkPermissions()).camera,
  request: async () => (await BarcodeScanner.requestPermissions()).camera,
  openSettings: () => BarcodeScanner.openSettings(),
  listen: async (onCode, onError) => [
    await BarcodeScanner.addListener("barcodesScanned", ({ barcodes }) => onCode(barcodes[0]?.rawValue)),
    await BarcodeScanner.addListener("scanError", ({ message }) => onError(message)),
  ],
  start: async () => { await BarcodeScanner.startScan({ formats: [BarcodeFormat.QrCode] }); },
  stop: () => BarcodeScanner.stopScan(),
  torchAvailable: async () => (await BarcodeScanner.isTorchAvailable()).available,
  torch: (on) => (on ? BarcodeScanner.enableTorch() : BarcodeScanner.disableTorch()),
};

/** One live scan under the page's own viewfinder: the camera draws behind the web view while `mobile-scanning` is on. */
export function scannerCamera(driver: ScanDriver, scanning: (on: boolean) => void = setScanning): CameraScanner {
  return {
    permission: async () => cameraPermission(await driver.permission()),
    request: async () => cameraPermission(await driver.request()),
    openSettings: () => driver.openSettings(),
    async start({ onCode, onError, overlay, onAction }) {
      let handles: PluginListenerHandle[] = [];
      const deliver = distinctCodes(onCode);
      let stopped = false;
      let stopping: Promise<void> | undefined;
      let torchOn = false;
      let torchPending = Promise.resolve();
      const stop = () => {
        if (stopping) return stopping;
        stopped = true;
        scanning(false);
        stopping = (async () => {
          try {
            await Promise.allSettled(handles.map((handle) => handle.remove()));
            await torchPending.catch(() => {});
            if (torchOn) await driver.torch(false).catch(() => {});
            await driver.stop();
          } finally {
            scanning(false);
          }
        })();
        return stopping;
      };
      try {
        scanning(true);
        handles = await driver.listen(
          (text) => { if (!stopped) deliver(text); },
          (message) => { if (!stopped) onError?.(message); },
          (key) => { if (!stopped) onAction?.(key); },
        );
        const fullScreen = Boolean((await driver.start(overlay))?.fullScreen);
        // the system's own scanner covers the page, which stays as it is under it
        if (fullScreen) scanning(false);
        const available = !fullScreen && await driver.torchAvailable();
        const busy = driver.busy;
        return {
          stop,
          fullScreen,
          busy: fullScreen && busy ? (on, label) => { if (!stopped) void busy(on, label).catch(() => {}); } : undefined,
          torch: available ? {
            set(on) {
              if (stopped) return Promise.resolve();
              torchPending = torchPending.catch(() => {}).then(async () => {
                if (stopped) return;
                await driver.torch(on);
                torchOn = on;
              });
              return torchPending;
            },
          } : undefined,
        };
      } catch (error) {
        await stop().catch(() => {});
        throw error;
      }
    },
  };
}

type PendingHandle = Promise<PluginListenerHandle>;
let overlayReady: Promise<void> | undefined;

export function cameraPermission(value: string): CameraPermission {
  return value === "granted" || value === "limited" ? "granted" : value === "denied" ? "denied" : "prompt";
}

export function distinctCodes(onCode: (text: string) => void): (text: string | undefined) => void {
  const seen = new Set<string>();
  return (text) => {
    if (typeof text !== "string" || seen.has(text)) return;
    seen.add(text);
    onCode(text);
  };
}

function unsubscribe(handles: PendingHandle[]): () => void {
  for (const handle of handles) void handle.catch(() => {});
  return () => {
    for (const handle of handles) void handle.then((value) => value.remove()).catch(() => {});
  };
}

function setScanning(on: boolean) {
  document.documentElement.classList.toggle("mobile-scanning", on);
}

async function ensureBarcodeModule(): Promise<boolean> {
  if ((await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()).available) return true;
  return new Promise((resolve) => {
    const handles: PendingHandle[] = [];
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe(handles)();
      resolve(available);
    };
    const timeout = setTimeout(() => finish(false), 60_000);
    void (async () => {
      handles.push(BarcodeScanner.addListener("googleBarcodeScannerModuleInstallProgress", ({ state }) => {
        if (state === GoogleBarcodeScannerModuleInstallState.COMPLETED) finish(true);
        else if (state === GoogleBarcodeScannerModuleInstallState.CANCELED || state === GoogleBarcodeScannerModuleInstallState.FAILED) finish(false);
      }));
      await Promise.all(handles);
      if (settled) return;
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      if ((await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()).available) finish(true);
    })().catch(() => finish(false));
  });
}

function notificationTarget(data: Record<string, unknown>): MobileOpenTarget {
  const target: MobileOpenTarget = {};
  const fields = { env: "environmentId", bot: "botId", group: "groupId", thread: "threadId", message: "messageId" } as const;
  for (const [field, key] of Object.entries(fields)) {
    if (typeof data[field] === "string") target[key] = data[field];
  }
  switch (data.view) {
    case "chat": case "computer": case "profile": case "routines": case "settings": case "notifications":
      target.view = data.view;
  }
  return target;
}

export async function nativePlatform(): Promise<MobilePlatform> {
  const kind = Capacitor.getPlatform() as "ios" | "android";
  if (kind === "android") {
    overlayReady ??= StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
  } else {
    // WKWebView draws a form bar (previous, next, Done) over the keyboard; a chat has one field and its own send
    void Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {});
  }
  // a plugin that never answers must not hold the first paint: each startup read gets two seconds
  const bounded = <T,>(work: Promise<T>, label: string): Promise<T | undefined> => new Promise((resolve) => {
    const timer = setTimeout(() => { console.warn(`startup: ${label} did not answer`); resolve(undefined); }, 2000);
    work.then(resolve, () => resolve(undefined)).finally(() => clearTimeout(timer));
  });
  const [info, launch, , glass, menu] = await Promise.all([
    bounded(App.getInfo(), "app info"),
    bounded(App.getLaunchUrl(), "launch url"),
    bounded(overlayReady ?? Promise.resolve(), "status bar"),
    kind === "ios" && Capacitor.isPluginAvailable("DuskGlass") ? bounded(DuskGlass.supported(), "glass") : undefined,
    kind === "ios" && Capacitor.isPluginAvailable("DuskMenu") ? bounded(DuskMenu.supported(), "menu") : undefined,
  ]);
  let pendingLaunchUrl = launch?.url;
  const secrets: MobilePlatform["secrets"] = {
    get: async (key) => {
      const { data } = await keystore.internalGetItem({ prefixedKey: SECRET_PREFIX + key, sync: false });
      return typeof data === "string" ? data : null;
    },
    set: (key, value) => keystore.internalSetItem({ prefixedKey: SECRET_PREFIX + key, data: value, sync: false }),
    remove: async (key) => { await keystore.internalRemoveItem({ prefixedKey: SECRET_PREFIX + key, sync: false }); },
  };
  const speech = Capacitor.isPluginAvailable("DuskSpeech");
  const turnActivityOn = Capacitor.isPluginAvailable("DuskTurnActivity");
  const notificationsOn = Capacitor.isPluginAvailable("DuskNotifications");
  registerPhoneVoice({
    os: kind,
    speech: speech ? phoneSpeech(DuskSpeech) : undefined,
    secrets,
    openSettings: speech ? () => DuskSpeech.openSettings() : undefined,
  });

  return {
    kind,
    native: true,
    appVersion: info?.version || __APP_VERSION__,
    deviceName: () => kind === "ios" ? "iPhone" : "Android phone",
    glass: glass?.supported ? glassBridge(DuskGlass) : undefined,
    menu: menu?.supported ? menuBridge(DuskMenu) : undefined,
    orientation: Capacitor.isPluginAvailable("DuskOrientation") ? orientationBridge(DuskOrientation) : undefined,
    haptic(type) {
      void (async () => {
        switch (type) {
          case "light": case "soft":
            await Haptics.impact({ style: ImpactStyle.Light });
            break;
          case "medium":
            await Haptics.impact({ style: ImpactStyle.Medium });
            break;
          case "selection":
            await Haptics.selectionStart();
            await Haptics.selectionChanged();
            await Haptics.selectionEnd();
            break;
          case "error":
            await Haptics.notification({ type: NotificationType.Error });
            break;
          case "success":
            await Haptics.notification({ type: NotificationType.Success });
        }
      })().catch(() => {});
    },
    onKeyboard(listener) {
      return unsubscribe([
        Keyboard.addListener("keyboardWillShow", ({ keyboardHeight }) => listener({ height: keyboardHeight, phase: "will" })),
        Keyboard.addListener("keyboardDidShow", ({ keyboardHeight }) => listener({ height: keyboardHeight, phase: "did" })),
        Keyboard.addListener("keyboardWillHide", () => listener({ height: 0, phase: "will" })),
        Keyboard.addListener("keyboardDidHide", () => listener({ height: 0, phase: "did" })),
      ]);
    },
    hideKeyboard() {
      void Keyboard.hide().catch(() => {});
    },
    setStatusBar(style) {
      void StatusBar.setStyle({ style: style === "dark" ? Style.Light : Style.Dark }).catch(() => {});
    },
    onBack(listener) {
      return unsubscribe([App.addListener("backButton", () => {
        if (listener() === false && kind === "android") void App.minimizeApp().catch(() => {});
      })]);
    },
    onAppUrl(listener) {
      // a universal link (https://dusk.bot/m/...) arrives as the app link it stands for
      const stop = unsubscribe([App.addListener("appUrlOpen", ({ url }) => listener(appLinkFromUniversal(url) ?? url))]);
      if (pendingLaunchUrl && listener(appLinkFromUniversal(pendingLaunchUrl) ?? pendingLaunchUrl)) pendingLaunchUrl = undefined;
      return stop;
    },
    onResume(listener) {
      return unsubscribe([App.addListener("resume", listener)]);
    },
    onPause(listener) {
      return unsubscribe([App.addListener("pause", listener)]);
    },
    prefs: {
      get: async (key) => (await Preferences.get({ key })).value,
      set: (key, value) => Preferences.set({ key, value }),
      remove: (key) => Preferences.remove({ key }),
    },
    secrets,
    scanQr: kind === "android" ? async () => {
      try {
        let permission = await BarcodeScanner.checkPermissions();
        if (permission.camera !== "granted" && permission.camera !== "limited") permission = await BarcodeScanner.requestPermissions();
        if (permission.camera !== "granted" && permission.camera !== "limited") return null;
        if (!await ensureBarcodeModule()) return null;
        const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
        const text = barcodes[0]?.rawValue;
        return typeof text === "string" ? { text } : null;
      } catch {
        return null;
      }
    } : undefined,
    camera: kind === "ios" ? (Capacitor.isPluginAvailable("QrScanner") ? scannerCamera(iosScanner) : undefined) : scannerCamera(androidScanner),
    async readClipboard() {
      try { return await navigator.clipboard?.readText() ?? null; } catch { return null; }
    },
    // Capacitor 8 hands a top-level navigation off the app's own origin to the system (Mail for mailto:); the in-app
    // browser view takes web pages only
    openExternal: async (url) => { if (/^https?:/i.test(url)) await Browser.open({ url, presentationStyle: "popover" }); else window.location.href = url; },
    closeBrowser() { void Browser.close().catch(() => {}); },
    share: async (data) => { await Share.share(data); },
    appleSignIn: kind === "ios" && Capacitor.isPluginAvailable("AppleSignIn") ? async (nonceHash) => {
      try { return await AppleSignIn.signIn({ nonce: nonceHash }); } catch (error) {
        if ((error as { code?: unknown }).code === "canceled") return null;
        throw error;
      }
    } : undefined,
    async registerPush(options) {
      try {
        const asked = (await PushNotifications.checkPermissions()).receive;
        if (asked === "denied" || (asked !== "granted" && !options?.prompt)) return null;
        if (asked !== "granted" && (await PushNotifications.requestPermissions()).receive !== "granted") return null;
        return await new Promise<{ token: string; platform: "apns" | "fcm" } | null>((resolve) => {
          const handles: PendingHandle[] = [];
          let settled = false;
          const finish = (value: { token: string; platform: "apns" | "fcm" } | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            unsubscribe(handles)();
            resolve(value);
          };
          const timeout = setTimeout(() => finish(null), 15_000);
          void (async () => {
            handles.push(PushNotifications.addListener("registration", ({ value }) => finish({ token: value, platform: kind === "ios" ? "apns" : "fcm" })));
            handles.push(PushNotifications.addListener("registrationError", () => finish(null)));
            await Promise.all(handles);
            if (!settled) await PushNotifications.register();
          })().catch(() => finish(null));
        });
      } catch {
        return null;
      }
    },
    setViewingThread: notificationsOn ? (threadId) => { void DuskNotifications.setViewing({ threadId }).catch(() => {}); } : undefined,
    async deliveredNotifications() {
      try {
        return notificationsOn ? (await DuskNotifications.delivered()).notifications : kind === "android" ? await androidDelivered() : [];
      } catch {
        return [];
      }
    },
    async removeDeliveredNotifications(ids) {
      if (!ids.length) return;
      try {
        if (notificationsOn) return await DuskNotifications.remove({ ids: [...ids] });
        if (kind !== "android") return;
        // Android cancels by id and tag, so the delivered entries go back whole
        const { notifications } = await PushNotifications.getDeliveredNotifications();
        const gone = notifications.filter((one) => ids.includes(one.id));
        if (gone.length) await PushNotifications.removeDeliveredNotifications({ notifications: gone });
      } catch {}
    },
    onNotificationOpen(listener) {
      return unsubscribe([PushNotifications.addListener("pushNotificationActionPerformed", ({ actionId, notification }) => {
        const data = notification.data ?? {};
        if (actionId === "tap" && !fromBotHost(data)) listener(notificationTarget(data));
      })]);
    },
    onPhoneAction(listener) {
      const handles = [PushNotifications.addListener("pushNotificationActionPerformed", ({ actionId, inputValue, notification }) => {
        const data = notification.data ?? {};
        if (actionId !== "tap" || fromBotHost(data)) listener({ actionId, ...(inputValue ? { inputValue } : {}), data });
      })];
      if (Capacitor.isPluginAvailable("DuskTurnActivity")) handles.push(DuskTurnActivity.addListener("action", listener));
      return unsubscribe(handles);
    },
    turnActivity: turnActivityOn ? turnActivityBridge() : undefined,
  };
}
