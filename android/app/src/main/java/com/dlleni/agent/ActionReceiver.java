package com.dlleni.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * "Later" / Decline on the ring notification.
 *   new lead   quiet for five minutes, then it rings again
 *   callback   moved ten minutes, on the server too
 */
public class ActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (intent.getStringExtra("lead_id") == null) {
            Alerts.stopRing(context);
            return;
        }
        Alerts.Lead lead = Alerts.Lead.fromExtras(intent);
        if (Alerts.ACTION_SNOOZE_CALLBACK.equals(action)) Alerts.snoozeCallback(context, lead);
        else if (Alerts.ACTION_SNOOZE.equals(action)) Alerts.snooze(context, lead);
    }
}
