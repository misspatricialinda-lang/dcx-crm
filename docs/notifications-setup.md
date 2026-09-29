# Email notifications

The CRM shows one alert for each newly synced incoming email. Repeated syncs do not create duplicates because `crm_notifications.message_id` is unique. Historical email imports older than 24 hours stay in the email timeline without generating a burst of alerts.

## Enable the feed

1. Run `supabase/migrations/202609270002_email_notifications.sql` once in the same Supabase project used by the CRM.
   Also run `supabase/migrations/202609290001_push_delivery_tracking.sql` for per-device push delivery tracking.
2. Deploy the updated app. The notification page and unread badge then work for signed-in owners. No change to the n8n workflows is needed.

## Enable phone alerts

1. Generate a VAPID key pair with `npx web-push generate-vapid-keys`. Set `WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PRIVATE_KEY` in the deployed app's server environment. Do not prefix either variable with `VITE_`.
2. Generate a separate random token of at least 32 characters and set it as `PUSH_DISPATCH_TOKEN` in the deployed app's server environment. Redeploy.
3. In Supabase Database Webhooks, create a webhook for `INSERT` on `public.crm_notifications`. Use `https://YOUR-CRM-DOMAIN/api/notifications?action=dispatch` as the URL, method `POST`, and HTTP header `Authorization: Bearer YOUR_PUSH_DISPATCH_TOKEN`. This invokes the dispatcher after an incoming message has been saved.
   Schedule a POST to the same URL every few minutes with the same header to retry transient push failures and catch missed webhooks. Push attempts stop for notifications older than 24 hours.
4. Open the deployed CRM on the phone, go to **Notifications**, and tap **Enable phone alerts**. On iPhone, first add the CRM to the Home Screen and open it from that icon.

Push requires HTTPS on the deployed site. The local development server can show the notification feed, but phone alerts should be enrolled from the deployed site. The app checks for new feed items every 30 seconds while it is open. Phone push is delivered by the webhook when the app is closed.

To verify, send a new email to the tracked mailbox and wait for its normal sync. Confirm that it appears once in Notifications. Then confirm the phone alert arrives, and tapping it opens the Notifications page. The existing email timeline remains the place to read the full conversation.
