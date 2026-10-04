package com.dlleni.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** A restarted phone, or an updated app, goes straight back on shift. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Prefs.shouldWatch(context)) WatchService.start(context);
    }
}
