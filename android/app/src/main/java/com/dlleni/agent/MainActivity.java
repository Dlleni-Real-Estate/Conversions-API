package com.dlleni.agent;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * The app's one screen: the agent pages from the server, in a WebView, with a
 * bridge to the things only the phone can do - dial, ring, run on shift in the
 * background, and ask for the permissions all of that needs.
 *
 * The screens live on the server on purpose: a fix or a new field reaches
 * every agent the moment it is deployed, with no app update to chase.
 */
public class MainActivity extends Activity {
    private static final int REQ_PERMS = 1;
    private static final int REQ_CALL = 2;

    private WebView web;
    private View offline;
    private final Handler main = new Handler(Looper.getMainLooper());

    /** A call started from the app: when the agent comes back, ask how it went. */
    private String pendingCallLead = null;
    private long pendingCallAt = 0;
    private boolean pageFailed = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Alerts.ensureChannels(this);
        styleBars();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF1F5F9);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        offline = buildOffline();
        offline.setVisibility(View.GONE);
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " DlleniAgent/" + Prefs.version(this));
        web.addJavascriptInterface(new Bridge(), "DlleniApp");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new Client());

        handleIntent(getIntent(), true);
        if (Prefs.shouldWatch(this)) WatchService.start(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent, false);
    }

    /**
     * Where the app was opened from. A ring's "call" dials at once and opens
     * the lead; "open" just opens it. Either way the ring stops and the server
     * hears that the agent has it.
     */
    private void handleIntent(Intent intent, boolean firstLoad) {
        String action = intent == null ? null : intent.getStringExtra("action");
        String leadId = intent == null ? null : intent.getStringExtra("lead_id");
        String phone = intent == null ? null : intent.getStringExtra("phone");
        String base = Prefs.server(this) + "/agent";

        if (action == null || leadId == null || leadId.isEmpty()) {
            if (firstLoad) web.loadUrl(base);
            return;
        }
        Alerts.stopRing(this);
        boolean test = "test".equals(leadId);

        if ("call".equals(action)) {
            if (!test) {
                try {
                    Api.postAsync(this, "/api/agent/leads/" + Uri.encode(leadId), new JSONObject().put("action", "call").put("channel", "phone"));
                } catch (Exception ignored) {
                    // JSON put cannot fail for these values.
                }
                pendingCallLead = leadId;
                pendingCallAt = System.currentTimeMillis();
            }
            // after_call: the result sheet is already open when the agent
            // comes back from the dialer, even if the page was still loading.
            web.loadUrl(test ? base : base + "?lead=" + Uri.encode(leadId) + "&after_call=1");
            dial(phone, test);
        } else {
            if (!test) {
                try {
                    Api.postAsync(this, "/api/agent/leads/" + Uri.encode(leadId), new JSONObject().put("action", "open"));
                } catch (Exception ignored) {
                    // As above.
                }
            }
            web.loadUrl(test ? base : base + "?lead=" + Uri.encode(leadId));
        }
    }

    /** Straight to the customer's phone ringing when allowed; the dialer otherwise. */
    private void dial(String phone, boolean dialOnly) {
        if (phone == null || phone.isEmpty()) return;
        Uri uri = Uri.parse("tel:+" + phone.replaceAll("[^0-9]", ""));
        boolean direct = !dialOnly && checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED;
        try {
            startActivity(new Intent(direct ? Intent.ACTION_CALL : Intent.ACTION_DIAL, uri));
        } catch (ActivityNotFoundException | SecurityException e) {
            try {
                startActivity(new Intent(Intent.ACTION_DIAL, uri));
            } catch (ActivityNotFoundException ignored) {
                // A phone with no dialer: nothing to do.
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pendingCallLead != null && System.currentTimeMillis() - pendingCallAt > 2500) {
            String id = pendingCallLead;
            pendingCallLead = null;
            js("window.dlleniAfterCall && window.dlleniAfterCall(" + JSONObject.quote(id) + ")");
        } else {
            js("window.dlleniResume && window.dlleniResume()");
        }
        if (Prefs.shouldWatch(this)) WatchService.start(this);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.dlleniBack ? window.dlleniBack() : false", handled -> {
            if (!"true".equals(handled)) moveTaskToBack(true);
        });
    }

    private void js(String code) {
        if (web != null) web.evaluateJavascript(code, null);
    }

    private void styleBars() {
        Window w = getWindow();
        w.setStatusBarColor(Color.WHITE);
        w.setNavigationBarColor(Color.WHITE);
        w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }

    // ── Offline ──────────────────────────────────────────────────────────────

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private View buildOffline() {
        boolean ar = Alerts.arabic(MainActivity.this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER);
        col.setPadding(dp(32), dp(32), dp(32), dp(32));
        col.setBackgroundColor(0xFFF1F5F9);

        TextView icon = new TextView(this);
        icon.setText("📡");
        icon.setTextSize(TypedValue.COMPLEX_UNIT_SP, 48);
        icon.setGravity(Gravity.CENTER);
        col.addView(icon);

        TextView title = new TextView(this);
        title.setText(ar ? "مفيش اتصال بالإنترنت" : "No internet connection");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(0xFF0F172A);
        title.setGravity(Gravity.CENTER);
        col.addView(title);

        TextView sub = new TextView(this);
        sub.setText(ar ? "اتأكد من الواي فاي أو الداتا وجرّب تاني" : "Check Wi-Fi or mobile data and try again");
        sub.setTextColor(0xFF64748B);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, dp(6), 0, dp(20));
        col.addView(sub);

        Button retry = new Button(this);
        retry.setText(ar ? "حاول تاني" : "Try again");
        retry.setAllCaps(false);
        retry.setTextColor(Color.WHITE);
        retry.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(16));
        bg.setColor(0xFF4F46E5);
        retry.setBackground(bg);
        retry.setOnClickListener(v -> {
            pageFailed = false;
            web.reload();
        });
        col.addView(retry, new LinearLayout.LayoutParams(dp(200), dp(52)));
        return col;
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String scheme = u.getScheme() == null ? "" : u.getScheme();
            if (scheme.equals("tel")) {
                dial(u.getSchemeSpecificPart().replace("+", ""), false);
                return true;
            }
            Uri server = Uri.parse(Prefs.server(MainActivity.this));
            if ((scheme.equals("https") || scheme.equals("http")) && server.getHost() != null && server.getHost().equals(u.getHost())) {
                return false;
            }
            // Everything else - WhatsApp, the APK download, maps - opens outside.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException ignored) {
                // Nothing on the phone can open it.
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!pageFailed) offline.setVisibility(View.GONE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                pageFailed = true;
                offline.setVisibility(View.VISIBLE);
            }
        }
    }

    // ── Permissions ──────────────────────────────────────────────────────────

    private boolean notificationsOk() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        boolean granted = Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        return granted && nm != null && nm.areNotificationsEnabled();
    }

    private boolean fullScreenOk() {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = getSystemService(NotificationManager.class);
        return nm != null && nm.canUseFullScreenIntent();
    }

    private boolean batteryOk() {
        PowerManager pm = getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    private boolean callOk() {
        return checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED;
    }

    /** First sign-in: ask for the two runtime permissions in one go. */
    private void askEssentials() {
        java.util.List<String> want = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!callOk()) want.add(Manifest.permission.CALL_PHONE);
        if (!want.isEmpty()) requestPermissions(want.toArray(new String[0]), REQ_PERMS);
    }

    private void openSettings(String action, boolean withPackage) {
        try {
            Intent i = new Intent(action);
            if (withPackage) i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
        }
    }

    private void fix(String what) {
        switch (what) {
            case "notifications":
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                        && shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_PERMS);
                } else if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                        && !getSharedPreferences("dlleni_agent", MODE_PRIVATE).getBoolean("asked_notif", false)) {
                    getSharedPreferences("dlleni_agent", MODE_PRIVATE).edit().putBoolean("asked_notif", true).apply();
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_PERMS);
                } else {
                    Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    try {
                        startActivity(i);
                    } catch (Exception e) {
                        openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, true);
                    }
                }
                break;
            case "fullscreen":
                if (Build.VERSION.SDK_INT >= 34) openSettings(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, true);
                break;
            case "battery":
                openSettings(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, true);
                break;
            case "call":
                if (shouldShowRequestPermissionRationale(Manifest.permission.CALL_PHONE)
                        || !getSharedPreferences("dlleni_agent", MODE_PRIVATE).getBoolean("asked_call", false)) {
                    getSharedPreferences("dlleni_agent", MODE_PRIVATE).edit().putBoolean("asked_call", true).apply();
                    requestPermissions(new String[]{Manifest.permission.CALL_PHONE}, REQ_CALL);
                } else {
                    openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, true);
                }
                break;
            default:
                openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, true);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        js("window.dlleniResume && window.dlleniResume()");
        if (Prefs.shouldWatch(this)) WatchService.start(this);
    }

    // ── The bridge the agent pages call ─────────────────────────────────────

    private final class Bridge {
        @JavascriptInterface
        public String session() {
            try {
                return new JSONObject()
                        .put("token", Prefs.token(MainActivity.this))
                        .put("name", Prefs.agentName(MainActivity.this))
                        .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void login(String token, String agentJson) {
            String name = "";
            boolean available = true;
            try {
                JSONObject a = new JSONObject(agentJson);
                name = a.optString("name", "");
                available = a.optBoolean("available", true);
            } catch (Exception ignored) {
                // Name is cosmetic.
            }
            Prefs.setSession(MainActivity.this, token, name, available);
            main.post(() -> {
                askEssentials();
                WatchService.start(MainActivity.this);
            });
        }

        @JavascriptInterface
        public void logout() {
            Prefs.clearSession(MainActivity.this);
            main.post(() -> {
                Alerts.stopRing(MainActivity.this);
                WatchService.stop(MainActivity.this);
            });
        }

        @JavascriptInterface
        public void setAvailable(boolean on) {
            Prefs.setAvailable(MainActivity.this, on);
            main.post(() -> {
                if (on) WatchService.start(MainActivity.this);
                else {
                    Alerts.stopRing(MainActivity.this);
                    WatchService.stop(MainActivity.this);
                }
            });
        }

        @JavascriptInterface
        public void call(String leadId, String phone) {
            main.post(() -> {
                Alerts.stopRing(MainActivity.this);
                pendingCallLead = leadId;
                pendingCallAt = System.currentTimeMillis();
                dial(phone, false);
            });
        }

        @JavascriptInterface
        public void whatsapp(String phone) {
            main.post(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/" + phone.replaceAll("[^0-9]", ""))));
                } catch (ActivityNotFoundException ignored) {
                    // No browser and no WhatsApp.
                }
            });
        }

        @JavascriptInterface
        public void ack(String leadId) {
            if (leadId == null) return;
            main.post(() -> {
                if (leadId != null && leadId.equals(Alerts.ringingLead)) Alerts.stopRing(MainActivity.this);
                Alerts.lastRing.put(leadId, System.currentTimeMillis());
            });
        }

        @JavascriptInterface
        public String status() {
            try {
                return new JSONObject()
                        .put("version", Prefs.version(MainActivity.this))
                        .put("notifications", notificationsOk())
                        .put("fullScreen", fullScreenOk())
                        .put("battery", batteryOk())
                        .put("callPhone", callOk())
                        .put("watching", WatchService.running)
                        .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void fix(String what) {
            main.post(() -> MainActivity.this.fix(what == null ? "" : what));
        }

        /** The agent switched language in the app: the ring and notifications follow. */
        @JavascriptInterface
        public void setLang(String lang) {
            if (lang == null || lang.equals(Prefs.lang(MainActivity.this))) return;
            Prefs.setLang(MainActivity.this, lang);
            // Re-registering a channel renames it in the phone's settings.
            main.post(() -> Alerts.ensureChannels(MainActivity.this));
        }

        /** Five seconds to lock the phone, then a pretend lead rings. */
        @JavascriptInterface
        public void testRing() {
            boolean ar = Alerts.arabic(MainActivity.this);
            main.postDelayed(() -> Alerts.ring(MainActivity.this, new Alerts.Lead("test",
                    ar ? "عميل تجريبي" : "Test customer", "201000000000",
                    ar ? "اختبار الرنة" : "Ring test",
                    ar ? "الميزانية: ٥٠٠ ألف\nنوع الوحدة: شقة" : "Budget: 500k\nUnit: apartment"), 0), 5000);
        }
    }
}
