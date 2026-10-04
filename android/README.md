# Dlleni Agent — Android app

The app agents keep on their phones. When a lead from a routed campaign is
handed to them, the phone **rings like an incoming call**, even when it is locked. One tap
dials the customer, and when the call ends the app asks what happened.

## How it is built

A thin native shell around the agent pages served at `/agent`:

| Native (this folder) | Web (`components/agent/AgentApp.tsx`) |
|---|---|
| Ringing: call-style notification + full-screen screen over the lock screen, sound played by the app | Lead list, lead page, form answers, timeline |
| "On shift" foreground service that checks for leads and callbacks every 15 s | The after-call result sheet, callback time and notes |
| Alarms that work with the app closed: callbacks, watchdog, ring test | Sign in, on-shift switch, phone setup screen |
| Dialling directly, WhatsApp, permissions, boot restart, phone-maker screens | |

The screens live on the server, so a change to them reaches every agent on the next
deploy, with no app update. The native part changes rarely. It is plain Java with **no
dependencies**, so it builds anywhere the Android SDK is installed.

```
MainActivity         WebView + the JS bridge (window.DlleniApp)
WatchService         on shift: polls /api/agent/inbox, picks what rings
Alerts               ring / waiting / follow-up / on-shift notifications
Ringer               the ring's sound (phone ringtone, alarm stream) and vibration
Reminders            exact alarms: next callback, watchdog, ring test
AlarmReceiver        where those alarms land; starts the service
IncomingLeadActivity full-screen ring over the lock screen
BootReceiver         back on shift after a reboot or an app update
ActionReceiver       "Later" / "In 10 min" on the ring
Oem                  phone makers' autostart and pop-up screens
Diag                 is this phone set up to ring? (setup screen + x-device header)
Api, Prefs           HTTP and stored session
```

## What rings, and when

| What | Rings | Again | Stops |
|---|---|---|---|
| A new lead handed to the agent | within 15 s of routing | every 3 min while unopened ("Later" = 5 min) | opened, called, or moved to another agent |
| A callback ("no answer, try in 30 min") | at that minute, even with the app closed | every 5 min, 3 times at most ("In 10 min" moves it) | called, snoozed, or a new time saved |

A ring lasts a minute, then waits silently in the shade. The sound is the phone's
ringtone played by the app on the **alarm** stream, not the notification's sound: many
phones mute new apps' notifications, which is what turned the first builds' ring into a
silent buzz. A low alarm volume is raised for the minute and put back after; during a
real phone call it stays quiet and resumes when the call ends; a volume key silences it.

## Surviving "the app is closed"

On shift the foreground service keeps the app alive. When a phone kills it anyway
(swiped from recents on Xiaomi, Oppo, Realme, Vivo, Infinix, Tecno, Huawei):

1. swiping it away schedules a restart in a few seconds;
2. a watchdog alarm, pushed five minutes ahead by every successful check, fires only if
   the checks stopped, and restarts the service;
3. the next callback's alarm is an alarm clock, which those phones still deliver.

What no code can do is switch off a maker's own killer: that is the **Autostart**
step in the app's phone setup screen, which opens the right screen for the phone.
Every check also reports the phone's setup (`x-device`), shown in the dashboard's
Agents tab next to the agent.

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

The app opens on **Phone setup** until it is done, and lists only the steps this phone has:

1. Allow notifications.
2. Android 14+: allow **full-screen notifications**, so the ring takes over a locked screen.
3. Battery: no restrictions, so it keeps checking while the phone sleeps.
4. Background activity, if Android has the app on "Restricted".
5. Xiaomi / Oppo / Realme / Vivo / Huawei / Honor / Infinix / Tecno / OnePlus: **Autostart**.
6. Xiaomi: show on lock screen and pop up from the background.
7. Alarms & reminders, so callbacks ring on the minute.
8. Optional: phone calls, so "Call" dials directly instead of opening the dialer.

**Test the ring** sets an alarm 15 seconds out: close the app completely, lock the
phone, and it must ring. That proves the whole path the real ring takes.
