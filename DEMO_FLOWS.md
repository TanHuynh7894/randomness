# Demo flows

Start the app (outside the sandbox, in your own terminal):

```sh
PATH="$HOME/.foundry/bin:$PATH" ./scripts/dashboard-demo.sh
```

To run on a local copy of Avalanche Fuji instead (same chain ID and block height, free dev accounts, nothing is sent to Fuji), start it with `FORK=fuji` in front. The header then reads `AVALANCHE FUJI (LOCAL FORK)`.

Open http://127.0.0.1:5173. To reset the data, stop the script (Ctrl+C) and run it again; it makes a fresh local chain every time. The script keeps rolling in the background, so the numbers grow during the demo.

On the local chain the sign-in sheet lists 10 dev accounts. The flows below use the regular wallet `0x3c44cd…4293bc`, a second wallet `0x90f79b…93b906`, and the wallet tagged `OPERATOR`.

## Flow 1 — Oracle: look and verify it yourself
URL: http://127.0.0.1:5173/#oracle
1. `Random numbers on request` and the 4 steps below it → The page explains what the oracle does
2. Hover the dotted words (`oracle`, `BLS`, `blocks`) → Each term is explained in place
3. `Latest result` → The newest number, its die face, how fast it was answered
4. The `Answered` and `Answer time` tiles → The node answers almost every request, in about 1 block
5. `Request history` → Every request, read straight from the chain
6. `Statistics`: `Entropy wall`, `Dice distribution` → The results look like noise, with no pattern
7. `VIEW AND VERIFY` (or click a row) → Detail sheet: the 4 steps and the 256-block window
8. `CHECK BLS SIGNATURE` → Verified right in the browser
9. `VALID` and `MATCH` → The BLS signature is correct, and the random number = keccak(signature)

## Flow 2 — Sign in with a wallet and roll
1. `SIGN IN WITH WALLET` → Sign in with a wallet signature
2. The line "Signing sends no transaction" and the `0x3c44cd…` row → Free to sign, regular wallet; press `SIGN IN` next to it
3. The address in the top right → Signed in
4. `ROLL · 0.01 AVAX` (under the intro) → Sends a request; press it
5. The new top row (`WAITING`, then `ANSWERED`) and `Latest result` updating → The node answers within 1 block

## Flow 3 — My account
URL: http://127.0.0.1:5173/#account
1. `My requests` → Exactly the roll just sent
2. The `Refunds to withdraw` tile → Fees come back when a request expires
3. `My Beacon rounds`, Deposit column → A failed round still returns the deposit if you revealed

## Flow 4 — Beacon: one full round with 2 wallets
URL: http://127.0.0.1:5173/#beacon
1. `A group draw, no node needed` and the 4 steps (Join, Reveal, Finalize, Get your deposit back) → No node needed
2. `NEW ROUND`: join time 1 minute, reveal time 1 minute, minimum 2 → With too few people everyone is refunded
3. Open the new round: its steps and `What to do now`; `JOIN · DEPOSIT 0.01 AVAX` → The secret is saved before sending
4. Sign out, sign in with `0x90f79b…`, open the round, join; `SHOW SECRET` → 2 people joined; back up the secret
5. When joining closes, `REVEAL SECRET` (wallet 2, then wallet 1) → Numbers published
6. `READY TO FINALIZE`, Next step column says `Everyone revealed, ready to finalize` → Anyone can finalize
7. `FINALIZE` → `HAS RESULT` and the round's random number
8. `GET DEPOSIT BACK 0.01 AVAX` → Deposit returned

Both wallets must join within 1 minute. If you are slow, make a 2-minute round.

## Flow 5 — Developer
URL: http://127.0.0.1:5173/#developer
1. "No sign-up" → Pay the fee and use it
2. Paste the dice contract address (the `dice` line in the script's log), `ADD` → Numbers for that contract only
3. `Add it to your contract` → Sample code with the oracle address filled in
4. `COPY CODE` → One-click copy (`COPIED`, or `COPY FAILED` if the browser blocks it)
5. `Try it from the command line` → A cast command to try it

## Flow 6 — Operator admin
URL: http://127.0.0.1:5173/#admin
1. (regular wallet) `This wallet is not the operator` → Regular wallets are blocked
2. `SIGN OUT`, sign in again with the `OPERATOR` wallet
3. The `Fees to withdraw` tile → Fees the node has earned
4. The `Profit per answer` tile → Fee minus gas
5. `Books`, `BALANCED` → The money in the contract matches what it owes
6. `Node wallet`, `Enough for` column → How many answers the gas still covers
7. `WITHDRAW …` → Fees go to the operator wallet, the books still balance
