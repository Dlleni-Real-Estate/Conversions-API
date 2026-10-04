package com.dlleni.agent;

import android.Manifest;
import android.app.ActivityManager;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.PowerManager;

import org.json.JSONObject;

/**
 * Is this phone set up to ring? The same answers feed the app's setup screen
 * and, compacted, every background check - so the dashboard can show which
 * agent's phone will not ring before a lead is missed.
 */
final class Diag {
    private Diag() {}

    static boolean notificationsOk(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        boolean granted = Build.VERSION.SDK_INT < 33
                || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        return granted && nm != null && nm.areNotificationsEnabled();
    }

    static boolean fullScreenOk(Context c) {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        return nm != null && nm.canUseFullScreenIntent();
    }

    static boolean batteryOk(Context c) {
        PowerManager pm = c.getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
    }

    /** Settings > Battery > "Restricted": Android itself then stops the app in the background. */
    static boolean backgroundRestricted(Context c) {
        if (Build.VERSION.SDK_INT < 28) return false;
        ActivityManager am = c.getSystemService(ActivityManager.class);
        return am != null && am.isBackgroundRestricted();
    }

    static boolean exactAlarmsOk(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = c.getSystemService(AlarmManager.class);
        return am != null && am.canScheduleExactAlarms();
    }

    static boolean callOk(Context c) {
        return c.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED;
    }

    /** "na" when the phone has no such screen, else "opened" or "todo". */
    static String oemState(Context c, String what) {
        boolean exists = "autostart".equals(what) ? Oem.autostart(c) != null : Oem.popup(c) != null;
        if (!exists) return "na";
        return Prefs.opened(c, what) ? "opened" : "todo";
    }

    private static int alarmVolumePct(Context c) {
        AudioManager am = c.getSystemService(AudioManager.class);
        if (am == null) return -1;
        int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
        return max <= 0 ? -1 : Math.round(100f * am.getStreamVolume(AudioManager.STREAM_ALARM) / max);
    }

    /** Everything, for the app's setup screen. */
    static JSONObject status(Context c) throws Exception {
        return new JSONObject()
                .put("version", Prefs.version(c))
                .put("notifications", notificationsOk(c))
                .put("fullScreen", fullScreenOk(c))
                .put("battery", batteryOk(c))
                .put("background", !backgroundRestricted(c))
                .put("exactAlarms", exactAlarmsOk(c))
                .put("callPhone", callOk(c))
                .put("autostart", oemState(c, "autostart"))
                .put("popup", oemState(c, "popup"))
                .put("watching", WatchService.running)
                .put("lastCheck", Prefs.lastCheck(c))
                .put("lastError", Prefs.lastError(c))
                .put("maker", Build.MANUFACTURER)
                .put("model", Build.MODEL)
                .put("sdk", Build.VERSION.SDK_INT)
                .put("alarmVolume", alarmVolumePct(c));
    }

    private static String cached = null;
    private static long cachedAt = 0;

    /** Compact, for the x-device header. Recomputed at most once a minute. */
    static synchronized String header(Context c) {
        long now = System.currentTimeMillis();
        if (cached != null && now - cachedAt < 60_000) return cached;
        try {
            cached = new JSONObject()
                    .put("mk", Build.MANUFACTURER)
                    .put("md", Build.MODEL)
                    .put("sdk", Build.VERSION.SDK_INT)
                    .put("v", Prefs.version(c))
                    .put("n", notificationsOk(c))
                    .put("fs", fullScreenOk(c))
                    .put("bat", batteryOk(c))
                    .put("bg", !backgroundRestricted(c))
                    .put("ex", exactAlarmsOk(c))
                    .put("as", oemState(c, "autostart"))
                    .put("pu", oemState(c, "popup"))
                    .put("av", alarmVolumePct(c))
                    .toString();
        } catch (Exception e) {
            cached = "{}";
        }
        cachedAt = now;
        return cached;
    }
}
