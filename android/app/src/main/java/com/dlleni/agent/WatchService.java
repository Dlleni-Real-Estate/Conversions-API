package com.dlleni.agent;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
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
 * notification) that asks the server every 15 seconds what should ring: new
 * leads nobody opened yet, and callbacks whose time has come. It holds a
 * partial wake lock while on shift, so the phone's CPU does not doze between
 * checks; switching "off shift" in the app stops all of it.
 *
 * If a phone maker kills it anyway, three things bring it back: a restart
 * alarm when the app is swiped away, the watchdog alarm (see Reminders), and
 * the next time the app is opened.
 */
public class WatchService extends Service {
    static final String ACTION_POLL_NOW = "com.dlleni.agent.POLL_NOW";
    static final String ACTION_CALLBACK = "com.dlleni.agent.RING_CALLBACK";
    static final String ACTION_TEST_RING = "com.dlleni.agent.RING_TEST";
    private static final long POLL_MS = 15_000;
    private static final long RETRY_MS = 20_000;

    static volatile boolean running = false;

    private HandlerThread thread;
    private Handler handler;
    private PowerManager.WakeLock wakeLock;
    private ConnectivityManager.NetworkCallback netCallback;
    private volatile boolean offline = false;
    private volatile boolean testing = false;
    private final Runnable poll = this::poll;

    static void start(Context c) {
        if (!Prefs.shouldWatch(c)) return;
        deliver(c, new Intent(c, WatchService.class));
    }

    /** Start (or wake) the service with an instruction. */
    static void deliver(Context c, Intent i) {
        try {
            c.startForegroundService(i);
        } catch (RuntimeException notAllowedNow) {
            // Android refuses a background start on some paths; the watchdog
            // alarm or the next app open starts it again.
        }
    }

    static void pollNow(Context c) {
        deliver(c, new Intent(c, WatchService.class).setAction(ACTION_POLL_NOW));
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, WatchService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Alerts.ensureChannels(this);
        if (!goForeground()) {
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
        listenForNetwork();
        // Off shift the service only ever runs for a test ring.
        if (Prefs.shouldWatch(this)) handler.post(poll);
    }

    private boolean goForeground() {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(Alerts.ID_SHIFT, Alerts.shift(this, status(null, 0, 0)), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(Alerts.ID_SHIFT, Alerts.shift(this, status(null, 0, 0)));
            }
            return true;
        } catch (RuntimeException refused) {
            return false;
        }
    }

    /** Back online after a gap: check at once instead of waiting out the retry. */
    private void listenForNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        if (cm == null) return;
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                if (offline && handler != null) {
                    handler.removeCallbacks(poll);
                    handler.postDelayed(poll, 1500);
                }
            }
        };
        try {
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (RuntimeException ignored) {
            netCallback = null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        // Every start must be answered with startForeground, or Android ends the app.
        goForeground();
        if (handler == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_TEST_RING.equals(action)) {
            testing = true;
            handler.post(this::ringTest);
            return Prefs.shouldWatch(this) ? START_STICKY : START_NOT_STICKY;
        }
        if (!Prefs.shouldWatch(this)) {
            if (!testing) stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_CALLBACK.equals(action) && intent != null) {
            Alerts.Lead lead = Alerts.Lead.fromExtras(intent);
            handler.post(() -> ringCallback(lead));
        } else if (ACTION_POLL_NOW.equals(action)) {
            handler.removeCallbacks(poll);
            handler.post(poll);
        }
        return START_STICKY;
    }

    private void poll() {
        if (!Prefs.shouldWatch(this)) {
            if (!testing) stopSelf();
            return;
        }
        // Held across the gap to the next check, released if we stop.
        if (wakeLock != null) wakeLock.acquire(POLL_MS + 60_000);
        long next = POLL_MS;
        try {
            JSONObject inbox = Api.get(this, "/api/agent/inbox");
            offline = false;
            Prefs.markCheck(this, null);
            handle(inbox);
        } catch (Api.Unauthorized u) {
            Prefs.clearSession(this);
            Reminders.cancelAll(this);
            Alerts.signedOut(this);
            stopSelf();
            return;
        } catch (Exception e) {
            offline = true;
            Prefs.markCheck(this, String.valueOf(e.getMessage()));
            update(status(arabic() ? "مفيش اتصال بالإنترنت، بيحاول تاني…" : "No connection, retrying…", 0, 0));
            next = RETRY_MS;
        }
        // Pushed five minutes ahead on every check: it only fires if the
        // checks stop, i.e. if this service was killed.
        Reminders.armWatchdog(this);
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
        JSONArray due = j.optJSONArray("due");
        int waitingNew = ring == null ? 0 : ring.length();
        int waitingCallbacks = due == null ? 0 : due.length();

        Alerts.Lead[] fresh = new Alerts.Lead[waitingNew];
        Alerts.Lead[] callbacks = new Alerts.Lead[waitingCallbacks];
        Set<String> live = new HashSet<>();
        for (int i = 0; i < waitingNew; i++) {
            JSONObject l = ring.getJSONObject(i);
            fresh[i] = new Alerts.Lead(l.getString("lead_id"), l.optString("name", ""), l.optString("phone", ""),
                    l.optString("campaign", ""), answers(l.optJSONArray("answers")), Alerts.Lead.NEW,
                    l.optLong("assigned_ms", 0), "");
            live.add(fresh[i].key());
        }
        for (int i = 0; i < waitingCallbacks; i++) {
            callbacks[i] = Alerts.Lead.callback(this, due.getJSONObject(i));
            live.add(callbacks[i].key());
        }

        // What is up on the phone was dealt with somewhere else (opened, called,
        // snoozed on another phone, or handed to another agent): take it down.
        Alerts.Lead shown = Alerts.current;
        if (shown != null && !shown.isTest() && !live.contains(shown.key())) Alerts.stopRing(this);
        shown = Alerts.current;
        String ringingKey = Ringer.isRinging() && shown != null ? shown.key() : null;

        // The next thing to ring: a new lead first - speed to lead - then a
        // callback. Snoozed ones wait; one that just rang waits its turn.
        Alerts.Lead pick = null;
        for (Alerts.Lead l : fresh) {
            if (l.key().equals(ringingKey) || snoozed(l, now)) continue;
            Long last = Alerts.lastRing.get(l.key());
            if (last != null && now - last < Alerts.RE_RING_MS) continue;
            pick = l;
            break;
        }
        if (pick == null) {
            for (Alerts.Lead l : callbacks) {
                if (l.key().equals(ringingKey) || snoozed(l, now)) continue;
                Integer rang = Alerts.rounds.get(l.key());
                if (rang != null && rang >= Alerts.CALLBACK_ROUNDS) continue;
                Long last = Alerts.lastRing.get(l.key());
                if (last != null && now - last < Alerts.CALLBACK_RE_RING_MS) continue;
                pick = l;
                break;
            }
        }
        if (pick != null) {
            boolean busy = ringingKey != null;
            // A new lead interrupts a callback or a test ring; nothing else
            // interrupts - the next one rings when this minute is up.
            boolean interrupt = busy && !pick.isCallback() && shown != null && (shown.isCallback() || shown.isTest());
            if (!busy || interrupt) Alerts.ring(this, pick, pick.isCallback() ? 0 : waitingNew - 1);
        }

        Reminders.applyUpcoming(this, j.optJSONArray("upcoming"));
        update(status(null, waitingNew, waitingCallbacks));
    }

    private static boolean snoozed(Alerts.Lead l, long now) {
        Long until = Alerts.snoozedUntil.get(l.key());
        return until != null && until > now;
    }

    /** The callback alarm fired: ring at once, then let a check confirm it is still due. */
    private void ringCallback(Alerts.Lead lead) {
        long now = System.currentTimeMillis();
        Integer rang = Alerts.rounds.get(lead.key());
        boolean rangOut = rang != null && rang >= Alerts.CALLBACK_ROUNDS;
        Alerts.Lead shown = Alerts.current;
        boolean newLeadRinging = Ringer.isRinging() && shown != null && !shown.isCallback() && !shown.isTest();
        boolean alreadyRinging = Ringer.isRinging() && shown != null && shown.key().equals(lead.key());
        if (!snoozed(lead, now) && !rangOut && !newLeadRinging && !alreadyRinging) Alerts.ring(this, lead, 0);
        handler.removeCallbacks(poll);
        handler.postDelayed(poll, 3000);
    }

    private void ringTest() {
        boolean ar = arabic();
        Alerts.ring(this, new Alerts.Lead("test",
                ar ? "عميل تجريبي" : "Test customer", "201000000000",
                ar ? "اختبار الرنة" : "Ring test",
                ar ? "الميزانية: ٥٠٠ ألف\nنوع الوحدة: شقة" : "Budget: 500k\nUnit: apartment",
                Alerts.Lead.TEST, System.currentTimeMillis(), ""), 0);
        handler.postDelayed(() -> {
            testing = false;
            if (!Prefs.shouldWatch(this)) stopSelf();
        }, Alerts.RING_MS + 2000);
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

    private String status(String problem, int waitingNew, int callbacks) {
        if (problem != null) return problem;
        boolean ar = arabic();
        if (waitingNew > 0) return ar ? "🔔 " + waitingNew + " ليد مستنية مكالمتك" : "🔔 " + waitingNew + " lead(s) waiting for your call";
        if (callbacks > 0) return ar ? "⏰ " + callbacks + " معاد مكالمة جه وقته" : "⏰ " + callbacks + " callback(s) due";
        String time = new SimpleDateFormat("h:mm a", Locale.US).format(new Date());
        return ar ? "شغّال · آخر تحديث " + time : "Watching · last check " + time;
    }

    private void update(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(Alerts.ID_SHIFT, Alerts.shift(this, text));
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        // Swiped away from recents. Some phones kill the whole app right after.
        scheduleRestart();
        Reminders.armWatchdog(this);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (netCallback != null) {
            ConnectivityManager cm = getSystemService(ConnectivityManager.class);
            try {
                if (cm != null) cm.unregisterNetworkCallback(netCallback);
            } catch (RuntimeException ignored) {
                // Already gone.
            }
        }
        if (Prefs.shouldWatch(this)) {
            // Killed while the agent is still on shift (memory, an OEM battery
            // manager): come back on our own.
            scheduleRestart();
        } else {
            Alerts.stopRing(this);
        }
        super.onDestroy();
    }

    private void scheduleRestart() {
        if (!Prefs.shouldWatch(this)) return;
        AlarmManager am = getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent pi = PendingIntent.getForegroundService(this, 7, new Intent(this, WatchService.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            if (Diag.exactAlarmsOk(this)) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 5_000, pi);
                return;
            }
        } catch (SecurityException ignored) {
            // Inexact below.
        }
        am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 10_000, pi);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
