export function n8nConfig(env = process.env) {
  return {
    calendarWebhook: env.N8N_CALENDAR_WEBHOOK_URL || '',
    emailAssistantWebhook: env.N8N_EMAIL_ASSISTANT_WEBHOOK_URL || '',
    crmWebhookSecret: env.N8N_CRM_WEBHOOK_SECRET || '',
    crmSecretHeader: env.N8N_CRM_SECRET_HEADER || 'x-webhook-secret',
  };
}
