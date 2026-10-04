export function memoryAddresses(messages, mailbox) {
  const owner = String(mailbox || '').trim().toLowerCase();
  if (!owner.includes('@')) return [];
  const latest = [...messages].reverse().find(m => !m.isDraft && m.from?.emailAddress?.address?.toLowerCase() !== owner);
  const email = String(latest?.from?.emailAddress?.address || '').trim().toLowerCase();
  // Avoid combining every participant in a group conversation into one identity.
  return email.includes('@') && email !== owner ? [email] : [];
}

export async function retrieveEmailMemory(db, messages, mailbox) {
  const addresses = memoryAddresses(messages, mailbox);
  if (!addresses.length) return { status: 'no_identity', messages: [] };
  const latest = [...messages].reverse().find(m => !m.isDraft && addresses.includes(m.from?.emailAddress?.address?.toLowerCase()));
  const query = `${latest?.subject || ''} ${latest?.body?.content || ''}`.slice(0, 1500);
  const { data, error } = await db.rpc('crm_email_memory', { p_addresses: addresses, p_query: query, p_limit: 12 });
  if (error) {
    // Older deployments keep working but must not claim historical recall.
    if (['PGRST202', '42883', '42P01'].includes(error.code)) return { status: 'not_configured', messages: [] };
    throw new Error(`Historical email lookup failed (${error.code || 'database error'}).`);
  }
  return { status: 'available', ...data, matched_addresses: addresses };
}
