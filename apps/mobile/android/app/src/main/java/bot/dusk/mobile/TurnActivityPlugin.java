package bot.dusk.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "DuskTurnActivity")
public class TurnActivityPlugin extends Plugin {

    static final String EXTRA_PHONE_ACTION = "bot.dusk.mobile.PHONE_ACTION";
    private static final String TAG_PREFIX = "dusk.turn:";
    private static final long DISMISS_AFTER_MS = 4 * 60_000L;

    private static final List<JSObject> pendingActions = new ArrayList<>();
    private static volatile TurnActivityPlugin instance;

    private static final class TurnRecord {
        final String id;
        final String botId;
        final String botName;
        final String threadId;
        final String groupId;
        double startedAt;
        String phase;
        String step;
        int steps;
        String askKind;
        String askRequestId;
        String line;
        boolean ended;

        TurnRecord(String id, String botId, String botName, String threadId, String groupId, double startedAt) {
            this.id = id;
            this.botId = botId;
            this.botName = botName;
            this.threadId = threadId;
            this.groupId = groupId;
            this.startedAt = startedAt;
            this.phase = "working";
        }
    }

    private final Map<String, TurnRecord> active = new ConcurrentHashMap<>();

    static boolean isTurnNotification(StatusBarNotification sbn) {
        String tag = sbn.getTag();
        return tag != null && tag.startsWith(TAG_PREFIX);
    }

    static void handleIntent(Intent intent) {
        if (intent == null) return;
        String actionId = intent.getStringExtra(EXTRA_PHONE_ACTION);
        if (actionId == null || actionId.isEmpty()) return;
        intent.removeExtra(EXTRA_PHONE_ACTION);

        String threadId = intent.getStringExtra("threadId");
        String botId = intent.getStringExtra("botId");
        String groupId = intent.getStringExtra("groupId");
        String requestId = intent.getStringExtra("requestId");
        if (threadId == null || threadId.isEmpty()) return;

        JSObject data = new JSObject();
        data.put("threadId", threadId);
        if (botId != null && !botId.isEmpty()) data.put("botId", botId);
        if (groupId != null && !groupId.isEmpty()) data.put("groupId", groupId);
        if (requestId != null && !requestId.isEmpty()) data.put("requestId", requestId);

        JSObject payload = new JSObject();
        payload.put("actionId", actionId);
        payload.put("data", data);

        TurnActivityPlugin current = instance;
        if (current != null) {
            current.emitAction(payload);
        } else {
            synchronized (pendingActions) {
                pendingActions.add(payload);
            }
        }
    }

    @Override
    public void load() {
        instance = this;
        PhoneNotificationsPlugin.ensureChannels(getContext());
        List<JSObject> queued;
        synchronized (pendingActions) {
            queued = new ArrayList<>(pendingActions);
            pendingActions.clear();
        }
        for (JSObject action : queued) emitAction(action);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    private void emitAction(JSObject action) {
        notifyListeners("action", action, true);
    }

    @PluginMethod
    public void start(PluginCall call) {
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager == null || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !manager.areNotificationsEnabled())) {
            call.resolve(new JSObject());
            return;
        }
        JSObject attributes = call.getObject("attributes");
        JSObject state = call.getObject("state");
        if (attributes == null || state == null) {
            call.reject("attributes and state are required", "invalid");
            return;
        }
        String botId = attributes.getString("botId", "");
        String botName = attributes.getString("botName", "Bot");
        String threadId = attributes.getString("threadId", "");
        String groupId = attributes.getString("groupId");
        if (botId.isEmpty() || threadId.isEmpty()) {
            call.reject("botId and threadId are required", "invalid");
            return;
        }
        String id = "turn:" + threadId;
        double startedAt = state.optDouble("startedAt", System.currentTimeMillis() / 1000.0);
        TurnRecord record = new TurnRecord(id, botId, botName, threadId, groupId, startedAt);
        applyState(record, state);
        active.put(id, record);
        postNotification(record);

        JSObject result = new JSObject();
        result.put("id", id);
        call.resolve(result);
    }

    @PluginMethod
    public void update(PluginCall call) {
        String id = call.getString("id");
        JSObject state = call.getObject("state");
        TurnRecord record = id != null ? active.get(id) : null;
        if (record == null || state == null) {
            call.resolve();
            return;
        }
        applyState(record, state);
        postNotification(record);
        call.resolve();
    }

    @PluginMethod
    public void end(PluginCall call) {
        String id = call.getString("id");
        JSObject state = call.getObject("state");
        boolean now = Boolean.TRUE.equals(call.getBoolean("now", false));
        TurnRecord record = id != null ? active.remove(id) : null;
        if (record == null) {
            if (id != null && now) cancelNotification(id);
            call.resolve();
            return;
        }
        if (state != null) applyState(record, state);
        record.ended = true;
        if (now) {
            cancelNotification(record.id);
        } else {
            postNotification(record);
        }
        call.resolve();
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray list = new JSArray();
        for (TurnRecord record : active.values()) {
            if (record.ended) continue;
            JSObject item = new JSObject();
            item.put("id", record.id);
            item.put("botId", record.botId);
            item.put("threadId", record.threadId);
            item.put("startedAt", record.startedAt);
            list.put(item);
        }
        JSObject result = new JSObject();
        result.put("activities", list);
        call.resolve(result);
    }

    @PluginMethod
    public void lineKey(PluginCall call) {
        call.resolve(new JSObject());
    }

    private static void applyState(TurnRecord record, JSObject state) {
        record.phase = state.getString("phase", record.phase);
        record.step = state.getString("step");
        record.steps = state.getInteger("steps", record.steps) != null ? state.getInteger("steps", record.steps) : record.steps;
        record.startedAt = state.optDouble("startedAt", record.startedAt);
        record.line = state.getString("line");
        JSObject ask = state.getJSObject("ask");
        if (ask != null) {
            record.askKind = ask.getString("kind");
            record.askRequestId = ask.getString("requestId");
        } else {
            record.askKind = null;
            record.askRequestId = null;
        }
        record.ended = "done".equals(record.phase) || "stopped".equals(record.phase);
    }

    private void cancelNotification(String id) {
        NotificationManager manager = getContext().getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(TAG_PREFIX + id, id.hashCode());
    }

    private boolean previewsAllowed(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || manager == null) return true;
        NotificationChannel channel = manager.getNotificationChannel(PhoneNotificationsPlugin.CHANNEL_TURNS);
        return channel == null || channel.getLockscreenVisibility() != Notification.VISIBILITY_SECRET;
    }

    private void postNotification(TurnRecord record) {
        Context context = getContext();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        PhoneNotificationsPlugin.ensureChannels(context);

        boolean needsYou = "needs-you".equals(record.phase) && record.askRequestId != null;
        String channelId = needsYou ? PhoneNotificationsPlugin.CHANNEL_APPROVALS : PhoneNotificationsPlugin.CHANNEL_TURNS;
        String summary = summaryText(record, previewsAllowed(manager));

        PendingIntent openIntent = actionPendingIntent(context, record, null, 0);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setSmallIcon(context.getApplicationInfo().icon)
            .setContentTitle(record.botName)
            .setContentText(summary)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(summary))
            .setContentIntent(openIntent)
            .setWhen((long) (record.startedAt * 1000.0))
            .setShowWhen(true)
            .setUsesChronometer(!record.ended)
            .setOngoing(!record.ended)
            .setAutoCancel(record.ended)
            .setOnlyAlertOnce(!needsYou)
            .setCategory(needsYou ? NotificationCompat.CATEGORY_MESSAGE : NotificationCompat.CATEGORY_PROGRESS);

        if (record.ended) {
            builder.setTimeoutAfter(DISMISS_AFTER_MS);
        }

        // Android 16+ (API 36/37) Live Updates promotion for active turn notifications
        Bundle extras = new Bundle();
        extras.putString("threadId", record.threadId);
        extras.putString("botId", record.botId);
        if (!record.ended) {
            extras.putBoolean("android.requestPromotedOngoing", true);
        }
        builder.addExtras(extras);

        if (needsYou) {
            if ("approve".equals(record.askKind)) {
                builder.addAction(0, "Approve", actionPendingIntent(context, record, "dusk.approve", 1));
                builder.addAction(0, "Deny", actionPendingIntent(context, record, "dusk.deny", 2));
            } else {
                builder.addAction(0, "Answer", actionPendingIntent(context, record, "dusk.answer", 3));
            }
        }

        manager.notify(TAG_PREFIX + record.id, record.id.hashCode(), builder.build());
    }

    private static PendingIntent actionPendingIntent(Context context, TurnRecord record, String actionId, int slot) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("threadId", record.threadId);
        intent.putExtra("botId", record.botId);
        if (record.groupId != null) intent.putExtra("groupId", record.groupId);
        if (record.askRequestId != null) intent.putExtra("requestId", record.askRequestId);
        if (actionId != null) {
            intent.putExtra(EXTRA_PHONE_ACTION, actionId);
        } else {
            intent.putExtra(EXTRA_PHONE_ACTION, "dusk.answer");
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, (record.id.hashCode() * 31) + slot, intent, flags);
    }

    private static String summaryText(TurnRecord record, boolean showLine) {
        if ("done".equals(record.phase)) {
            if (showLine && record.line != null && !record.line.isEmpty()) return record.line;
            return record.steps > 0 ? "Done · " + stepCount(record.steps) : "Done";
        }
        if ("stopped".equals(record.phase)) {
            return record.steps > 0 ? "Stopped · " + stepCount(record.steps) : "Stopped";
        }
        if ("needs-you".equals(record.phase)) {
            return "approve".equals(record.askKind) ? "Waiting for your approval" : "Waiting for your answer";
        }
        String label = stepWord(record.step);
        return record.steps > 0 ? label + " · " + stepCount(record.steps) : label;
    }

    private static String stepWord(String step) {
        if (step == null) return "Working";
        switch (step) {
            case "write": return "Writing";
            case "edit": return "Editing";
            case "command": return "Running command";
            case "web": return "Browsing";
            case "read": return "Reading";
            case "fetch": return "Fetching";
            case "search": return "Searching";
            case "tool": return "Using tool";
            default: return "Working";
        }
    }

    private static String stepCount(int steps) {
        return steps == 1 ? "1 step" : steps + " steps";
    }
}
