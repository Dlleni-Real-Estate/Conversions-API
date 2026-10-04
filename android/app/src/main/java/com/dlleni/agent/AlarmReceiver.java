package com.dlleni.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Where the phone's alarms land (see {@link Reminders}). Android lets an app
 * woken by an exact alarm start its foreground service even from the
 * background, so this is the path that works after the app was closed.
 */
public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null || !Prefs.signedIn(context)) return;

        switch (action) {
            case Reminders.ACTION_WATCHDOG:
                // Only fires when the 15-second checks stopped: bring them back.
                if (Prefs.shouldWatch(context)) {
                    WatchService.start(context);
                    Reminders.armWatchdog(context);
                }
                break;

            case Reminders.ACTION_CALLBACK: {
                Alerts.Lead lead = Alerts.Lead.fromExtras(intent);
                if (Prefs.shouldWatch(context)) {
                    WatchService.deliver(context, lead.toExtras(new Intent(context, WatchService.class)
                            .setAction(WatchService.ACTION_CALLBACK)));
                } else {
                    // Off shift: a reminder, not a ring. Then set the next one.
                    Alerts.followUp(context, lead);
                    PendingResult result = goAsync();
                    Reminders.refreshAsync(context, result::finish);
                }
                break;
            }

            case Reminders.ACTION_TEST:
                WatchService.deliver(context, new Intent(context, WatchService.class).setAction(WatchService.ACTION_TEST_RING));
                break;

            default:
                break;
        }
    }
}
