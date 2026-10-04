# Dlleni Agent — Android app

The app agents keep on their phones. When a lead from a routed campaign is
handed to them, the phone **rings like an incoming call**, even when it is locked. One tap
dials the customer, and when the call ends the app asks what happened.

## How it is built

A thin native shell around the agent pages served at `/agent`:

| Native (this folder) | Web (`components/agent/AgentApp.tsx`) |
|---|---|
| Ringing: insistent notification + full-screen screen over the lock screen | Lead list, lead page, form answers, timeline |
| "On shift" foreground service that checks for leads every 15 s | The after-call result sheet and notes |
| Dialling directly, WhatsApp, permissions, boot restart | Sign in, on-shift switch, setup checklist |

The screens live on the server, so a change to them reaches every agent on the next
deploy, with no app update. The native part changes rarely. It is plain Java with **no
dependencies**, so it builds anywhere the Android SDK is installed.

```
MainActivity         WebView + the JS bridge (window.DlleniApp)
WatchService         on shift: polls /api/agent/inbox, rings, reminds
Alerts               ring / follow-up / on-shift notifications
IncomingLeadActivity full-screen ring over the lock screen
BootReceiver         back on shift after a reboot or an app update
ActionReceiver       "Later" on the ring
Api, Prefs           HTTP and stored session
```

## Language

English by default, Arabic one tap away: the **ع / EN** button on the lead list, the
login screen and Settings. The choice is passed to the native shell (`setLang`), so the
ring, its notifications and the on-shift notice follow it too. Lead data (names, form
answers) is never translated.

## Getting the APK

Every push that touches `android/` runs `.github/workflows/android.yml`, which builds
the APK and publishes it as the latest GitHub release. The download link never
changes:

```
https://github.com/Dlleni-Real-Estate/Conversions-API/releases/latest/download/dlleni-agent.apk
```

It is also linked from the dashboard's **Agents & routing** tab.

## Signing: do this once before rolling out

Android only installs an update over an app signed with the **same key**. Until the
repository has a key, each build is signed with a throwaway one, and installing a newer
build means uninstalling the old one first. To fix that for good:

```bash
keytool -genkeypair -v -keystore dlleni-agent.jks -alias dlleni -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 dlleni-agent.jks    # copy the output
```

Then in GitHub, under **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | the base64 output |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `dlleni` |
| `ANDROID_KEY_PASSWORD` | the key password |

Keep the `.jks` file safe. Losing it means every agent reinstalls once.

## Building locally

```bash
cd android
gradle assembleRelease      # Gradle 8.10+, JDK 17, Android SDK 34
```

## Phone setup (shown in the app under Settings)

1. Allow notifications.
2. Android 14+: allow **full-screen notifications**, so the ring takes over a locked screen.
3. Turn off battery optimisation for the app, so it keeps checking while the phone sleeps.
4. Allow phone calls, so "Call" dials directly instead of opening the dialer.
5. Xiaomi / Oppo / Realme / Vivo: also enable **Autostart** in the app's settings.

The **Test the ring** button rings the phone five seconds after it is tapped, so the
whole setup can be checked with the screen locked.
