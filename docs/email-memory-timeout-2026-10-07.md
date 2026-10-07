# Historical retrieval timeout, 7 October 2026

Real incoming-email execution 32 saved lead/incomplete_inquiry classification, then stopped with Request timed out in Email history search embeddings. The credential was n8n-managed Gateway credits. The node schema confirms timeout units are seconds, so the prior value 120 was not a milliseconds error.

Increased timeout to 180 seconds and added two maximum attempts, 2 seconds apart, to the parent retrieval node. Kept stopWorkflow behavior so missing memory cannot silently be treated as successful retrieval. Published bounded retry settings.

Read-only synthetic retrieval test 34 used the real gateway embedding and Supabase search, with all mailbox actions, database writes and reply generation pinned. It also failed with Request timed out. Execution 33 failed in synthetic identity validation before retrieval and is not evidence about the provider.

A direct OpenAI credential is absent from this n8n account. The connected tools can list and assign existing credentials but cannot create them. Next action: create an OpenAI credential in the TecShor account using the existing local OPENAI_API_KEY, then assign it to Email history search embeddings and verify real retrieval before declaring resolution. No source data was changed, no external email was sent, and no GitHub push occurred.
