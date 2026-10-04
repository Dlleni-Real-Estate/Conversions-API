package com.dlleni.agent;

import android.app.Application;

public class App extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Alerts.ensureChannels(this);
    }
}
