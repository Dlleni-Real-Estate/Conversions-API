package com.dlleni.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * A restarted phone, or an updated app, goes straight back on shift. A reboot
 * also wipes every alarm, so the next callback's alarm is set again.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Alerts.ensureChannels(context);
        if (Prefs.shouldWatch(context)) {
            WatchService.start(context);
            Reminders.armWatchdog(context);
        } else if (Prefs.signedIn(context)) {
            PendingResult result = goAsync();
            Reminders.refreshAsync(context, result::finish);
        }
    }
}
