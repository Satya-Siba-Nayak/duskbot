import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { MascotLoader } from "@/components/MascotLoader";
import { readSessionState } from "@/lib/session";
import { resetSessionEnded, useSessionEnded } from "@/lib/session-ended";
import { THEME_SKINS } from "@/lib/skins";
import { parseMobilePairingLink, parseSignInLink, type MobileConnectionRecord } from "../../../shared/mobile-link";
import { usePlatform } from "../platform";
import { useMobileAccount } from "../account/AccountGate";
import { enrollWorkspace } from "../account/enroll-workspace";
import { followSignInService, takeHeldSignIn } from "../account/environment";
import { installTransport } from "../transport/transport";
import { Onboarding } from "../onboarding/Onboarding";
import { SignInOffer } from "../account/SignInOffer";
import { Success } from "../onboarding/Success";
import { connectToWorkspace, createConnectionStore } from "./connections";
import { PairError, parseTypedPairing, type TypedPairing } from "./pair";
import { ActiveConnection } from "./active";
import { TranscriptShelfScope } from "@/state/transcript-scope";
import { forgetTranscriptShelf } from "@/state/transcript-cache";
import { reportPresence } from "./presence";
import { registerPushForConnection } from "./push";
import { Unreachable } from "./Unreachable";
import { PhoneUpdateLine } from "./PhoneUpdateLine";
import { markCloudAsleep, noteCloudPageActivity } from "@/lib/cloud-power";

type GateState = { kind: "loading" } | { kind: "pair"; reason?: "revoked" } | { kind: "ready"; id: string }
  | { kind: "offline"; record: MobileConnectionRecord; others: MobileConnectionRecord[]; attempts: number; trying: boolean };

export function ConnectionGate({ children, forcePair }: { children: ReactNode; forcePair?: boolean }) {
  const platform = usePlatform();
  const account = useMobileAccount();
  const accountRef = useRef(account);
  accountRef.current = account;
  const store = useMemo(() => createConnectionStore(platform), [platform]);
  const [state, setState] = useState<GateState>({ kind: "loading" });
  const [incoming, setIncoming] = useState<{ payload: TypedPairing; sequence: number } | null>(null);
  const [celebrate, setCelebrate] = useState<{ name: string; sequence: number } | null>(null);
  const [entered, setEntered] = useState(false);
  const [adding, setAdding] = useState(0);
  // "dusk:sign-in" (Settings, signed out) opens the dusk cloud sign-in
  const [addingStep, setAddingStep] = useState<"welcome" | "signin">("welcome");
  // a dusk cloud's qr opens the app at that sign-in, its email filled in
  const [signInEmail, setSignInEmail] = useState<{ email: string; code?: string; sequence: number } | null>(null);
  useEffect(() => {
    const signIn = () => { setAddingStep("signin"); setAdding((n) => n + 1); };
    window.addEventListener("dusk:sign-in", signIn);
    return () => window.removeEventListener("dusk:sign-in", signIn);
  }, []);
  // the app never reads the shelf shared by every workspace again; it may still hold an unlinked one's chats
  useEffect(() => { if (platform.native) void forgetTranscriptShelf(null); }, [platform]);
  const sequence = useRef(0);
  const uninstall = useRef<(() => void) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    // a retry keeps the unreachable screen up while it tries
    setState((s) => s.kind === "offline" ? { ...s, trying: true } : { kind: "loading" });
    const decide = async () => {
      if (forcePair) { setState({ kind: "pair" }); return; }
      const active = await store.active();
      if (stopped) return;
      if (active) {
        try {
          const transport = await connectToWorkspace(active.record, active.token, platform, controller.signal);
          if (stopped) { if (transport.kind === "relay") transport.channel.close(); return; }
          uninstall.current = installTransport(transport, retry);
          if (transport.asleep) markCloudAsleep();
          setState({ kind: "ready", id: active.record.id });
          void store.touch(active.record.id).catch(() => {});
        } catch (error) {
          if (stopped) return;
          if (error instanceof PairError && error.code === "refused") {
            await store.remove(active.record.id);
            if (!stopped) setState({ kind: "pair", reason: "revoked" });
          } else {
            // offline is not unpaired: keep the link and the other saved installations reachable
            const others = (await store.list().catch(() => [])).filter((record) => record.id !== active.record.id);
            if (!stopped) setState((s) => ({ kind: "offline", record: active.record, others, attempts: s.kind === "offline" ? s.attempts + 1 : 1, trying: false }));
          }
        }
        return;
      }
      // a native app's own origin is its bundled files, never an installation: it always links one
      if (platform.native) { setState({ kind: "pair" }); return; }
      const session = await readSessionState();
      if (stopped) return;
      if (session.kind === "loopback" || session.kind === "session") {
        uninstall.current = installTransport({ kind: "same-origin", origin: window.location.origin });
        setState({ kind: "ready", id: "same-origin" });
      } else setState({ kind: "pair" });
    };
    void decide().catch(() => { if (!stopped) setState({ kind: "pair" }); });
    return () => { stopped = true; controller.abort(); uninstall.current?.(); uninstall.current = null; };
  }, [forcePair, platform, store, attempt, retry]);

  // the workspace stopped taking this phone's session (it was removed there): connecting again finds out which it is,
  // and a refused token leaves for pairing with the reason
  const ended = useSessionEnded();
  useEffect(() => {
    if (!ended || state.kind !== "ready" || state.id === "same-origin") return;
    resetSessionEnded();
    retry();
  }, [ended, state, retry]);

  useEffect(() => {
    if (state.kind === "ready" && platform.native) void registerPushForConnection(platform);
  }, [state, platform]);

  useEffect(() => (state.kind === "ready" && platform.native ? reportPresence(platform) : undefined), [state, platform]);
  // the app coming back is the person using it, also when the web view misses its visibilitychange
  useEffect(() => platform.onResume?.(() => noteCloudPageActivity()), [platform]);

  useEffect(() => {
    if (state.kind === "ready" && account?.account) void enrollWorkspace(platform, state.id, account.account.id, account.enrollGrant);
  }, [state, platform, account]);

  useEffect(() => {
    const receive = (url: string) => {
      const signIn = parseSignInLink(url);
      if (signIn && followSignInService(url, signIn.service, accountRef.current)) return true;
      if (signIn) {
        setIncoming(null);
        setSignInEmail({ email: signIn.email, ...(signIn.code ? { code: signIn.code } : {}), sequence: ++sequence.current });
        setAddingStep("signin");
        setAdding((n) => n + 1);
        return true;
      }
      const payload = parseMobilePairingLink(url);
      if (payload) setIncoming({ payload, sequence: ++sequence.current });
      return Boolean(payload);
    };
    const customLink = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (typeof detail !== "string") return;
      const parsed = parseTypedPairing(detail);
      if (parsed && !("kind" in parsed)) setIncoming({ payload: parsed, sequence: ++sequence.current });
    };
    const stop = platform.onAppUrl?.(receive);
    const held = takeHeldSignIn();
    if (held) receive(held);
    window.addEventListener("dusk:pair-link", customLink);
    return () => { stop?.(); window.removeEventListener("dusk:pair-link", customLink); };
  }, [platform]);

  /** Linked: the app mounts on the new installation straight away, under the success moment, so Home is loaded by the
   * time the moment hands over. No reload. */
  const linked = useCallback(async (record: MobileConnectionRecord, token: string, name: string) => {
    await store.save(record, token);
    let transport: Awaited<ReturnType<typeof connectToWorkspace>>;
    try {
      transport = await connectToWorkspace(record, token, platform, new AbortController().signal);
    } catch (error) {
      if (record.origin && (record.transport === "companion" || record.transport === "https") && !(error instanceof PairError && error.code === "refused")) {
        transport = { kind: "bearer", origin: record.origin, token };
      } else {
        throw error;
      }
    }
    uninstall.current?.();
    uninstall.current = installTransport(transport, retry);
    if (transport.asleep) markCloudAsleep();
    resetSessionEnded();
    setIncoming(null);
    setAdding(0);
    setEntered(true);
    setCelebrate({ name, sequence: ++sequence.current });
    setState({ kind: "ready", id: record.id });
  }, [store, platform, retry]);
  const cancel = () => { ++sequence.current; setIncoming(null); };
  const switchTo = useCallback((id: string) => { void store.setActive(id).then(retry, retry); }, [store, retry]);

  const success = (
    <AnimatePresence>
      {celebrate && <Success key={celebrate.sequence} name={celebrate.name} onDone={() => { setCelebrate(null); platform.setStatusBar?.(document.documentElement.dataset.skin === THEME_SKINS.dark ? "light" : "dark"); }} />}
    </AnimatePresence>
  );
  const onboarding = state.kind !== "ready" || (forcePair && !entered);
  if (state.kind === "loading" && !incoming && !forcePair) return <div className="dusk-mobile flex size-full items-center justify-center bg-app"><MascotLoader naps={false} /></div>;
  if (state.kind === "offline" && !forcePair) {
    if (!incoming && adding === 0) return <>{success}<Unreachable record={state.record} others={state.others} attempts={state.attempts} trying={state.trying} onRetry={retry} onSwitch={switchTo} /></>;
    return <>{success}<Onboarding key={incoming ? `in-${incoming.sequence}` : `add-${adding}`} initial={incoming?.payload} startAtLink startAt={incoming ? undefined : addingStep} email={signInEmail?.email} signInCode={incoming ? undefined : signInEmail?.code} onLinked={linked} onCancel={() => { cancel(); setAdding(0); }} /></>;
  }
  if (onboarding) {
    return <>{success}<Onboarding key={incoming?.sequence ?? signInEmail?.sequence ?? 0} initial={incoming?.payload} reason={state.kind === "pair" ? state.reason : null}
      startAt={!incoming && signInEmail ? "signin" : undefined} email={signInEmail?.email} signInCode={incoming ? undefined : signInEmail?.code} onLinked={linked} onCancel={cancel} /></>;
  }
  return (
    <>
      <ActiveConnection value={state.id}><TranscriptShelfScope value={state.id === "same-origin" ? null : state.id}><Fragment key={state.id}>{children}</Fragment></TranscriptShelfScope></ActiveConnection>
      <PhoneUpdateLine connection={state.kind === "ready" ? state.id : null} />
      {(incoming || adding > 0) && (
        <div className="fixed inset-0 z-50">
          <Onboarding key={incoming ? `in-${incoming.sequence}` : `add-${adding}`} initial={incoming?.payload} startAtLink startAt={incoming ? undefined : addingStep} email={signInEmail?.email} signInCode={incoming ? undefined : signInEmail?.code}
            onLinked={linked} onCancel={() => { cancel(); setAdding(0); }} />
        </div>
      )}
      <SignInOffer paused={Boolean(celebrate || incoming || adding > 0)} />
      {success}
    </>
  );
}
