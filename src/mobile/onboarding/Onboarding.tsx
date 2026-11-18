import { useEffect, useId, useRef, useState } from "react";
import { storeApp } from "@/lib/store-app";
import { AnimatePresence } from "motion/react";
import { ClipboardPaste, Keyboard, QrCode, UserRound } from "../../icons";
import { WorkingDots } from "@/components/WorkingIndicator";
import { t } from "@/lib/i18n";
import { THEME_SKINS } from "@/lib/skins";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { haptic } from "../haptics";
import { PixelArt, PixelMascot } from "../Illustration";
import { usePlatform, type CameraPermission } from "../platform";
import { PairError, readScanned, redeemPairing, resolveTypedCode, type TypedPairing } from "../connection/pair";
import { followSignInService } from "../account/environment";
import { Scanner } from "./Scanner";
import { CloudPicker } from "../account/CloudPicker";
import { MobileSignIn } from "../account/MobileSignIn";
import { useMobileAccount } from "../account/AccountGate";
import { MascotTrio } from "./SkyScene";
import { BackButton, ErrorLine, FIELD, HEADLINE, LINE, PRIMARY, QUIET, Screen, StepPane, TONAL } from "./parts";

export type Step = "welcome" | "signin" | "clouds" | "confirm" | "permission" | "denied" | "scan" | "code" | "paste";
type Failure = { code: PairError["code"] | "account-offline"; name: string; companion: boolean; details?: string };
type PhoneCodeOutcome = Awaited<ReturnType<NonNullable<ReturnType<typeof useMobileAccount>>["signIn"]["phoneCode"]>>["outcome"];

/** a dusk cloud code that did not log in, as the failure the code screen says */
export function phoneCodeFailure(outcome: Exclude<PhoneCodeOutcome, "signed-in">): Failure["code"] {
  switch (outcome) {
    case "wrong-code": return "unknown";
    case "expired": return "expired";
    case "used": return "used";
    case "limited": return "limited";
    case "offline": return "account-offline";
    case "failed": return "account-offline";
  }
}

export const DOWNLOAD_URL = "https://dusk.bot/download";

function installationName(payload: TypedPairing | null): string {
  if (payload?.name) return payload.name;
  try { return new URL(payload?.origin ?? "").host; } catch { return t("mobile.pair.workspace"); }
}

/** Where a fresh start lands: a link that arrived goes to its confirmation, a signed-in phone to its clouds, a sign-in
 * asked for from Settings to the sign-in, anyone else to pairing with their computer. */
export function firstStep({ incoming, signedIn, adding, startAt = "welcome" }: { incoming: boolean; signedIn: boolean; adding: boolean; startAt?: "welcome" | "signin" }): Step {
  if (incoming) return "confirm";
  if (startAt === "signin") return signedIn ? "clouds" : "signin";
  if (signedIn && !adding) return "clouds";
  return "welcome";
}

function Failed({ failure, onSignIn }: { failure: Failure; onSignIn?: () => void }) {
  const key = failure.code === "unreachable" && failure.companion ? "network" : failure.code;
  // a cloud never takes a code, and a code nobody knows is often a cloud's or a browser's: logging in is the way there
  const signIn = onSignIn && (failure.code === "sign-in" || failure.code === "unknown");
  return (
    <ErrorLine action={signIn ? (
      <button type="button" data-failure-sign-in="" onClick={onSignIn} className="mobile-press -ms-2 mt-1 flex min-h-11 items-center rounded-full px-2 text-[15px] font-semibold text-ink underline underline-offset-2">
        {t("mobile.onboarding.err.signInAction")}
      </button>
    ) : null}>
      <span className="block font-semibold">{t(`mobile.onboarding.err.${key}.title` as Parameters<typeof t>[0])}</span>
      <span className="block text-ink-secondary">{t(`mobile.onboarding.err.${key}.body` as Parameters<typeof t>[0], { name: failure.name })}</span>
      {failure.details && (
        <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-ink/[0.06] px-2.5 py-2 font-mono text-[11px] leading-4 text-ink-secondary">
          {`ERR_${failure.code.toUpperCase()}\n${failure.details}`}
        </pre>
      )}
    </ErrorLine>
  );
}

/** First launch to linked. Pairing with your own computer needs no account (App Store guideline 5.1.1(v)): scan its QR
 * code first, or type its code. Signing in is only for a dusk cloud (the account finds it and pairs with it). The success moment and the hand-off
 * to Home belong to the connection gate. */
export function Onboarding({ initial = null, reason = null, startAtLink = false, startAt = "welcome", email, signInCode, onLinked, onCancel }: {
  /** where a sheet opened from inside the app starts */
  startAt?: "welcome" | "signin";
  /** a dusk cloud's qr named the account to sign in with */
  email?: string;
  /** and carried a desktop's code that logs the phone in: it is redeemed at once, on the code screen */
  signInCode?: string;
  initial?: TypedPairing | null;
  /** Linking another computer from inside the app: a way back out. */
  startAtLink?: boolean;
  reason?: "revoked" | null;
  onLinked(record: MobileConnectionRecord, token: string, name: string): void | Promise<void>;
  onCancel?: () => void;
}) {
  const platform = usePlatform();
  const account = useMobileAccount();
  const signedIn = Boolean(account?.account);
  const home: Step = firstStep({ incoming: false, signedIn, adding: startAtLink });
  const [step, setStep] = useState<Step>(() => signInCode ? "code" : firstStep({ incoming: Boolean(initial), signedIn, adding: startAtLink, startAt }));
  const [confirm, setConfirm] = useState<TypedPairing | null>(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // a failed scan lands on the code screen with an empty field: its way forward is scanning again, not a dead submit
  const [scanFailed, setScanFailed] = useState(false);
  const [noClouds, setNoClouds] = useState(false);
  const [value, setValue] = useState(() => signInCode ? formatCode(signInCode) : "");
  const [signInEmail, setSignInEmail] = useState(email ?? "");
  const locked = useRef(false);
  const fieldId = useId();

  useEffect(() => {
    platform.setStatusBar?.(step === "scan" || document.documentElement.dataset.skin === THEME_SKINS.dark ? "light" : "dark");
  }, [platform, step]);

  const go = (next: Step) => { setFailure(null); setScanFailed(false); setValue(""); setStep(next); };

  const redeem = async (text: string | TypedPairing, from: Step) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setFailure(null);
    setScanFailed(false);
    let payload: TypedPairing | null = typeof text === "string" ? null : text;
    try {
      if (typeof text === "string") {
        const scanned = readScanned(text);
        if (scanned?.kind === "store") throw new PairError("store-qr");
        if (scanned?.kind === "signin" && followSignInService(text, scanned.service, account)) return;
        const accountCode = scanned?.kind === "account" || scanned?.kind === "signin" ? scanned.code : undefined;
        if (accountCode) {
          if (!account) throw new PairError("sign-in");
          const result = await account.signIn.phoneCode(accountCode);
          if (result.outcome !== "signed-in") {
            haptic("error");
            setFailure({ code: phoneCodeFailure(result.outcome), name: t("mobile.pair.workspace"), companion: false });
            if (from !== "code") { setStep("code"); setValue(formatCode(accountCode)); }
            return;
          }
          haptic("success");
          go("clouds");
          return;
        }
        if (scanned?.kind === "signin") { setSignInEmail(scanned.email); go(signedIn ? "clouds" : "signin"); return; }
        payload = scanned?.kind === "code" ? await resolveTypedCode(scanned.code) : scanned?.kind === "pair" ? scanned.payload : null;
      }
      if (!payload) throw new PairError("invalid");
      const result = await redeemPairing(payload, platform);
      await onLinked(result.record, result.token, result.record.label || installationName(payload));
    } catch (error) {
      haptic("error");
      const details = error instanceof PairError ? error.details : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      setFailure({ code: error instanceof PairError ? error.code : "unreachable", name: installationName(payload), companion: payload?.transport === "companion", ...(details ? { details } : {}) });
      if (from === "scan") { setStep("code"); setScanFailed(true); }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  const linkCode = useRef(signInCode);
  useEffect(() => {
    const code = linkCode.current;
    linkCode.current = undefined;
    if (code) void redeem(code, "code");
  }, []);

  const openScanner = async () => {
    setFailure(null);
    const camera = platform.camera;
    if (!camera) { go("code"); return; }
    const state: CameraPermission = await camera.permission().catch(() => "prompt");
    go(state === "granted" ? "scan" : state === "denied" ? "denied" : "permission");
  };
  const askCamera = async () => {
    const state = await platform.camera?.request().catch(() => "denied" as const);
    // the OS prompt pauses the app; the camera only opens once it is back in front
    if (state === "granted") await new Promise((resolve) => setTimeout(resolve, 450));
    go(state === "granted" ? "scan" : "denied");
  };
  const paste = async () => {
    const text = await platform.readClipboard?.();
    if (text) setValue(text.trim());
  };

  const back = (to: Step = home) => <BackButton onClick={() => go(to)} />;
  const close = startAtLink && onCancel ? <BackButton close onClick={onCancel} /> : null;
  const download = (
    <p className="mt-5 text-[14px] leading-5 text-ink-secondary">
      {t("mobile.entry.noApp")}{" "}
      <button type="button" className="font-semibold text-ink underline underline-offset-2" onClick={() => void platform.openExternal(DOWNLOAD_URL)}>{t("mobile.entry.download")}</button>
    </p>
  );

  return (
    <main className="dusk-mobile relative size-full overflow-hidden bg-app text-ink" data-scan-clear aria-busy={busy}>
      <AnimatePresence mode="wait" initial={false}>
        {step === "welcome" && (
          <StepPane id="welcome">
            <Screen top={close} art={<MascotTrio scale={1.4} />} actions={<>
              <button type="button" data-entry="scan" className={PRIMARY} onClick={() => void openScanner()}><QrCode size={20} />{t("mobile.entry.scan")}</button>
              <button type="button" data-entry="signin" className={TONAL} onClick={() => go(signedIn ? "clouds" : "signin")}><UserRound size={20} />{t("mobile.entry.signInCloud")}</button>
              <button type="button" data-entry="code" className={`${QUIET} gap-2`} onClick={() => go("code")}><Keyboard size={18} />{t("mobile.entry.code")}</button>
            </>}>
              {reason === "revoked" && <ErrorLine>{t("mobile.pair.revoked")}</ErrorLine>}
              <h1 className={`${HEADLINE} ${reason === "revoked" ? "mt-5" : ""}`}>{t(startAtLink ? "mobile.entry.addTitle" : "mobile.entry.title")}</h1>
              <p className={LINE}>{t(storeApp() ? "mobile.entry.bodyStore" : "mobile.entry.body")}</p>
              {download}
            </Screen>
          </StepPane>
        )}

        {step === "signin" && (
          <StepPane id="signin">
            <Screen top={back("welcome")} align="top" actions={null}>
              <MobileSignIn initialEmail={signInEmail} onSignedIn={() => go("clouds")} />
            </Screen>
          </StepPane>
        )}

        {step === "clouds" && (
          <StepPane id="clouds">
            <Screen top={close ?? back("welcome")} art={noClouds ? <PixelArt name="signpost" size={84} /> : <PixelMascot color="blue" size={64} />} actions={<>
              {noClouds && <button type="button" className={TONAL} onClick={() => void openScanner()}><QrCode size={20} />{t("mobile.entry.scan")}</button>}
              {noClouds && <button type="button" className={TONAL} onClick={() => go("code")}><Keyboard size={20} />{t("mobile.entry.code")}</button>}
              {!noClouds && <button type="button" disabled={busy} className={QUIET} onClick={() => go("welcome")}>{t("mobile.entry.otherWays")}</button>}
            </>}>
              <h1 className={HEADLINE}>{t(noClouds ? storeApp() ? "mobile.clouds.noneTitleStore" : "mobile.clouds.noneTitle" : "mobile.clouds.pickTitle")}</h1>
              <p className={LINE}>{t(noClouds ? storeApp() ? "mobile.clouds.noneStore" : "mobile.clouds.none" : "mobile.clouds.pickBody", { email: account?.account?.email ?? "" })}</p>
              <CloudPicker busy={busy} autoPick onNone={() => setNoClouds(true)} onPairing={(payload) => redeem(payload, "clouds")} />
              {failure && <Failed failure={failure} />}
            </Screen>
          </StepPane>
        )}

        {step === "confirm" && confirm && (
          <StepPane id="confirm">
            <Screen art={<PixelArt name="computer" size={84} />} actions={<>
              <button type="button" disabled={busy} className={PRIMARY} onClick={() => void redeem(confirm, "confirm")}>{busy ? <WorkingDots /> : t("mobile.pair.link")}</button>
              <button type="button" disabled={busy} className={QUIET} onClick={() => { setConfirm(null); setFailure(null); if (onCancel && startAtLink) onCancel(); else go(home); }}>{t("mobile.pair.cancel")}</button>
            </>}>
              <h1 className={HEADLINE}>{t("mobile.pair.confirm", { name: installationName(confirm) })}</h1>
              <p className={LINE}>{t("mobile.onboarding.confirmBody")}</p>
              {failure && <Failed failure={failure} onSignIn={() => go(signedIn ? "clouds" : "signin")} />}
            </Screen>
          </StepPane>
        )}

        {(step === "permission" || step === "denied") && (
          <StepPane id={step}>
            <Screen top={back()} art={<PixelArt name={step === "denied" ? "signpost" : "computer"} size={84} />} actions={<>
              {step === "permission"
                ? <button type="button" className={PRIMARY} onClick={() => void askCamera()}>{t("mobile.onboarding.allowCamera")}</button>
                : platform.camera?.openSettings && <button type="button" className={PRIMARY} onClick={() => void platform.camera?.openSettings?.()}>{t("mobile.onboarding.openSettings")}</button>}
              <button type="button" className={QUIET} onClick={() => go("code")}>{t("mobile.onboarding.codeInstead")}</button>
            </>}>
              <h1 className={HEADLINE}>{t(step === "denied" ? "mobile.onboarding.deniedTitle" : "mobile.onboarding.cameraTitle")}</h1>
              <p className={LINE}>{t(step === "denied" ? "mobile.onboarding.deniedBody" : "mobile.entry.cameraBody")}</p>
            </Screen>
          </StepPane>
        )}

        {(step === "code" || step === "paste") && (
          <StepPane id={step}>
            <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={(event) => { event.preventDefault(); if (value.trim()) void redeem(value, step); }}>
              <div className="flex h-[calc(var(--m-safe-top)+60px)] shrink-0 items-end px-4 pb-2">{back(step === "paste" ? "code" : home)}</div>
              <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-4 text-center">
                <PixelArt name="computer" size={76} className="mb-5" />
                <h1 className={HEADLINE}>{t(step === "code" ? "mobile.onboarding.codeTitle" : "mobile.onboarding.pasteTitle")}</h1>
                <p className={LINE}>{t(step === "code" ? "mobile.entry.codeBody" : "mobile.onboarding.pasteBody")}</p>
                <div className="mt-7 w-full text-left">
                  <label htmlFor={fieldId} className="mb-1.5 block px-1 text-[15px] font-medium text-ink">{t(step === "code" ? "mobile.onboarding.codeLabel" : "mobile.onboarding.pasteLabel")}</label>
                  {step === "code" ? (
                    <input id={fieldId} autoFocus value={value} disabled={busy}
                      onChange={(event) => { setValue(formatCode(event.target.value)); setFailure(null); }}
                      inputMode="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX" maxLength={14}
                      aria-invalid={Boolean(failure) || undefined}
                      className={`${FIELD} text-center font-mono text-[19px] tracking-[0.1em] placeholder:text-ink/[0.3]`} />
                  ) : (
                    <div className="flex w-full gap-2">
                      <input id={fieldId} autoFocus value={value} disabled={busy} onChange={(event) => { setValue(event.target.value); setFailure(null); }}
                        inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="duskbot://pair?..." aria-invalid={Boolean(failure) || undefined}
                        className={`${FIELD} flex-1`} />
                      {platform.readClipboard && <button type="button" onClick={() => void paste()} aria-label={t("mobile.onboarding.pasteFromClipboard")} className="mobile-press flex size-[52px] shrink-0 items-center justify-center rounded-[16px] bg-ink/[0.06] text-ink"><ClipboardPaste size={20} /></button>}
                    </div>
                  )}
                  {failure && <Failed failure={failure} onSignIn={() => go(signedIn ? "clouds" : "signin")} />}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-center gap-1 px-6 pb-[calc(var(--m-safe-bottom)+16px)] pt-4">
                {scanFailed && !value.trim() && !busy
                  ? <button type="button" data-scan-again="" className={PRIMARY} onClick={() => void openScanner()}><QrCode size={20} />{t("mobile.onboarding.scanAgain")}</button>
                  : <button type="submit" disabled={busy || !value.trim() || (step === "code" && !typedCodeComplete(value))} className={PRIMARY}>{busy ? <WorkingDots /> : t(failure ? "mobile.onboarding.retry" : "mobile.pair.link")}</button>}
                {step === "code" && <button type="button" className={QUIET} onClick={() => { setValue(""); setFailure(null); setStep("paste"); }}>{t("mobile.onboarding.pasteInstead")}</button>}
              </div>
            </form>
          </StepPane>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {step === "scan" && (
          <Scanner key="scan" platform={platform} busy={busy}
            onCode={(text) => void redeem(text, "scan")}
            onClose={() => go(home)} onEnterCode={() => go("code")} onPaste={() => go("paste")} />
        )}
      </AnimatePresence>
    </main>
  );
}

/** a computer's 12-character code, or a dusk cloud's 8 letters */
export function typedCodeComplete(value: string): boolean {
  const raw = value.replace(/-/g, "");
  return raw.length === 12 || (raw.length === 8 && /^[A-Z]+$/.test(raw));
}

/** XXXX-XXXX-XXXX as the person types: letters and digits only, uppercase, dashes added. */
export function formatCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return raw.replace(/(.{4})(?=.)/g, "$1-");
}
