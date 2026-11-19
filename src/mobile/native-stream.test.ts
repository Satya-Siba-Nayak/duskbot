import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeStreamFetch, type StreamPlugin } from "../../apps/mobile/src/native-platform";

type ChunkEvent = { id: string; data: string };
type EndEvent = { id: string; error?: string };

function fakeStreamPlugin() {
  let onChunk: ((event: ChunkEvent) => void) | undefined;
  let onEnd: ((event: EndEvent) => void) | undefined;
  const open = vi.fn();
  const close = vi.fn(async () => {});
  const addListener = vi.fn(async (event: "chunk" | "end", listener: (data: never) => void) => {
    if (event === "chunk") onChunk = listener as (event: ChunkEvent) => void;
    else onEnd = listener as (event: EndEvent) => void;
    return { remove: async () => {} };
  });
  return {
    plugin: { open, close, addListener } as unknown as StreamPlugin,
    open,
    close,
    addListener,
    emitChunk: (id: string, text: string) => onChunk?.({ id, data: Buffer.from(text, "utf8").toString("base64") }),
    emitEnd: (id: string, error?: string) => onEnd?.(error ? { id, error } : { id }),
  };
}

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<string[]> {
  if (!body) return [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(decoder.decode(next.value, { stream: true }));
  }
  return chunks;
}

describe("createNativeStreamFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams plain-http companion SSE chunks incrementally", async () => {
    const fake = fakeStreamPlugin();
    fake.open.mockResolvedValue({ status: 200, headers: { "content-type": "text/event-stream" } });
    const nativeFetch = createNativeStreamFetch(fake.plugin);

    const response = await nativeFetch("http://192.168.1.50:8810/api/events", {
      headers: { Authorization: "Bearer secret", Accept: "text/event-stream" },
      redirect: "error",
    });

    expect(fake.open).toHaveBeenCalledWith(expect.objectContaining({
      id: "s1",
      url: "http://192.168.1.50:8810/api/events",
      method: "GET",
      stream: true,
      followRedirects: false,
      headers: expect.objectContaining({ authorization: "Bearer secret", accept: "text/event-stream" }),
    }));
    expect(response.status).toBe(200);

    const reading = readAll(response.body);
    fake.emitChunk("s1", "event: ping\ndata: {}\n\n");
    fake.emitChunk("s1", "data: {\"ok\":true}\n\n");
    fake.emitEnd("s1");

    expect(await reading).toEqual(["event: ping\ndata: {}\n\n", "data: {\"ok\":true}\n\n"]);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("detects relay NDJSON stream=1 requests as streaming and preserves x-link-beat", async () => {
    const fake = fakeStreamPlugin();
    fake.open.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "x-link-beat": "10" },
    });
    const nativeFetch = createNativeStreamFetch(fake.plugin);

    const response = await nativeFetch("https://link.dusk.bot/v1/channels/abcdefghij/to-app?wait=25&stream=1", {
      headers: { Authorization: "Bearer relay-token" },
      redirect: "error",
    });

    expect(fake.open).toHaveBeenCalledWith(expect.objectContaining({
      id: "s1",
      stream: true,
      followRedirects: false,
    }));
    expect(response.headers.get("x-link-beat")).toBe("10");

    const reading = readAll(response.body);
    fake.emitChunk("s1", "{\"frames\":[]}\n");
    fake.emitChunk("s1", "{\"frames\":[\"abc\"]}\n");
    fake.emitEnd("s1");

    expect(await reading).toEqual(["{\"frames\":[]}\n", "{\"frames\":[\"abc\"]}\n"]);
  });

  it("passes same-origin, CapacitorHttp interceptor, and non-http URLs through to webFetch", async () => {
    vi.stubGlobal("window", { location: { origin: "https://localhost" } });
    const fake = fakeStreamPlugin();
    const webFetch = vi.fn(async () => new Response("local-ok", { status: 200 }));
    const nativeFetch = createNativeStreamFetch(fake.plugin, webFetch);

    await nativeFetch("https://localhost/_capacitor_http_interceptor_?u=http%3A%2F%2F192.168.1.50%3A8810%2Fapi%2Fhealth");
    await nativeFetch("https://localhost/assets/app.js");
    await nativeFetch("data:text/plain;base64,aGk=");

    expect(webFetch).toHaveBeenCalledTimes(3);
    expect(fake.open).not.toHaveBeenCalled();
  });

  it("preserves AbortError when aborted while opening and closes the native call", async () => {
    const fake = fakeStreamPlugin();
    fake.open.mockReturnValue(new Promise(() => {}));
    const nativeFetch = createNativeStreamFetch(fake.plugin);
    const controller = new AbortController();

    const pending = nativeFetch("http://192.168.1.50:8810/api/events", { signal: controller.signal });
    await vi.waitFor(() => expect(fake.open).toHaveBeenCalledTimes(1));
    const reason = new DOMException("timed out", "TimeoutError");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fake.close).toHaveBeenCalledWith({ id: "s1" });
  });

  it("rejects 3xx responses when redirect is error and closes the native call", async () => {
    const fake = fakeStreamPlugin();
    fake.open.mockResolvedValue({ status: 302, headers: { location: "https://evil.example" }, body: "" });
    const nativeFetch = createNativeStreamFetch(fake.plugin);

    await expect(
      nativeFetch("http://192.168.1.50:8810/api/events", { redirect: "error" }),
    ).rejects.toThrow(/Unexpected redirect/);
    expect(fake.close).toHaveBeenCalledWith({ id: "s1" });
  });

  it("returns inline responses and closes native stream on reader cancel", async () => {
    const fake = fakeStreamPlugin();
    fake.open
      .mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from("{\"ok\":true}", "utf8").toString("base64"),
      })
      .mockResolvedValueOnce({ status: 200, headers: { "content-type": "text/event-stream" } });
    const nativeFetch = createNativeStreamFetch(fake.plugin);

    const inline = await nativeFetch("http://192.168.1.50:8810/api/health");
    expect(await inline.json()).toEqual({ ok: true });

    const streamRes = await nativeFetch("http://192.168.1.50:8810/api/events");
    await streamRes.body?.cancel();
    expect(fake.close).toHaveBeenCalledWith({ id: "s2" });
  });
});
