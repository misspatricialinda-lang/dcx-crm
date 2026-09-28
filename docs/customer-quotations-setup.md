# Customer quotations

The Customers screen now has a **Quotations** tab with an itemized editor. The owner can add and remove rows, see the subtotal, 13% HST, and total update immediately, save a draft, issue it, download the matching DCX PDF, or delete it from the normal history view. Older browser calculator quotes and earlier narrative proposals remain in separate tabs; they are not silently migrated.

## One-time Supabase step

Run [`supabase/migrations/202609270001_customer_quotations.sql`](../supabase/migrations/202609270001_customer_quotations.sql) in the project's Supabase SQL Editor after the existing customer migrations. It creates `crm_quotations`, `crm_quotation_items`, a server-side save/delete function, and a sequence whose **first number is 6538**. Confirm that 6537 really is the last number issued across all existing systems before applying it. Do not run the migration twice.

The app server needs the existing `SUPABASE_URL` and `SUPABASE_SECRET_KEY` configuration. Browser preview mode shows the editor but deliberately does not issue numbers or save quotations. Live mode saves through `/api/crm?action=quotations&customer_id=...` using the signed-in session.

## Behavior and history

- New estimates receive a unique number on first save. Database uniqueness and the sequence prevent number reuse, including after deletion.
- Rows are stored under one customer quotation; the server calculates line totals, subtotal, HST, and total in one database transaction. The live editor calculates the same values for immediate feedback.
- A draft can be edited while its version matches. Issuing locks it against further edits. The saved customer/address snapshot and rows remain available for later PDF downloads.
- Delete is a soft delete: the quotation disappears from the ordinary customer list while the database retains its record and number. It does not delete the customer.
- The PDF uses the exact DCX logo extracted from the supplied reference and reproduces its itemized layout. More rows continue onto further pages.

## Smoke test

1. Open a customer, choose **New quotation**, and add at least two rows.
2. Check the live line totals and 13% HST; save the draft.
3. Reopen and edit it, then issue it. The first new estimate should be #6538 if no other estimate was created first.
4. Download the PDF and check the recipient, address, rows, logo, and totals.
5. Delete a test estimate and confirm it disappears. Create another and confirm its number is higher, never reused.

The old proposal and calculator quote paths are preserved under **Earlier proposals** and **Earlier calculator quotes**. They do not use the new estimate number sequence.
