package bot.dusk.mobile;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native HTTP and SSE streaming client for Android (`DuskStream`).
 *
 * CapacitorHttp buffers entire responses before returning to JS, ignores AbortSignal timeouts,
 * and rewrites GET requests to `https://localhost/_capacitor_http_interceptor_?u=...` through
 * `window.CapacitorWebFetch`.
 *
 * Executing requests through native `HttpURLConnection` sends no `Origin: https://localhost` header,
 * respects `network_security_config.xml`, enforces explicit connect/read timeouts, returns regular
 * HTTP responses atomically, and streams Server-Sent Events (`/api/events`) chunk by chunk.
 */
@CapacitorPlugin(name = "DuskStream")
public class SseStreamPlugin extends Plugin {

    private static final class ActiveCall {
        final HttpURLConnection conn;
        final Thread thread;

        ActiveCall(HttpURLConnection conn, Thread thread) {
            this.conn = conn;
            this.thread = thread;
        }
    }

    private final ConcurrentHashMap<String, ActiveCall> connections = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    private static boolean isStreamingUrl(String urlString) {
        if (urlString == null) return false;
        int q = urlString.indexOf('?');
        String path = (q >= 0 ? urlString.substring(0, q) : urlString).toLowerCase(Locale.ROOT);
        return path.endsWith("/api/events") || path.endsWith("/stream");
    }

    @PluginMethod
    public void open(PluginCall call) {
        final String id = call.getString("id");
        final String urlString = call.getString("url");
        final String method = call.getString("method", "GET");
        final JSObject headers = call.getObject("headers");
        final String bodyBase64 = call.getString("body");
        final Integer reqConnectTimeout = call.getInt("connectTimeout");
        final Integer reqReadTimeout = call.getInt("readTimeout");
        final Boolean reqStream = call.getBoolean("stream");
        final Boolean reqFollowRedirects = call.getBoolean("followRedirects");

        if (id == null || id.isEmpty() || urlString == null || urlString.isEmpty()) {
            call.reject("id and url are required");
            return;
        }

        final int connectTimeout = reqConnectTimeout != null && reqConnectTimeout > 0 ? reqConnectTimeout : 8_000;
        final boolean followRedirects = reqFollowRedirects != null && reqFollowRedirects;

        executor.execute(() -> {
            HttpURLConnection conn = null;
            boolean resolved = false;
            boolean wantStream = Boolean.TRUE.equals(reqStream) || isStreamingUrl(urlString);
            try {
                URL url = new URL(urlString);
                conn = (HttpURLConnection) url.openConnection();
                connections.put(id, new ActiveCall(conn, Thread.currentThread()));

                String reqMethod = method != null ? method.toUpperCase(Locale.ROOT) : "GET";
                conn.setRequestMethod(reqMethod);
                conn.setInstanceFollowRedirects(followRedirects);
                conn.setConnectTimeout(connectTimeout);
                conn.setUseCaches(false);

                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        if (key == null) continue;
                        String lower = key.toLowerCase(Locale.ROOT);
                        if ("origin".equals(lower) || "accept-encoding".equals(lower)) continue;
                        String val = headers.getString(key);
                        if (val != null) {
                            if ("accept".equals(lower) && val.toLowerCase(Locale.ROOT).contains("text/event-stream")) {
                                wantStream = true;
                            }
                            conn.setRequestProperty(key, val);
                        }
                    }
                }

                int defaultReadTimeout = wantStream ? 0 : Math.max(connectTimeout + 4_000, 15_000);
                conn.setReadTimeout(reqReadTimeout != null && reqReadTimeout >= 0 ? reqReadTimeout : defaultReadTimeout);

                if (bodyBase64 != null && !bodyBase64.isEmpty() && !"GET".equals(reqMethod) && !"HEAD".equals(reqMethod)) {
                    byte[] payload = Base64.decode(bodyBase64, Base64.DEFAULT);
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(payload.length);
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(payload);
                        out.flush();
                    }
                }

                int status = conn.getResponseCode();
                JSObject resHeaders = new JSObject();
                String contentType = "";
                Map<String, List<String>> fields = conn.getHeaderFields();
                if (fields != null) {
                    for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
                        String name = entry.getKey();
                        List<String> values = entry.getValue();
                        if (name != null && values != null && !values.isEmpty()) {
                            String lower = name.toLowerCase(Locale.ROOT);
                            if ("content-encoding".equals(lower) || "transfer-encoding".equals(lower) || "content-length".equals(lower)) {
                                continue;
                            }
                            String joined = String.join(", ", values);
                            resHeaders.put(lower, joined);
                            if ("content-type".equals(lower)) {
                                contentType = joined.toLowerCase(Locale.ROOT);
                            }
                        }
                    }
                }

                boolean isStream = wantStream || contentType.contains("text/event-stream");

                InputStream raw = null;
                try {
                    raw = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                } catch (Exception ignored) {}

                if (!isStream) {
                    ByteArrayOutputStream baos = new ByteArrayOutputStream();
                    if (raw != null && status != 204 && status != 205 && status != 304 && !"HEAD".equals(reqMethod)) {
                        try (InputStream in = raw) {
                            byte[] buf = new byte[8192];
                            int n;
                            while (connections.containsKey(id) && (n = in.read(buf)) != -1) {
                                if (n > 0) baos.write(buf, 0, n);
                            }
                        }
                    }
                    connections.remove(id);
                    JSObject head = new JSObject();
                    head.put("status", status);
                    head.put("headers", resHeaders);
                    head.put("body", Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP));
                    resolved = true;
                    call.resolve(head);
                    return;
                }

                JSObject head = new JSObject();
                head.put("status", status);
                head.put("headers", resHeaders);
                resolved = true;
                call.resolve(head);

                if (raw != null) {
                    try (InputStream in = raw) {
                        byte[] buf = new byte[8192];
                        int n;
                        while (connections.containsKey(id) && (n = in.read(buf)) != -1) {
                            if (n > 0) {
                                JSObject chunk = new JSObject();
                                chunk.put("id", id);
                                chunk.put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                                notifyListeners("chunk", chunk);
                            }
                        }
                    }
                }

                connections.remove(id);
                JSObject end = new JSObject();
                end.put("id", id);
                notifyListeners("end", end);
            } catch (Exception e) {
                boolean wasActive = connections.remove(id) != null;
                String detail = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
                if (!resolved) {
                    call.reject(detail);
                } else if (wasActive) {
                    JSObject end = new JSObject();
                    end.put("id", id);
                    end.put("error", detail);
                    notifyListeners("end", end);
                }
            } finally {
                if (conn != null) {
                    try {
                        conn.disconnect();
                    } catch (Exception ignored) {}
                }
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        final String id = call.getString("id");
        final ActiveCall active = id != null ? connections.remove(id) : null;
        if (active != null) {
            try {
                active.thread.interrupt();
            } catch (Exception ignored) {}
            executor.execute(() -> {
                try {
                    active.conn.disconnect();
                } catch (Exception ignored) {}
            });
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Map.Entry<String, ActiveCall> entry : connections.entrySet()) {
            final ActiveCall active = connections.remove(entry.getKey());
            if (active != null) {
                try {
                    active.thread.interrupt();
                } catch (Exception ignored) {}
                executor.execute(() -> {
                    try {
                        active.conn.disconnect();
                    } catch (Exception ignored) {}
                });
            }
        }
        super.handleOnDestroy();
    }
}
