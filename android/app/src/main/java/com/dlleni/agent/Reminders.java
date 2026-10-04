package com.dlleni.agent;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The phone's own alarms, which fire even when the app has been closed or
 * killed - the one thing Android and the phone makers reliably wake an app for.
 *
 *   watchdog   five minutes out, pushed forward by every successful check.
 *              It only fires if the checks stopped (the app was killed), and
 *              brings the on-shift service back.
 *   callback   the next follow-up time the agent picked. It rings at that
 *              minute even if nothing else is running.
 *   test       "close the app and lock the phone": proves the whole chain.
 */
final class Reminders {
    static final String ACTION_WATCHDOG = "com.dlleni.agent.WATCHDOG";
    static final String ACTION_CALLBACK = "com.dlleni.agent.CALLBACK_DUE";
    static final String ACTION_TEST = "com.dlleni.agent.TEST_RING";

    static final long WATCHDOG_MS = 5 * 60_000;

    private static final int REQ_WATCHDOG = 41;
    private static final int REQ_CALLBACK = 42;
    private static final int REQ_TEST = 43;

    /** The callback the alarm is set for, so a poll every 15s does not reset it every time. */
    private static volatile String scheduledKey = null;

    private Reminders() {}

    private static PendingIntent pending(Context c, String action, int req, Intent extras) {
        Intent i = (extras != null ? extras : new Intent()).setClass(c, AlarmReceiver.class).setAction(action);
        return PendingIntent.getBroadcast(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static AlarmManager am(Context c) {
        return c.getSystemService(AlarmManager.class);
    }

    /** Exact and allowed in Doze where permitted; the closest thing otherwise. */
    private static void setExact(Context c, long atMs, PendingIntent pi) {
        AlarmManager am = am(c);
        if (am == null) return;
        try {
            if (Diag.exactAlarmsOk(c)) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                return;
            }
        } catch (SecurityException revoked) {
            // Fall through to the inexact alarm.
        }
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
    }

    static void armWatchdog(Context c) {
        setExact(c, System.currentTimeMillis() + WATCHDOG_MS, pending(c, ACTION_WATCHDOG, REQ_WATCHDOG, null));
    }

    /**
     * The next callback, as an alarm clock: the most reliable alarm Android
     * has - never delayed by Doze, and kept by phone makers that clear others.
     */
    static void scheduleCallback(Context c, Alerts.Lead lead) {
        AlarmManager am = am(c);
        if (am == null) return;
        if (lead == null || lead.atMs <= 0) {
            if (scheduledKey != null || lead == null) am.cancel(pending(c, ACTION_CALLBACK, REQ_CALLBACK, null));
            scheduledKey = null;
            return;
        }
        if (lead.key().equals(scheduledKey)) return;
        PendingIntent pi = pending(c, ACTION_CALLBACK, REQ_CALLBACK, lead.toExtras(new Intent()));
        try {
            if (Diag.exactAlarmsOk(c)) {
                Intent show = Alerts.mainIntent(c, "open", lead);
                PendingIntent showPi = PendingIntent.getActivity(c, REQ_CALLBACK, show,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(lead.atMs, showPi), pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, lead.atMs, pi);
            }
            scheduledKey = lead.key();
        } catch (SecurityException revoked) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, lead.atMs, pi);
            scheduledKey = lead.key();
        }
    }

    /** From an inbox response: the soonest upcoming callback gets the alarm. */
    static void applyUpcoming(Context c, JSONArray upcoming) {
        JSONObject next = upcoming == null || upcoming.length() == 0 ? null : upcoming.optJSONObject(0);
        scheduleCallback(c, next == null ? null : Alerts.Lead.callback(c, next));
    }

    static void scheduleTest(Context c, long delayMs) {
        setExact(c, System.currentTimeMillis() + delayMs, pending(c, ACTION_TEST, REQ_TEST, null));
    }

    static void cancelAll(Context c) {
        AlarmManager am = am(c);
        if (am == null) return;
        am.cancel(pending(c, ACTION_WATCHDOG, REQ_WATCHDOG, null));
        am.cancel(pending(c, ACTION_CALLBACK, REQ_CALLBACK, null));
        am.cancel(pending(c, ACTION_TEST, REQ_TEST, null));
        scheduledKey = null;
    }

    /**
     * Off shift there is no service polling, but callbacks still need their
     * alarm: ask the server once, in the background, and set it.
     */
    static void refreshAsync(Context c, Runnable done) {
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                if (Prefs.signedIn(app)) applyUpcoming(app, Api.get(app, "/api/agent/inbox").optJSONArray("upcoming"));
            } catch (Api.Unauthorized u) {
                Prefs.clearSession(app);
                cancelAll(app);
            } catch (Exception offline) {
                // The next app open or check sets it.
            } finally {
                if (done != null) done.run();
            }
        }, "reminders").start();
    }
}
