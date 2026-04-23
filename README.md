# ZigChain Wallet Monitor Bot

Production-grade Telegram bot written in strict TypeScript for monitoring only the tracked ZigChain wallets you configure and sending real-time alerts for:

- native transfers via `/cosmos.bank.v1beta1.MsgSend`
- CosmWasm contract activity via `/cosmwasm.wasm.v1.MsgExecuteContract`
- swap-like contract executions inferred from CosmWasm payloads and events

The service uses wallet-scoped ZigChain WebSocket subscriptions for low-latency detection and wallet-scoped RPC `tx_search` fallback for deterministic parsing, checkpointing, and restart safety.

## Features

- Wallet-scoped WebSocket listener with automatic reconnect
- Wallet-scoped RPC fallback if WebSocket delivery is missed or delayed
- Parallel block catch-up with bounded worker concurrency and in-order checkpoint advancement
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
- `BLOCK_WORKER_COUNT`
  - default: `5`
  - controls how many block heights can be processed in parallel during catch-up

Example:

```env
TELEGRAM_BOT_TOKEN=123456:telegram-bot-token
RPC_URL=rpc url
WS_URL=websocket url 
VAULT_WALLETS= wallets to track 
NAWA_USDC_WALLET= wallets of nawa to track
LOG_LEVEL=info
BLOCK_WORKER_COUNT=5
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

This starts the service directly.

If you want file watching during development:

```powershell
npm.cmd run dev:watch
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
- WebSocket subscriptions are built only from the configured wallet list.
- RPC fallback searches only wallet-related indexed transactions using `message.sender`, `transfer.sender`, and `transfer.recipient`.
- Catch-up uses a worker pool and only dispatches heights up to the latest observed chain height, so workers do not run out of range.
- The persisted checkpoint still advances in order, even though multiple heights can be processed in parallel.
- This avoids duplicate handling and makes restart recovery deterministic.
- `LOG_LEVEL=debug` is useful when validating subscriptions and real-time event flow.
- `npm.cmd run dev` now builds first and then runs `dist/index.js`, which is the more reliable startup path for this bot on Windows.
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
