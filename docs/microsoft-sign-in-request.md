# Request for IT: register the Performance Review app in Microsoft Entra ID

Send this to the R3 Microsoft 365 / Entra admin once the app has its Replit address.
Replace `<APP-URL>` with that address, e.g. `https://r3-performance-review.replit.app`.

---

Hi,

We're launching an internal web app for the H2 2026 performance review cycle (opens 15 December).
Everyone signs in with their R3 Microsoft account. Could you register it in Microsoft Entra ID?

1. **Entra admin center → App registrations → New registration**
   - Name: `R3 Performance Review`
   - Supported account types: **Accounts in this organizational directory only** (single tenant)
   - Redirect URI: platform **Web**, value `<APP-URL>/auth/microsoft/callback`
2. **API permissions:** keep the default **Microsoft Graph → User.Read (delegated)**. The app only reads the
   signed-in person's name and email (scopes `openid profile email`). No other permissions are needed.
   If users can't consent to apps themselves in our tenant, please click **Grant admin consent**.
3. **Certificates & secrets → New client secret** (e.g. 24 months).
4. Please send back, through a password manager or another secure channel (not email or chat):
   - **Directory (tenant) ID**
   - **Application (client) ID**
   - **Client secret value**

Optional: under Enterprise applications → R3 Performance Review → Properties, set
"Assignment required" to Yes and assign all employees, if you want to control who can sign in.
The app itself also only lets in people HR has added to a review cycle.

Thanks!

---

## What the app owner does with the values

In Replit → Secrets, set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and
`APP_BASE_URL=<APP-URL>`, then set `ALLOW_TEST_LOGIN` to `false` (or delete it) and redeploy.
The sign-in page then shows "Sign in with Microsoft" only.
