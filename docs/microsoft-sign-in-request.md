# Request for IT: register the Performance Review app in Microsoft Entra ID (sign-in + emails)

Send this to the R3 Microsoft 365 / Entra admin once the app has its Replit address.
Replace `<APP-URL>` with that address, e.g. `https://r3-performance-review.replit.app`.

---

Hi,

We're launching an internal web app for the H2 2026 performance review cycle (opens 15 December).
Everyone signs in with their R3 Microsoft account, and the app sends a few automatic emails
(e.g. "please confirm this review", "your review is available"). Could you register it in Microsoft Entra ID
and give it one mailbox to send from?

1. **Entra admin center → App registrations → New registration**
   - Name: `R3 Performance Review`
   - Supported account types: **Accounts in this organizational directory only** (single tenant)
   - Redirect URI: platform **Web**, value `<APP-URL>/auth/microsoft/callback`
2. **API permissions:** keep the default **Microsoft Graph → User.Read (delegated)**. The app only reads the
   signed-in person's name and email (scopes `openid profile email`). No other permissions are needed.
   If users can't consent to apps themselves in our tenant, please click **Grant admin consent**.
3. **Certificates & secrets → New client secret** (e.g. 24 months).
4. **Sending emails:**
   - Create a shared mailbox to send from, e.g. `performance-review@r3robotics.ai` (no licence needed).
   - API permissions → add **Microsoft Graph → Mail.Send (application)** and click **Grant admin consent**.
   - Please **limit that permission to this one mailbox** (Exchange Online application access policy or
     RBAC for Applications), so the app cannot send as anyone else.
   - The emails only say who did what and link to the app; they never contain ratings or feedback.
5. Please send back, through a password manager or another secure channel (not email or chat):
   - **Directory (tenant) ID**
   - **Application (client) ID**
   - **Client secret value**
   - **The sending mailbox address**

Optional: under Enterprise applications → R3 Performance Review → Properties, set
"Assignment required" to Yes and assign all employees, if you want to control who can sign in.
The app itself also only lets in people HR has added to a review cycle.

Thanks!

---

## What the app owner does with the values

In Replit → Secrets, set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`,
`APP_BASE_URL=<APP-URL>` and `MAIL_FROM=<sending mailbox>`, then set `ALLOW_TEST_LOGIN` to `false`
(or delete it) and redeploy. The sign-in page then shows "Sign in with Microsoft" only, and
HR → Emails shows "Emails are sent from …". Emails can be switched on and off per event there.
