package bot.dusk.mobile;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DuskOrientation")
public class OrientationPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());

    /** Android 17 (API 37) ignores orientation locks on large screens (sw >= 600dp); compact phones stay portrait
     * except while the remote screen viewer asks for landscape. */
    static void applyDefaultOrientation(Activity activity, boolean landscapeAllowed) {
        if (activity == null) return;
        Configuration config = activity.getResources().getConfiguration();
        boolean largeScreen = config.smallestScreenWidthDp >= 600;
        if (landscapeAllowed) {
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_USER);
        } else if (largeScreen) {
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        } else {
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        }
    }

    @PluginMethod
    public void allowLandscape(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        main.post(() -> {
            Activity activity = getActivity();
            if (activity instanceof MainActivity) {
                ((MainActivity) activity).setLandscapeAllowed(on);
            } else {
                applyDefaultOrientation(activity, on);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void rotate(PluginCall call) {
        boolean landscape = "landscape".equals(call.getString("to"));
        main.post(() -> {
            Activity activity = getActivity();
            if (activity instanceof MainActivity) {
                MainActivity host = (MainActivity) activity;
                if (landscape) host.setLandscapeAllowed(true);
                host.setRequestedOrientation(
                    landscape ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                );
            }
            call.resolve();
        });
    }
}
