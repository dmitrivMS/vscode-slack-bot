# VS Code Slack Chat Bridge

A VS Code extension that bridges Slack with VS Code Chat (GitHub Copilot). Incoming Slack messages are routed to the `@slack` chat participant in Agent mode — the model can use all available tools (file editing, terminal, search, etc.) and replies are posted back to the Slack thread.

## Architecture

```
Slack user ──► SlackBot (Socket Mode) ──► @slack chat participant ──► Copilot LM + tools
                                                    │
                                          VS Code Chat panel
                                                    │
                                              ◄─── reply ──► Slack thread
```

1. A Slack message (DM or @-mention) arrives via Socket Mode.
2. `SlackBot` stashes the thread info and opens VS Code Chat in **Agent mode** targeting the `@slack` participant.
3. The participant handler runs a multi-turn tool-calling loop through `ChatBridge`, streaming the response into the Chat panel.
4. The final response is posted back to the originating Slack thread, with Markdown converted to Slack mrkdwn.

## Requirements

- VS Code 1.100 or later
- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension (provides the language model and tools)
- A Slack workspace where you can create apps

## Slack App Setup

### Quick Setup (Manifest)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**.
2. Select your workspace, paste the contents of [`slack-app-manifest.yaml`](slack-app-manifest.yaml), and click **Create**.
3. Under **Basic Information**, generate an **App-Level Token** with the `connections:write` scope — copy the `xapp-…` token.
4. Under **OAuth & Permissions**, click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`).
5. Invite the bot to channels with `/invite @YourBotName`.

### Manual Setup

<details>
<summary>Click to expand manual steps</summary>

#### Enable Socket Mode

Under **Settings → Socket Mode**, toggle on. Generate an **App-Level Token** with `connections:write`.

#### Bot Token Scopes

Under **OAuth & Permissions → Bot Token Scopes**, add:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Receive @-mentions |
| `channels:history` | Read messages in public channels |
| `channels:read` | List public channels |
| `chat:write` | Post messages |
| `groups:history` | Read messages in private channels |
| `groups:read` | List private channels |
| `im:history` | Read direct messages |
| `im:read` | List DM conversations |
| `im:write` | Open DM conversations |
| `mpim:history` | Read group DMs |
| `mpim:read` | List group DM conversations |

#### Bot Events

Under **Event Subscriptions**, enable and add:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

#### Install

Under **OAuth & Permissions**, click **Install to Workspace** and copy the Bot User OAuth Token.

</details>

---

## Extension Setup

### Install and compile

```bash
cd vscode-slack-bot
npm install
npm run compile
```

### Configure tokens

Run **Slack Bot: Configure Tokens** (`Ctrl+Shift+P`) and enter your `xoxb-…` bot token and `xapp-…` app token. Tokens are stored in VS Code's [SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage).

### Start the bot

Run **Slack Bot: Start**. The status bar shows `✓ Slack` when connected.

To start automatically on launch:

```json
"vscode-slack-bot.autoStart": true
```

---

## Usage

### From Slack

- **DM the bot** to start a conversation.
- **@-mention the bot** in any channel it's been invited to.
- **Reply in the same thread** to continue — conversation history is preserved.

### From VS Code

Each incoming Slack message opens a new chat turn in the VS Code Chat panel with the `@slack` participant. The response is visible in the panel and posted back to Slack.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `vscode-slack-bot.autoStart` | `false` | Start the bot automatically on launch |
| `vscode-slack-bot.systemPrompt` | `"You are a helpful coding assistant…"` | System prompt prepended to new conversations |
| `vscode-slack-bot.maxHistoryMessages` | `20` | Rolling message window per thread |

---

## Debugging

Run **Slack Bot: Show Logs** to open the output channel. Press **F5** to launch an Extension Development Host for development.

## Security

- Tokens are stored in VS Code SecretStorage (OS keychain on desktop).
- **Socket Mode** — no inbound HTTP port is opened.
- The bot only responds to DMs and @-mentions, not all workspace messages.
