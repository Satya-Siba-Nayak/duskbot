package bot.dusk.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.service.notification.StatusBarNotification;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONException;

@CapacitorPlugin(name = "DuskNotifications")
public class PhoneNotificationsPlugin extends Plugin {

    static final String CHANNEL_MESSAGES = "dusk.messages";
    static final String CHANNEL_APPROVALS = "dusk.approvals";
    static final String CHANNEL_TURNS = "dusk.turns";

    private static volatile String viewingThread;
    private final Handler main = new Handler(Looper.getMainLooper());

    static String currentViewingThread() {
        return viewingThread;
    }

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel messages = new NotificationChannel(
            CHANNEL_MESSAGES,
            "Messages",
            NotificationManager.IMPORTANCE_HIGH
        );
        messages.setDescription("Replies from your bots and group chats");
        manager.createNotificationChannel(messages);

        NotificationChannel approvals = new NotificationChannel(
            CHANNEL_APPROVALS,
            "Approvals and questions",
            NotificationManager.IMPORTANCE_HIGH
        );
        approvals.setDescription("When a bot asks before acting or needs an answer");
        manager.createNotificationChannel(approvals);

        NotificationChannel turns = new NotificationChannel(
            CHANNEL_TURNS,
            "Live turn activity",
            NotificationManager.IMPORTANCE_LOW
        );
        turns.setDescription("Live progress while a bot is working on a turn");
        turns.setShowBadge(false);
        manager.createNotificationChannel(turns);
    }

    @Override
    public void load() {
        ensureChannels(getContext());
    }

    @PluginMethod
    public void setViewing(PluginCall call) {
        String thread = call.getString("threadId");
        main.post(() -> {
            viewingThread = (thread != null && !thread.isEmpty()) ? thread : null;
            if (viewingThread != null) cancelForThread(viewingThread);
            call.resolve();
        });
    }

    @PluginMethod
    public void delivered(PluginCall call) {
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        JSArray list = new JSArray();
        if (manager != null) {
            for (StatusBarNotification one : manager.getActiveNotifications()) {
                if (TurnActivityPlugin.isTurnNotification(one)) continue;
                JSObject entry = new JSObject();
                entry.put("id", keyOf(one));
                String threadId = threadIdOf(one);
                if (threadId != null && !threadId.isEmpty()) entry.put("threadId", threadId);
                String notificationId = notificationIdOf(one);
                if (notificationId != null && !notificationId.isEmpty()) entry.put("notificationId", notificationId);
                list.put(entry);
            }
        }
        JSObject result = new JSObject();
        result.put("notifications", list);
        call.resolve(result);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        JSArray raw = call.getArray("ids");
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (raw != null && manager != null) {
            Set<String> targetIds = new HashSet<>();
            try {
                List<String> items = raw.toList();
                for (Object item : items) {
                    if (item instanceof String && !((String) item).isEmpty()) targetIds.add((String) item);
                }
            } catch (JSONException ignored) {}
            if (!targetIds.isEmpty()) {
                for (StatusBarNotification one : manager.getActiveNotifications()) {
                    if (TurnActivityPlugin.isTurnNotification(one)) continue;
                    String key = keyOf(one);
                    String plainId = String.valueOf(one.getId());
                    if (targetIds.contains(key) || targetIds.contains(plainId)) {
                        if (one.getTag() != null) manager.cancel(one.getTag(), one.getId());
                        else manager.cancel(one.getId());
                    }
                }
            }
        }
        call.resolve();
    }

    private void cancelForThread(String threadId) {
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null) return;
        for (StatusBarNotification one : manager.getActiveNotifications()) {
            if (TurnActivityPlugin.isTurnNotification(one)) continue;
            if (threadId.equals(threadIdOf(one))) {
                if (one.getTag() != null) manager.cancel(one.getTag(), one.getId());
                else manager.cancel(one.getId());
            }
        }
    }

    private static String keyOf(StatusBarNotification sbn) {
        String tag = sbn.getTag();
        return (tag != null && !tag.isEmpty()) ? tag + ":" + sbn.getId() : String.valueOf(sbn.getId());
    }

    private static String threadIdOf(StatusBarNotification sbn) {
        Notification notification = sbn.getNotification();
        if (notification != null && notification.extras != null) {
            Bundle extras = notification.extras;
            String direct = extras.getString("threadId");
            if (direct != null && !direct.isEmpty()) return direct;
            Bundle dusk = extras.getBundle("dusk");
            if (dusk != null) {
                String nested = dusk.getString("threadId");
                if (nested != null && !nested.isEmpty()) return nested;
            }
        }
        String tag = sbn.getTag();
        return (tag != null && !tag.isEmpty() && !tag.startsWith("dusk.turn:")) ? tag : null;
    }

    private static String notificationIdOf(StatusBarNotification sbn) {
        Notification notification = sbn.getNotification();
        if (notification == null || notification.extras == null) return null;
        Bundle extras = notification.extras;
        String direct = extras.getString("id");
        if (direct != null && !direct.isEmpty()) return direct;
        Bundle dusk = extras.getBundle("dusk");
        return dusk != null ? dusk.getString("id") : null;
    }
}
