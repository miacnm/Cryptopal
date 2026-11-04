# CryptoPal

**Pay with crypto in a tap. AI picks the smartest way to pay and guards every send.**

Live demo: https://cryptopal.michaelwilson260.workers.dev (every visitor gets their own sandbox, no sign-up)

Crypto is hard to spend. You have to decide whether to sell, which coin, and when, and a phone thief or a scammer can drain it in seconds. CryptoPal makes crypto work like a tap-to-pay card, with an AI advisor in front of every payment and an AI watchdog behind it.

## What it does

- **Double-click the side button** (or say "CryptoPal pay bitcoin") and tap phones with the register, or scan its QR code.
- **Four ways to pay, AI pick on top:**
  - **Sell**: sells just enough crypto, at 1% under market (CryptoPal's fee).
  - **Borrow**: borrow against your crypto at today's price and keep the crypto (up to 50% of its value, 8% a year).
  - **Give**: send the crypto itself to another CryptoPal user, with no fee.
  - **Cash**: your dollar balance, added with PayPal.
- **Tap "?"** to see why the AI picked it, with the real numbers.
- **Send and receive** any crypto or currency by tap or QR code. Add any coin or currency Coinbase lists.
- **The store always gets dollars**, paid out through PayPal.

## Security built for real-world theft

- **CryptoPal's own face + voice on every send.** Unlocking the phone with Face ID or a passcode never unlocks CryptoPal. Every send, cancel or undo needs the owner's face (matched on the device) and their spoken secret phrase.
- **Night limit:** only $100 total can leave between 10 PM and 6 AM. Raising it takes a photo ID, a live selfie and 24 hours.
- **24-hour hold** on big sends, so a forced payment can be canceled once you're safe.
- **AI watchdog** checks every send against your normal behavior: time of night, new recipient, amount, scam words in the note, and **whether your voice sounds slurred or different from usual** (speech speed and clarity compared with your enrolled voice). Unusual sends wait 24 hours. Stacked red flags freeze the account until a person checks your ID + selfie.
- **Panic phrase:** if someone forces you (including with drugs like scopolamine), say your panic phrase instead. The phone shows "Processing" so the thief sees nothing unusual, but the account locks and a person at CryptoPal is alerted. It stays locked until the owner calls in with photo ID and a live selfie.
- **Human review desk** (`/review`): every panic lock, unlock and security change is approved by a person.

## How PayPal is used

- **PayPal Orders API v2 + JavaScript SDK:** "Add cash with PayPal" creates and captures an order in the sandbox and credits the CryptoPal balance.
- **PayPal Payouts API:** when a customer pays the café with crypto, the café receives US dollars through a sandbox payout. The payout batch ID shows on the register and in the activity list.
- Sandbox only. No real money moves.

## How AI is used (Cloudflare Workers AI)

| Job | Model |
|---|---|
| Voice commands and the secret phrase, with word timings used to measure speech speed and clarity | `@cf/openai/whisper-large-v3-turbo` |
| Turning "send 20 dollars to Ana in ethereum" into an action | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (JSON mode) |
| Picking the best way to pay and explaining why | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (JSON mode) |
| Watchdog: ok / hold 24 h / freeze | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (JSON mode), with hard rules underneath that the AI can only make stricter |
| Face match on the device | face-api (TinyFaceDetector + 128-number face descriptor) |

Live prices and 24-hour changes come from Coinbase's public price data.

## Try it (2 minutes)

1. Open the demo. No camera or mic? Tick **No camera or mic** in the demo panel.
2. Set up: name, secret phrase, panic phrase, face, and say the phrase once.
3. On the café register, press **Charge**. On your phone, double-click the side button, then **Tap phones**.
4. Read the AI pick, tap **?**, and confirm with your face and phrase.
5. Tick **Pretend it's 2 AM**, set the typed phrase to **slurred**, and send $40 to Ana. The watchdog freezes it. Open the **Human review desk** to unlock it after sending an ID + selfie.
6. Say or type your panic phrase on a send. The phone says "Processing". The review desk shows the lock.

## Run it yourself

```bash
npm install
npx wrangler dev        # http://localhost:8787 (Workers AI runs on your Cloudflare account)
npx wrangler deploy
```

PayPal sandbox (optional: without it, payouts are simulated and labeled that way):

1. Create a free account at developer.paypal.com. Under Apps & Credentials (Sandbox), create an app.
2. Put the Client ID in `wrangler.jsonc` → `vars.PAYPAL_CLIENT_ID`. Put a sandbox personal account email (it plays the café) in `vars.PAYPAL_MERCHANT_EMAIL`.
3. `npx wrangler secret put PAYPAL_SECRET` and paste the sandbox secret.

## Code

- `src/worker.js`: API, rules, AI calls, PayPal calls. One Durable Object per demo session holds the accounts.
- `public/app.js`: the two phones and the demo panel. `public/face.js`: the on-device face check. `public/review.html`: the human review desk.

## Prototype limits

Balances are a simulated ledger at live prices. Real tap-to-pay (NFC) and the real side button need a native app, so the browser simulates both, and on iPhone a Shortcut can open CryptoPal from "Hey Siri" or the Action Button. The face check runs in the browser. A production version would verify it on a server or in secure hardware. Crypto lending would need licenses.

## License

MIT
