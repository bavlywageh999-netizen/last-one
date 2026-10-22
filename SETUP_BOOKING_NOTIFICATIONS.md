# Automatic appointment requests

The website sends each final booking submission to the `submit-booking` Supabase Edge Function. That function saves the request to `public.bookings`, sends a confirmation email to the patient's signed-in email address through Resend, and sends a clinic notification through the WhatsApp Cloud API. The admin Appointments view reads the same bookings table.

**Do not publish the homepage with `AUTO_NOTIFY = true` until the database, function, and secrets below are configured.** The configured project already responds at the `submit-booking` URL, but its source was missing from this workspace. Deploy `supabase/functions/submit-booking/index.ts` to install the complete implementation and keep it maintainable.

## 1. Database

In Supabase SQL Editor, run these files in order:

1. `supabase_quick_fix.sql`
2. `supabase_bookings.sql`
3. `supabase_bookings_security.sql`

The security migration adds the hashed-IP and notification retry columns required by the Edge Function. Do not expose the `bookings` table to anonymous users.

## 2. Turnstile

In Cloudflare Turnstile, add the exact production website hostname and create a Managed widget. Use its **site key** in `TURNSTILE_SITEKEY` in `index-livechat-natural.html`. The corresponding secret is configured only in Supabase in the next step. A development `file://` URL cannot pass hostname validation.

## 3. Email and WhatsApp providers

- **Email:** verify a sending domain with Resend and create an API key. Use a sender address on that verified domain.
- **WhatsApp:** configure the Meta WhatsApp Cloud API and create an approved message template in the required language, with six body text variables in this order: booking reference, patient name, treatment, requested date, requested time, patient phone.

The clinic WhatsApp number is configured using the international country-code format without `+`. The default is `201556277801`; override it with `WA_TO` if needed.

## 4. Configure server-side secrets

In Supabase > Edge Functions > Secrets, configure:

| Secret | Purpose |
|---|---|
| `BOOKING_SECRET` | Random secret of at least 32 characters, used to create patient retry tokens and hash network addresses. |
| `TURNSTILE_SECRET_KEY` | Private Turnstile secret matching the public homepage site key. |
| `RESEND_API_KEY` | Resend API key. |
| `EMAIL_FROM` | Verified sender address, for example `bookings@example.com`. |
| `WA_TOKEN` | Meta WhatsApp Cloud API access token. |
| `WA_PHONE_NUMBER_ID` | Meta WhatsApp business phone-number ID. |
| `WA_TEMPLATE` | Name of the approved WhatsApp template with the six variables above. |
| `WA_TO` | Clinic destination number, digits only, e.g. `201556277801`. |
| `ALLOWED_ORIGIN` | Comma-separated exact origins for the live homepage and admin page, e.g. `https://example.com,https://www.example.com`. |

Optional: `EMAIL_FROM_NAME`, `WA_TEMPLATE_LANG` (default `ar`), `WA_GRAPH_VERSION` (default `v22.0`), `TURNSTILE_HOSTNAME`, `CLINIC_NAME`, `RL_IP_HOUR`, `RL_IP_DAY`, `RL_EMAIL_HOUR`, `RL_EMAIL_DAY`, `RL_GLOBAL_HOUR`, and `RL_GLOBAL_DAY`.

Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions automatically. **Never put provider tokens, Turnstile secrets, `BOOKING_SECRET`, or the service-role key in HTML or commit them.**

## 5. Deploy

From the project directory, deploy the function with gateway JWT verification disabled; the function validates CAPTCHA on public submissions and validates the admin's Supabase session for admin retries:

```sh
supabase functions deploy submit-booking --no-verify-jwt
```

Set the secrets in the Supabase dashboard (or with `supabase secrets set` without saving the values in this repository). Confirm `submit-booking` is listed in the project's Edge Functions.

## 6. Enable and publish

The homepage source has `AUTO_NOTIFY = true`. Publish `index-livechat-natural.html` as the live homepage and `admin-livechat-configured.html` as the admin page only after the SQL and function are deployed and all secrets above are set. Ensure the Turnstile site key is for the production hostname.

Test with an inbox and clinic number you control. Verify the booking appears in Admin > Appointments, the patient email provider accepts the message, the WhatsApp provider accepts the clinic notification, and the request remains **Requested** until clinic staff confirms it. Provider acceptance is not proof of delivery or that a person read the message.

If a provider is temporarily unavailable, the booking still saves and the notification status is shown in Admin > Appointments; an admin can use **Retry** after correcting the provider configuration. Do not share patient or provider credentials in support messages.
