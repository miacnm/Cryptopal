# CryptoPal

**Pay with crypto in a tap. AI picks the smartest way to pay and guards every send.**

Live demo: https://cryptopal.michaelwilson260.workers.dev (no sign-up; every visitor gets their own pretend wallet)

Crypto is hard to spend. You have to decide which coin, whether to sell it or borrow against it, and when, and a phone thief can drain it in seconds. CryptoPal makes crypto work like a tap-to-pay card, with an AI advisor in front of every payment and an AI watchdog behind it. Everything in the demo is pretend money; PayPal runs in its sandbox.

## What it does

Three tabs: **Pay**, **Market**, **Portfolio**.

- **Double-tap to pay.** Double-tap anywhere on the Pay tab (or tap Pay). iPhone Face ID, CryptoPal's own face check and a voice check all start together. Then **Pay now**, hold near the reader, done.
- **AI picks how to pay.** Pick what to pay with (cash or any coin you own) and how: **Sell asset**, **Borrow against** it, or **Use cash**. Your choice is saved for next time. An AI bubble recommends the smartest option with real numbers, for example "Cash costs nothing, and selling Bitcoin today would lock in its 1.9% drop." One tap uses the AI pick.
- **AI watchdog** checks every payment against your normal behavior (time, new recipient, amount, scam words) and explains its verdict on the receipt.
- **Market:** live crypto prices with pretend trading (buy and sell inside your account). A bubble sums up the biggest moves this hour.
- **Portfolio:** total value, a color bar of what you hold, holdings with Buy / Sell, loans and activity. Add any coin or any country's currency.
- **Add funds** with a number pad. **PayPal** uses the real PayPal sandbox checkout; Bank, Debit card and Apple Pay are pretend. **Send** and **Receive** with pretend contacts.
- **AI settings:** choose which tips the AI shows and how careful it is.

## Privacy: faces never leave the phone

The face check runs on the device (face-api in the browser, plus iPhone Face ID in the app). Face data is kept only in that phone's local storage. The server never receives or stores a face image or face data; it only gets "matched / not matched". In the demo, any face and any voice pass.

## Security engine (src/worker.js)

Built into the server for real accounts:

- **Night limit:** only $100 can leave between 10 PM and 6 AM.
- **24-hour hold** on big or unusual sends, so a forced payment can be canceled once you're safe.
- **Freeze** when red flags stack up, until a person checks a photo ID and live selfie.
- **Panic phrase:** say it instead of your phrase and the account locks quietly.
- **Human review desk** (`/review`) approves every lock, unlock and security change.

In the demo pay flow, payments always go through (no holds) so a live demo never gets stuck; the watchdog still runs and explains its check. On a computer, the **Demo controls** panel next to the phone lets you try the night limit and the review desk.

## How PayPal is used (sandbox only, no real money)

- **PayPal JavaScript SDK + Orders API v2:** Portfolio → Add funds → **PayPal** opens the PayPal sandbox checkout. The server creates the order, the buyer approves it, and the server captures it and adds the dollars to your CryptoPal cash.
- **Payouts API v1:** when you pay the store, the store receives US dollars through a sandbox payout to its PayPal account. The payout ID shows on the Paid screen.
- **OAuth 2.0 client credentials** sign every server call. The secret lives only in a Cloudflare secret, never in the code.

## How AI is used (Cloudflare Workers AI)

| Job | Model |
|---|---|
| Picks the best way to pay (sell, borrow, cash) and explains why with real numbers | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (JSON mode) |
| Watchdog: ok / hold 24 h / freeze, with hard rules underneath that the AI can only make stricter | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (JSON mode) |
| Pay tab money tips (owned coins first, with the real sell and borrow trade-offs) | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Voice commands and the spoken phrase | `@cf/openai/whisper-large-v3-turbo` |
| Face match on the device | face-api.js (TensorFlow.js: TinyFaceDetector + 128-number face descriptor) |

The app shows a quick local tip instantly and replaces it with the AI's answer when it arrives. Live prices come from Coinbase's public price data. The AI never promises gains and is not financial advice.

## Try it (2 minutes)

1. Open the live demo on a phone or computer. Set up with any name and phrase; any face and voice pass.
2. **Pay tab:** read the AI tip, tap **Pay with** to pick a coin and see the AI's pick, and spin the **How** wheel (Sell / Borrow / Cash).
3. Double-tap anywhere. Look at the camera and say anything. Tap **Pay now**, then wait at "hold near reader". The Paid screen shows the watchdog's check and the PayPal sandbox payout ID.
4. **Portfolio → Add funds → PayPal:** log in with any PayPal sandbox personal account to add test dollars.
5. **Market:** buy or sell a coin; check the Portfolio color bar.

## Run it yourself

```bash
npm install
npx wrangler dev        # http://localhost:8787 (Workers AI runs on your Cloudflare account)
npx wrangler deploy
```

PayPal sandbox (optional; without it, Add funds is pretend and payouts are labeled "simulated"):

1. At developer.paypal.com → Apps & Credentials (Sandbox), create an app (or use Default Application) with Payouts turned on.
2. Put the Client ID in `wrangler.jsonc` → `vars.PAYPAL_CLIENT_ID`, and a sandbox personal account email (it plays the store) in `vars.PAYPAL_MERCHANT_EMAIL`.
3. `npx wrangler secret put PAYPAL_SECRET` and paste the sandbox secret.

iPhone app (optional): install [XcodeGen](https://github.com/yonaskolb/XcodeGen), then `cd ios && xcodegen`, open `CryptoPal.xcodeproj`, choose your Apple team, and run it on your iPhone. It loads the live site and adds iPhone Face ID and CryptoPal links that open in the app.

## Code

- `src/worker.js`: API, security rules, AI calls, PayPal calls. One Durable Object per demo wallet holds the accounts.
- `public/app.js`: the app (Pay, Market, Portfolio, setup, pay flow, Add funds) and the desktop demo panel.
- `public/face.js`: the on-device face check. `public/face-api/`: face-api.js and its models (MIT).
- `public/review.html`: the human review desk. `public/sw.js`: offline cache for the app shell and face models.
- `ios/`: the native iPhone app (SwiftUI + WKWebView, Face ID through LocalAuthentication).
- `voice-filter/`: on-device voice models (Viper1, Viper2, V5); see above.

## Voice filter (next step for the voice check)

`voice-filter/` holds my own on-device voice models: PyTorch code plus ready-to-run ONNX models. All three take mono 16 kHz audio. They are the plan for making CryptoPal's voice check work in a loud store, entirely on the phone. They are not wired into the web demo yet.

| Model | What it does | Input | Output |
|---|---|---|---|
| **Viper2** (`viper2.onnx`) | Hears up to 3 voices in a clip and makes a voice signature (192 numbers) for each. These signatures are what get saved to the voice vault on the phone. | `audio` [1, 32000] (2 s) | `sigs` [1, 3, 192], `pres` [1, 3] (higher = that voice is really there) |
| **Viper1** (`viper1.onnx`) | Makes one voice signature and checks it against the vault: is this the owner talking? | `audio` [1, 32000] (2 s) | `embedding` [1, 192], `overlap` [1] (0 to 1: chance more than one person is talking) |
| **V5** (`v5.onnx`) | Voice filter. Removes music and background noise and keeps every voice Viper2 found. | `audio` [1, 23040] (1.44 s), `sig` [1, 576] (Viper2's 3 signatures in a row, zeros for empty slots) | `voices` [1, 23040] (clean audio) |

The plan: V5 cleans the audio, Viper1 checks it against the owner's voice in the vault, and Whisper reads the phrase.

### Try the models

```bash
pip install onnxruntime numpy soundfile
```

```python
import numpy as np, onnxruntime as ort, soundfile as sf
wav, sr = sf.read("clip.wav", dtype="float32")   # mono, 16 kHz, at least 2 seconds
clip = wav[None, :32000]

viper2 = ort.InferenceSession("voice-filter/viper2.onnx")
sigs, pres = viper2.run(None, {"audio": clip})      # up to 3 voices; save the owner's to the vault
owner = sigs[0, 0]

viper1 = ort.InferenceSession("voice-filter/viper1.onnx")
emb, overlap = viper1.run(None, {"audio": clip})
print("same person score:", float(emb[0] @ owner))  # signatures are unit length, so 1.0 = identical

v5 = ort.InferenceSession("voice-filter/v5.onnx")
clean = v5.run(None, {"audio": wav[None, :23040], "sig": sigs.reshape(1, 576)})[0]
sf.write("clean.wav", clean[0], 16000)
```

### Files

- `viper2_model.py`, `viper2_trainer.py`: Viper2 model and training.
- `viper_trainer.py` (model + training), `export_viper1.py`: Viper1.
- `v4sig_model.py`, `v5_trainer.py`, `export_v5sig.py`: V5 model, training and export.
- `spk_model.py`, `v4_model.py`, `venomx_model.py`: building blocks the three models need to run.

Training (optional, needs PyTorch): `pip install torch torchaudio numpy scipy`, then `python viper2_trainer.py`, `python viper_trainer.py` or `python v5_trainer.py`. The trainers expect your own 16 kHz speech and music folders; the paths are at the top of each file.

## Prototype limits

Balances are a pretend ledger at live prices, and the Market's hourly moves are simulated (daily moves too when live data isn't available). Real tap-to-pay (NFC) is simulated. Crypto lending would need licenses. Sandbox only: no real money moves.

## License

MIT
