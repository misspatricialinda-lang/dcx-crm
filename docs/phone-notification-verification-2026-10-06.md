# Phone notification verification, 6 October 2026

Two mobile browser checks passed at a 390px viewport: notification feed/navigation and the main work areas. Two service-worker checks passed: an alert displays with no open windows, tapping it opens the CRM, and malformed payloads produce a safe fallback. These checks simulate delivery and do not prove receipt on a physical phone.

Read-only database checks found one saved push subscription and eight notification records. VAPID keys are configured locally. The missing local PUSH_DISPATCH_TOKEN was generated and added to the ignored .env without printing its value; Vite restarted successfully. No real push was sent.

Remaining prerequisites for a real closed-browser phone test: a reachable HTTPS deployment with the same server configuration, a verified notification-insert webhook and retry dispatcher, and enrolling the intended phone on that deployment. Open Notifications and enable phone alerts. On iPhone use the installed Home Screen app. Close the CRM, sync a new test email, confirm the phone receives one alert and that tapping it opens the conversation. A browser force-stop or disabled OS notifications can prevent delivery.

The dashboard now combines relationship and purpose controls with contact activity, compact summary cards and search/status/classification/date filters. The requested explanatory text and three configuration sections, standalone recent contact activity, and recent workspace activity were removed from the dashboard. Contact totals are sampled message totals per sender, not per-conversation totals. Build and rendered purpose/review filter checks passed.
