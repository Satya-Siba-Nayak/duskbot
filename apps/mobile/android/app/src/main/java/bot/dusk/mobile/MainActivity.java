package bot.dusk.mobile;

import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private boolean landscapeAllowed = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SpeechRecognizerPlugin.class);
        registerPlugin(OrientationPlugin.class);
        registerPlugin(PhoneNotificationsPlugin.class);
        registerPlugin(TurnActivityPlugin.class);
        registerPlugin(SseStreamPlugin.class);
        super.onCreate(savedInstanceState);

        OrientationPlugin.applyDefaultOrientation(this, landscapeAllowed);
        configureWindow();
        configureWebView();
        TurnActivityPlugin.handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        TurnActivityPlugin.handleIntent(intent);
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        OrientationPlugin.applyDefaultOrientation(this, landscapeAllowed);
        applyTextScale(newConfig);
    }

    void setLandscapeAllowed(boolean allowed) {
        if (this.landscapeAllowed == allowed) return;
        this.landscapeAllowed = allowed;
        OrientationPlugin.applyDefaultOrientation(this, allowed);
    }

    private void configureWindow() {
        Window window = getWindow();
        if (window == null) return;
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            window.setAttributes(attrs);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attrs = window.getAttributes();
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attrs);
        }
    }

    private void configureWebView() {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                if (webView.getRootSurfaceControl() != null) {
                    // match iOS CADisableMinimumFrameDurationOnPhone (120 Hz on high-refresh displays)
                    webView.setFrameContentVelocity(120f);
                }
            } catch ( Throwable ignored) {}
        }
        applyTextScale(getResources().getConfiguration());
    }

    /** Clamps the system font scale to 90%–135%, matching iOS Larger Text (src/mobile/text-scale.ts). */
    private void applyTextScale(Configuration config) {
        if (getBridge() == null || config == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        WebSettings settings = webView.getSettings();
        float scale = Float.isFinite(config.fontScale) && config.fontScale > 0f ? config.fontScale : 1.0f;
        int zoom = Math.max(90, Math.min(135, Math.round(scale * 100f)));
        settings.setTextZoom(zoom);
    }
}
