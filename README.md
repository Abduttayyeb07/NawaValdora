# ZigChain Wallet Monitor Bot

Production-grade Telegram bot written in strict TypeScript for monitoring tracked ZigChain wallets and sending real-time alerts for:

- native transfers via `/cosmos.bank.v1beta1.MsgSend`
- CosmWasm contract activity via `/cosmwasm.wasm.v1.MsgExecuteContract`
- swap-like contract executions inferred from CosmWasm payloads and events

The service uses ZigChain WebSocket subscriptions for low-latency detection and RPC block processing for deterministic parsing, checkpointing, and restart safety.

## Features

- WebSocket-first listener with automatic reconnect
- Polling fallback if WebSocket delivery is missed or delayed
- Strict TypeScript build with modular service layout
- Block checkpoint persistence in `data/state.json`
- Telegram chat subscription commands:
  - `/start`
  - `/subscribe`
  - `/unsubscribe`
  - `/status`
- Structured logging with `pino`
- Dockerized production run path

## Project Structure

```text
src/
  bot/
    telegramBot.ts
  listener/
    blockProcessor.ts
    pollingFallback.ts
    rpcClient.ts
    wsListener.ts
  parser/
    txParser.ts
  services/
    notificationService.ts
    stateStore.ts
    transactionMonitorService.ts
  types/
    blockchain.ts
  utils/
    config.ts
    format.ts
    logger.ts
    retry.ts
  index.ts
```

## Environment Variables

Create a `.env` file from `.env.example`.

Required:

- `TELEGRAM_BOT_TOKEN`
- `RPC_URL`
- `WS_URL`
- `VAULT_WALLETS`
- `NAWA_USDC_WALLET`

Optional:

- `LOG_LEVEL`
  - default: `info`
  - use `debug` if you want to see WebSocket event flow and block scheduling in detail

Example:

```env
TELEGRAM_BOT_TOKEN=123456:telegram-bot-token
RPC_URL=https://zigchain-mainnet.zigscan.net/
WS_URL=wss://zigchain-mainnet.zigscan.net/websocket
VAULT_WALLETS=zig1c7ltk2w9x6nqdkzuv2xp3pcxuqnwcya9ackdxj,zig12q5lshzwywgf4dryhn3tcw0cd2p468hw6w22sh,zig18fxy8zrnpccftn3l4uj98ruajqhfpnwq09cnp8,zig1laq7y7hmkuvracnuxzcgujlhlr0h2tuqekal2m,zig1ssf7peey2gs2m4rwwg9qq6dx0ezq4fkd6wfvg2
NAWA_USDC_WALLET=zig1h029787ganqh9c2up868nhh4gvsrytp0zg9aw5
LOG_LEVEL=info
```

## Run Locally

### 1. Install dependencies

```powershell
npm.cmd install
```

### 2. Start in development mode

```powershell
npm.cmd run dev
```

### 3. Build for production

```powershell
npm.cmd run build
```

### 4. Run the compiled service

```powershell
npm.cmd start
```

## Run With Docker

### 1. Build the image

```powershell
docker build -t zigchain-wallet-monitor .
```

### 2. Create the persistence directory

```powershell
New-Item -ItemType Directory -Force .\data | Out-Null
```

### 3. Run the container

```powershell
docker run `
  --name zigchain-wallet-monitor `
  --restart unless-stopped `
  --env-file .env `
  --mount type=bind,source="$(Resolve-Path .\data)",target=/app/data `
  zigchain-wallet-monitor
```

## Run With Docker Compose

The repo includes [docker-compose.yml](/c:/Users/abdut/OneDrive/Desktop/NawaValdora/docker-compose.yml:1).

### 1. Create the persistence directory

```powershell
New-Item -ItemType Directory -Force .\data | Out-Null
```

### 2. Build and start the service

```powershell
docker compose up -d --build
```

### 3. View logs

```powershell
docker compose logs -f
```

### 4. Stop the service

```powershell
docker compose down
```

The container writes checkpoint and subscriber state to:

```text
data/state.json
```

### 4. View container logs

```powershell
docker logs -f zigchain-wallet-monitor
```

### 5. Stop the container

```powershell
docker stop zigchain-wallet-monitor
```

### 6. Remove the container

```powershell
docker rm -f zigchain-wallet-monitor
```

## First-Time Bot Setup

1. Start the service.
2. Open your Telegram bot chat.
3. Send `/start` or `/subscribe`.
4. The bot stores your chat in `data/state.json`.
5. Alerts will be delivered to every subscribed chat.

## Operational Notes

- On first boot, if no checkpoint exists, the monitor starts from the current ZigChain height instead of replaying old history.
- WebSocket subscriptions are used as triggers, but full processing always happens by block height over RPC.
- This avoids duplicate handling and makes restart recovery deterministic.
- `LOG_LEVEL=debug` is useful when validating subscriptions and real-time event flow.
- No inbound HTTP port is exposed because this service only talks outbound to ZigChain RPC/WebSocket and Telegram.

## Useful Commands

Typecheck:

```powershell
npm.cmd run typecheck
```

Build:

```powershell
npm.cmd run build
```

Rebuild Docker image after code changes:

```powershell
docker build -t zigchain-wallet-monitor .
```
