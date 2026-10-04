package com.dlleni.agent;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * "On shift": the app keeps working with the screen off and the app closed.
 *
 * A foreground service (so Android lets it live, with its own quiet
 * notification) that asks the server every 15 seconds whether a lead is
 * waiting for this agent. A waiting lead rings, call-style, until it is
 * opened. It holds a partial wake lock while on shift, so the phone's CPU does
 * not doze between checks; switching "off shift" in the app stops all of it.
 */
public class WatchService extends Service {
    static final String ACTION_POLL_NOW = "com.dlleni.agent.POLL_NOW";
    private static final long POLL_MS = 15_000;
    private static final long RETRY_MS = 20_000;

    static volatile boolean running = false;

    private HandlerThread thread;
    private Handler handler;
    private PowerManager.WakeLock wakeLock;
    private final Set<String> followNotified = new HashSet<>();
    private final Runnable poll = this::poll;

    static void start(Context c) {
        if (!Prefs.shouldWatch(c)) return;
        Intent i = new Intent(c, WatchService.class);
        try {
            c.startForegroundService(i);
        } catch (RuntimeException notAllowedNow) {
            // Android refuses a background start on some paths; the next time
            // the app is opened starts it again.
        }
    }

    static void pollNow(Context c) {
        if (!running) {
            start(c);
            return;
        }
        try {
            c.startService(new Intent(c, WatchService.class).setAction(ACTION_POLL_NOW));
        } catch (RuntimeException ignored) {
            // Not allowed from the background; the regular poll is 15s away.
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, WatchService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Alerts.ensureChannels(this);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(Alerts.ID_SHIFT, Alerts.shift(this, status(null, 0)), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(Alerts.ID_SHIFT, Alerts.shift(this, status(null, 0)));
            }
        } catch (RuntimeException refused) {
            stopSelf();
            return;
        }
        running = true;
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dlleni:on-shift");
            wakeLock.setReferenceCounted(false);
        }
        thread = new HandlerThread("lead-watch");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(poll);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!Prefs.shouldWatch(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (handler != null && intent != null && ACTION_POLL_NOW.equals(intent.getAction())) {
            handler.removeCallbacks(poll);
            handler.post(poll);
        }
        return START_STICKY;
    }

    private void poll() {
        if (!Prefs.shouldWatch(this)) {
            stopSelf();
            return;
        }
        // Held across the gap to the next check, released if we stop.
        if (wakeLock != null) wakeLock.acquire(POLL_MS + 60_000);
        long next = POLL_MS;
        try {
            handle(Api.get(this, "/api/agent/inbox"));
        } catch (Api.Unauthorized u) {
            Prefs.clearSession(this);
            Alerts.signedOut(this);
            stopSelf();
            return;
        } catch (Exception offline) {
            update(status(arabic() ? "مفيش اتصال بالإنترنت، بيحاول تاني…" : "No connection, retrying…", 0));
            next = RETRY_MS;
        }
        if (handler != null) handler.postDelayed(poll, next);
    }

    private void handle(JSONObject j) throws Exception {
        JSONObject agent = j.optJSONObject("agent");
        if (agent != null && !agent.optBoolean("available", true)) {
            // Switched off shift somewhere else (the browser, another phone).
            Prefs.setAvailable(this, false);
            Alerts.stopRing(this);
            stopSelf();
            return;
        }

        long now = System.currentTimeMillis();
        JSONArray ring = j.optJSONArray("ring");
        int waiting = ring == null ? 0 : ring.length();

        // The lead that is ringing was opened somewhere else: stop.
        String ringing = Alerts.ringingLead;
        if (ringing != null && !"test".equals(ringing) && !contains(ring, ringing)) Alerts.stopRing(this);

        // Ring for the longest-waiting lead that is not snoozed and has not
        // rung in the last few minutes. One ring at a time; the others are
        // counted on it.
        if (ring != null) {
            for (int i = 0; i < ring.length(); i++) {
                JSONObject l = ring.getJSONObject(i);
                String id = l.getString("lead_id");
                Long snooze = Alerts.snoozedUntil.get(id);
                if (snooze != null && snooze > now) continue;
                if (id.equals(Alerts.ringingLead) && now - Alerts.ringingSince < Alerts.RING_MS) break;
                Long last = Alerts.lastRing.get(id);
                if (last != null && now - last < Alerts.RE_RING_MS) continue;
                Alerts.ring(this, new Alerts.Lead(id, l.optString("name", ""), l.optString("phone", ""),
                        l.optString("campaign", ""), answers(l.optJSONArray("answers"))), waiting - 1);
                break;
            }
        }

        // Follow-ups whose time has come: one reminder each.
        JSONArray due = j.optJSONArray("due");
        if (due != null) {
            for (int i = 0; i < due.length(); i++) {
                JSONObject l = due.getJSONObject(i);
                String key = l.optString("lead_id") + "@" + l.optString("follow_up_at");
                if (followNotified.add(key)) {
                    Alerts.followUp(this, l.optString("lead_id"), l.optString("name", ""), l.optString("phone", ""));
                }
            }
        }

        update(status(null, waiting));
    }

    private static boolean contains(JSONArray ring, String id) {
        if (ring == null) return false;
        for (int i = 0; i < ring.length(); i++) {
            if (id.equals(ring.optJSONObject(i) == null ? null : ring.optJSONObject(i).optString("lead_id"))) return true;
        }
        return false;
    }

    private static String answers(JSONArray a) {
        if (a == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < a.length(); i++) {
            JSONObject qa = a.optJSONObject(i);
            if (qa == null) continue;
            if (sb.length() > 0) sb.append('\n');
            sb.append(qa.optString("q")).append(": ").append(qa.optString("a"));
        }
        return sb.toString();
    }

    private boolean arabic() {
        return Alerts.arabic(this);
    }

    private String status(String problem, int waiting) {
        if (problem != null) return problem;
        String time = new SimpleDateFormat("h:mm a", Locale.US).format(new Date());
        if (waiting > 0) return arabic() ? "🔔 " + waiting + " ليد مستنية مكالمتك" : "🔔 " + waiting + " lead(s) waiting for your call";
        return arabic() ? "شغّال · آخر تحديث " + time : "Watching · last check " + time;
    }

    private void update(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(Alerts.ID_SHIFT, Alerts.shift(this, text));
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        scheduleRestart();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        // Killed while the agent is still on shift (memory, an OEM battery
        // manager): come back on our own.
        if (Prefs.shouldWatch(this)) scheduleRestart();
        super.onDestroy();
    }

    private void scheduleRestart() {
        if (!Prefs.shouldWatch(this)) return;
        AlarmManager am = getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent pi = PendingIntent.getForegroundService(this, 7, new Intent(this, WatchService.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 10_000, pi);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
