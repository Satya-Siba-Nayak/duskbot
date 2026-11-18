package bot.dusk.mobile;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
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
 * Native streaming HTTP client for Android (`DuskStream`).
 *
 * CapacitorHttp buffers entire responses before returning to JS, so Server-Sent Events (`/api/events`)
 * cannot stream through it. Falling back to the WebView's `fetch` (`CapacitorWebFetch`) sends an
 * `Origin: https://localhost` header that the companion proxy (`apps/companion/src/proxy.ts`) refuses
 * with 403, and triggers Mixed Content blocks on `http://` LAN/Tailscale companion endpoints.
 *
 * Streaming through native `HttpURLConnection` sends no `Origin` header, respects `network_security_config.xml`,
 * and delivers SSE chunks as they arrive.
 */
@CapacitorPlugin(name = "DuskStream")
public class SseStreamPlugin extends Plugin {

    private final ConcurrentHashMap<String, HttpURLConnection> connections = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void open(PluginCall call) {
        final String id = call.getString("id");
        final String urlString = call.getString("url");
        final String method = call.getString("method", "GET");
        final JSObject headers = call.getObject("headers");
        final String bodyBase64 = call.getString("body");

        if (id == null || id.isEmpty() || urlString == null || urlString.isEmpty()) {
            call.reject("id and url are required");
            return;
        }

        executor.execute(() -> {
            HttpURLConnection conn = null;
            boolean resolved = false;
            try {
                URL url = new URL(urlString);
                conn = (HttpURLConnection) url.openConnection();
                connections.put(id, conn);

                conn.setRequestMethod(method != null ? method : "GET");
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(0);
                conn.setUseCaches(false);

                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        if (key == null || "origin".equalsIgnoreCase(key)) continue;
                        String val = headers.getString(key);
                        if (val != null) {
                            conn.setRequestProperty(key, val);
                        }
                    }
                }

                if (bodyBase64 != null && !bodyBase64.isEmpty()) {
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
                Map<String, List<String>> fields = conn.getHeaderFields();
                if (fields != null) {
                    for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
                        String name = entry.getKey();
                        List<String> values = entry.getValue();
                        if (name != null && values != null && !values.isEmpty()) {
                            resHeaders.put(name.toLowerCase(Locale.ROOT), String.join(", ", values));
                        }
                    }
                }

                JSObject head = new JSObject();
                head.put("status", status);
                head.put("headers", resHeaders);
                resolved = true;
                call.resolve(head);

                InputStream raw = null;
                try {
                    raw = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                } catch (Exception ignored) {}

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
                String msg = e.getMessage() != null ? e.getMessage() : "stream failed";
                if (!resolved) {
                    call.reject(msg);
                } else if (wasActive) {
                    JSObject end = new JSObject();
                    end.put("id", id);
                    end.put("error", msg);
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
        final HttpURLConnection conn = id != null ? connections.remove(id) : null;
        if (conn != null) {
            executor.execute(() -> {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {}
            });
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Map.Entry<String, HttpURLConnection> entry : connections.entrySet()) {
            final HttpURLConnection conn = connections.remove(entry.getKey());
            if (conn != null) {
                executor.execute(() -> {
                    try {
                        conn.disconnect();
                    } catch (Exception ignored) {}
                });
            }
        }
        super.handleOnDestroy();
    }
}
